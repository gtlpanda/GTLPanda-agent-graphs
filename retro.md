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
wording overpromised; new knowledge ids could reuse an existing map's. A pre-merge re-review found one
more (MEDIUM): an `approve` with ids still in `conflicts` returned `design-ready`, so a binding decision
the architect could not honor never reached the human; it now counts as a revision. All code fixes have tests.

**Untested.** No live design run yet (L1 is next, on the reading list, with pass conditions in the
todo). A knowledge owner path is not checked against module names (paths and names differ).

**Stats.** 51 new tests (19 plus 32 table rows; 209 passed, 0 failed), 25 mutations, all caught.
Diff about 780 added lines, about 300 of them tests: over the ~300 guide, and already the B2a half of
the split.

## 14. L1-design live run; the design gate re-gates a revision (2026-11-05)

**What changed.** The first live design run on the reading-list app (run wf_164f6cf0-7b5) took
1265 s (4 agents, 206k subagent tokens). It escalated with "design not approved after 2 architect
round(s)" and failed one of its four pre-registered conditions (approved within one revision). The
other three passed: 18 of 18 ids honored, 0 departures, 0 critical gaps. The round-2 gate reviewed
the whole design again (8 modules, 26 failure modes, 16 ADRs) and found 2 new blocking issues. One of
them was caused by a round-1 fix. Fix: `MAX_DESIGN_ROUNDS` is now 3. Only the first gate is a full
review. Every later gate is a re-gate (`regatePrompt`) that checks only the blocking issues it sent
back. A re-gate blocking issue counts only when the references before its colon include `#<n>` (an
issue it sent back) or a decision or assumption id (`inScope`). Any other finding goes to
`ledger.notes` for the human, and a re-gate `revise` with nothing in scope is `design-ready`.
`gatePrompt` stayed byte-identical, so the resume replayed round 1 from cache. The resumed run took
163 s (56k tokens): the re-gate approved in round 2 with 6 notes, all marked non-blocking by the
advisor itself. So the code's downgrade of an out-of-scope blocking issue is covered by tests, not
yet by a live run.

**Bugs caught.** A pre-merge re-review of B2a (MEDIUM, merged in #8): an `approve` with ids still in
`conflicts` returned `design-ready`. The review of this change found 2 MEDIUM and 3 LOW, all fixed
with tests:
- MEDIUM: a full-review approve turned into a revision lost its non-blocking findings.
- MEDIUM: the synthetic conflicts issue could reuse an advisor's issue number.
- LOW: a `blocked` gate dropped its issues.
- LOW: the scope prefix missed `**q1:**`, `Q1, Q2:` and `Issue #1:`.
- LOW: advisor.md still said every revise sends the design back.

**Stats.** 219 tests passed, 0 failed (10 new, plus the 2-round tests moved to 3), 15 mutations,
all caught. 2 validate.sh rules (both checked to fail when their text is removed).

## 15. GTM families and the product brief (2026-11-05)

**What changed.** The graphs now come in families. **Build** graphs change your code. **Marketing**
graphs (SEO first) change your own site and content, and their fixes ship as code PRs. **Sales**
graphs (research, scout, and sdr, planned) reach other people, so you approve every send. The
README graph table has a Family column. Marketing and sales share one brief per product,
`docs/gtm.md` in that product's repo, never in PandaStack. `core/skills/gtm-brief` owns the format:
Product, Customer, Positioning, Voice, Proof (each claim with a source), Never claim, Compliance.
It also owns the rules: agents read the brief and never edit it, and without a passing brief they
stop instead of inventing a customer. `gtm-brief.mjs check <path>` has zero dependencies and ends
with `GTM-BRIEF: PASS|FAIL`, exit code 0 or 1 (2 for usage).

**Bugs caught.** Review found 2 MEDIUM and 4 LOW, each reproduced before the fix:
- MEDIUM: fences toggled on any ``` or ~~~ line, so a ```` block around a ``` example, or a ```
  block "closed" by ~~~, turned an example `## Compliance` into a real section, and a brief missing
  that section passed. Fences now follow CommonMark: same character, at least as long, at most 3
  spaces of indent.
- MEDIUM: an unclosed fence was reported one line past the end of the file; it now names the line
  that opened the fence.
- LOW: the placeholder rule failed `<2s, >99.9%` and inline code, and passed `<your name@here>`
  and a `TBD` in a heading.
- LOW: a Proof item with an empty claim, or `source: n/a`, passed.
- LOW: the CLI did nothing and exited 0 under `node --preserve-symlinks-main`.
- LOW: the docs said "proves" a brief is complete; the check covers the format only.

**Stats.** 12 tests (231 passed, 0 failed in the suite), 27 mutations, all caught. 2 validate.sh
rules. Diff about 350 lines, about 150 of them tests.

## 16. seo-check: the page checks of the SEO gate (2026-11-05)

**What changed.** `graphs/seo/` is the first marketing graph; so far it holds the check.
`node seo-check.mjs check <built dir> --site <url> [--json]` reads a site's build output (never
the source) and checks every page's title, meta description, canonical, Open Graph tags, and
JSON-LD. It prints `seo-check: <file>[:line]: error|warn <check>: <message>` lines and a count,
and its last line is `SEO-CHECK: PASS|FAIL` (exit code 0 or 1; 2 for usage). Errors fail and
warnings never do. Every rule names its source, and checked against Google's docs on 2026-11-05:
- Google sets no length limit for titles or descriptions, so "title <= 60, description
  150-160" from the old skill are warnings (our guide), never failures.
- Google only accepts a canonical inside `<head>` and recommends an absolute URL.
- FAQ rich results are no longer shown since 2026-05-07 (Google's FAQ doc, opened; the earlier
  note said "summary only, not opened").
- `og:image` must be absolute: the Open Graph URL type is http(s) URLs. Facebook's docs say
  nothing either way.
- A missing meta description is an error by our rule, labeled as ours (user, 3A).
Shipped as three stacked PRs (user, 5A): the scanner, the checks for one page, then the command
and docs. It stacks on the gtm-brief PR for the README Family column.

**Bugs caught.** The tests caught `og:image` flagged as "two tags disagree" (Open Graph lets it
repeat). The first review found 1 HIGH, 4 MEDIUM, and 2 LOW, each reproduced before the fix:
- HIGH: the head ended only at `</head>` or `<body>`, so a `<meta>` after an `<img>` in the head,
  or after content in minified HTML without head tags, passed. Browsers put it in `<body>`.
