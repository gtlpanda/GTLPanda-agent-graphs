# Default /loop instructions

Run when `/loop` is invoked with no prompt. Each iteration, in order. Stop early
when a step needs a human decision; say what you need and why.

1. **Unfinished work.** Finish anything still in progress from this conversation
   before starting new work.
2. **Pull request for the current branch.** If one exists (`gh pr view` or
   `git branch --show-current`):
   - Address every unresolved review comment. Reply on the thread with what changed.
   - If CI is red, read the failing job's log, fix the cause, push.
   - If there are merge conflicts with the base branch, rebase or merge and resolve.
3. **Verify.** Run `/verify`. Do not push or report success unless the last
   line is `VERIFY: PASS`.
4. **Idle work.** Only when 1 to 3 are clean: run `/review` on the branch diff and
   fix any High or Critical finding. Then a small cleanup pass: dead code,
   duplicated helpers, stale TODOs touched by this branch. Keep each cleanup
   commit under ~50 lines.
5. **Report.** End the iteration with a 3 line status: what changed, what is
   blocked, next step.

Never force-push. Never merge a PR. Never change files outside the current
branch's scope without saying so first.
