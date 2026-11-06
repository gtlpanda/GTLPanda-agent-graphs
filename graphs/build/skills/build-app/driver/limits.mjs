// Usage-limit handling for unattended runs (pure; tested in graphs/build/tests/limits.test.mjs).
// Ported verbatim from the user's autobuild kit (~/.autobuild/lib/limits.mjs); only these
// header lines differ, so a fix there can be copied here as is.
//
// When a claude.ai subscription limit is hit, a headless session fails at once with
// text like "You've hit your session limit · resets 3:45pm" (or "weekly limit · resets
// Mon 12:00am"), and the StopFailure hook receives error "rate_limit". The driver waits
// for the reset and retries the same slice instead of counting a failure.

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Classifies how a session ended, from the StopFailure hook record (preferred),
 * the final result line and the raw stream text (fallback).
 * Kinds:
 *   usage_limit  plan quota reached → wait for the reset, retry the same feature
 *   billing      spend limit, credits, billing error → stop the loop (never auto-spend)
 *   auth         not logged in, org not allowed, account on hold → stop the loop
 *   transient    overloaded or server errors that outlived in-session retries → short wait, retry
 *   normal       anything else (success, max turns, budget cap): judged by the loop's own checks
 */
export function classifyOutcome({ stopFailure = null, result = null, text = "" } = {}) {
  const error = String(stopFailure?.error ?? "").toLowerCase();
  const message = [stopFailure?.last_assistant_message, stopFailure?.error_details, result?.result, typeof text === "string" ? text.slice(-20000) : ""]
    .filter(Boolean)
    .join("\n");

  if (/credit balance is too low|spend limit|usage credits required|individual usage limit|team's shared budget/i.test(message) || error === "billing_error") {
    return { kind: "billing", message: firstLine(message, /credit|spend limit|usage credits|usage limit|budget/i) };
  }
  if (["authentication_failed", "oauth_org_not_allowed", "account_on_hold"].includes(error) || /not logged in|please run \/login|authentication required/i.test(message)) {
    return { kind: "auth", message: firstLine(message, /log ?in|authenticat|org|on hold/i) };
  }
  if (/hit your (?:session|weekly|opus|sonnet|fable|haiku|[a-z]+) limit|usage limit reached|claude ai usage limit/i.test(message)) {
    return { kind: "usage_limit", message: firstLine(message, /limit/i) };
  }
  if (error === "rate_limit") return { kind: "usage_limit", message: firstLine(message, /limit|429/i) };
  if (error === "overloaded" || error === "server_error" || /repeated 529|overloaded|server is temporarily limiting requests|experiencing high load/i.test(message)) {
    return { kind: "transient", message: firstLine(message, /overload|529|limiting|high load|server/i) };
  }
  return { kind: "normal", message: "" };
}

function firstLine(text, pattern) {
  const line = text.split("\n").find((candidate) => pattern.test(candidate)) ?? text.split("\n")[0] ?? "";
  return line.trim().slice(0, 300);
}

/** Wall-clock parts of `date` in `timeZone`. */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(String(get("weekday")).toLowerCase().slice(0, 3)),
  };
}

/** The instant whose wall-clock time in `timeZone` is the given local date and time (DST-safe). */
function zonedInstant({ year, month, day, hour, minute }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i += 1) {
    const seen = zonedParts(new Date(guess), timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    const wantedUtc = Date.UTC(year, month - 1, day, hour, minute);
    if (seenUtc === wantedUtc) break;
    guess += wantedUtc - seenUtc;
  }
  return new Date(guess);
}

