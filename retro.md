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

## 3. Monorepo for agent graphs (2026-10-30)

**What changed.** `claude-harness` became `GTLPanda-agent-graphs`, the home for
every graph (QA now; dev and release next). GitHub repo renamed (old URL
redirects); local checkout moved to `~/Documents/code/GTLPanda-agent-graphs`.
History was rewritten before going public: commits use the GitHub noreply
address, `tasks/` is local-only, and an MIT LICENSE was added.

**Layout.** `core/skills/` holds what every graph shares (`verify`,
`harness-review`). `graphs/qa/` holds the repair graph's agents, workflow,
routing tests, and README. `scripts/`, `loop.md`, `settings.json`, and
`CLAUDE.md` stay at the root: `/verify` detects the repo through
`scripts/test.sh`, the pre-commit hook calls `scripts/check-secrets.sh`, and
there is only one `~/.claude/loop.md`.

**Key details.**
- `install.sh` maps repo source to `~/.claude` target (they no longer match)
  and refuses two sources with one name before writing anything. Existing
  installs re-point cleanly: the stale-link check matches on the target
  suffix, so all 8 live links moved with zero backups.
- The workflow mock runtime is now `scripts/workflow-harness.mjs`; each graph
  ships `graphs/<graph>/tests/*.test.mjs`, and `scripts/test-workflow.mjs`
  runs them all.
- Bug caught in the new install test, not in install.sh: the test compared a
  `/var/folders` path with the `/private/var` path `install.sh` records
  (`pwd -P`). Fixed in the test.
- Mutations, each caught: effort drift, a test file that fails to import, no
  test files, a duplicate agent across graphs, a stray top-level `agents/`.

**Open.** Each graph will need its own loop entry point; today the QA graph
owns the default `/loop`.

**Stats.** 3 commits. TEST: PASS (TEST-INSTALL 73/0, TEST-WORKFLOW 33/0, TEST-SECRETS 22/0).

## 4. QA auditor node in the QA graph (2026-10-30)

**What changed.** New read-only `qa-auditor` agent (sonnet, high) in
`graphs/qa/agents/`. It runs after review is clean and traces behavior across
files: data flows, states and transitions, failure modes, authorization, input
validation, integration seams. Its HIGH/CRITICAL findings go through the same
advisor-confirm → fix → check → review path as review findings; then QA
re-audits only the files changed since its last run.

**Key details.**
- Named `qa-auditor`, not `qa-engineer`: a private agent by that name lives in
  `~/.claude/agents/`, and install would have backed it up and replaced it.
- The confirm/fix block that review used is now one `confirmAndFix(source, …)`
  shared by review and QA. Signatures carry the source (`review|…`, `qa|…`),
  and noted/refuted findings record it.
- Behavior change: when the advisor refutes every blocking review finding, the
  run continues to QA instead of ending `done`.
- Mutations, each caught: QA never narrowing to the fix diff, fixes not
  tracked for QA, review-refuted skipping QA, QA signatures labeled `review`.

**Live run** (`claude -p` on a fixture whose branch adds a `deleteRoute` with
no ownership check; tests pass): checker → reviewer (CRITICAL authz bypass,
HIGH missing negative test) → advisor confirmed both, one by running the code
→ fixer added the check and two tests → checker PASS → reviewer of the fix,
clean → qa-auditor on the branch → done. About $1.30. QA's only finding (LOW)
was that the fix was uncommitted, which is by design (`/loop` commits); the
QA prompt now says so (`0b29ce8`).

**Stats.** TEST-WORKFLOW 40/0 (7 new QA tests; 16 existing tests updated for the extra node).

## 5. Dev graph (2026-10-30)

**What changed.** `graphs/dev/`: `/dev <task>` → `dev-build` workflow →
planner → advisor plan gate → you approve → parallel scouts → implementer per
component (tests first) with a checker gate → acceptance-auditor → the QA
graph as a child workflow. `advisor` and `checker` moved to `core/agents/`.
Design and contracts: `graphs/dev/README.md`. Rules adapted from the user's
`build`/`dry` skills and gstack's `spec`/`test-audit`/`plan-eng-review`/
`investigate` (credited).

**Key details.**
- In code, not prompts: structural plan problems go back to the planner
  without an advisor call; an unreported criterion counts as unmet; a red
  component never reaches QA; the QA child gets only the caller's args and
  its `stuckSig` comes back up. Helpers shared with the QA script are copied
  verbatim and a test fails if they drift.
- Mutations: 11 of the dev routing, each caught.

**Live run** (`claude -p`, fixture task "owner-only updateRoute; 404 for
non-owners and missing docs; 400 for an empty body"): planner (7 criteria,
2 components) → gate approve → 2 scouts → implementer/checker ×2 →
acceptance all MET → harness-repair (check, review, QA) → done. 12 agents,
none failed, about $2.10. Re-verified by hand: VERIFY: PASS; breaking the
owner check, the 404-before-400 order, or the write fails 5, 3, and 3 tests.
Two gaps it exposed, both fixed:
- Implementers proved their tests only by "the function did not exist".
  `tests_added[].bite` is now required: the break made after green and the
  assertion that failed.
- The reviewer rated a duplicated authorization check MEDIUM, reading the
  DRY rule's "differ or security path" as "and". The rule now says EITHER,
  and that matching copies on those paths are still HIGH.

**Stats.** TEST-WORKFLOW 78/0 (34 dev routing tests).
