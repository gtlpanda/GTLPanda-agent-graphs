# Default /loop instructions

Run when `/loop` is invoked with no prompt. Each iteration, in order. When a
step needs a human decision, skip to steps 5 and 6: say what you need and why,
and notify. Stopping an iteration never skips steps 5 to 7.

1. **Unfinished work.** Finish anything still in progress from this conversation
   before starting new work.
2. **Pull request for the current branch.** If one exists (`gh pr view` or
   `git branch --show-current`):
   - Address every unresolved review comment. Reply on the thread with what changed.
   - If CI is red, read the failing job's log, fix the cause, push.
   - If there are merge conflicts with the base branch, rebase or merge and resolve.
3. **Repair graph.** These instructions are the opt-in to the Workflow tool for
   this step. The graph checks, fixes, reviews, QA-audits, and stops on its own; you own
   its state and every commit.
   1. Read the ledger at `"$(git rev-parse --git-path harness-loop)/ledger.json"`
      (inside `.git`, never committed). Missing or unparseable means
      `{"runs": [], "stuckSigs": [], "blockedOn": null, "idleRuns": 0}`; say so
      if it was unparseable. A missing `blockedOn` means `null`, a missing
      `idleRuns` means `0`.
   2. Run the `harness-repair` workflow: Workflow tool with `name: "harness-repair"`.
      If that name is not found, use `scriptPath` set to the absolute path of
      `~/.claude/workflows/harness-repair.js`. Args:
      `{"repo": "<git rev-parse --show-toplevel>", "base": "<PR base branch, if a PR exists>", "maxFixRounds": 3, "knownStuckSigs": <ledger.stuckSigs>}`.
   3. Write the ledger back (`mkdir -p` the directory first). Append the result
      to `runs` with `"at": "<date -u +%FT%TZ>"`; keep the last 20. On `done`,
      set `stuckSigs` to `[]`. On `escalate` with a `stuckSig`, add it to
      `stuckSigs` so the next iteration does not spend fix rounds on it again.
   4. On `done`: `lastVerify` is the checker's transcription, so do not commit
      on it. Run `/verify` yourself and quote its block; its last line must be
      `VERIFY: PASS`, otherwise treat the run as `escalate`. Run
      `git status --short` and confirm the changed files match `touched`. If
      `touched` is non-empty, commit exactly those files in one commit whose
      message lists the result's `fixed` list; push only if the branch has a PR.
   5. On `escalate`: stop the iteration's work, then run steps 5 and 6. Report
      `reason`, `lastVerify`, any `unconfirmed` findings, and what the human must
      decide; that decision is the action step 6 notifies about. Leave the
      fixer's uncommitted changes in place and list them.
4. **Idle work.** Only when 1 to 3 are clean: list the `noted` (MEDIUM/LOW) and
   `refuted` findings from the last run without fixing them. Then a small
   cleanup pass: dead code, duplicated helpers, stale TODOs touched by this
   branch. Keep each cleanup commit under ~50 lines, and run `/verify` before
   committing it.
5. **Report.** End the iteration with a 3 line status: what changed (with the
   graph's `status` and `fixRounds`), what is blocked, next step.
6. **Blocked on you.** When the iteration cannot advance until a human acts
   (merge or approve a PR, answer a question, supply a credential), write one
   line naming that action, with the PR and commit, for example
   `merge #276 (a79b606c); #275 waits on it`. Compare it with `blockedOn` in
   the ledger. If it differs, send it as one PushNotification (if the tool is
   available) and save it as `blockedOn`; if it is the same, do not notify
   again. Clear `blockedOn` once nothing is waiting on a human. Keep any
   watcher you armed and keep iterating: being blocked is not idle.
7. **Idle.** An iteration is idle only when nothing is pending: no unfinished
   work, no PR on this branch that needs action or waits on a human, the graph
   returned `done` with an empty `touched`, step 4 committed nothing, and no
   watcher is armed. Count idle iterations in the ledger's `idleRuns`: add 1
   for an idle iteration, reset it to 0 for any other. When it reaches 2,
   report that and end the loop. With no interval, call
   ScheduleWakeup with `stop: true`; with a fixed interval, delete the loop's
   cron job.

Never force-push. Never merge a PR. Never change files outside the current
branch's scope without saying so first.
