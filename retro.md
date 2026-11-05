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

## 6. Release graph (2026-10-30)

**What changed.** `graphs/release/`: `/release-pr [PR#]` drives the
`release-flow` workflow through four instant stages: `docs` (scribe updates
the repo's existing docs in the PR) → `ready` (GitHub's merge gate and every
check on the exact head) → `land` (you approve that head; the merger merges
once) → `verify` (deploy evidence for the merge commit, health checks).
Rules adapted from gstack's `land-and-deploy`, `canary`, `document-release`,
and `setup-deploy`, and the user's `release` skill (credited).

**Key details.**
- Nothing in the graph waits. Bash calls cap at 10 minutes and foreground
  `sleep` is blocked, so `/release-pr` owns the clock and waits with
  background `gh pr checks --watch` / `gh run watch`, then re-invokes.
- In code: approval bound to `{pr, head, base}` (any move → `stale`); `land`
  reads the PR first and never calls the merger on a merged PR; the merger
  runs once per run; a health failure is BROKEN only on the second round in a
  row; no deploy evidence or an unreported target is UNVERIFIED, never a pass.
- The merger is the only agent in these graphs allowed an irreversible
  action, on an approval for one exact head.
- `validate.sh` now refuses a skill and a workflow with the same name (both
  appear in the skills list); `release` itself was taken twice (the user's
  skill and a plugin's), hence `release-pr` / `release-flow`.
- Mutations: 6 of the release routing, each caught.

**Untested live.** Mock-tested only. A live run needs a real PR and a deploy
target; Terracotta's Guardian workflows (triggered by a PR closing) and
Render services are the first candidates, and it has no health URL, so its
verdicts will be UNVERIFIED until one is configured.

**Stats.** TEST-WORKFLOW 109/0 (31 release routing tests).

## 7. /dev runs unattended after up-front questions (2026-10-30)

**What changed.** Plain `/dev` now lets the advisor approve the plan (`--review` restores the human
approval stop; `--auto` is accepted as the default). Questions happen only before any code exists
(the dirty tree, `needs-human`); every later stop is a report. At the plan round cap, a plan whose
open gate issues are all `blocking: false` gets one final planner revision that is structure-checked
but not gated, then builds (`ledger.planSettled`). Any blocking issue escalates as before.

**Why.** In a real `/dev` run on Terracotta PR 4a, the gate said revise three times (7, 8, then 4
issues, the last all wording) and the run escalated. `--auto` could not have prevented that,
because the cap was checked before the approval mode was read. The orchestrator then applied the
round-3 fixes by hand, which is what the final revision now does.

**Key details.**
- Strict by default: a missing or non-boolean `blocking`, an empty issue list, or a structural
  problem from `planProblems()` counts as blocking. At most 4 planner calls.
- `ledger.planApproved` (new): `/dev` saves the plan whenever it is true, so `--resume` works after a
  build escalates in the advisor-approved default. Caught by the reviewer: the only `plan.json`
  write was in the `plan-ready` step, which the new default skips. Fixed before commit.
- `loop.md` unchanged: that session had no `/loop` iteration.

**Untested live.** Mock-tested only; no live `/dev` run with the new cap behavior yet.

**Stats.** TEST-WORKFLOW 116/0 (7 new dev routing tests); 7 mutations, each caught; 1 HIGH review
finding fixed.

## 8. Hardening from the first real runs (2026-11-02)

**What changed.**
- `/dev` runs an approved plan from a generated script instead of inline args:
  `graphs/dev/skills/dev/run-script.mjs` writes `plan.json` into a copy of `dev-build.js` by replacing
  its one `const INJECTED_PLAN = null` line, proves the plan round-trips and that exactly one line
  changed, and `/dev` runs the copy with `scriptPath`. A plan given both ways escalates.
- Acceptance triage: unplanned behavior changes from the first audit go to the advisor before any
  rework. `keep` (must cite `goal` or a real acceptance id) is added to `plan.behavior_changes` and
  reported as decided without the human; `remove` goes to the rework; any `blocking` escalates with
  `blockedChanges`. Code overrules a bad triage: no decision, two decisions, or an uncited keep is blocking.
- `loop.md`: a block on a human sends one push notification per distinct block (`blockedOn` in the
  ledger) and never ends the loop; two truly idle iterations in a row end it.
- `/dev` notifies on `done` and states expected durations at launch; `/release-pr` notifies on every
  stop that waits on the user.
- Leaner tests: the implementer puts data-only variations in one table-driven test per function and
  asserts user-facing text by its rule, not the whole sentence; `/dev` reports a test ratio per build.

**Why.** Evidence from Terracotta tc-wt-p2 (sessions 9f9f0138, fba91340; run records in
`~/.claude/projects/<proj>/<session>/workflows/wf_*.json`):
- 4 of 7 dev-build runs used hand-patched script copies: the plan is 52 KB and workflow scripts have
  no filesystem access, so the orchestrator could only retype it or patch line 143 by hand.
- Acceptance escalated on both real builds after one rework (3, then 1 unplanned changes); the human
  kept the 4b change. The 4a changes were not benign (scan poll spanning pages, a stale flag), which is
  why a keep must cite what it serves and anything touching cost, contracts, or data is blocking.
- 27 hourly "nothing actionable" wakeups were not idle: each was blocked on the user's merge, with a
  watcher armed. Nothing told the user for ~40 hours. My first proposal (stop after 2 idle wakeups)
  would have killed that loop; corrected before building (lessons.md, "A status line is not a diagnosis").
- Entry 7's cap behavior now has live evidence: run wf_ea206ca0 got 1 blocking + 5 non-blocking issues
  at the cap and escalated as designed.

**Test volume.** Measured on Terracotta, frontend lines only: the two `/dev` builds carry 2.4x and
2.8x test lines per code line; comparable non-`/dev` feature PRs 0.6x-1.6x (median ~1.25). No
duplicated test bodies, and the two follow-up fixes rewrote 0 existing test lines, so no maintenance
cost is shown yet. The bulk is exact-wording tests (94 of 122 cases in `assessmentsVoice.test.js`
assert copy). Untested hypothesis for the cause: 26 acceptance criteria plus scout edge cases, each
given its own test. Re-measure after 3 builds with the new rule.

**Review.** The reviewer found 1 MEDIUM and 2 LOW; all fixed with tests:
- MEDIUM: kept changes vanished from the report after an escalate and `--resume`. They now live in
  `plan.kept_changes`, which `/dev` saves and resume passes back; `ledger.keptChanges` is that array.
- LOW: `loop.md` "stop the iteration" on escalate could skip the new notify step, and the idle count
  had no storage. Now stopping never skips steps 5 to 7, and `idleRuns` lives in the ledger.
- LOW: a `__proto__` key in plan.json would change the plan as an object literal. The plan is now
  embedded as `JSON.parse("<string>")`, which reads it exactly as plan.json is read.
- Found while testing the MEDIUM fix: the workflow mutated the caller's `args.plan`, which leaked
  kept changes between tests. It now works on a copy.

A second review of PR #2 found 1 MEDIUM and 4 LOW; all fixed with tests before merge:
- MEDIUM: the first `loop.md` fix was incomplete. The header and step 3.5 still said "steps 5 and 6",
  so an escalated iteration skipped step 7 and never reset `idleRuns`. This entry claimed the fix
  before that was true; now every place says 5 to 7, and a blocked iteration counts as not idle.
- LOW: a blocking triage exit dropped the keeps from the same triage; they now go into the plan first.
- LOW: the round-2 acceptance exit gave only a count; it now lists the changes in `blockedChanges`.
- LOW: "to drop one, say so" had no mechanism; the orchestrator now reverts the change, runs
  `/verify`, then resumes.
- LOW: the test-ratio command dropped files like `clock.ts` (unanchored `lock`) and counted pytest's
  `test_*.py` as code; both fixed, and it still reads 2.8x on Terracotta PR 4b.

**Untested live.** Triage, the run script under the real Workflow tool (including a `scriptPath`
inside `.git/`), and every `loop.md` / notification rule. The prose rules are only checked for
presence by `validate.sh`. Release graph: still never run live; routing merges through it waits on one
live run.

**Stats.** TEST-WORKFLOW 129/0, up from 116: 7 run-script tests, 6 triage tests, and the old
unplanned-change test rewritten for triage; 13 mutations, each caught; validate.sh gains 13 rule
checks, one bite-tested by deleting the idle rule. VERIFY: PASS.

## 9. Live triage replay; the advisor follows leftover state (2026-11-02)

**What changed.** One rule in `core/agents/advisor.md` triage: when a change leaves state behind (a
flag, timer, poll, subscription, cache entry), follow it into the next run, mount, or navigation;
state left stale for the next one is a defect: `remove` when it lives only in memory, `blocking`
when it is persisted or shared beyond the session. `validate.sh` checks the rule is present. The
persisted/shared clause came from the PR review, after the A/B below; the A/B case is in-memory.

**Why.** First live test of entry 8's triage, by replay: the exact prompt `dev-build.js` builds,
from each build's pre-decision plan and the auditor's real findings, sent to the real advisor
(Fable), decisions routed through the real `sortTriage`. Ground truth: the human kept all 4 changes
in the plan, and for 4a #2 (stale `detailsOpen`) also fixed the code.

| Change | Human | Old rule | New rule |
|---|---|---|---|
| 4b 409 emits intentional-saved | keep | keep (AC22) | not re-run |
| 4a #1 poll lifetime | keep | keep (AC12) | keep (AC12) |
| 4a #2 stale detailsOpen | fix + document | keep: "at worst pre-expands the next running payload" | remove, with the human's fix |
| 4a #3 two root nodes | keep | keep (AC13) | keep (AC13) |

Routing on the old-rule decisions: both builds `done`, nothing blocked, citations valid. The old
rule saw the next-run effect and kept it anyway; the new rule removes it.

**Replay contamination, three runs.** The merged code held two hand edits made 4 minutes after the
4a escalation: the store fix (`assessmentRun.js:220`) and a test whose names state the answer. The
first 4a replay "refuted" the defect by citing the fix; the next two (old rule, then new rule)
reverted the fix but not the test, and the new-rule run cited the test. The A/B above ran on a snapshot with both reverted, checked
against every Edit/Write in the session from escalation to merge (lessons.md).

**Untested.** One sample per arm, and outputs vary run to run: the rule can flip this call, not
proven that it always will. Prompts reached the agents as a file, and the code as a non-git
snapshot; the runtime's StructuredOutput enforcement was not exercised.

**Stats.** 6 advisor runs: the 3 in the table, plus 3 contaminated 4a replays discarded as evidence.
~337k agent tokens (from the run notifications), 1.4 to 4.4 minutes each. VERIFY: PASS.

## 10. Knowledge map: one owner per piece of shared knowledge (2026-11-04)

**What changed.** New `core/skills/knowledge-map`: the same-knowledge test, when knowledge gets a
single owner (auth, authz, untrusted-input validation, money: from the first caller; anything else:
from the second, counting planned callers), anti-patterns, and the format of an optional per-repo
`docs/knowledge-map.json`. Planner, scout, advisor, and reviewer preload it. `dev-build.js`: plan
components carry `owners_used`/`owners_created`; `planProblems` rejects an owner created twice, used
and created by one component, used before its creator, a malformed id, or a creator that does not
list the map file; the map file never counts toward the 8-file cap; the scout brief gains `owners`;
the gate checks the map (or, with none, that owner lists are empty); a rework is told the owners and
may not edit the map. Only `/blueprint` (not built yet) adds map entries. `validate.sh` now parses
`skills:` block lists and fails on a preloaded skill that does not exist, and keeps harness-review's
copy of the same-knowledge test identical to the skill's (standalone `/harness-review` does not load
the skill).

