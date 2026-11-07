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

`--propose` and `--fix` then repair each reproduced bug in an isolated
worktree, one at a time:
- A repair is kept only when the reproduction passes with it, fails without
  it, and the repo's suite is no worse.
- `--fix` also has an independent verifier review it and write adversarial
  tests that must pass.

No mode ever touches the branch under review, merges, or pushes. Still planned:
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
  → mode propose | fix: per reproduced (or --approve'd) finding, most severe first, in <state>/fix:
    repairer → runner: evidence.mjs fix (three-arm + suite) → FAIL: revert, feedback, retry
      propose: PASS → evidence.mjs commit → proposed
      fix:     PASS → fix-verifier (blind) → runner: evidence.mjs adversarial
               accept + PASS → evidence.mjs commit → verified; else revert, feedback, retry
    attempts used up (maxRepairAttempts, default 2) → revert → unresolved
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
| Runner | `agents/runner.md` | haiku | high | once per written reproduction, and per repair command |
| Repairer | `agents/repairer.md` | sonnet | high | per repair attempt (propose, fix) |
| Fix verifier | `agents/fix-verifier.md` | sonnet | high | per repair that passed its check (fix only) |

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
    finding as the same bug and that twin ends up confirmed. Then it is folded
    in as a duplicate: the twin gains its source and keeps the more severe
    rating. A twin that is itself refuted takes nothing with it;
  - **contested:** everything else, including a confident refute of a HIGH or
    CRITICAL finding (one Sonnet never drops a blocking bug) and a skeptic that
    returned nothing.
- **The referee** gets every contested finding in one call, with the hunter's
  reasoning and the skeptic's.
  - `real=false` refutes it.
  - `real=true`, or no verdict for it, confirms it: a missed bug costs more,
    and the test settles it.
  - It can set the severity. Its view on whether the change introduced the bug
    is recorded, but only the reproduction can make a finding pre-existing.
  - A referee that returns nothing leaves them contested, and the next run on
    the same head referees them again.
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
  - **NOT_REPRODUCED:** the test passes at the head. That is the only way to
    get it.
  - **ERROR:** no evidence either way. That covers a failure without the
    marker, a missing tool (pytest, go, jest, vitest), a runner that cannot
    start, a timeout, a bad path, a symlink or file in the test's path, or an
    analysis tree the reproducer modified. An ERROR leaves the finding confirmed
    with static evidence only, never demoted.
- **The session re-runs every reproduction** (`evidence.mjs recheck`) and
  corrects the ledger to what the runs show (`findings.mjs reconcile`), writing
  it after each finding.
  - The runner's transcription is never the final word.
  - A claimed run with no written reproduction falls back to confirmed.
  - `test_results` come only from these runs.
  - The report shows a run only when it came from this head and from the test
    that finding's reproduction declared.
- **A new head clears what belonged to the old one.** A re-found finding loses
  its reproduction, test results, and fix, and drops back under the confidence
  cap.
- **Repair (propose, fix)** runs one finding at a time, most severe first, all
  in `<state>/fix`.
  - **Which findings:** only `reproduced` ones, plus confirmed ones the human
    names with `--approve`.
  - **The repairer** must find the root cause before changing anything. It
    makes the smallest change, never touches the reproduction test, never
    edits or deletes an existing test, and never commits.
  - **`evidence.mjs fix` stages the repair first.** It builds a git tree in a
    private index: HEAD plus every change, ignored files left out, modes and
    symlink targets kept. Every arm runs on an export of that tree, the tree is
    the fingerprint, and commit commits that tree. What is checked is what is
    committed.
  - **It FAILs a repair** (feedback, then retry) that:
    - changed nothing;
    - edits or deletes an existing test (renames count as delete plus add);
    - edits a file that defines what the suite runs (`package.json`, test
      configs, `conftest.py`, snapshots, `Makefile`, and similar);
    - edits the reproduction;
    - changes more than 8 source files;
    - leaves the reproduction failing, or passing without it (it cannot tell a
      fix from no fix);
    - leaves the suite failing where it passed without the repair.
  - **It BLOCKs a repair** (no retry; the finding is unresolved for a human)
    when no attempt could pass as things stand:
    - the suite already fails without the repair, so a regression inside it
      cannot be told apart;
    - an earlier fix already committed a test at the reproduction's path;
    - the reproduction that proved the finding is unreadable (it fails closed,
      never into a suite-only check);
    - the suite does not fit the time the check allows.
  - **A 9-minute budget.** One `fix` call has 9 minutes of wall clock in all,
    because the runner agent's Bash call allows 10. A repo whose suite takes
    longer than about 4 minutes cannot be repaired by `/bughunt`; the finding is
    BLOCKED and says why.
  - **On PASS,** the reproduction test joins the change.
  - **Propose mode** commits after the fix check. The fix stays `proposed`,
    because nobody independent reviewed it.
  - **Fix mode** goes on:
    - the fix verifier reviews the change without the repairer's reasoning (is
      the root cause gone, are callers intact, any unrelated change, any new
      boundary failure) and writes up to 5 adversarial tests;
    - `evidence.mjs adversarial` runs them against the checked state;
    - only an accept plus a PASS commits the repair and marks it `verified`.
  - **The verifier's accept must agree with its own checks.** It counts only
    when the verifier also says the root cause is addressed, callers are
    preserved, and nothing unrelated changed.
  - **A failed attempt is reverted** (`evidence.mjs revert`, ignored files
    included). The next attempt gets the reasons as fenced feedback. A revert
    that fails stops all repair, so nothing unchecked is swept into a later
    commit. When attempts run out, the finding is `unresolved` with the last
    reason, and a later run tries it again.
  - **A fix check that cannot run** (no worktree) stops all repair.
  - **A verified fix does not close the finding.** It sits on the fix branch,
    not in the PR, so the disposition still counts the bug until someone merges
    the fix.
  - **Commits only what was checked.** `evidence.mjs commit` re-stages the
    tree and refuses one that differs from the checked tree, so an agent cannot
    slip a change in. It commits with plumbing (`commit-tree`, `update-ref`), so
    no hook runs.
  - **Rechecked from the commit.** `recheck` re-proves each committed repair
    from its commit. The commit must still be on the fix worktree or its
    branch, the reproduction must pass at it, and the reproduction must fail at
    its parent. One that does not hold goes back to `rejected`.
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
| `fix/` | the fix worktree (propose, fix): detached in propose mode, branch `bughunt/<key>` in fix mode. Made by `/bughunt`, never removed by it |
| `repro/F<n>/adversarial/` | the fix verifier's adversarial tests: `adversarial.json` and `files/` |

