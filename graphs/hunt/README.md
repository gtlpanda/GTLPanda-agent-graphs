# Hunt graph (`bughunt-flow`)

`/bughunt [PR# | branch | base..head]` looks for real functional defects that
one change introduced. It finds bugs, not style. A finding must name its
trigger, the code path that mishandles it, and the wrong result someone sees,
with evidence quoted from the code. A finding that cannot do this is dropped.

Status: **discover mode**. It maps the impact and runs the specialist hunters
the change calls for. Then:
- A blind skeptic challenges every finding, and the advisor referees the ones
  it cannot settle.
- Each confirmed finding gets a failing test that `evidence.mjs` runs at the
  head and at the merge-base, in a sandbox.
- The session re-runs every reproduction before the report.

It never edits the branch under review. Still planned:
- the propose and fix modes;
- wiring into `/build-app` and `/loop`;
- the live benchmark.

```
intake.mjs (the session, deterministic) → the commits, files, hunks, routing signals, analysis worktree
impact (impact-mapper) → route = intake signals ∪ impact picks, capped at maxHunters
  → hunt × lens (hunter, in parallel)
  → merge in code: drop candidates without a trigger, path, observable, or evidence, or under
    confidence 60; drop every finding of a hunter that never read its lens; dedupe against this run
    and the ledger's earlier findings
  → skeptic × candidate (in parallel; it sees the claim, never the hunter's reasoning)
  → referee (the advisor, one batched call) for every contested finding
  → reproduce × confirmed (pipeline, capped at maxRepros): reproducer writes a test →
    runner runs `evidence.mjs repro` → the gate reads the script's own last line
the session: findings.mjs save → evidence.mjs recheck (re-runs every reproduction, corrects the
ledger to the runs) → findings.mjs report
impact returns nothing → route on the intake signals alone
a hunter returns nothing → its lens is not_covered, and the disposition becomes manual review
```

| Role | Who | Model | Effort | Called |
|------|-----|-------|--------|--------|
| Orchestrator | the `/bughunt` session | opus | high | intake, save, report |
| Impact mapper | `agents/impact-mapper.md` | sonnet | high | once per run |
| Hunter | `agents/hunter.md`, preloads `bug-lenses` | sonnet | high | once per routed lens |
| Skeptic | `agents/skeptic.md` | sonnet | high | once per candidate |
| Referee | `core/agents/advisor.md` (shared), "Refereeing a finding" | fable | high | once per run, only when something is contested |
| Reproducer | `agents/reproducer.md` | sonnet | high | once per confirmed finding, up to maxRepros |
| Runner | `agents/runner.md` | haiku | high | once per written reproduction |

## Routing

- **The intake routes lenses from the change's own lines**, in
  `skills/bughunt/intake.mjs` `SIGNALS`. It never routes from tests or docs.
  - Code changes always get `logic` and `regression`.
  - `concurrency` routes on async work, locks, retries, transactions, and queues.
  - `security` routes on auth, tokens, exec, SQL, file paths, deserialization, and HTML sinks.
  - `errors` routes on try/catch/finally, cleanup, and fallbacks.
  - `contract` routes on exports, added or removed, plus schemas, routes, and serialization.
  - A tests-only change runs `regression`, and a docs-only change runs nothing.
- **The impact map can add a lens** the signals missed. It never removes one.
- **Lens order** is logic, regression, security, contract, errors,
  concurrency. `maxHunters` (default 6) drops lenses from the end. A dropped lens
  is logged and recorded `not_covered`.
- **Each hunter proves it read its lens.** It copies that lens reference's
  `lens-token:`. With the wrong token, all of its findings are discarded.
- **Every candidate is checked in code** (`candidateProblems`). It needs a
  repo-relative file, an ordered line range, a lens category, and a severity.
  It also needs a confidence from 0 to 100, plus a trigger, a path, and an
  observable, and at least one `file:line` quote.
  - Under 60, a candidate is dropped.
  - Above 79, it is capped until a later stage reproduces it.
