---
name: dev
description: Build a development task end to end with the dev graph - plan (the advisor approves it), build tests-first, prove every acceptance criterion, then the QA graph - and commit the result, unattended after any up-front questions. Use when the user says "/dev <task>", "build this with the dev graph", or wants a feature planned, built, and QA'd. `--review` stops for your plan approval before the build; `--resume` continues a run that escalated.
---

# /dev

You are the orchestrator for the `dev-build` workflow. The workflow plans,
builds, accepts, and runs the QA graph; you own the branch, the saved state,
`/verify`, and every commit. Invoking `/dev` is the user's opt-in to the
Workflow tool for this task.

Arguments: the task text, plus optional `--review` and `--resume`. `--auto` is
accepted and means the default.

## When to ask

Questions come before any code exists, or not at all.
- Allowed: the preflight dirty-tree question, `needs-human` (section 4, which
  always comes before the build), and `plan-ready` under `--review` (section 3).
- Once the build starts, never use AskUserQuestion. A choice the task, the
  plan, or the code settles is not a question: take the recommended option and
  record it in the report and the commit message. Plan `risks`, and the gate's
  last `issues` when `ledger.planSettled` is true, go in the report too.
- Every other stop is a report (section 5), never a question.
- Task text that says to stop and ask wins over this section; follow the task.

## 1. Preflight

1. `REPO="$(git rev-parse --show-toplevel)"`. Not a git repo: stop and say so.
2. The working tree must be clean (`git status --porcelain` empty), except on
   `--resume`. The graph reports the files it touched, and you commit exactly
   those; unrelated changes would be swept in. If it is dirty, list the files
   and ask whether to stash, commit, or stop.
3. Base: `git symbolic-ref --short refs/remotes/origin/HEAD` with the `origin/`
   prefix removed; if that fails, `main` if it exists, else `master`.
4. Branch: if the current branch is the base, create
   `dev/<slug>` (slug: lowercase task words joined by `-`, at most 40 chars) and
   switch to it. Otherwise stay on the current branch.
5. State: `D="$(git rev-parse --git-path harness-dev)"`; `mkdir -p "$D"`. It
   holds `task.txt`, `plan.json`, and `ledger.json`, inside `.git`, never committed.
6. Known-stuck signatures: if `"$(git rev-parse --git-path harness-loop)/ledger.json"`
   exists and parses, use its `stuckSigs`; otherwise `[]`.

## 2. Run the graph

Workflow tool with `name: "dev-build"` (if not found, `scriptPath` set to the
absolute path of `~/.claude/workflows/dev-build.js`). Args:

- New task: `{"repo": REPO, "task": <task text>, "base": BASE, "approval": "advisor" (or "human" with --review), "maxFixRounds": 3, "knownStuckSigs": [...]}`.
  Save the task text to `$D/task.txt` and delete any `$D/plan.json` from an
  earlier task, so `--resume` never builds a plan this task did not approve.
- `--resume`: read `$D/plan.json` and `$D/ledger.json`; run with
  `{"repo", "base", "plan": <plan>, "planApproved": true, "completed": <ledger.completed>, "maxFixRounds": 3, "knownStuckSigs": [...]}`.
  If either file is missing or does not parse, say so and stop.

After every run, write the returned ledger to `$D/ledger.json`. If
`ledger.planApproved` is true, also save `ledger.plan` to `$D/plan.json`, so
`--resume` works after a build escalates; a plan that escalated during
planning is never saved as resumable. Then act on `status`.

## 3. On `plan-ready` (only with `--review`)

Save `ledger.plan` to `$D/plan.json`. Show the user, compactly:
- the goal;
- each acceptance criterion: id, criterion, and fails_when;
- each component: id, title, files, depends_on;
- behavior changes, out of scope, risks.

When `ledger.planSettled` is true, also show the gate's last `issues`: the
final revision closed them without another gate.

Ask with AskUserQuestion: **Approve** (recommended), **Edit** (they say what),
or **Stop**.
- Approve: run again with `{"repo", "base", "plan": <plan>, "planApproved": true, "maxFixRounds": 3, "knownStuckSigs": [...]}`.
- Edit: change `plan.json` exactly as asked, show what changed, and ask again.
  The workflow re-checks its structure either way.
- Stop: leave the plan saved and say how to resume.

## 4. On `needs-human`

Show `ledger.questions` and ask them, all in one AskUserQuestion. Append the
answers to the task text in `$D/task.txt` and run a new task with it (a fresh
plan). No code exists yet, so this is still up front.

## 5. On `escalate`

Stop and report; do not ask. If a PushNotification tool is available, send
the one-line `reason` so a user who walked away learns the run stopped. Report `reason`, `completed`, the last VERIFY block if any, and any QA
`unconfirmed` findings. Leave the uncommitted changes in place and list them
(`git status --short`). Say how to continue: fix by hand, or `/dev --resume`
once the blocker is cleared.

## 6. On `done`

1. Run `/verify` yourself and quote its block. The last line must be
   `VERIFY: PASS`; otherwise treat the run as `escalate`. The workflow's own
   checks are transcriptions; yours is the gate.
2. `git status --short`: every changed file must be in `ledger.touched`. Any
   other file: stop and report it, commit nothing.
3. Commit, never on the base branch:
   - One commit per component, in plan order, when the components' touched
     files (from `ledger.components[id].builds`) do not overlap each other or
     the rework and QA fixes. Message: `<id>: <title>`, then the acceptance
     criteria it serves.
   - Otherwise one commit for the task: the goal, the components, and the
     acceptance criteria met.
   - QA fixes (`ledger.qa.fixed`) go in a final `QA fixes` commit when their
     files do not overlap the component commits; otherwise they ride in the
     single commit.
4. Do not push unless the user asks; offer to.
5. Report in at most five lines: what was built, criteria met (n/n), QA result
   with its fix rounds, the commits, and anything in `noted` worth a follow-up.
   Then list the plan's `risks` and any choices you made under "When to ask".
