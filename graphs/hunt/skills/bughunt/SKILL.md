---
name: bughunt
description: Hunt a pull request for real bugs with the hunt graph - map the change's impact, run the specialist hunters it calls for (logic, contract, concurrency, security, errors, regression) in parallel, challenge every finding with a blind skeptic and a referee, reproduce each confirmed one with a failing test run in a sandbox at the head and the merge-base, and report reproduced bugs apart from unverified ones, with a computed disposition. --propose and --fix also repair each reproduced bug at its root in an isolated worktree, proven by the reproduction and the suite, and (--fix) reviewed by an independent verifier with adversarial tests. It never edits your branch, merges, pushes, or comments. Use when the user says "/bughunt [PR# | branch | base..head]", "hunt this PR for bugs", "find the bugs in this PR", or asks whether a PR was reviewed for bugs.
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

Two more modes share the same graph:
- **`--propose`** repairs each reproduced bug in a detached worktree. A repair
  is kept only when the reproduction passes with it, fails without it, and the
  suite is no worse. You get the commits to review. No independent verifier
  runs.
- **`--fix`** does the same on a new branch `bughunt/<key>`. An independent
  verifier then reviews each repair and writes adversarial tests that must
  pass. Only then is it committed and marked verified.
- **`--approve F3,F5`** lets a confirmed finding with no reproduction be
  repaired too. Without it, only reproduced findings are.

No mode ever touches the branch under review, merges, or pushes.

These instructions are the opt-in to the Workflow tool for this skill.

## 1. Resolve the target

Usage: `/bughunt [<PR number> | <branch> | <base>..<head>] [--base <ref>] [--propose | --fix] [--approve F<n>,...] [--draft-pr]`.
It reviews committed work only.

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

## 1b. The fix worktree (`--propose`, `--fix` only)

Repairs happen only in `$D/fix`, a separate worktree at the head under review.

```bash
HEAD_SHA="$(node -p 'require(process.argv[1]).target.head' "$D/intake.json")"
KEY="$(node -p 'require(process.argv[1]).key' "$D/intake.json")"
git -C "$REPO" worktree add -b "bughunt/$KEY" "$D/fix" "$HEAD_SHA"   # --fix
git -C "$REPO" worktree add --detach "$D/fix" "$HEAD_SHA"            # --propose
```

- **When it already exists.** If `$D/fix` exists, or (for `--fix`) the
  branch `bughunt/$KEY` does, an earlier run left them. Stop, and tell the
  human what is there:
  `git -C "$D/fix" log --oneline "$HEAD_SHA"..HEAD`.
  Give them the commands to clear it when they have reviewed it:
  `git -C "$REPO" worktree remove --force "$D/fix"` and
  `git -C "$REPO" branch -D "bughunt/$KEY"`. Never remove either yourself.
  After that, findings left `unresolved` are tried again. A fix that was
  verified on the removed branch is taken back by the next recheck, because no
  kept branch holds it any more.
- **At launch.** Tell the human:
  - each repair attempt runs the repo's suite in the sandbox, up to 2 attempts
    per bug;
  - one check has 9 minutes in all, so a suite that takes more than about 4
    minutes leaves the finding blocked, for a human.

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
  of each commit, with only an allowlist of the environment (no credentials),
  a timeout, and, where `unshare` works, no outside network (loopback stays up)
  and a process namespace that dies with the run. The tests can still read and
  write files your user can, including the repo's linked `node_modules`, so run
  `/bughunt` only on changes you are willing to execute locally.

Note the start time first: `STARTED="$(date -u +%FT%TZ)"`. Then call the
Workflow tool with `scriptPath` set to the absolute path that `run-script.mjs`
printed, and these args:
`{"repo": "<REPO>", "tree": "<D>/tree", "configDir": "<CONFIG expanded>", "stateDir": "<D>", "mode": "<discover | propose | fix>"}`.
- **`--fix`:** also pass `"fixBranch": "bughunt/<KEY>"`.
- **`--approve`:** also pass `"approve": ["F3", "F5"]`.
Do not pass the intake or the findings in args; the run script carries them.

If the run reports an agent type that is not found, the hunt agents are not
installed in this session. Tell the human to run `./install.sh` in their
PandaStack checkout and restart Claude Code, then stop.

## 4. Save and report

1. Write the returned ledger, as JSON, to `$D/result.json`.
2. Save it, checking each quote against the code:
   `node "$CONFIG/skills/findings/findings.mjs" save "$D/ledger.json" "$D/intake.json" "$D/result.json" --repo "$D/tree" --started "$STARTED"`.
   It must print `FINDINGS: SAVED`; otherwise report the error.
3. Re-run every reproduction the ledger relies on, and correct the ledger to
   what the runs show:
   `node "$CONFIG/skills/bughunt/evidence.mjs" recheck "$D"`.
   - Run it with the Bash tool's timeout at 600000 ms. Each finding can take two
     test runs.
   - It writes the ledger after each finding. If it is cut off anyway, run it
     again before the report.
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
6. **`--propose`:** show the proposed commits and their diff:
   - `git -C "$D/fix" log --oneline "$HEAD_SHA"..HEAD`;
   - `git -C "$D/fix" diff "$HEAD_SHA"..HEAD`.

   Say that no independent verifier reviewed them.
7. **`--fix`:** name the branch `bughunt/<KEY>` and its commits (same `log`
   command). Each verified fix is one commit with its regression test.
   - Say that nothing was merged or pushed.
   - Give the human's options: review the branch, cherry-pick the commits onto
     their own branch, or push it and open a PR themselves.
   - List every unresolved finding with its last feedback.
8. **`--draft-pr`** (only with `--fix`, and only when `bughunt/<KEY>` has
   commits). This is the one outward step, so first ask the human with
   AskUserQuestion, naming exactly what happens:
   - pushing `bughunt/<KEY>` to `origin`;
   - opening a draft PR from it into the reviewed branch (the PR's head branch,
     or the branch you hunted), titled `bughunt: fixes for <label>`, with the
     report as its body.

   Only on a yes:
   `git -C "$REPO" push -u origin "bughunt/$KEY"`, then
   `gh pr create --draft --base <reviewed branch> --head "bughunt/$KEY" --title "bughunt: fixes for <label>" --body-file "$D/report.md"`
   (write the report there first). Give the human the URL. Never merge it, and
   never push anything else. On anything but a yes, push nothing and say so.

Never edit the branch under review, merge, or post a comment, and never push,
except the one `--draft-pr` push the human approves in step 8. The only commits
are the repairs in `$D/fix`, made by `evidence.mjs`. The report, the
reproduction tests (under `$D/repro/`), and the fix worktree stay local until
the human decides what to do with them.
