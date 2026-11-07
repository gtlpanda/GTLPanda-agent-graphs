# Hunt graph (`bughunt-flow`)

`/bughunt [PR# | branch | base..head]` looks for real functional defects that
one change introduced. It finds bugs, not style. A finding must name its
trigger, the code path that mishandles it, and the wrong result someone sees,
with evidence quoted from the code. A finding that cannot do this is dropped.

Status: **discover mode, read-only**. It maps the impact, runs the specialist
hunters the change calls for, merges their findings under stable ids, and
reports. Nothing here verifies or reproduces a finding yet, so every finding is
an unverified candidate, and the report says so. Still planned:
- the skeptic and referee (adversarial verification);
- reproduction as a failing test;
- the propose and fix modes;
- wiring into `/build-app` and `/loop`.

```
intake.mjs (the session, deterministic) → the commits, files, hunks, routing signals, analysis worktree
impact (impact-mapper) → route = intake signals ∪ impact picks, capped at maxHunters
  → hunt × lens (hunter, in parallel)
  → merge in code: drop candidates without a trigger, path, observable, or evidence, or under
    confidence 60; drop every finding of a hunter that never read its lens; dedupe against this run
    and the ledger's earlier findings → done
impact returns nothing → route on the intake signals alone
a hunter returns nothing → its lens is not_covered, and the disposition becomes manual review
```

| Role | Who | Model | Effort | Called |
|------|-----|-------|--------|--------|
| Orchestrator | the `/bughunt` session | opus | high | intake, save, report |
| Impact mapper | `agents/impact-mapper.md` | sonnet | high | once per run |
| Hunter | `agents/hunter.md`, preloads `bug-lenses` | sonnet | high | once per routed lens |

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
- **The disposition is computed** (`findings.mjs disposition`), never chosen by a model.
  - **changes requested:** an open confirmed or reproduced bug above LOW.
  - **manual review:** an unsettled HIGH or CRITICAL finding, or a lens not covered.
  - **pass:** otherwise.

## State

Everything lives in `<git common dir>/bughunt/<key>/`, inside `.git` and never
committed. `<key>` is `pr-<n>` for a pull request, or the branch as a slug. It
is never a commit, so a new head finds the same ledger.

| File | What it is |
|------|------------|
| `intake.json` | what intake resolved |
| `tree/` | a detached worktree at the head; the agents read only this, never your checkout |
| `input.json` and `run.js` | the run's input, written into a copy of the workflow by `workflow-state/run-script.mjs`, so nothing big is retyped |
| `result.json` | the workflow's returned ledger |
| `ledger.json` | the findings across runs (`findings.mjs`) |

## Permissions and trust

- **Read-only by instruction.** The impact mapper and the hunters are read-only
  by their instructions, not by their tool list. They have Bash so they can run
  `git diff`, `git show`, and `git grep`, as the reviewer does.
- **What `/bughunt` never does:** edit the branch under review, commit, push,
  or comment.
- **Untrusted text.** The PR description, the code, comments, and commit
  messages are data:
  - The description goes to agents inside an `<untrusted-pr-description>` fence that it cannot close.
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