- MEDIUM: tags between `</head>` and `<body>` were called "in body"; the parser puts them in
  the head. One test asserted the wrong behavior.
- MEDIUM: only the first `og:image` was checked. A `--site` root canonical without a trailing
  slash failed. No test failed if warnings started failing the gate.
- LOW: `&constructor;` decoded to function source; an all-noindex site passed silently.
The re-check of the fixes found 1 HIGH and 2 LOW: a tracking pixel's `<img>` in a head
`<noscript>` ended the head, so every Meta Pixel or tag-manager site would falsely fail (noscript
and template content are now never scanned); text before a comment was not counted; a
non-breaking space counted as whitespace. The scanner now follows the HTML parser's head modes.

**Stats.** 21 tests (252 passed, 0 failed in the suite), 67 mutations, all caught (the scanner
tests alone catch its 25). 2 validate.sh rules, both checked to fail when their text is removed.
858 added lines in three PRs: 180, 358, and 320 (the last includes this entry).

## 17. seo-check: sitemaps, robots.txt, duplicates, and app shells (2026-11-05)

**What changed.** seo-check now reads the build the way a crawler finds it, as well as page by page.
- **Sitemaps.** It reads robots.txt `Sitemap:` lines, plus `sitemap.xml`, `sitemap-index.xml`, or
  `sitemap_index.xml`, and follows every index once.
- **Strictness (user, 2A).** The sitemap decides which pages are strict. A page it leaves out gets its
  errors as warnings, except JSON-LD's. With no sitemap, every page is strict, and the same holds
  when a sitemap could not be read, since that one may list any page.
- **robots.txt** is read as Google documents for Googlebot. Groups that name it are combined,
  matching uses the product token, and the longest matching path wins, with Allow winning a tie.
  `*` and a final `$` are supported. Paths are compared case-sensitively, percent-encoded. A rule
  with no path is ignored, and anything after 500 KiB is ignored. Errors: blocking a listed URL,
  and blocking every page (a staging build).
- **Duplicates.** A title or description shared between pages is an error when both pages are
  strict.
- **App shells.** A page whose tags are missing and whose `<body>` is empty until a script runs gets
  the single-page-app warning.

Four new checks: `sitemap`, `robots`, `duplicates`, `spa`. Every rule was checked on 2026-11-05
against Google's build-sitemap, large-sitemaps, block-indexing, robots_txt, title-link, and snippet
docs, and against sitemaps.org. Neither source says whether an index may list another index, so
nested indexes are followed and nothing is claimed. The user asked for one pass with no check-ins
("Stop stopping"). The advisor caught the first plan revising answer 2A (a robots-blocked page made
non-strict); the build follows 2A as answered.

**Bugs caught.**
- Mutation runs found 21 test gaps (11 in the three build PRs, 10 after the review fixes) and two
  pieces of dead code, both deleted: isAppShell's `</head>` fallback, which no input can reach, and an
  empty-path guard that the regular-file check made redundant.
- The reviewer could not run commands, so I reproduced each of its findings before fixing. The
  reviewer and the QA auditor together reported 7 distinct defects, and all 7 reproduced:
  - HIGH: an index whose children were all gzipped or off-site counted as a sitemap, so every page
    became non-strict. A page missing its title passed. Pages that only an unread sitemap listed
    were demoted too.
  - MEDIUM: a `..%2f` sitemap URL (from an index or a `Sitemap:` line) read files outside the build.
    Reproduced by reading `/etc/hosts`.
  - MEDIUM: two files serving one URL (`a.html`, `a/index.html`): only the first in sort order was
    listed, so the verdict depended on file names. With no sitemap, the two were flagged as
    duplicates of each other.
  - LOW: a `*`-heavy robots rule backtracked (a 60-character path took over 60 seconds); an
    unclosed `<url>` was quadratic (35.7 seconds for 200,000); `%c3%a9` never matched `%C3%A9`; a
    Latin-1 byte in robots.txt was a hard FAIL (Google: it must be UTF-8 and may ignore the rest).
- One regression in my own fix: the new tag stripper went quadratic once the stripped `<script>`
  took the last `>` with it (7 seconds), caught by the new timing test.

**Stats.** 36 seo-check tests (267 passed, 0 failed in the suite). On the final code, 175 of 177
mutants are caught. The 2 missed are equivalent: noindex pages have no title fact and only JSON-LD
findings, so the explicit `indexable` guards cannot be told apart. 1 new validate.sh rule, shown to
fail when its phrase is removed. Four stacked PRs: 278, 266, 132, and 263 added lines (the review fixes, this entry
included).
## 18. The backlog module: format, ledger, and next-step rules (2026-11-05)

**What changed.** `core/skills/backlog/` holds the format of `docs/backlog.json` and the rules the
`/build-app` driver will run on: a zero-dependency `backlog.mjs` (CLI `check <path>` ending in
`BACKLOG: PASS|FAIL`, same shape as gtm-brief) and a `SKILL.md` whose JSON example is tested against the
code. `validateBacklog` checks ids `S1..Sn` in build order, criteria `S<n>-AC<k>` (1 to 8, each with
`fails_when`), earlier-only `depends_on` (so no cycle is possible), full requirement coverage, at most 40
slices, and no "stop and ask" in a goal (`/dev` lets task text override its no-ask rule). It uses nothing
outside its own source, so the backlog stage can copy it verbatim; a test evaluates it in isolation.
The ledger rules are pure: `nextSlice`, `blockedClosure`, `recordOutcome` (returns a new ledger),
`frozenFiles`, `brake`. `readLedger` throws on a corrupt ledger rather than starting over, and
`writeLedger` writes a temp file and renames it.

**Design call.** The README's "three slice escalations in a row" fired on the third try of one slice
when the driver retries it, so its re-plan never got a chance. The brake now counts *different* slices
escalating with none landing in between (shared breakage), a slice that escalated goes after
independent ready slices, and one slice is bounded by its own limits: two escalations re-plan it, two
more mark it stuck (blocked). README updated to match.