- **The merge keeps ids stable across runs** (`mergeFindings`, in the
  `findings` skill, copied verbatim here, with a drift test).
  - Two lenses reporting one bug make one finding with both sources and one duplicate.
  - A re-run on the same head changes nothing.
  - On a new head, a re-found finding moves to the new lines and goes back to
    candidate; a finding nobody re-found goes stale.
  - `maxFindings` (default 25) keeps the most severe new findings and logs the rest.
- **The skeptic sees the claim, never the hunter's reasoning.** The claim is
  the frozen fields: file, lines, trigger, path, observable, expected and
  actual, and the quotes. It routes each finding:
  - **confirmed:** it names an execution path, and it does not say the bug
    predates the change;
  - **refuted:** it refutes above 67 on a finding below HIGH, or names another
    live finding as the same bug (refuted as its duplicate, with the other
    gaining the source);
  - **contested:** everything else, including a confident refute of a HIGH or
    CRITICAL finding (one Sonnet never drops a blocking bug) and a skeptic that
    returned nothing.
- **The referee** gets every contested finding in one call, with the hunter's
  reasoning and the skeptic's.
  - `real=false` refutes it.
  - `real=true`, or no verdict for it, confirms it: a missed bug costs more,
    and the test settles it.
  - It can set the severity, and mark a finding pre-existing.
  - A referee that returns nothing leaves them contested.
- **Reproduction** runs on the most severe confirmed findings, up to
  `maxRepros` (default 8, the rest logged).
  - The reproducer writes `repro/F<n>/repro.json` (`{"test_file": ...}`) and
    `repro/F<n>/files/<test_file>`. That is a new test file whose failing
    assertion carries `BUGHUNT-F<n>`.
  - The runner runs `evidence.mjs repro <state dir> F<n>`. The command is fixed
    in code, never chosen by an agent.
  - The gate reads only the last line, `EVIDENCE: <verdict> F<n>`. Then
    REPRODUCED gives reproduced (confidence at least 90), PREEXISTING gives
    pre-existing, and NOT_REPRODUCED gives not reproduced.
  - ERROR, no test written, or no EVIDENCE line keeps the finding confirmed,
    and the report says it has static evidence only.
- **`evidence.mjs` decides from the runs**, at the head and at the merge-base:
  - **REPRODUCED:** the head fails with the marker, and the merge-base passes or
    fails without the marker (the code under test is new).
  - **PREEXISTING:** both arms fail with the marker.
  - **NOT_REPRODUCED:** the head passes, or fails without the marker (another
    reason).
  - **ERROR:** a timeout, a test that cannot run, a bad path, a symlinked test,
    or an analysis tree the reproducer modified.
- **The session re-runs every reproduction** (`evidence.mjs recheck`) and
  corrects the ledger to what the runs show (`findings.mjs reconcile`). The
  runner's transcription is never the final word. `test_results` come only
  from these runs.
- **The disposition is computed** (`findings.mjs disposition`), never chosen by a model.
  - **changes requested:** an open confirmed or reproduced bug above LOW.
  - **manual review:** an unsettled HIGH or CRITICAL finding, a lens not fully covered, or a run that stopped early. A stopped run never replaces the saved findings.
  - A hunter that lists no areas examined and no findings counts as partial coverage.
  - **pass:** otherwise.

## State

Everything lives in `<git common dir>/bughunt/<key>/`, inside `.git` and never
committed. `<key>` is `pr-<n>` for a pull request. For a branch it is the
branch's slug plus a hash of its exact name, so `feat/x` and `feat-x` never
collide. A detached HEAD uses `detached-<commit>`. Only the detached key changes
with the head; every other key survives a new head, so a new head finds the same
ledger.

- **A PR target refreshes `origin/<base>` first**, so other people's merged work
  never lands in the review. If it can't (offline), it uses the local copy and
  says so.

