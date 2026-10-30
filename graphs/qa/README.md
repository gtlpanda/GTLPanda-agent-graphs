# QA graph (`harness-repair`)

`/loop` is the outer layer: the clock, PR tending, commits, and state.
`workflows/harness-repair.js` in this graph is the inner layer: one deterministic graph run
per iteration. Code routes between nodes; agents are leaves and never call
each other.

```
check --FAIL--> fix --> check            (the fixer's own verify run is never the gate)
check --PASS--> review --nothing HIGH/CRITICAL--> done
review --HIGH/CRITICAL--> advisor confirms --real--> fix --> check --> review (touched files only)
same failure twice in a row --> advisor unsticks once --> fix with its strategy, else escalate
```

| Role         | Who                        | Model  | Effort | Called                          |
|--------------|----------------------------|--------|--------|---------------------------------|
| Orchestrator | the `/loop` session        | opus   | high   | every iteration                 |
| Advisor      | `agents/advisor.md`        | fable  | high   | blocking findings, stuck loops  |
| Checker      | `agents/checker.md`        | haiku  | high   | every check                     |
| Fixer        | `agents/fixer.md`          | sonnet | high   | each fix round                  |
| Reviewer     | `agents/reviewer.md`       | sonnet | high   | after each passing check        |

The root `settings.json` sets `model: opus`, `advisorModel: fable`, and
`effortLevel: high`, so the orchestrator runs at high and its own advisor
tool is Fable too. Agent efforts live in each agent file's `effort:` and in
`NODES`; `scripts/test-workflow.sh` (repo root) fails if they disagree. Models are aliases; in CLI
2.1.308 they resolve to Opus 5.5, Fable 5.1, Sonnet 5.5, and Haiku 5.5. To pin
exact versions, put full IDs (`claude-sonnet-5-5`) in the agent files and in
`NODES` at the top of the workflow; `scripts/test-workflow.sh` fails if the two
disagree.

Routing rules, all in code and all tested:
- Every node returns a schema. The gate reads the last line of the verbatim
  `VERIFY` block, not the checker's own verdict field.
- At most `maxFixRounds` (default 3) fix rounds per run. A failure whose
  signature (step, exit code, first error) repeats goes to the advisor once;
  if it repeats after the advisor's strategy, the run escalates.
- Blocking findings are confirmed by the advisor in one batched call before a
  fix round is spent. Refuted ones are recorded, not fixed. MEDIUM/LOW are
  noted, not fixed.
- A node that returns nothing escalates; nothing crashes the loop.
- The run returns a ledger. `/loop` stores it in
  `$(git rev-parse --git-path harness-loop)/ledger.json` and passes escalated
  signatures back as `knownStuckSigs`, so a stuck failure costs one checker
  call per iteration until a human changes something.

Known limits:
- Repo content (test output, file text) flows verbatim into the fixer's and
  advisor's prompts, and the fixer can write files and run Bash. Run the
  unattended loop only on branches whose code you trust.
- `reviewer` and `advisor` are read-only by instruction, not by tool list:
  both have Bash so they can run `git diff` and friends.
- Before committing, `/loop` re-runs `/verify` itself rather than trusting the
  checker's transcribed block.

Cost and speed: a clean iteration is two calls (haiku check, sonnet review).
Fable runs only at decision points, and its confirmations are batched.
Fixes run one at a time on one working tree; no worktrees, no merge step.

**Agents** (`agents/`, linked into `~/.claude/agents/`): `checker` (haiku) runs verify and reports
failures; `fixer` (sonnet) implements fixes and re-verifies; `reviewer`
(sonnet) reviews diffs, read-only; `advisor` (fable) confirms findings,
unsticks loops, and answers judgment calls, read-only.

Routing tests: `tests/harness-repair.test.mjs`, run by `scripts/test-workflow.sh`.
