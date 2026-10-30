# Dev graph (`dev-build`)

Takes a task, plans it, builds it with tests, proves each acceptance criterion,
then hands the branch to the [QA graph](../qa/README.md) as a child workflow.
Entry point: the `/dev` skill. `/loop` stays the maintenance loop for branches
that already exist.

Status: **built**. Routing is tested with mocked agents (`tests/dev-build.test.mjs`), and one live run
on a fixture finished `done` (see the root `retro.md`, entry 5).

## Graph

Code routes; agents are leaves and never call each other.

```
planner --> advisor(plan gate) --revise (max 2)--> planner
                               --revise at the cap, all issues blocking:false--> planner (final, structure-checked, not gated) --> approved
                               --revise at the cap, any blocking issue--> escalate
                               --blocked--> needs-human (questions)
                               --approve--> plan-ready      (approval: human, the workflow default; /dev --review)
                                        --> build          (approval: advisor, /dev's default; or args.plan given and approved)
build:   scouts (all components, in parallel, read-only)
         for each component in build order:
           implementer --> checker --FAIL--> implementer (one retry, gets the failure) --> checker --FAIL--> escalate (resumable)
accept:  acceptance-auditor --UNMET--> implementer (one rework round) --> checker --> acceptance-auditor --UNMET--> escalate
handoff: workflow('harness-repair', {repo, base, maxFixRounds, knownStuckSigs})   check, fix, review, QA, advisor; its ledger is returned as qa
```

Fix rounds, stuck signatures, and advisor-unstick live only in the QA graph.
Workflow scripts cannot import each other, so the dev graph does not copy that
loop: a component that fails verify twice escalates, and everything after the
build is repaired by the QA graph it calls.

## Roles

| Role               | Who                            | Model  | Effort | Called                                  |
|--------------------|--------------------------------|--------|--------|-----------------------------------------|
| Orchestrator       | the `/dev` session             | opus   | high   | once per task; branches, commits        |
| Advisor            | `core/agents/advisor.md`       | fable  | high   | plan gate (and QA's decision points)    |
| Planner            | `agents/planner.md`            | sonnet | high   | until approved (max 3, +1 final if all issues are non-blocking) |
| Scout              | `agents/scout.md`              | sonnet | high   | once per component, in parallel         |
| Implementer        | `agents/implementer.md`        | sonnet | high   | once per component, plus retries        |
| Checker            | `core/agents/checker.md`       | haiku  | high   | after every implementer run             |
| Acceptance auditor | `agents/acceptance-auditor.md` | sonnet | high   | after the build, and after a rework     |

`advisor` and `checker` move to `core/agents/` because both graphs use them.

## Contracts

All routing reads schemas, never prose.

**args:** `repo` (absolute, required), `task` (required unless `plan`), `base`,
`approval` (`human` default | `advisor`), `plan` + `planApproved` (skip
planning), `completed` (component ids already built; resume skips them),
`maxFixRounds` and `knownStuckSigs` (passed through to the QA child).

**plan** (planner output, gated by the advisor):
- `acceptance[]`: `{id: "AC1", criterion, protects, fails_when, no_claim}`.
  Numbered, pass/fail, no subjective language ("edge cases are handled" is rejected).
- `components[]` in build order: `{id: "C1", title, files[], depends_on[], tests[]}`.
  Self-contained, non-overlapping, together exhaustive; shared dependencies first, glue last.
- `behavior_changes[]`, `out_of_scope[]`, `risks[]` (`{risk, mitigation}`).
- Complexity gate: more than 8 files or 2+ new services → the advisor sends it
  back to be split or justified.

**plan gate** (advisor): `{verdict: approve|revise|blocked, issues[] {n, issue, fix, blocking}, questions[]}`.
A missing or non-boolean `blocking` counts as blocking.

**scout brief** per component: `{reuse[] (file:line + what), must_preserve[], interfaces[], edge_cases[], test_patterns}`.

**implementer report:** `{done, touched[], tests_added[] {file, name, protects, fails_when}, test_changes[], verify_verdict, unchecked[]}`.
`test_changes` lists any change to a test, timeout, threshold, snapshot, or
suppression, first and with its reason. `verify_verdict` is a claim: the gate is
the checker's VERIFY line, never the implementer's own run.

**acceptance:** per criterion `{id, status: MET|UNMET, evidence}`, where
evidence is a passing test at `file:line` that asserts the criterion; plus
`behavior_changes_missing[]` (a change the code makes that the plan never listed).

**ledger:** `status` (`plan-ready` | `needs-human` | `escalate` | `done`),
`reason`, `plan`, `planApproved` (approved for the build; `/dev` saves it for `--resume`),
`planSettled` (the final revision closed non-blocking issues ungated), `completed[]`, per-component results, `acceptance`, `touched`,
`qa` (the QA child's ledger), and the child's `stuckSig`, so `/loop`'s
cross-iteration stuck detection keeps working for dev-started QA runs.

## The implementer's rules

- Test first. Every test passes the value bar (what it protects, what
  regression fails it, why existing coverage misses it, no test-only seams) and
  the regression proof (fails before the change, passes after).
- Real code and real tests in the same change; a stub or a deferred test is not done.
- Read before writing: every function it calls, by its signature, not from memory.
- Minimal scope: anything outside the component goes in `unchecked`, not in the diff.
- Never commit. Never loosen a test, timeout, or threshold to get green.

## `/dev` (orchestrator skill)

Unattended by default: questions come before any code exists (dirty tree,
`needs-human`), and every later stop is a report, never a question.

1. Branch: if on the default branch, create `dev/<slug>`. Detect the base.
2. Run `dev-build` with `approval: advisor`. With `/dev --review`, it stops at
   `plan-ready`: show the acceptance criteria and components, ask for approval
   or edits, save the plan to `$(git rev-parse --git-path harness-dev)/plan.json`,
   and re-run with it.
3. On `done`: run `/verify` itself, then commit. One commit per component when
   their touched files do not overlap, otherwise one commit listing them.
4. On `needs-human`: ask the advisor's questions once, then re-plan with the answers.
5. On `escalate`: report what is blocked and how to resume (`/dev --resume`
   re-runs with the saved plan and `completed`).

## Changes to the QA graph

- `harness-review` has a "Duplicated rules" check, from `dry`: copied logic
  that enforces a rule (auth, validation, billing, limits) drifts. HIGH when the
  copies already differ or sit on a security or money path, MEDIUM otherwise.
  Repetition with independent reasons to change is not a finding.

## Files

- `workflows/dev-build.js`: the graph. Helpers marked `// shared` are copied
  verbatim from the QA graph's script, and a test fails if they drift.
- `agents/`: planner, scout, implementer, acceptance-auditor.
- `skills/dev/SKILL.md`: the `/dev` orchestrator.
- `tests/dev-build.test.mjs`: routing tests, run by `scripts/test-workflow.sh`.

## Credits

Several implementer and planner rules are adapted from
[gstack](https://github.com/garrytan/gstack) (MIT, © Garry Tan): the
implementing-agent rules and acceptance-criteria form (`spec`), the test value
bar and regression proof (`test-audit`), the complexity gate (`plan-eng-review`),
and the stop rules (`investigate`).