| File | What it is |
|------|------------|
| `intake.json` | what intake resolved |
| `tree/` | a detached worktree at the head; the agents read only this, never your checkout |
| `input.json` and `run.js` | the run's input, written into a copy of the workflow by `workflow-state/run-script.mjs`, so nothing big is retyped |
| `result.json` | the workflow's returned ledger |
| `ledger.json` | the findings across runs (`findings.mjs`) |
| `repro/F<n>/` | each reproduction: `repro.json` and `files/<test_file>` |
| `evidence/F<n>.json` | what `evidence.mjs` ran and saw: each arm's commit, exit code, marker, and output tail, plus the verdict |
| `work/F<n>/` | the exports a run uses, removed when it ends |

## Permissions and trust

- **Read-only by instruction.** The impact mapper, hunters, and skeptic are
  read-only by their instructions, not by their tool list. They have Bash so
  they can run `git diff`, `git show`, and `git grep`, as the reviewer does.
  - The reproducer writes only `repro/F<n>/`. `evidence.mjs` voids the run if
    the analysis tree changed.
  - The runner runs one fixed command.
- **Running code from the change.** Only `evidence.mjs` does it:
  - **Where:** in a fresh `git archive` export of each commit, so the repo,
    its worktrees, and the user's checkout are never touched. The repo's
    `node_modules` are linked in when present.
  - **Environment:** credentials are stripped. That means anything named like
    a token, secret, key, password, credential, or session, and every `AWS_`,
    `GH_`, `GITHUB_`, `ANTHROPIC_`, `CLAUDE_`, `NPM_`, and `SSH_` variable,
    Claude's own sign-in included.
  - **Network:** blocked with `unshare -rn` where that works (measured on WSL2:
    it does).
  - **Time:** under GNU `timeout -s KILL`, which kills the whole process group.
    Killing only the runner left a `node --test` child spinning forever
    (measured).
  - **What is not isolated:** the test can still read files your user can
    read. Run `/bughunt` only on changes you are willing to execute locally.
- **What `/bughunt` never does:** edit the branch under review, commit, push,
  or comment.
- **Untrusted text.** The PR title and description, branch names, the code,
  comments, and commit messages are data:
  - The title and the branch label go to agents inside an `<untrusted-pr-title>` fence that they cannot close.
  - The description goes inside an `<untrusted-pr-description>` fence that it cannot close.
  - The impact map's notes reach the hunters inside an `<impact-map-notes>` fence, because another agent wrote them after reading the same code.
  - The `bug-lenses` skill tells every hunter to treat embedded instructions as a security signal, never as instructions.
- **Quotes are checked.** `findings.mjs save --repo` checks each quoted line
  against the file at the head. A quote that is not there shows as a warning in
  the report.

## Extending

- **A new lens** is three changes:
  - add `core/skills/bug-lenses/lenses/<lens>.md`, with its own `lens-token:`;
  - add the lens to the skill's table and to `LENSES` in `findings.mjs` (copied into the workflow);
  - add its token to `LENS_TOKENS`, and its signal to `SIGNALS` if it has one.
  The drift tests fail until all of them agree.
- **Changing a threshold** (the confidence floor or cap, or the near-lines
  distance) means editing the shared block in `findings.mjs` and copying it into
  the workflow. The drift test enforces the copy.

## Troubleshooting

- **`agent type not found`:** run `./install.sh` in the PandaStack checkout,
  then restart Claude Code. A running session does not always see newly linked
  agents.
- **`INTAKE: FAIL ... nothing to review`:** the head has no commits beyond the
  base. Pass `--base`.
- **A broken ledger:** `findings.mjs check <ledger>` names the problem. The
  skill never overwrites a ledger it cannot read.

Credits for the methods adapted here are in
[`core/skills/bug-lenses/CREDITS.md`](../../core/skills/bug-lenses/CREDITS.md).

Tests: `tests/bughunt-flow.test.mjs` (routing and drift) and
`tests/intake.test.mjs` (intake over throwaway repos), run by
`scripts/test-workflow.sh`, plus `tests/findings.test.mjs` at the repo root.