**Why.** Step 1 toward `/blueprint` and an unattended autoloop. Each `/dev` run plans one slice
against today's code, so "two real callers" cannot see callers a later slice adds, and copies pile up
until review flags them (untested hypothesis: not counted in past builds). The map lets the planner
count planned callers; this step makes it enforced before anything writes one.

**Bugs caught.** Reviewer: 4 LOW (map file read as component overlap; the cap exemption reached only
the gate prompt; scout paths stale for owners built in the same run; `fm_list` missed unindented and
quoted items). QA auditor: 7 MEDIUM + 1 LOW, including that the first draft broke its own AC9 (with
no map, the skill's thresholds replaced the planner's two-callers rule), owner ids accepted in a repo
with no map, use-before-create passing, and the rework seeing no owners. All fixed with tests except
QA #6 (mechanically checking the implementer's map edit), deferred to the user. Self-caught: a
mutation (M8) survived because the gate prompt names the map path on another line too; a bite test
undone with `git checkout` dropped uncommitted frontmatter (lessons.md).

**Stats.** 13 files, +185/-21 plus the 106-line skill. 4 new routing tests (133 passed, 0 failed),
13 mutations all caught, 5 validate bites (misspelled, inline, unindented, quoted-misspelled skill;
drifted test copy). TEST: PASS, VERIFY: PASS.