## Permissions and trust

- **Read-only by instruction.** The impact mapper, hunters, and skeptic are
  read-only by their instructions, not by their tool list. They have Bash so
  they can run `git diff`, `git show`, and `git grep`, as the reviewer does.
  - The reproducer writes only `repro/F<n>/`. `evidence.mjs` voids the run if
    the analysis tree changed.
  - The runner runs one fixed command.
  - The repairer writes only the fix worktree, and never commits.
  - The fix verifier writes only its adversarial directory. The worktree is
    fingerprinted, and a change voids the check.
  - Every commit is `evidence.mjs commit`, in the fix worktree, of the checked
    tree.
  - The fix worktree is checked every time:
    - `<state>/fix` must be a real directory, not a symlink;
    - its `.git` must be a plain linked-worktree file pointing into this repo's
      `worktrees/`;
    - git's own record of which worktree owns that admin directory
      (`<admin>/gitdir`) must name this exact `.git`.

    A `.git` redirected at the repo, or at the user's own worktree, or a fix dir
    symlinked to it, once let commit and revert act on the user's branch and
    files (found in review, twice).
  - **The guards judge the staged tree, never `git status`.** Skip-worktree
    flags once hid edits from status that the commit would have kept.
  - **Every export uses a private index and `checkout-index`, never
    `git archive`.** Archive honors a tree's own `export-ignore`, which once hid
    a broken test from the check while the commit kept it.
  - **`revert` rebuilds the index from HEAD** and restores every file. It
    removes untracked and ignored files and nested repos (`clean -ffdqx`), and
    says DONE only once the worktree stages to exactly HEAD's tree.
- **No git call runs the PR's hooks or fsmonitor.** Every git call in `intake`
  and `evidence.mjs` runs with `core.hooksPath=/dev/null` and
  `core.fsmonitor=false`. Both are settings a repo may give with a relative
  path, which resolves inside the checkout: the PR's own code.
  - Measured: `git status` in a worktree of the PR ran a committed fsmonitor
    script, and a post-commit hook the PR committed ran on commit with the full
    environment.
  - Git calls inside the fix worktree also get the sandbox environment.
- **Running code from the change.** Only `evidence.mjs` does it:
  - **Where:** in a fresh `git archive` export of each commit, so the repo,
    its worktrees, and the user's checkout are never touched. The repo's
    `node_modules` are linked in when present.
  - **Environment:** only an allowlist of variables a toolchain needs (`PATH`,
    `HOME`, locale, `TMPDIR`, and the Node, Go, Python, Java, and Rust home
    variables), none of them named like a credential. Nothing else reaches the
    test: no tokens, database URLs, webhooks, or Claude's own sign-in.
  - **Processes:** in a fresh PID namespace (`unshare -rnpf --kill-child`), so
    every process the test starts, detached ones included, dies with the run.
  - **Network:** no outside network. Loopback is brought up inside, so a test
    can start a local server.
  - **Time:** under GNU `timeout -s KILL`.
  - **Output:** written to a file, not a pipe.
  - **Measured on WSL2:** killing only the runner left a `node --test` child
    spinning forever, and a detached grandchild survived. Without the
    namespace, loopback was unreachable. Where `unshare` is missing, it falls
    back to the process group and says so in the evidence.
  - **What is not isolated:** the test can still read and write files your user
    can, including the repo's linked `node_modules`. Run `/bughunt` only on
    changes you are willing to execute locally.
  - **Tool probes never run the change's code.** "Is pytest installed?" is
    asked from an empty temp directory, with `python3 -I`, the sandbox
    environment, and a time limit. A probe inside the export once imported a
    `pytest.py` the PR had committed.
  - **What the test may never decide:** the reproducer names only a test path.
    The path is checked:
    - repo-relative;
    - no `..`;
    - no part starting with `-`;
    - named like a test;
    - new at the head;
    - no symlink in its path in the commit.
    The command, its flags, and its working directory are chosen in code. For
    JavaScript, the working directory is the nearest `package.json`.
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
