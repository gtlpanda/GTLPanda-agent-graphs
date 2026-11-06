---
name: dev
description: Build a development task end to end with the dev graph - plan (the advisor approves it), build tests-first, prove every acceptance criterion, then the QA graph - and commit the result, unattended after any up-front questions. Use when the user says "/dev <task>", "build this with the dev graph", or wants a feature planned, built, and QA'd. `--review` stops for your plan approval before the build; `--resume` continues a run that escalated; `--slice S<n>` builds one slice of the repo's backlog, and `--unattended` never asks (the /build-app driver uses both).
---

# /dev

You are the orchestrator for the `dev-build` workflow. The workflow plans,
builds, accepts, and runs the QA graph; you own the branch, the saved state,
`/verify`, and every commit. Invoking `/dev` is the user's opt-in to the
Workflow tool for this task.

Arguments: the task text, plus optional `--review` and `--resume`. `--auto` is
accepted and means the default. Also:
- `--base <branch>`: the base branch, instead of detecting it (section 1).
- `--slice S<n>`: the task is slice `S<n>` of `docs/backlog.json` instead of
  task text (section 1, step 5), and every commit subject starts with `S<n>: `.
- `--unattended`: nobody is there. Never use AskUserQuestion, whatever the
  task text says; every point below that would ask is a report instead
  (section 5), and the run ends there. `--review` cannot be combined with it.

Installed paths start with `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`, where
`install.sh` linked PandaStack. Write it out in every command: shell state does
not carry from one command to the next.

## When to ask

Questions come before any code exists, or not at all.
- Allowed: the preflight dirty-tree question, `needs-human` (section 4, which
  always comes before the build), and `plan-ready` under `--review` (section 3).
- Once the build starts, never use AskUserQuestion. A choice the task, the
  plan, or the code settles is not a question: take the recommended option and
  record it in the report and the commit message. Plan `risks`, and the gate's
  last `issues` when `ledger.planSettled` is true, go in the report too.
- Every other stop is a report (section 5), never a question.
- Task text that says to stop and ask wins over this section; follow the task,
  except under `--unattended`, which wins over everything.

## 1. Preflight

1. `REPO="$(git rev-parse --show-toplevel)"`. Not a git repo: stop and say so.
2. The working tree must be clean (`git status --porcelain` empty), except on
   `--resume`. The graph reports the files it touched, and you commit exactly
   those; unrelated changes would be swept in. If it is dirty, list the files
   and ask whether to stash, commit, or stop (`--unattended`: list them and
   stop).
3. Base: `--base <branch>` when given (`git rev-parse --verify -q "<branch>"`
   must succeed, or stop and say so); otherwise
   `git symbolic-ref --short refs/remotes/origin/HEAD` with the `origin/`
   prefix removed; if that fails, `main` if it exists, else `master`.
4. State: `D="$(git rev-parse --path-format=absolute --git-path harness-dev)"`; `mkdir -p "$D"`. It
   holds `task.txt`, `plan.json`, `slice.json`, and `ledger.json`, inside `.git`, never committed.
5. `--slice S<n>`, before any branch is made: `docs/backlog.json` must exist
   in `REPO`. Run
   `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/backlog/backlog.mjs" task "$REPO/docs/backlog.json" S<n> "$(git rev-parse --path-format=absolute --git-path harness-build)" > "$D/slice.json"`
   (the last argument is the build state directory; the app's ledger in it
   is read when it exists, and a missing one is a first attempt). A
   non-zero exit: report its message and stop. The task text is
   `slice.json`'s `task`, and `requiredCriteria` is its `requiredCriteria`,
   both copied exactly as printed.