**Bugs caught.** Adversarial tests, before commit: `stop-and-ask` with hyphens passed the goal check;
`"S01"` passed as a dependency, which the ledger's exact-id compare would never mark done, so the
build would stop with a misleading "every remaining slice is blocked".

Reviewer, on the uncommitted change (2 MEDIUM, 2 LOW, all fixed with tests): `replan` stayed true after
the re-plan attempt failed, so a driver would re-plan again uncounted, past the limits; a tripped brake
could never clear and a blocked slice had no way back, so a resumed build would stop at once (now
`resume` and `unblock`); one ordering assertion could not fail; a comment claimed a drift test that does
not exist yet (the backlog stage adds it with the copy).

PR review (#20, 1 MEDIUM, 3 LOW, each reproduced, all fixed with tests): a second `unblock` replaced
the first round's answers, so a re-planned slice lost the human's earlier decision (answers now
accumulate); `readLedger` checked only the top level, so `{S1: "done"}` read as pending (rebuilt) and
`status: "complete"` was offered forever (now every entry, status, and count is checked); any read
error whose message held "ENOENT" (a directory named so) turned a corrupt ledger into a fresh build
(now the error code); "stop and ask" was checked in the goal only, though the whole slice is task text
(now title, criteria, and `fails_when` too).
Found while fixing it: `recordOutcome` stored non-text test files or questions, which the stricter
`readLedger` would then refuse on resume; `writeLedger` now refuses any ledger `readLedger` would.

**Stats.** 28 new tests (295 passed, 0 failed in the suite, after rebasing on entries 15-17), 30 mutations, all caught (one survived at first:
`unblock` keeping the re-plan count; an assertion was added).

**Also measured this session (outside the repo).** `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` in the user
env made every workflow `agent()` run on that model, ignoring `model: 'haiku'`/`'fable'` pins;
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=0` alone did not fix it. Removing it restored Haiku 5.5 and Fable 5.1
(modelUsage in headless probes). A headless `claude -p` runs a Workflow script to completion
(correction, entry 23: only within 10 minutes of its last turn, unless
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`; the probe took 16 s). Both
feed the driver design.

## 19. /blueprint run 3: the backlog stage and the one approval (2026-11-05)

**What changed.** `blueprint-design.js` gains `stage: "backlog"`. A new slicer agent (Sonnet) reads
`state.json` and the design run (`run2.json`) by path and returns `{app, slices, knowledge}`; the code
adds `version`, `integrationBranch`, and the design's requirement ids, so the parts a model could get
wrong are not its to write. The structure check is `validateBacklog`, copied verbatim from
`core/skills/backlog/backlog.mjs` with a drift test, plus the owner rule from the knowledge-map skill
as code: every design knowledge item once, and `built_in` must be the first slice in `used_by` (never
a shared slice ahead of its callers). Then the advisor's new "Gating a backlog" section: approve only
if `/dev` could build every slice unattended. Same rounds and re-gate scope as the design (3 rounds;
a re-gate checks only what it sent back). `/blueprint` gets sections 5 (backlog) and 6 (the one
approval: Approve / Edit / Stop). Approve needs nothing staged and a new branch, creates
`integration/<app>`, and commits only what `write-docs.mjs` writes: `docs/blueprint/<app>.md` (never
overwritten), `docs/backlog.json` (an earlier backlog is replaced; git keeps it), and
`docs/knowledge-map.json` (the knowledge-map format, `used_by` in build order, appended to an
existing map).
Edit becomes a binding `D<n>` decision and designs again. `gateRounds` is now in the `state.json`
shape (it was counted there but never listed).

**Design calls.** The backlog loop is a sibling of the design loop, sharing `inScope`, `note`,
`gateQuestions`, and the re-gate prompt, rather than one generic loop with flags: the two would not
change together (conflicts are design-only). No injected state: like run 2, the agents read the files
and the code gets only ids (`knowledge`). The design doc goes to `docs/blueprint/<app>.md`, not
`docs/design.md`, because `/blueprint --doc docs/design.md` is the common input and is never
overwritten.

**Bugs caught.** My own tests: a dependency message is quoted (`S1 depends on "S2"`).
PR review (#21; 1 HIGH, 2 MEDIUM, all in the approval, each fixed and the git steps then run as
written in a scratch repo): the clean-tree rule stopped every new app, because `/blueprint --doc`
leaves the doc untracked (now: nothing staged); `git add` ran from the shell's folder while
write-docs wrote under `REPO`, which fails when the repo is above it (now every command is
`git -C "$REPO"`); and any repo blueprinted before could never be approved again, because the
backlog and the knowledge map were refused instead of replaced and merged.

**Stats.** 31 new tests (326 passed, 0 failed), 25 mutations, all caught. 5 validate.sh rules, 3 of
them checked to fail when their text is removed.

## 20. /dev slice mode: --slice, --base, --unattended (2026-11-05)

**What changed.** `/dev --slice S<n> --base integration/<app> --unattended` builds one backlog slice
with nobody there, the way the `/build-app` driver will call it.
- `backlog.mjs task <backlog> S<n> [build state dir]` (`sliceTask`) turns the slice into the task
  text (goal, requirements, every criterion with its id) plus every earlier reason and answer from
  the app's build ledger, and prints the `requiredCriteria`. A missing ledger is a first attempt; a
  broken one fails. Each app has its own ledger, `<state dir>/<app>/ledger.json` (`ledgerPath`), so
  a second backlog in one repo never inherits the first one's done slices.
- `dev-build.js` takes `requiredCriteria`: a plan that drops one, or rewords its criterion, goes back
  to the planner before any gate, and an approved plan in `args` that lacks one escalates. So the
  acceptance audit proves the backlog's own criteria, not a paraphrase. The planner agent keeps the
  slice's ids (`S2-AC1`) and numbers its own `AC1`, ...
- `/dev`: `--base` replaces detection (and must exist); `--unattended` turns the dirty-tree question
  and `needs-human` into reports and wins over task text; with `--slice`, every commit subject starts
  with `S<n>: `. Installed paths go through `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` (also in
  `/blueprint`), as `install.sh` does.
- `harness-review` diffs against the base its prompt names (the QA graph already passes it), so a slice
  on `integration/<app>` is reviewed alone instead of with every slice before it.

