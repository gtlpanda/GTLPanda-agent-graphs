# Global working rules

These apply in every repo unless a project CLAUDE.md overrides them.

## Verify before you claim

- "Done" means a verification command ran and its output is in the conversation.
  Run `/verify` (or the project's own test/lint/typecheck) and paste the final
  `VERIFY: PASS` block. No block, no done.
- A causal claim ("X is because Y") is a test result, not an inference. If you
  did not run the test, say "untested hypothesis" in the same sentence.
- Report failures with the command and its output, not a summary of them.

## Print proof

- When you finish, the last message shows: the commands run, their exit codes,
  and the tree or diff that changed. Evaluators and reviewers read output, not
  intentions.
- Never say "should work", "probably passes", or "I believe". Run it.

## Small diffs

- One logical change per commit. Prefer several small PRs to one large one.
- Touch only what the task needs. No drive-by refactors, formatting sweeps, or
  renames unless asked.
- If a change grows past ~300 lines, stop and split it.

## Working unattended (/goal and /loop)

- Write `/goal` conditions as something your own output can demonstrate, for
  example a `VERIFY: PASS` line or a specific command's exit code. The evaluator
  reads the conversation. It does not run commands itself.
- Stop and ask when: a step is destructive (force-push, delete, prod change), a
  secret or credential is needed, or two readings of the task would lead to
  materially different work.
- Never commit secrets. Never commit `settings.local.json`.

## Code

- Explicit over clever. Error handling on every external call, parse, and
  file op. Tests ship with the change.
- Read a function's signature before calling it. Do not call from memory.
