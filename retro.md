# Retro

## 1. Agent graph for /loop (2026-10-28)

**What changed.** The loop was prose only: `loop.md` called `/verify` and
`/review` directly and nothing routed between the checker, fixer, and reviewer
agents. Now `/loop` (Opus) is the outer clock and state owner, and
`workflows/harness-repair.js` is a code-routed inner graph per iteration:
check → fix → check, then review → (advisor confirms) → fix → check → review of
the touched files only. Agents are leaves and never call each other.

**Key details.**
- Models: orchestrator opus, advisor fable (new `agents/advisor.md`), checker
  haiku/low, fixer sonnet/medium, reviewer sonnet/medium (was opus). Aliases
  checked against the CLI 2.1.308 alias table (Opus 5.5, Fable 5.1, Sonnet 5.5,
  Haiku 5.5). `settings.json` gains `model` and `advisorModel`.
- The gate reads the last line of the verbatim VERIFY block, never the
  checker's verdict field, and never the fixer's own verify run.
- Termination is in code: fix-round cap (3), failure signature repeat → advisor
  once → escalate; `knownStuckSigs` from the ledger stops later iterations from
  re-spending rounds on the same failure.
- `skills/review` renamed `harness-review` (collided with gstack's `review`).
- `install.sh`: links `workflows/` per entry; `--skip=a,b` (installed on this
  Mac with `--skip=settings.json,CLAUDE.md` to keep the user's own files).
- Ledger lives in `$(git rev-parse --git-path harness-loop)/ledger.json`.

**Bugs caught.**
- `check_skips` used `list_targets | grep -q` under `pipefail`; grep exiting on
  the first match SIGPIPEs the producer, so valid `--skip` names were refused.
  Caught by the new install test, fixed by collecting targets first.
- An unknown `agentType` makes `agent()` throw, which crashed the whole run
  instead of escalating. Found by the live run; `runNode` now catches and the
  ledger records the error.
- `loop.md` relied on a `fixed` list the ledger did not expose; now aggregated.

- Audit round (independent read-only agent, findings re-reproduced before
  fixing): the `runNode` catch also swallowed asserts inside mock agents, so
  six mutations survived at 25/25 (base never reaching the reviewer, refuted
  findings reaching the fixer, review-path cap and known-stuck checks, noted
  dedupe, review-fix `fixed` items). The harness now rethrows mock errors and
  fails on unconsumed responses; a node failure must be scripted as
  `{ throws }`. Empty `--skip=` silently did a full install (reproduced: it
  replaced settings.json); now refused. Step-less FAILs all shared the
  signature `verify|`; now keyed on the block. `/loop` re-runs `/verify`
  itself before committing instead of trusting the checker's transcription.

**Verified.**
- `scripts/test.sh`: VALIDATE PASS, TEST-INSTALL 68/0, TEST-SECRETS 22/0,
  TEST-WORKFLOW 31/0. Twelve deliberate mutations of the workflow (the
  audit's six plus: gate trusts the verdict field, advisor on sonnet, missing
  verdict = refuted, stuck detection off, fix-scope review widened, meta phase
  model drift) each fail at least one test.
- Live: `claude -p` in a fixture repo with a real bug ran the installed
  workflow by name: check FAIL → fix (`a - b` → `a + b`) → check PASS → review
  → done; the fixer did not commit; re-running verify independently gave
  VERIFY: PASS.
- Observed: user-level `~/.claude/workflows/` is read. Agents linked into a
  running session were not visible to a workflow run right after install, and
  appeared later.

- Live run 2 (fixture whose tests pass but whose branch adds
  `execSync('ls ' + dir)`): check PASS → review (2 findings) → advisor
  confirmed the injection → fix (`fs.readdirSync` plus an injection
  regression test) → check PASS → review of lib.js/test.js only → done,
  nothing committed, about $1.16. Subagent transcripts show the models used:
  opus-5-5 orchestrator, fable-5-1 advisor, haiku-5-5 for both checks,
  sonnet-5-5 for the fix and both reviews.

- Live run 3 (`claude -p "/loop"` in a fresh copy of the failing fixture):
  bare `/loop` picked up `~/.claude/loop.md`; the CLI resolves
  `<project>/.claude/loop.md` first, then `~/.claude/loop.md`, capped at
  25,000 bytes. The orchestrator ran the graph, wrote the ledger, re-ran
  `/verify` itself, and committed exactly `add.js` (`095f140`). It put the
  commit on a new branch, following the global rule to branch off the
  default branch. Cost about $1.50.

**Untested.** The advisor's unstick path (same failure twice) has run only
against mocked agents.

## 2. High effort across the graph (2026-10-30)

**What changed.** Every node in `harness-repair` is now configured at `high`: checker
(was low), fixer (was medium), reviewer (was medium), advisor (already high).
Each agent file carries a matching `effort: high` so standalone use agrees with
the graph. `settings.json` records `effortLevel: high` for the orchestrator;
the live `~/.claude/settings.json` already had it, but install skips
`settings.json`, so the repo did not reflect it.

**Key details.**
- `scripts/test-workflow.mjs`: the drift test now compares effort as well as
  model against the agent files, and asserts every node runs at high.
- `scripts/validate.sh`: agents must declare `effort` (low|medium|high|xhigh|max);
  `settings.json` must declare `effortLevel`.
- Mutations, each caught: NODES-only effort change (TEST-WORKFLOW), `effort`
  removed from an agent file (VALIDATE + TEST-WORKFLOW), `effortLevel` removed
  from settings (VALIDATE).
- Cost: haiku checker at high costs more per run than at low. Not measured.

**Untested.** That the runtime honors the `effort` option: live runs so far
recorded models from subagent transcripts, never effort. Also unchecked: which
of `effortLevel` and `modelSettings` wins for the live opus-5-5 orchestrator.

**Stats.** 10 files (60+/19-). TEST: PASS (TEST-WORKFLOW 31/0, TEST-INSTALL 68/0, TEST-SECRETS 22/0).
