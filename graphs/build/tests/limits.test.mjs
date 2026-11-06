// limits.test.mjs — usage-limit classification and reset-time parsing for the /build-app driver.
// Ported from the autobuild kit's test/limits.test.mjs with the same cases; only the imports and
// the test runner differ.
import assert from "node:assert/strict";
import { test } from "../../../scripts/workflow-harness.mjs";
console.log("== build-app driver: usage limits")
import { classifyOutcome, parseResetTime, planLimitWait } from "../skills/build-app/driver/limits.mjs";

const LA = "America/Los_Angeles";
// Sunday 2026-10-11 21:24 PDT (UTC-7) = 2026-10-12T04:24:00Z
const NOW = new Date("2026-10-12T04:24:00.000Z");
const iso = (date) => date?.toISOString() ?? null;

await test("classifies a subscription limit from the StopFailure hook record", () => {
  const out = classifyOutcome({ stopFailure: { error: "rate_limit", last_assistant_message: "You've hit your session limit · resets 11:00pm" } });
  assert.equal(out.kind, "usage_limit");
  assert.match(out.message, /resets 11:00pm/);
});

await test("classifies limits from result text when no hook record exists", () => {
  for (const text of ["You've hit your session limit · resets 3:45pm", "You've hit your weekly limit · resets Mon 12:00am", "You've hit your Opus limit · resets 3pm", "Claude AI usage limit reached|1760000000"]) {
    assert.equal(classifyOutcome({ result: { result: text } }).kind, "usage_limit", text);
  }
});

await test("spend and credit errors stop the loop instead of waiting", () => {
  for (const text of ["Credit balance is too low", "You've hit your monthly spend limit", "Usage credits required for 1M context", "You've hit your individual usage limit"]) {
    assert.equal(classifyOutcome({ text }).kind, "billing", text);
  }
  assert.equal(classifyOutcome({ stopFailure: { error: "billing_error" } }).kind, "billing");
});

await test("auth problems and transient overloads are told apart", () => {
  assert.equal(classifyOutcome({ stopFailure: { error: "authentication_failed" } }).kind, "auth");
  assert.equal(classifyOutcome({ text: "Not logged in · Please run /login" }).kind, "auth");
  assert.equal(classifyOutcome({ stopFailure: { error: "overloaded" } }).kind, "transient");
  assert.equal(classifyOutcome({ text: "API Error: Repeated 529 Overloaded errors" }).kind, "transient");
  assert.equal(classifyOutcome({ result: { result: "Built P1B-01 and committed it." } }).kind, "normal");
  assert.equal(classifyOutcome({}).kind, "normal");
});

await test("a clock time later today resets today", () => {
  assert.equal(iso(parseResetTime("You've hit your session limit · resets 11:00pm", NOW, LA)), "2026-10-12T06:00:00.000Z");
  assert.equal(iso(parseResetTime("resets 11pm", NOW, LA)), "2026-10-12T06:00:00.000Z");
  assert.equal(iso(parseResetTime("resets 23:30", NOW, LA)), "2026-10-12T06:30:00.000Z");
});

await test("a clock time already past today means tomorrow (the 2 a.m. case)", () => {
  assert.equal(iso(parseResetTime("· resets 3:45pm", NOW, LA)), "2026-10-12T22:45:00.000Z");
  assert.equal(iso(parseResetTime("resets 9:24pm", NOW, LA)), "2026-10-13T04:24:00.000Z"); // exactly now → tomorrow
  const twoAm = new Date("2026-10-12T09:05:00.000Z"); // Mon 02:05 PDT
  assert.equal(iso(parseResetTime("resets 2:00am", twoAm, LA)), "2026-10-13T09:00:00.000Z");
  assert.equal(iso(parseResetTime("resets 2:10am", twoAm, LA)), "2026-10-12T09:10:00.000Z");
});

await test("a weekday reset is the next such weekday", () => {
  assert.equal(iso(parseResetTime("You've hit your weekly limit · resets Mon 12:00am", NOW, LA)), "2026-10-12T07:00:00.000Z"); // Mon 00:00 PDT, 2h36m away
  assert.equal(iso(parseResetTime("resets Sun 9:00pm", NOW, LA)), "2026-10-19T04:00:00.000Z"); // today's already past → next week
  assert.equal(iso(parseResetTime("resets Wednesday at 8am", NOW, LA)), "2026-10-14T15:00:00.000Z");
});

await test("dates, relative durations and explicit zones", () => {
  assert.equal(iso(parseResetTime("resets Oct 14, 3:45pm", NOW, LA)), "2026-10-14T22:45:00.000Z");
  assert.equal(iso(parseResetTime("resets Oct 1 at 9am", NOW, LA)), "2027-10-01T16:00:00.000Z"); // past → next year
  assert.equal(iso(parseResetTime("resets in 2h 13m", NOW, LA)), "2026-10-12T06:37:00.000Z");
  assert.equal(iso(parseResetTime("resets in 45 minutes", NOW, LA)), "2026-10-12T05:09:00.000Z");
  assert.equal(iso(parseResetTime("resets 3:45pm (America/New_York)", NOW, LA)), "2026-10-12T19:45:00.000Z");
  assert.equal(iso(parseResetTime("resets 3:45pm (UTC)", NOW, LA)), "2026-10-12T15:45:00.000Z");
});

await test("across the DST change the wall-clock time is honoured", () => {
  const beforeFallBack = new Date("2026-10-31T20:00:00.000Z"); // Sat 13:00 PDT; DST ends Sun Nov 1
  assert.equal(iso(parseResetTime("resets Sun 9:00am", beforeFallBack, LA)), "2026-11-01T17:00:00.000Z"); // 09:00 PST
});

await test("unparseable reset text gives null, never a guess", () => {
  for (const text of ["You've hit your session limit", "resets soon", "resets 25:00", "resets 13pm", "resets Funday 3pm", "resets 7", "", undefined, 42]) {
    assert.equal(parseResetTime(text, NOW, LA), null, String(text));
  }
});

await test("planLimitWait waits with a margin, probes when unknown, gives up past the cap", () => {
  const wait = planLimitWait({ resetAt: new Date(NOW.getTime() + 60 * 60_000), now: NOW });
  assert.equal(wait.action, "wait");
  assert.equal(wait.waitMs, 63 * 60_000);
  assert.deepEqual(planLimitWait({ resetAt: null, now: NOW }), { action: "probe", waitMs: 30 * 60_000 });
  assert.equal(planLimitWait({ resetAt: new Date(NOW.getTime() + 5 * 24 * 3_600_000), now: NOW }).action, "give_up");
  assert.equal(planLimitWait({ resetAt: new Date(NOW.getTime() - 60_000), now: NOW }).waitMs, 3 * 60_000);
});