**Bugs caught.** My own tests: the planner prompt shows issues as JSON, so a quoted criterion
arrives escaped; the build fixture's auditor reported the wrong criterion ids. Both were test
mistakes, not code.
PR review (#22; 2 MEDIUM, 1 LOW, all fixed): under `--slice` the branch step came before the step
that produces the task text its name needs, so a failed slice lookup left a stray branch behind
(the lookup now runs first); `$C` was defined once in prose, but shell state does not carry between
commands, so the run-script path (which worked before) would have broken (every command now spells
out `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`); the retro's test count was one too high.

**Stats.** 9 new tests (335 passed, 0 failed), 12 mutations, all caught. 3 validate.sh rules, each
checked to fail when its text is removed.

## 21. The /build-app driver (2026-11-05)

**What changed.** `graphs/build/` is the build graph; so far it holds the driver,
`skills/build-app/driver/driver.mjs run|status|stop --repo <path> --app <slug>`. Per slice it runs a
fresh headless `claude -p "/dev --slice S<n> --base integration/<app> --unattended"` on
`slice/S<n>`, fresh from `integration/<app>`. It then lands the slice by fast-forward only when `/dev`
reports done AND the driver's own checks pass: the session left the repo on its branch with a clean
tree, the branch builds on integration, every commit starts `S<n>: `, no frozen test changed, and
the driver's own verify ends `VERIFY: PASS`. The ledger (`.git/harness-build/<app>/`) and every
next-step rule and brake come from `backlog.mjs`. A failed attempt is kept on `attempt/S<n>-<time>`
(uncommitted work is committed there), never discarded. Usage limits wait for the reset or probe
and retry the same slice uncounted; billing and auth stop; an overloaded API is retried three times.
`stop` ends the running session (SIGTERM, then SIGKILL) and also cuts short an hours-long limit
wait. `PANDASTACK_NOTIFY` gets one line per landing, block, brake, and stop.

**Measured first (probe, ~$0.02).** Under `--permission-mode bypassPermissions` in headless
`claude -p`, a PreToolUse hook deny blocked a Bash call in the main session and in an Agent-tool
subagent, and a `permissions.deny` rule from `--settings` blocked one too. So the guard hook is the
boundary, and the deny rules are a second layer (they match text only: `git -C . push` slips past
`Bash(git push *)`). Workflow-tool agents were not probed directly; the smoke run must confirm them.

**Ported.** `limits.mjs` verbatim from the user's autobuild kit (header lines aside), with its 11
tests. `buildEnv`, the stop-failure hook, the pid lock, the probe, and the SIGTERM-then-SIGKILL stop
follow the kit. Not copied: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, and the kit's denies of Skill
and Workflow (`/dev` needs both).

**Bugs caught before review.** Reading the guard: `bash -c "git push"` and `$(git push)` slipped
through, because the quote stuck to `"git` (words are now stripped of quotes, `$(`, and backticks, and
every `git` in a command is checked; it fails closed, so even an echo of "git push" is denied). A
stop during an hours-long usage-limit wait, or during probing, would not take effect until the wait
ended (waits now end on a stop). A verify that leaves untracked files would make the next slice
start dirty, and `/dev --unattended` stops on that (the driver now names them instead). Mutation run:
3 of 18 mutants survived (a session that commits cleanly but leaves files behind, a `/dev`
escalation with clean-looking commits, the guard's frozen list), each closed with a test.

PR review (#23; 1 HIGH, 8 MEDIUM, 1 LOW, each reproduced by the reviewer, all fixed with tests):
- HIGH: `git mv` of a frozen test passed the frozen check, since git's rename detection listed only the
  new name (now `--no-renames`).
- A relative or symlinked `--repo` switched off the guard's `.git` and frozen-test rules (the repo,
  and every edited path, are now resolved to real paths).
- A fourth overloaded-API failure in a row fell through into the checks and was counted as the slice's
  escalation (now the build pauses, exit 7, uncounted).
- After a killed driver, the next run reset `slice/S<n>` and orphaned its finished commits (now kept on
  `attempt/S<n>-<time>-recovered`), and a session it started could still be running (now a
  `session.pid` blocks a second one).
- A crash between the fast-forward and the ledger write left a landed slice pending, which then
  failed four times and braked (the ledger is now written first, and preflight records a slice whose
  `S<n>: ` commits are already on integration).
- A reused pid in `driver.pid` wedged the lock and let `stop` SIGTERM an unrelated process (a pid now
  counts only while its command line is the driver's).
- Stripping every `CLAUDE_CODE_*` would drop `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_BEDROCK`,
  so an unattended box could not log in (auth and provider settings are kept).
- The guard read any later word `git` as a command, so a commit message like "drop git rebase helper"
  was denied; a real tokenizer now treats quotes, heredocs, and arguments as data and still checks
  `bash -c`, `$(...)`, `eval`, and prefixes such as `xargs` and `env`. `git clean -n` and `git branch -d`
  are allowed.
- The test-file regex was a hand copy of `/dev`'s (now a test pins it to the SKILL.md command).
- LOW: a slice that got stuck was not notified, and the README said "any spelling".

**Stats.** 43 new tests (23 end-to-end driver runs, 9 guard and session, 11 ported limits); 378 workflow
tests passed, 0 failed. 37 mutations, all caught after the fixes.

## 22. /build-app: the skill, the finish, and the smoke run (2026-11-05)

**What changed.** `graphs/build/skills/build-app/SKILL.md` is `/build-app`: `start` (the default)
preflights (Node 20.11+, a clean tree, the backlog on `integration/<app>` passes, a remote and `gh`
login unless `--no-pr`, owed preflight items asked once), then launches the driver detached
(`setsid nohup`) so it outlives the session; `status`, `stop`, `resume`, and `unblock S<n> <answer>`
read and steer it. The driver gains the finish: once every slice has landed, one headless session
runs the QA graph (`harness-repair`) over the whole branch against the default branch, commits its
fixes as `final: QA fixes`, and reports through a file; the driver applies the same checks (no
commits is fine), fast-forwards, pushes `integration/<app>` itself (sessions never push), and opens
one PR to the default branch, or reuses an open one. A final QA that fails brakes with every slice
still landed, and a rerun repeats only the finish. `driver.mjs resume` and `unblock` change the
ledger only while no driver runs. `scripts/smoke-build.sh` builds one real slice on a throwaway repo
with `--no-pr` and prints its cost and the models it used; it is opt-in and never in `scripts/test.sh`.

**Bugs caught.** Tests: the first finish tests reused one bare remote for two repos, so the second
push was rejected (a test mistake, which then became the test for a rejected push). Mutation run:
1 of 10 survived (a failed push was untested), closed with that test.

PR review (#24; 1 HIGH, 4 MEDIUM, 3 LOW, all fixed): the launch line redirected into `STATE/logs`
before anything created it, so every first start failed (the skill now creates it); a build started
with `--no-pr` would push once resumed, since the flag was not remembered (it now is, until `--pr`);
`$REPO` and `$STATE` were shell variables no command defined (now placeholders written out); a
killed driver left `status.json` at "running" forever, which blocked the next start (status now
says "stale"); `setsid` does not exist on macOS (used only where it does); the guard denied the final
QA's own report inside `.git` (now the one writable file); `resume` on a mistyped app looked like
success; `smoke-build.sh -h` printed a code line, and a crash before `status.json` skipped its FAIL line.

Live smoke run, first attempt: three minutes in, the throwaway repo disappeared. The reviewer agent,
cleaning its own scratch, had run `rm -rf /tmp/smoke-build-*`. The driver then crashed writing its
log; its bookkeeping now never crashes it, and live runs use the session scratchpad, not a shared
/tmp glob (tasks/lessons.md).

Live smoke run, second attempt (`scripts/smoke-build.sh`, one real slice, `--no-pr`): **PASS** in 4.5
minutes and $2.44 over 2 sessions (corrected in entry 24: first reported as $4.89, because each stream
log repeats its result line and the script counted both). The slice session ran `dev-build`; its plan carried the backlog's
`S1-AC1` and `S1-AC2` unchanged and added AC1 and AC2, and all four were met. The driver's own checks
passed, and the slice landed. The final session ran `harness-repair` (check, review, QA: no findings) and
wrote its report through the guard's one writable file. modelUsage: opus $1.14 (the orchestrators),
sonnet $0.49, fable $0.81, haiku under $0.01 (corrected in entry 24 from figures double-counted). Fable and Haiku appear only through the agents pinned to them,
so the pins hold inside Workflow agents under the driver's settings (the open item from entry 21).

**Stats.** 10 new tests (388 workflow tests passed, 0 failed), 14 mutations, all caught. 2 validate.sh
rules.

## 23. The headless background-wait ceiling (2026-11-05)

**What changed.** The first stage of the live end-to-end run (PR 6) that ran longer than 10
minutes, the design, was killed: a headless `claude -p` that starts a Workflow and ends its turn
stops "background tasks still running 10m after the last turn", unless
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. Every earlier headless run was shorter (the 16 s probe, the
4.5-minute smoke slice), which hid it; a real `/dev` slice runs an hour or more, so every one would
have died at 10 minutes. The driver now sets the ceiling to 0 in each session's env and settings; its
own 6-hour session timeout stays the outer limit. Entry 18's "a headless `claude -p` runs a Workflow
script to completion" is corrected in place.

**Measured that `=0` lifts it.** The same live run's backlog stage then ran headless for 10 min 40 s
with the ceiling at 0 and returned its ledger. The design rerun finished in 9 min 40 s, so it proved
nothing.

**Stats.** 3 assertions added to an existing test (388 workflow tests passed, 0 failed): the slice
session's env and the final QA session's env, plus the settings. The mutation that drops the setting
is caught.

## 24. The first live end-to-end build: a reading-list CLI (2026-11-05)

**What ran.** A one-sentence request ("a command-line reading list for one person: add a book, list
all, mark one read, list what's left; Node, a local JSON file, no network, no accounts") went through
`/blueprint` (interview, design, backlog, approval) and `/build-app` in a scratch repo, with the pass
conditions written down first (`tasks/todo.md`). The agent stood in for the human: every interview
answer was the recommended option, it kept every assumption, and it gave the one approval. Each
blueprint stage ran in a clean headless session, because the orchestrating session still carried the
old `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` and would have forced every agent onto Sonnet. No GitHub
remote, so `--no-pr`.

| Stage | Wall time | Cost | Result |
|-------|-----------|------|--------|
| Interview | 79 s | $0.61 | 8 questions, 9 assumptions, 3 preflight items |
| Design, first attempt | 10 min | $3.42 | killed by the headless 10-minute ceiling (entry 23) |
| Design | 9 min 40 s | $3.82 | approved in round 2: 5 modules, 14 failure modes, 0 departures, 2 notes |
| Backlog | 10 min 40 s | $5.25 | approved in round 2 (the first gate sent back 3 blocking issues; the re-gate checked only those): 7 slices, 4 knowledge owners |
| Build: 7 slices | 1 h 35 min | $41.74 | every slice landed on its first attempt: 8, 16, 11, 17, 16, 13, and 13 min |
| Final QA | 4 min | $2.16 | `harness-repair` over the whole branch: VERIFY: PASS, no findings, nothing to fix |
| **Total** | **2 h 11 min of stage time** (2 h 14 min elapsed, with the hand-offs between stages) | **$57.00** | |

The build's model spend was opus $6.95 (the orchestrators), sonnet $9.46, fable $27.48, and haiku
$0.03. Fable is the advisor, which gates every plan and confirms every finding; it was 63% of the
build. That makes it the first cost lever to look at.

**Pre-registered conditions: all 7 pass.**
- C1: backlog-ready in 2 slicer rounds, and `BACKLOG: PASS`.
- C2: the approval commit holds exactly write-docs' 3 files.
- C3: the ledger shows all 7 slices done, 0 escalations, 0 re-plans, no brake, and driver exit 0.
- C4: every commit after the approval starts `S<n>: ` (7 of 7), and the 9 frozen test files on the
  final branch equal their content at the commit that froze each one.
- C5: the final QA status is done, with 0 fix rounds.
- C6: fable and haiku appear in modelUsage.
- C7: the app's own suite runs 143 tests, all passing, and `verify` passes. By hand, the CLI adds,
  lists, and marks a book read; it rejects a duplicate with the existing id; marking a book read
  twice succeeds with a note; an unknown id exits 1 and bad usage exits 2; a corrupt file is refused
  and left untouched.

Not exercised live (the fake-`claude` tests cover them): a planted frozen-test edit, a usage-limit
wait, and the push and PR.

**Bugs the live run found.**
- The headless 10-minute background-wait ceiling would have killed every real slice. It is fixed
  in #25 and measured: a 10 min 40 s and a 12 min 51 s headless run both completed with the ceiling
  at 0.
- Each stream log repeats its result line, so summing result lines doubles the cost. The smoke run
  was $2.44, not the $4.89 entry 22 reported (corrected there and on #24), and `smoke-build.sh` now
  counts each session once. The driver now logs each session's cost and keeps a running `costUsd` in
  `status.json`, carried across runs. The fake `claude` repeats its result line the same way, so the
  tests count once.

PR review (#26; 2 MEDIUM, 2 LOW, all fixed):
- A session stopped mid-run was never charged, and one killed before its result line logged a
  misleading `$0.00`. It is now charged before the stop check, and logs "no result line, cost
  unknown"; the README now defines `costUsd` as what the sessions reported.
- The `/blueprint` skill still announced at launch that the backlog had never run live.
- The total time did not add up from the rows: 2 h 11 min of stage time against 2 h 14 min
  elapsed.
- A failed final QA did not name its cost.

## 25. /bughunt, part 1: a read-only bug-discovery graph (2026-11-06)

**Why.** An agent that built features with an unattended loop said, when asked, that it never
reviewed the PRs. The QA graph (`harness-repair`) has one generalist reviewer and one QA auditor,
and nothing in it reproduces a bug before fixing it. `/bughunt` is a dedicated graph for real
functional defects one change introduced. It is planned in five PRs: discovery, then verification
and reproduction, repair, hardening and wiring into `/build-app` and `/loop`, and a live benchmark.

**What changed (PR1: discover mode, read-only).**
- `graphs/hunt/skills/bughunt/intake.mjs` (deterministic):
  - resolves a PR (through `gh pr view`), a branch, or a range to exact commits and the merge-base;
  - parses the diff into files, head-side hunks, and added and removed lines;
  - routes lenses from the change's own lines, never from tests or docs;
  - checks out a detached analysis worktree at the head, so agents never read the user's checkout.
- `bughunt-flow.js` runs the graph:
  - the impact-mapper maps callers, contracts, tests, and the protections the change must keep;
  - one hunter per routed lens runs in parallel; the impact map can add a lens, never remove one;
  - code drops candidates without a trigger, path, observable, and quoted evidence, or under
    confidence 60;
  - code also discards every finding of a hunter that did not return its lens reference's token;
  - findings merge under stable ids.
- `core/skills/findings/findings.mjs` owns the shared rules:
  - the record, with every field the spec lists;
  - ids that survive re-runs: a new head re-verifies a re-found finding and marks the rest stale;
  - the status moves;
  - a computed disposition;
  - metrics against ground truth;
  - a report that keeps confirmed and unverified findings apart, and takes test runs only from
    evidence files.
- `core/skills/bug-lenses` holds the finding bar, the do-not-flag list, the untrusted-content rule,
  and six lens references.

**The research behind it.** I read eight public projects with `gh api`, installed and ran nothing,
and spot-checked the licenses.
- **Adapted, with credit:**
  - paad's trigger, path, and observable rule, and its confidence floor and cap;
  - bug-hunt's blind skeptic and asymmetric dismissal;
  - the code-review plugin's do-not-flag list. It moved to `anthropics/claude-plugins-official`
    (Apache-2.0); its old home in `claude-code` is "All rights reserved";
  - bugbot's coverage ledger and computed disposition;
  - superpowers' root cause before a fix;
  - prove-it's claim freeze.
- **Ideas only, no text:** Trail of Bits, which is CC-BY-SA-4.0.
- **Rejected:** buddhi-review, an app with a licensing call to its own API.
- The credits are in `core/skills/bug-lenses/CREDITS.md`.

**Bugs caught before review.**
- The diff parser read a removed `-- comment` line (SQL) as a file header; headers are now
  recognized only before a file's first hunk.
- Title similarity counted stopwords and plurals, so two lenses describing one bug in different
  words stayed two findings.
- The PR-description fence left a stray `>` when it removed a forged closing tag.

**PR review (#27).** Two independent reviewers: a line-level reviewer and a behavioral QA auditor.
They found 2 HIGH, 5 MEDIUM, and 3 LOW, which overlap to 10 distinct issues. All are fixed and
tested:
- **HIGH:** an escalated run (bad args, a mode not built yet) returned an empty findings list, and
  `save` replaced the ledger's findings with it. The report then said "pass". Now a stopped run
  never replaces anything, the workflow hands back the earlier findings, and a stopped run's
  disposition is manual review.
- **HIGH:** a branch named `_wip` made the key `_wip`, which the ledger rejects. The whole hunt ran,
  then could not be saved.
- **Paths:** they now come from `git diff --name-status -z`. Before, a deleted binary was listed as
  `/dev/null` and treated as code. A filename with a space kept git's trailing tab, so `my notes.md`
  was not recognized as docs. Quoted names kept their backslashes.
- **The base:** a PR target diffed against a stale local `origin/<base>`, which pulled other people's
  merged work into the review. The base is now refreshed first.
- **Merging:** the same generic title far apart in one file merged two different bugs. Equal titles
  now also need the same category and a quoted line in common.
- **Coverage:** `partial` coverage, and a hunter that listed nothing, still allowed "pass".
- **Untrusted text:** the PR title and the impact map's notes reached prompts unfenced.
- **Keys:** `feat/x` and `feat-x` shared one ledger and worktree. Keys now carry a hash of the exact
  name.
- **Errors:** a missing `gh` gave an empty failure reason, and `report` on a missing ledger printed
  "pass".

A second mutation run over the fixes: 14 of 14 caught.

**Mutation run.** 21 mutations across `findings.mjs`, `intake.mjs`, and the workflow. 20 were caught
at first. The survivor was a recall that used the wrong denominator, which the test could not see
because its reported count happened to equal its truth count. A third true bug in the test closes
it; 21 of 21 are caught.

**Stats.**
- 71 new tests: 30 findings, 20 intake (over real throwaway repos), and 21 routing and drift. The
  suite is 460 workflow tests, 0 failed.
- 7 new validate.sh rules.
- 3 new skills, 2 new agents, and 1 workflow.
- Discover mode is tested with mocked agents only; its first live run is part of PR5.

## 26. /bughunt, part 2: adversarial verification and real reproductions (2026-11-06)

**What changed.**
- **The skeptic.** `bughunt-flow` now sends every candidate to a blind skeptic (Sonnet). The skeptic
  sees the frozen claim and its quotes, never the hunter's reasoning, and tries to disprove it:
  - an unreachable path;
  - a guard upstream;
  - a misread callee;
  - the same behavior already at the merge-base;
  - a duplicate of another finding.
- **Routing in code:**
  - **confirmed** needs an execution path;
  - **refuted** needs a refute above 67 on a finding below HIGH, or a named duplicate;
  - **contested** is everything else, including a confident refute of a HIGH finding (one Sonnet
    never drops a blocking bug) and a skeptic that returned nothing.
- **The referee.** The advisor (Fable) referees every contested finding in one batched call, with
  both sides' reasoning. A missing verdict counts as real, because the test settles it next. Fable
  runs only when something is contested (the cost lever from entry 24).
- **Reproduction.** A reproducer (Sonnet) writes a new failing test whose assertion carries
  `BUGHUNT-F<n>`. A runner (Haiku) runs `evidence.mjs repro`, and the graph gates on that script's
  own last line. The runner's command is fixed in code; the reproducer declares only a test path,
  never a command.
- **`evidence.mjs`** is the only code in the graph that executes the change:
  - **Arms:** it runs the test at the head and at the merge-base.
  - **Exports:** each arm runs in a fresh `git archive` export, so the repo is never touched.
  - **Environment:** credentials are stripped, Claude's sign-in included.
  - **Network:** blocked by `unshare -rn`.
  - **Time:** limited under GNU `timeout -s KILL`.
  - **Verdict:** decided from exit codes and the marker. **REPRODUCED** (the head fails with the
    marker; the merge-base passes, or fails without it because the code is new), **PREEXISTING**,
    **NOT_REPRODUCED**, or **ERROR**.
- **The session reruns everything.** The `/bughunt` session reruns every reproduction itself
  (`evidence.mjs recheck`), and `findings.mjs reconcile` corrects the ledger to the runs, so a
  runner's transcription is never the final word. `test_results` come only from those runs.

**Measured, not assumed.**
- `unshare -rn` blocks the network on this WSL2 box (`EAI_AGAIN`), and the tests check it.
- Killing only the test runner at a timeout left `node --test`'s child spinning forever. I found the
  orphan with `ps` after the first green run. GNU `timeout -s KILL` signals the whole process group:
  2 s, no orphans. A test now asserts that no test process outlives the timeout.

**Bugs caught before review.**
- The orphaned test process above.
- `mergeFindings` copied each finding but shared its `history` array with the input, so a status
  move in the workflow also wrote into the caller's objects.

**PR review (#28).** Two independent reviewers: a line-level reviewer and a behavioral QA auditor,
both reproducing in throwaway repos. They found 5 HIGH, 7 MEDIUM, and 4 LOW, which overlap to 16
distinct issues. All are fixed and tested:
- **Recheck:** a claimed `reproduced` with no `repro.json` was never re-run, so a fabricated runner
  line survived. Now a claimed run with no written reproduction falls back to confirmed.
- **Crashes:** one throw in a run (a PR file where the test's directory should be) aborted the whole
  recheck before anything was written. Each run is now caught, and recheck writes the ledger after
  each finding.
- **Failures counted against the finding:** a missing runner (no pytest, no go) or a test failing
  without its marker became `NOT_REPRODUCED`, which demoted real bugs. Now only a test that passes at
  the head is `NOT_REPRODUCED`; the rest is ERROR, which keeps static evidence. Missing tools are
  probed, and exit 126 or 127 means the runner never started.
- **Network:** loopback was down inside `unshare -rn`, so any local-server test failed. It is now
  brought up inside a fresh PID namespace (measured: 200 inside, `ENETUNREACH` without).
- **Processes:** a detached grandchild survived every run. The namespace now kills it on exit
  (measured: 0 left versus 1 without), and output goes to a file, not a pipe.
- **Symlinks:** a symlink the PR commits in the test's path made `evidence.mjs` itself write outside
  the state dir. Every part of the path is now checked in the export.
- **Flags:** a test path starting with `-` reached the runner as a flag (`--import=...`).
- **Quoting:** paths with spaces broke every evidence command an agent was told to run. They are now
  single-quoted, and a shell test proves the split.
- **Stale state:** reproductions, test results, and fixes from an old head carried over to a
  re-found finding, and the report showed old-head runs. A new head now clears them, and the report
  shows only runs from this head and this finding's own test.
- **Environment:** the deny-list missed `DATABASE_URL`, `SENTRY_DSN`, `STRIPE_KEY`, `KUBECONFIG`, and
  others. It is now an allowlist.
- **Duplicates:** a duplicate verdict could refute a HIGH finding into a twin that was later refuted,
  or keep the lower severity. It now folds only into a confirmed twin, which keeps the higher rating.
- **The referee:** its "not introduced" view skipped the reproduction. Only the test decides now.
- **Re-runs:** a finding left contested by a failed referee was never refereed again.
- **Unfenced text:** the confirmation notes reached the reproducer unfenced.
- **Monorepos:** the runner read only the root `package.json`. It now uses the test's nearest
  package.
- **Report wording:** it said "not attempted" for an attempted reproduction.

A third mutation run over the fixes: 17 of 17 caught, after one more test that forces a throw inside
a run.

A focused re-review of the fix commit confirmed seven of its eight fixes and found one new HIGH,
which it reproduced. The pytest probe added for the missing-tool fix ran
`python3 -c 'import pytest'` inside the export, with the full environment and no sandbox. A PR that
committed its own `pytest.py` therefore had that file executed with the real credentials, outside
every isolation the run itself had. Probes now run from an empty temp directory, in Python's
isolated mode (`-I`), with the sandbox environment and a 20-second limit. A test commits a trap
`pytest.py` and checks the secret never reaches it; with the old probe back, that test fails.

My own mistake while running it: a cleanup step's `pkill -f <name>` matched the shell that carried
that name in its command line and killed it. That orphaned one mutation run, which then raced a
second one and left three mutations in `evidence.mjs`. A site-by-site check found all three, and I
restored them before any commit (tasks/lessons.md).

**Mutation run.** 26 mutations across the workflow's routing, `evidence.mjs`'s verdicts, guards, and
sandbox, and `reconcile`; 24 were caught at first. The two survivors were real test gaps:
- Every token in the sandbox test was also caught by a prefix rule, so dropping `TOKEN` from the
  pattern went unseen. `SLACK_BOT_TOKEN` closes it.
- The reconcile test's findings had no claimed test results to overwrite.

26 of 26 are caught now.

**Stats.**
- 46 new tests:
  - 24 evidence tests that run real `node --test` processes in throwaway repos (every verdict, a
    timeout, bad paths, symlinks, a modified tree, a forced throw, secrets, the network, loopback,
    no orphans, the repo untouched, recheck);
  - 19 routing tests;
  - 3 reconcile and report tests.
- The suite is 506 workflow tests, 0 failed.
- 3 new agents, 6 new validate.sh rules, and an advisor section.
- The workflow test harness gained a real `pipeline()`.

## 27. /bughunt, part 3: proven repairs and independent fix verification (2026-11-06)

**What changed.** `/bughunt --propose` and `--fix` share the graph with discover mode and add a
repair stage. Each reproduced finding (plus any the human names with `--approve`) is repaired in
`<state>/fix`, one at a time, most severe first. That worktree is a separate checkout: detached for
propose, branch `bughunt/<key>` for fix. The skill makes it and never removes it.
- **The repairer** (Sonnet) investigates the root cause first, then makes the smallest change. It
  never touches the reproduction test, never edits or deletes an existing test, and never commits.
- **`evidence.mjs fix`** proves the repair:
  - **Scope:** it rejects an empty change, an edited existing or reproduction test, and more than 8
    source files.
  - **Three arms:** the reproduction passes on a copy of the worktree, and fails with its marker at
    the worktree's last commit. A test that passes both ways cannot tell a fix from no fix.
  - **The suite:** the repo's own suite (the verify skill) must be no worse than without the repair.
  - **On PASS,** the reproduction joins the change, and the worktree state is fingerprinted.
- **Propose mode** commits there; the fix stays `proposed` because no one independent reviewed it.
- **Fix mode** adds the verifier:
  - an independent fix verifier (Sonnet, never shown the repairer's reasoning) reviews the change
    and writes up to 5 adversarial tests;
  - `evidence.mjs adversarial` runs them against the fingerprinted state;
  - only an accept plus a PASS lets `evidence.mjs commit` commit it, and it is marked `verified`.
- **Failed attempts.** A failed attempt is reverted, and the next one gets the reasons as fenced
  feedback. After `maxRepairAttempts` (default 2) the finding is `unresolved`. A fix check that
  cannot run stops all repair.
- **Recheck.** It re-proves every committed repair from its commit (passes there, fails at its
  parent), and `findings.mjs reconcileFix` takes back one that does not hold.

**Bugs caught before review.** The mutation run turned up one real test gap: no test had a
reproduction that already passes without the repair, so dropping the discrimination check went
unseen. A test now covers it. 22 of 22 mutations are caught, across the repair guards in
`evidence.mjs` and the repair routing.

**PR review (#29).** Two independent reviewers, a line-level reviewer and a behavioral QA auditor,
reproduced every finding in throwaway repos. They found 5 HIGH, 11 MEDIUM, and 2 LOW, which overlap
to 15 distinct issues. All are fixed and tested.
- **HIGH: a redirected `.git` reached the user's branch.** A repairer could point the fix worktree's
  `.git` file at the repo itself, so `commit` and `revert` acted on the user's branch and index. The
  worktree is now checked as a real linked worktree inside the repo's `worktrees/`.
- **HIGH: a PR hook ran unsandboxed.** `commit` ran the PR's `post-commit` hook (a relative
  `core.hooksPath`) with the full environment, and a committed fsmonitor script ran on `git status`.
  Every git call in intake and evidence now disables hooks and fsmonitor, and commits use plumbing.
- **HIGH: a verified fix outlived its branch and closed the finding.** It was trusted after the
  branch was deleted, and the disposition read "pass" while the PR still had the bug. Recheck now
  requires a kept branch, and a verified fix no longer closes the finding.
- **HIGH: the runner's Bash default (2 minutes) was shorter than a fix check.** Agents are now told
  to use the 10-minute limit, and the check has a 9-minute wall-clock budget. A suite that cannot fit
  is BLOCKED, not a silent failure.
- **HIGH: a rename slipped past the test guard.** A staged rename deleted an existing test unseen.
  Status now runs with `--no-renames`.
- **The suite could be neutered.** Changing `package.json`'s test script to `true` passed a broken
  repair. Suite-defining files are now protected like tests.
- **Ignored files, modes, and symlinks.** A fix hidden in a git-ignored file passed the check but
  was not committed, and the fingerprint missed modes and symlink targets. The check, the
  fingerprint, and the commit now all use one staged git tree.
- **The reproduction failed open.** An unreadable reproduction became a suite-only check. It is now
  BLOCKED.
- **`--approve` could never succeed** on a not-reproduced finding.
- **A red base suite masked regressions,** and a repair was still committed. It is now BLOCKED.
- **Shared test paths.** Two findings with one test path overwrote the first fix's regression test.
  It is now BLOCKED.
- **Smaller ones:** stale adversarial tests judged later attempts; a revert's failure was ignored;
  an accept was counted even when the verifier's own fields disagreed; unresolved findings could
  never be retried.

A mutation run over the fixes caught 18 of 18, including removing the hook and fsmonitor flags (a
trap test catches each). The fixes added 12 tests, for 549 workflow tests and 0 failed.

**Stats.**
- 31 new tests (537 workflow tests, 0 failed):
  - 17 repair tests that run real `npm test` suites through the verify skill in a throwaway project
    (a non-fix, edited tests, a suite broken by the repair, a correct fix, adversarial passes and
    failures, a worktree changed after the check, commit, revert, a suite that already failed, and
    a recheck that keeps one fix and takes back another);
  - 12 routing tests (propose versus fix, a rejection then a success, attempts used up, a check
    that cannot run, the adversarial gate, a missing verifier, approvals, re-runs, the exact
    commands);
  - 2 findings tests.
- 2 new agents, 6 new or updated validate.sh rules.