6. Branch: if the current branch is the base, create `dev/<slug>` and switch
   to it (slug: lowercase task words joined by `-`, at most 40 chars; with
   `--slice`, `S<n>-` then the slice title's words). Otherwise stay on the
   current branch (the `/build-app` driver puts each slice on its own).
7. Known-stuck signatures: if `"$(git rev-parse --path-format=absolute --git-path harness-loop)/ledger.json"`
   exists and parses, use its `stuckSigs`; otherwise `[]`.

## 2. Run the graph

Workflow tool with `name: "dev-build"` (if not found, `scriptPath` set to the
absolute path of `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/workflows/dev-build.js`, expanded first). Args:

- New task: `{"repo": REPO, "task": <task text>, "base": BASE, "approval": "advisor" (or "human" with --review), "maxFixRounds": 3, "knownStuckSigs": [...]}`,
  plus `"requiredCriteria"` with `--slice`.
  Save the task text to `$D/task.txt` and delete any `$D/plan.json` from an
  earlier task, so `--resume` never builds a plan this task did not approve.
- `--resume`: read `$D/ledger.json`, then run the approved plan (below) with
  `{"repo", "base", "planApproved": true, "completed": <ledger.completed>, "maxFixRounds": 3, "knownStuckSigs": [...]}`,
  plus `"requiredCriteria"` with `--slice`.
  If `$D/plan.json` or `$D/ledger.json` is missing or does not parse, say so and stop.

**Running an approved plan.** Never pass the plan in `args` and never retype
it: a real plan is ~50 KB and workflow scripts cannot read files. Write it into
a run script instead:
`node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/workflow-state/run-script.mjs" INJECTED_PLAN "$D/plan.json" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/workflows/dev-build.js" "$D/run.js"`
(the shared `workflow-state` skill).
Its output must start with `run-script: wrote <path>`; anything else, report it
and stop. If node cannot find the script, it moved to the shared skill: tell
the human to run `./install.sh` in their PandaStack checkout, then retry. Then call the Workflow tool with `scriptPath` set to that printed
absolute path, and the args without `plan`.

Say at launch how long it usually takes (first real runs: planning about 30
minutes, a build of 7-8 components 55-85 minutes, a resume 10-15 minutes).

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
- Approve: run the approved plan (section 2) with `{"repo", "base", "planApproved": true, "maxFixRounds": 3, "knownStuckSigs": [...]}`.
- Edit: change `plan.json` exactly as asked, show what changed, and ask again.
  The workflow re-checks its structure either way.
- Stop: leave the plan saved and say how to resume.

## 4. On `needs-human`

`--unattended`: do not ask. The questions are in `$D/ledger.json`; report
them (section 5) and stop.

Otherwise show `ledger.questions` and ask them, all in one AskUserQuestion. Append the
answers to the task text in `$D/task.txt` and run a new task with it (a fresh
plan). No code exists yet, so this is still up front.

## 5. On `escalate`

Stop and report; do not ask. If a PushNotification tool is available, send
the one-line `reason` so a user who walked away learns the run stopped. Report `reason`, `completed`, the last VERIFY block if any, and any QA
`unconfirmed` findings. List every `ledger.keptChanges` entry under "decided
without you"; they stay in the saved plan and are reported again at `done`.
When `ledger.blockedChanges` is not empty, list each
change with its file:line and the advisor's reason: these are the decisions the
human must make. To keep one, add it to `behavior_changes` in `$D/plan.json`;
to drop one, revert that change in the code yourself (with the user's
go-ahead), run `/verify`, and confirm it passes. Then `/dev --resume`: the
re-audit no longer sees a dropped change, and sees a kept one as planned. Leave the uncommitted changes in place and list them
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
   With `--slice S<n>`, every subject above starts with `S<n>: `
   (`S2: C1: <title>`, `S2: QA fixes`): the driver lands only commits that do.
   Every entry in `ledger.keptChanges` goes in the commit body under
   "Kept by the advisor (not in the approved plan)", with its file:line,
   `serves`, and reason.
4. Do not push unless the user asks; offer to (`--unattended`: never push,
   and the driver pushes nothing either until the whole backlog is built).
5. If a PushNotification tool is available, send one line: done, criteria met
   (n/n), and the commit count.
6. Test ratio, measured the same way every time so builds compare:
   `git diff --numstat "$BASE"...HEAD | awk '$1 != "-" && $3 !~ /\.md$|\.lock$|(^|\/)pnpm-lock\.yaml$|\.json$|\.snap$/ { if ($3 ~ /(^|\/)(tests?|__tests__)\/|[._](test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^\/]*\.py$/) t += $1; else c += $1 } END { printf "Test ratio: tests +%d / code +%d lines (%.1fx)\n", t, c, c ? t/c : 0 }'`.
   Quote its line in the report. For reference, the user's comparable feature
   PRs ran 0.6x-1.6x; above 2x, name the test files that carry most of it.
7. Report in at most five lines: what was built, criteria met (n/n), QA result
   with its fix rounds, the commits, and anything in `noted` worth a follow-up.
   Then list the plan's `risks`, every `keptChanges` entry under "decided
   without you", and any choices you made under "When to ask".
