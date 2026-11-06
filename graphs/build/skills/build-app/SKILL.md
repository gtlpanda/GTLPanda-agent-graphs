---
name: build-app
description: Build an approved /blueprint backlog unattended with the build graph - one fresh headless /dev session per slice on integration/<app>, each landed only on the driver's own checks, then one final QA pass, a push of the branch, and one pull request for you to review. Use when the user says "/build-app", "build the backlog", "build the whole app unattended", or asks for the status of, to stop, to resume, or to unblock such a build. Subcommands start (the default), status, stop, resume, unblock.
---

# /build-app

You start, watch, and steer the `/build-app` driver. The driver does the
building in its own detached process; this session never builds a slice
itself. Invoking `/build-app` (start) is the user's opt-in to everything the
driver does unattended: headless sessions with `bypassPermissions` behind the
guard hook, commits on `integration/<app>`, and, at the end, a push of that
branch and one pull request to the default branch. It never merges, and
production deploys are never part of it.

Arguments: a subcommand (`start` when none), then optionally the app slug.
`unblock` also takes `S<n>` and the human's answer. `--no-pr` (start only):
stop after the final QA pass, without pushing. The driver remembers it, so a
resumed or unblocked build never pushes either; `start --pr` opts back in.

Paths: shell state does not carry between commands. Write
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}` out in every command, and put the
absolute paths section 1 finds in place of `REPO`, `STATE`, and `<app>` in
every command below; they are placeholders, not shell variables. The driver
is `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/build-app/driver/driver.mjs"`.

## 1. Which repo and which app

1. REPO is `git rev-parse --show-toplevel`; not a repo: stop and say so.
2. The app: the slug given, else the one `integration/<app>` branch
   (`git -C REPO branch --list 'integration/*' --format='%(refname:short)'`).
   None: say to run `/blueprint` first and stop. More than one and no slug:
   list them and ask which.
3. STATE is `git -C REPO rev-parse --path-format=absolute --git-path harness-build`
   followed by `/<app>`. Create it and its logs: `mkdir -p STATE/logs`.

## 2. start

1. Preflight, all before anything starts; stop and report the first failure:
   - `node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=11)?0:1)'`
     (Node 20.11 or later).
   - `git -C REPO status --porcelain` prints nothing.
   - The backlog passes: `git -C REPO show "integration/<app>:docs/backlog.json" > STATE/backlog.json`,
     then
     `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/backlog/backlog.mjs" check STATE/backlog.json`
     ends `BACKLOG: PASS`.
   - No driver runs for this app: `driver.mjs run` refuses a second one
     (exit 11) on its own, so this is only about saying so early: when
     `driver.mjs status --repo REPO --app <app>` reports `"state": "running"`
     or `"waiting"`, report that and stop (`"stale"` means a driver was
     killed: go ahead, the next run picks up from the ledger).
   - With a push (no `--no-pr`): `git -C REPO remote get-url origin` and
     `gh auth status` both succeed; otherwise say the build can run with
     `--no-pr` and stop.
2. Owed preflight items: if `state.json` in `git -C REPO rev-parse --path-format=absolute --git-path harness-blueprint`
   lists `preflight` items with `have: false`, show them (names only, never
   values) and ask once, with AskUserQuestion: `Start anyway` or `Stop`. A
   slice that needs one will stop with a question instead of guessing.
3. Show the plan in at most six lines: the app, the number of slices and how
   many already landed (from the ledger, when there is one), that each slice
   is a full `/dev` run (the first real runs took 30 minutes of planning and
   55-85 minutes of building for 7-8 components), and what happens at the end
   (the final QA pass, then the push and the PR, or not with `--no-pr`).
4. Launch it detached, so it survives this session (`setsid` where it exists,
   as on Linux; plain `nohup` elsewhere, as on macOS):
   `$(command -v setsid) nohup node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/build-app/driver/driver.mjs" run --repo REPO --app <app> [--no-pr|--pr] > STATE/logs/nohup.out 2>&1 < /dev/null &`
   Then wait about five seconds and run `status`: it must say `running`.
   Otherwise quote the last 20 lines of `STATE/logs/nohup.out` and of
   `STATE/logs/driver.log`, and stop.
5. Say how to watch it (`/build-app status`), how to stop it
   (`/build-app stop`), and that `PANDASTACK_NOTIFY`, when set in the
   environment the driver started from, pings on every landing, block, brake,
   and stop.

## 3. status

Run `driver.mjs status --repo REPO --app <app>` and read `STATE/ledger.json`.
Report in at most eight lines: the state and its message; slices done,
blocked (each with its questions), and pending; the slice being built and for
how long; the last five lines of `STATE/logs/driver.log`; and, when it is
done, the PR URL from the status. `stale` means the driver was killed (a
reboot, an OOM): say so, and that `resume` continues from the ledger.

## 4. stop

`driver.mjs stop --repo REPO --app <app>`. Say that the running session is
ended, landed slices stay, and the stopped attempt is kept on an `attempt/`
branch; `/build-app resume` continues.

## 5. resume

For a build that braked, stopped, or paused (a usage limit, an API outage, a
final QA that did not pass, a failed push). Show `status.json`'s message and
ask nothing more: `driver.mjs resume --repo REPO --app <app>` starts the
brake counters over (the human has looked; it refuses, exit 11, while a driver
runs), then launch it as in section 2, steps 4 and 5. Landed slices are never
rebuilt: with every slice landed, a run repeats only the final QA and the PR.
Blocked slices stay blocked: list them and point at `unblock`.

## 6. unblock S<n> <answer>

Show the slice's `questions` from the ledger first. Redact the answer as
`/blueprint` does (never a secret value), then
`driver.mjs unblock --repo REPO --app <app> --slice S<n> --answer "<answer>"`
(one `--answer` per answer). It fails unless `S<n>` is blocked, and refuses
(exit 11) while a driver runs. The slice then starts from a fresh plan with
every answer it was ever given. Then offer `resume`.

## Exit codes

The driver's exit code is in `status.json` (`exitCode`): 0 done, 3 a brake or a
final QA that did not pass, 6 preflight, 7 the API stayed overloaded, 8 a usage
limit past the wait cap, 9 billing, 10 auth, 11 another driver or session
running, 12 a git state it will not touch, 13 the push or the PR failed, 130
stopped. `graphs/build/README.md` has the graph.
