---
name: release-pr
description: Release one green pull request with the release graph - docs into the PR, readiness on the exact head commit, a merge you approve for that head, then deploy evidence for the merge commit and health checks. Never merges or rolls back without you. Use when the user says "/release-pr [PR#]", "release this PR", "merge and deploy this", or "ship it" for a PR the dev and QA graphs already made green.
---

# /release-pr

You are the orchestrator for the `release-flow` workflow. The workflow takes
instant snapshots and does one thing per stage; you own the clock (every wait),
the commits, the push, the approval question, and the saved state. Invoking
`/release-pr` is the user's opt-in to the Workflow tool for this release.

Never merge, revert, force-push, or deploy yourself. The merge happens only
inside stage `land`, only with an approval the user gave for one exact head.

## Setup

1. `REPO="$(git rev-parse --show-toplevel)"`. PR number: the argument, or
   `gh pr view --json number -q .number` for the current branch. None: stop and ask.
2. State: `D="$(git rev-parse --git-path harness-release)/<pr>"`; `mkdir -p "$D"`.
   After every workflow run, write the returned ledger to `$D/ledger.json`
   (inside `.git`, never committed). If `$D/ledger.json` already exists, read it
   and resume from its status instead of starting over: `merged` resumes at
   step 6, `ready-to-merge` at step 4, anything else at step 1.
3. Run the workflow with the Workflow tool, `name: "release-flow"` (if not
   found, `scriptPath` set to the absolute path of `~/.claude/workflows/release-flow.js`),
   args `{"repo": REPO, "pr": <pr>, "stage": <stage>, ...}`.

## 1. Stage `docs`

- `blocked`: report the blockers and stop.
- `needs-config`: show `proposal` as a `## Deploy Configuration` block (format
  in the release-checker agent). Ask the user to confirm or edit it. Write it to
  the repo's `CLAUDE.md` only after they confirm, commit it on the PR's branch
  by name, push, and run stage `docs` again. Never write it unconfirmed.
- `docs-ready`: show `docs.summary`, `docs.for_human`, and the release notes.
  If `docs.touched` is not empty, make sure you are on the PR's branch, commit
  exactly those files by name (`docs: release notes for #<pr>`), and push. Then
  go to stage `ready`.

## 2. Stage `ready`

- `waiting` on `ci`: wait for the checks on that head with a background
  command, `gh pr checks <pr> --watch --interval 30` (run in the background;
  you are notified when it exits). Then run stage `ready` again. Stop after
  `ciWaitMinutes` (default 30) and report what is still running.
- `blocked`: report and stop.
- `ready-to-merge`: go to step 4.

## 3. Waiting on deploys

`waiting` on `deploy` (from stage `verify`): wait in the background for the
named workflow runs (`gh run watch <id>`), or, for status-command targets,
about two minutes, using a background `until` loop rather than a foreground
sleep. Then run stage `verify` again with `verifyRound` one higher and `prior`
set to the previous ledger's `deploy`. Stop after `deployWaitMinutes`
(default 20): report each target as it stands.

## 4. Approval

Show: the PR, its head SHA, base, the checks, every warning, and the release
notes. Ask with AskUserQuestion to **merge #<pr> at <head>** (recommended only
when there are no warnings), or **stop**. On approve, save the approval
`{pr, head, base}` to `$D/approval.json` and run stage `land` with it.

## 5. Stage `land`

- `merged`: save `merge.merge_sha` and `targets`, then run stage `verify` with
  `{"mergeSha": ..., "targets": ..., "verifyRound": 1}`.
- `stale`: say what moved since the approval, delete `$D/approval.json`, and
  go back to stage `ready`. The old approval never carries over.
- `blocked`: report and stop.
- `escalate`: report `reason` exactly. If it says the merge may have happened,
  run `gh pr view <pr> --json state,mergeCommit` and show the result before
  anything else. Never retry the merge.

## 6. Stage `verify`

- `waiting`: step 3.
- `done`: report the merge SHA and each target's verdict with its evidence.
- `done-with-concerns`: the same, plus every UNVERIFIED target and warning,
  and the advisor's diagnosis if there is one.
- `rollback-recommended`: show the advisor's diagnosis and evidence, and ask
  whether to roll back. Never roll back yourself; on yes, the rollback is a
  revert pull request built and released through the same graphs.

End with at most five lines: merged (SHA), deploy verdicts, docs changed,
release notes, anything left for the user.