## 11. Owner records are checked, not trusted (2026-11-04)

**What changed.** Follow-up to entry 10 (its deferred QA #6). The acceptance auditor now reports
`owners[] {id, RECORDED|MISSING, evidence}` for every owner a plan builds: RECORDED only when
`docs/knowledge-map.json` parses (it runs a parse and quotes it), the entry is `built`, and the owner
file exists. Code has the last word: an owner not reported RECORDED, or reported both ways, is a gap.
Gaps ride the existing acceptance loop (one rework, verify, re-audit, then escalate by id). The
rework may edit the map only to fix those records or to undo a map change triage said to remove;
it is told to create or move a missing owner file and to repair an unparseable map's syntax only.
Any other map edit is an unplanned behavior change for triage. A blocking-triage escalation also
names missing records. Plans without owners route as before.

**Why the auditor and not the implementer.** The option the user picked described the implementer
reporting `owners_recorded`. That is the builder grading itself; this repo gates on evidence from
another node, so the check moved to the auditor, with no new retry path.

**Bugs caught.** Reviewer: 2 MEDIUM (a triage "remove" on a map change could never be undone because
the rework was forbidden to edit the map; a blocking-triage escalation hid missing records) and 1 LOW
(README contradicted the new rule). QA auditor: 3 LOW (duplicate report entries decided by order;
no way to repair an unparseable map under "change nothing else"; no instruction to create a missing
owner file). All fixed, each with a test.

**Stats.** 6 new routing tests (139 passed, 0 failed), 12 mutations all caught; a 7th test for missing
records and a map removal together came from the final review (140 passed). TEST: PASS, VERIFY: PASS.

## 12. /blueprint run 1: intake and interview (2026-11-04)

**What changed.** New graph `graphs/blueprint`, first of three planned PRs (B1 of B1-B3, plan in
`tasks/todo.md`). `blueprint-design.js` run 1: `extractor` (sonnet) turns docs, the repo, and the
request into a brief (R* requirements with sources, decisions already made, gaps, X* contradictions,
constraints, existing stack); `questioner` (sonnet) ranks open decisions by cost to change, each with
2-4 options, a recommendation, and a default, plus the preflight list and assumptions. Code checks
both and sends each back once. At most 12 questions (user's choice); the rest become assumptions with
their default; contradiction questions are always asked; more than 12 contradictions escalate. The
`/blueprint` skill asks in rounds of four, never asks for secret values, and saves the answers as
binding decisions in `.git`. `/dev`'s `run-script.mjs` moved to the shared `core/skills/workflow-state`
(seam name and workflow path are arguments), as the user chose, so run 2 can reuse it.

**Bugs caught.** Mutation B16 survived the first suite: the bad-`docs` test also lacked a request, so
an earlier check escalated and the docs check was never reached (lessons.md). Reviewer: 2 MEDIUM (a
missing `questions` list crashed the workflow instead of escalating; the preflight question broke
AskUserQuestion's 2-4 option limit and the 12-question cap) and 1 LOW (a stale script path). QA
auditor: 2 HIGH (`/dev` with a saved plan fails until `install.sh` re-links the moved script; the same
preflight question), 4 MEDIUM (an empty folder inside another repo read as that repo; a stale
`state.json` surviving "start over"; stray `resolves` ids making questions undroppable; secrets in
free-text answers saved verbatim), and 6 LOW (wording of the cap escalation, doc paths resolved
against the repo instead of the current directory, `--git-path` relative to the current directory in
every graph's skill, unspecified overrides). All fixed; the code ones with tests. Preflight and
overrides now come back in one free-text reply, so the 12-question cap holds.

**Final PR review.** 2 MEDIUM, 2 LOW, all fixed: assumptions now get stable ids from the workflow
(`A<n>`, or the `Q<n>` past the cap) so an override names one exactly; the new-app check is runnable
commands and asks when a non-empty folder sits inside another repo; the request is redacted once and
the ledger before `run1.json`; three READMEs now show the absolute `--git-path`.

**Untested.** No live run: agents, prompts, and the skill's interview have only run against mocks.
The default-stack rule lives in `questioner.md` until run 2's researcher needs it too.

**Stats.** 17 routing tests (147 passed, 0 failed), 20 mutations caught, 1 after a test fix.

## 13. L0 live interview; /blueprint run 2a: design and the design gate (2026-11-04)

**L0 (first live run of run 1).** A reading-list app in a scratch repo: 8 questions, 10 assumptions, 6
preflight items in 63.5 s (2 agents). The pre-registered pass conditions held: no decided item was asked
again, every question had its recommendation first, and no credential-shaped string reached `run1.json`
or `state.json`. Two findings mocks could not show: preflight items kept after answers ruled them out
(a hosting account after "local only", an email key after "no reset"; B3 adds conditions), and the
optional last step read as a new task to the human (the skill now says "none" keeps every default).

**What changed.** First half of B2 (19A split; the autobuild plan is in `tasks/todo.md`).
`blueprint-design.js` gains `stage: design`: the `architect` (sonnet, new) designs against the saved
answers; code checks the structure (`designProblems`: requirement coverage, two distinct shapes per
new boundary with a pick and depth reason, no silent+untested+unhandled failure, ADRs with two options,
at most 3 departures from the default stack, every decision and assumption id in `honors` or
`conflicts`, knowledge items per the knowledge-map rules); then the advisor's new "Gating a design"
(8 red flags from gstack's `plan-eng-review`, premises, surfaces). Two architect rounds, then escalate.
A `blocked` gate returns questions that name the id they challenge; the skill replaces that decision
or assumption with the answer and reruns, at most twice. Args are ids (529 bytes on the real state)
plus `statePath`; agents read `state.json` themselves, so no injected seam. The default stack moved
from `questioner.md` into `core/skills/default-stack`, preloaded by the questioner, architect, and
advisor. `GATE_SCHEMA` is marked shared with `dev-build.js` and drift-tested; the knowledge-map kinds
are drift-tested against the skill.

**Bugs caught.** Advisor before code: a `blocked` gate was a dead end (now `needs-human`); decision
ids must not be shape-checked (`A<n>` overrides, `D<n>` gate answers). Reviewer and QA auditor, both on
the uncommitted diff, agreed on the worst one (HIGH): a gate answer was appended as `D<n>` next to the
decision it contradicted, so the gate would ask the same question forever; now each question names the
id it challenges and the answer replaces it, with a 2-round cap. Also fixed: the architect pointed at a
`scaffold-app` skill it cannot load (MEDIUM, now `default-stack`); "UNVERIFIED premise" meant three
things (MEDIUM, now `conflicts` for a decision that cannot hold, premises only for evidence); an
`approve` carrying a blocking issue was accepted; duplicate shape names passed the two-shapes check;
failure ids were unchecked; `server/helpers.js` passed the grab-bag check; the advisor's revision
wording overpromised; new knowledge ids could reuse an existing map's. All code fixes have tests.

**Untested.** No live design run yet (L1 is next, on the reading list, with pass conditions in the
todo). A knowledge owner path is not checked against module names (paths and names differ).

**Stats.** 50 new tests (18 plus 32 table rows; 208 passed, 0 failed), 24 mutations, all caught.
Diff about 780 added lines, about 300 of them tests: over the ~300 guide, and already the B2a half of
the split.
