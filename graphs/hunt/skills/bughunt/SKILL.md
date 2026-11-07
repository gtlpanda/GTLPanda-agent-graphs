---
name: bughunt
description: Hunt a pull request for real bugs with the hunt graph - map the change's impact, run the specialist hunters it calls for (logic, contract, concurrency, security, errors, regression) in parallel, challenge every finding with a blind skeptic and a referee, reproduce each confirmed one with a failing test run in a sandbox at the head and the merge-base, and report reproduced bugs apart from unverified ones, with a computed disposition. It never edits your branch, pushes, or comments. Use when the user says "/bughunt [PR# | branch | base..head]", "hunt this PR for bugs", "find the bugs in this PR", or asks whether a PR was reviewed for bugs.
---

# /bughunt

Find the functional defects one change introduced, with evidence, not style
opinions. This build runs **discover mode**:
1. It maps the impact and hunts.
2. A blind skeptic challenges every finding, and the advisor referees the
   contested ones.
3. Every confirmed finding gets a reproduction test. `evidence.mjs` runs it at
   the head and at the merge-base, in a sandbox.
4. You re-run every reproduction yourself before the report, so no agent's
   transcription is the final word.

`--propose` and `--fix` are not built yet. If either is asked for, say so and
stop.

These instructions are the opt-in to the Workflow tool for this skill.

## 1. Resolve the target

Usage: `/bughunt [<PR number> | <branch> | <base>..<head>] [--base <ref>]`. It
reviews committed work only.

```bash
REPO="$(git rev-parse --show-toplevel)"
CONFIG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
node "$CONFIG/skills/bughunt/intake.mjs" "$REPO" <one of: --pr <n> | --branch <name> | --range <base>..<head>, or none for the current branch> [--base <ref>]
```

- **Usage and errors.** A bare number is `--pr`, `a..b` is `--range`, and any
  other word is `--branch`. The last line must start with `INTAKE: OK`. On
  `INTAKE: FAIL`, report the reason and stop.
- **The output.**
  - The first line is the intake path. Call its directory `D`. It is
    `<git common dir>/bughunt/<key>`, inside `.git` and never committed.
  - `D/tree` is a detached worktree at the head under review. The agents read
    only that, never your checked-out branch.
- **Notes.** Relay every `note:` line it printed:
  - uncommitted changes, which are not reviewed;
  - a base it could not refresh from origin, which may be behind.

## 2. Prepare the run

```bash
node "$CONFIG/skills/findings/findings.mjs" input "$D/ledger.json" "$D/intake.json" "$D/input.json"
node "$CONFIG/skills/workflow-state/run-script.mjs" INJECTED_INPUT "$D/input.json" "$CONFIG/workflows/bughunt-flow.js" "$D/run.js"
```

- **Earlier findings.** The first command carries the earlier findings in the
  ledger, if there is one, so a re-run keeps their ids.
- **Failures.** If the first command fails because the ledger is unsound, report
  it and stop; never overwrite it. If the second command's output does not
  start with `run-script: wrote`, report it and stop.

## 3. Run the graph

Before launching, tell the human:
- which lenses intake routed (`lenses=` on the `INTAKE: OK` line);
- that reproduction tests run code from the change. They run in fresh exports
  of each commit, with credentials stripped from the environment, a timeout,
  and the network blocked where `unshare -rn` works. The tests can still read
  files your user can read, so run `/bughunt` only on changes you are willing
  to execute locally.

Call the Workflow tool with `scriptPath` set to the absolute path that
`run-script.mjs` printed, and these args:
`{"repo": "<REPO>", "tree": "<D>/tree", "configDir": "<CONFIG expanded>", "stateDir": "<D>", "mode": "discover"}`.
Do not pass the intake or the findings in args; the run script carries them.

If the run reports an agent type that is not found, the hunt agents are not
installed in this session. Tell the human to run `./install.sh` in their
PandaStack checkout and restart Claude Code, then stop.

## 4. Save and report

1. Write the returned ledger, as JSON, to `$D/result.json`.
2. Save it, checking each quote against the code:
   `node "$CONFIG/skills/findings/findings.mjs" save "$D/ledger.json" "$D/intake.json" "$D/result.json" --repo "$D/tree"`.
   It must print `FINDINGS: SAVED`; otherwise report the error.
3. Re-run every reproduction the ledger relies on, and correct the ledger to
   what the runs show:
   `node "$CONFIG/skills/bughunt/evidence.mjs" recheck "$D"`.
   - The last line is `RECHECK: PASS` (the runs agree with the graph) or
     `RECHECK: CORRECTED <n>`.
   - When it corrected anything, list each `corrected` line for the human. A
     correction means the graph's runner transcribed a result the rerun did not
     reproduce.
4. Print the report:
   `node "$CONFIG/skills/findings/findings.mjs" report "$D/ledger.json" "$D/evidence"`.
   Show it to the human as it is. Then add, in your own words:
   - the disposition;
   - every lens that was skipped or not covered;
   - which findings are **reproduced** (a test proved them), which are
     confirmed by reading only (static evidence), and which are contested.
5. If the run ended with `escalate`, quote its `reason`. The save kept the
   earlier findings as they were; nothing from the stopped run replaced them.

Never edit the branch under review, commit, push, or post a comment. The report
and the reproduction tests (under `$D/repro/`) stay local until the human
decides what to do with them.