function addDays({ year, month, day }, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function to24h(hour, minute, meridiem) {
  if (hour > 23 || minute > 59) return null;
  if (!meridiem) return { hour, minute };
  if (hour < 1 || hour > 12) return null;
  const pm = meridiem.toLowerCase() === "pm";
  return { hour: (hour % 12) + (pm ? 12 : 0), minute };
}

/**
 * Reads the reset time out of a limit message. Returns a Date, or null when it cannot.
 * Understands:
 *   "resets 3:45pm", "resets 3pm", "resets 15:45"   → the next such wall-clock time (today, else tomorrow)
 *   "resets Mon 12:00am"                             → the next such weekday and time (a week ahead if it is now)
 *   "resets Oct 14, 3:45pm" / "resets Oct 14 at 3pm" → that date (next year if already past)
 *   "resets in 2h 13m", "resets in 45 minutes"       → now + duration
 *   an optional zone in parentheses, e.g. "(America/Los_Angeles)", else `timeZone`
 */
export function parseResetTime(text, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (typeof text !== "string") return null;
  const lower = text.toLowerCase();
  const at = lower.search(/\bresets?\b/);
  if (at < 0) return null;
  const tail = text.slice(at).replace(/^resets?\s*(?:at\s+)?/i, "");

  const zone = /\(([A-Za-z_]+\/[A-Za-z_/+-]+|UTC)\)/.exec(tail)?.[1];
  let tz = timeZone;
  if (zone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      tz = zone;
    } catch {
      /* unknown zone: keep the default */
    }
  }

  const relative = /^in\s+(?:(\d+)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?/i.exec(tail);
  if (relative && (relative[1] || relative[2])) {
    const minutes = Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0);
    return new Date(now.getTime() + minutes * 60_000);
  }

  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
  const nowLocal = zonedParts(now, tz);

  const dated = new RegExp(`^(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s*(?:at\\s+)?${time.source})?`, "i").exec(tail);
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase()) + 1;
    const day = Number(dated[2]);
    const clock = dated[3] ? to24h(Number(dated[3]), Number(dated[4] ?? 0), dated[5]) : { hour: 0, minute: 0 };
    if (!clock || day < 1 || day > 31) return null;
    let candidate = zonedInstant({ year: nowLocal.year, month, day, ...clock }, tz);
    if (candidate.getTime() <= now.getTime()) candidate = zonedInstant({ year: nowLocal.year + 1, month, day, ...clock }, tz);
    return candidate;
  }

  const weekday = new RegExp(`^(${WEEKDAYS.join("|")})[a-z]*\\.?,?\\s+(?:at\\s+)?${time.source}`, "i").exec(tail);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1].toLowerCase().slice(0, 3));
    const clock = to24h(Number(weekday[2]), Number(weekday[3] ?? 0), weekday[4]);
    if (!clock) return null;
    let ahead = (target - nowLocal.weekday + 7) % 7;
    let candidate = zonedInstant({ ...addDays(nowLocal, ahead), ...clock }, tz);
    if (candidate.getTime() <= now.getTime()) {
      ahead += 7;
      candidate = zonedInstant({ ...addDays(nowLocal, ahead), ...clock }, tz);
    }
    return candidate;
  }

  const clockOnly = new RegExp(`^${time.source}`, "i").exec(tail);
  if (clockOnly && (clockOnly[2] !== undefined || clockOnly[3] !== undefined)) {
    const clock = to24h(Number(clockOnly[1]), Number(clockOnly[2] ?? 0), clockOnly[3]);
    if (!clock) return null;
    let candidate = zonedInstant({ ...addDays(nowLocal, 0), ...clock }, tz);
    if (candidate.getTime() <= now.getTime()) candidate = zonedInstant({ ...addDays(nowLocal, 1), ...clock }, tz);
    return candidate;
  }
  return null;
}

/**
 * What the loop does after a usage limit: wait until `resetAt + marginMinutes`, or probe
 * every `probeEveryMinutes` when the reset time is unknown; give up when the wait would
 * exceed `maxWaitHours` (for example a weekly limit days away).
 */
export function planLimitWait({ resetAt, now = new Date(), marginMinutes = 3, probeEveryMinutes = 30, maxWaitHours = 26 }) {
  if (!resetAt) return { action: "probe", waitMs: probeEveryMinutes * 60_000 };
  const waitMs = Math.max(0, resetAt.getTime() - now.getTime()) + marginMinutes * 60_000;
  if (waitMs > maxWaitHours * 3_600_000) return { action: "give_up", waitMs, resumeAt: new Date(now.getTime() + waitMs) };
  return { action: "wait", waitMs, resumeAt: new Date(now.getTime() + waitMs) };
}
