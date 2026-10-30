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
3. **Repair graph.** These instructions are the opt-in to the Workflow tool for
   this step. The graph checks, fixes, reviews, QA-audits, and stops on its own; you own
   its state and every commit.
   1. Read the ledger at `"$(git rev-parse --git-path harness-loop)/ledger.json"`
      (inside `.git`, never committed). Missing or unparseable means
      `{"runs": [], "stuckSigs": []}`; say so if it was unparseable.
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
   5. On `escalate`: stop the iteration. Report `reason`, `lastVerify`, any
      `unconfirmed` findings, and what the human must decide. Leave the fixer's
      uncommitted changes in place and list them.
4. **Idle work.** Only when 1 to 3 are clean: list the `noted` (MEDIUM/LOW) and
   `refuted` findings from the last run without fixing them. Then a small
   cleanup pass: dead code, duplicated helpers, stale TODOs touched by this
   branch. Keep each cleanup commit under ~50 lines, and run `/verify` before
   committing it.
5. **Report.** End the iteration with a 3 line status: what changed (with the
   graph's `status` and `fixRounds`), what is blocked, next step.

Never force-push. Never merge a PR. Never change files outside the current
branch's scope without saying so first.
