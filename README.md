# claude-harness

Portable, user-level Claude Code config: skills, agents, `settings.json`,
`CLAUDE.md`, `loop.md`. One repo, symlinked into `~/.claude/` on every machine.
Built for unattended, self-verifying work with `/goal` and `/loop`.

## Install

```bash
git clone <your-remote> ~/code/claude-harness
cd ~/code/claude-harness
./install.sh --dry-run   # see what would change
./install.sh             # link it
```

On a machine whose `~/.claude/settings.json` and `CLAUDE.md` you want to keep
(they hold machine-specific hooks, plugins, or your own rules), leave them out:

```bash
./install.sh --skip=settings.json,CLAUDE.md
```

`--skip` takes any target from the table below, or a whole directory
(`--skip=agents`). An unknown name is an error, not a silent install.

`install.sh` backs up anything already in the way to
`~/.claude/backups/<timestamp>/` with a manifest, then links. It is safe to
re-run: already-correct links are skipped and no new backup is made.

What gets linked (never the whole `~/.claude/`; it holds credentials, sessions,
history, and project state):

| Repo path                | Target                       | How                       |
|--------------------------|------------------------------|---------------------------|
| `settings.json`          | `~/.claude/settings.json`    | one symlink               |
| `CLAUDE.md`              | `~/.claude/CLAUDE.md`        | one symlink               |
| `loop.md`                | `~/.claude/loop.md`          | one symlink               |
| `skills/<name>/`         | `~/.claude/skills/<name>`    | one symlink **per skill** |
| `agents/<name>.md`       | `~/.claude/agents/<name>.md` | one symlink **per agent** |
| `workflows/<name>.js`    | `~/.claude/workflows/<name>.js` | one symlink **per workflow** |

Skills, agents, and workflows are linked per entry, not as whole directories,
so entries installed by other tools (plugins, gstack, your own one-offs) keep
working alongside these. The review skill is named `harness-review` so it does
not collide with gstack's `review`.

## Update

```bash
cd ~/code/claude-harness && git pull && ./install.sh
```

Links point at the checkout, so most edits take effect on the next session
without re-running install. Re-run after adding or removing a skill or agent;
it links new entries and prunes dangling links to removed ones.

## Uninstall

```bash
./install.sh --uninstall
```

Removes only symlinks that point into this repo, then restores the most recent
backup (the files that were in the way at install time) and deletes the
emptied backup dir.

## Machine-specific settings

Claude Code reads exactly these settings files, in increasing precedence:
`~/.claude/settings.json` (user), `.claude/settings.json` (project),
`.claude/settings.local.json` (project, gitignored). **There is no user-level
`settings.local.json`.** So:

- Anything portable goes in this repo's `settings.json`.
- Anything machine-specific (hook commands with absolute paths, local plugins,
  status line scripts) goes in the project's `.claude/settings.local.json`, or
  in your shell environment. `settings.local.json` is gitignored here and the
  pre-commit hook refuses to commit it.
- Claude Code itself writes to `~/.claude/settings.json` (for example `/config`
  changes and plugin toggles). Untested on this setup: whether those writes go
  through the symlink (repo file changes, link survives) or replace the link
  with a regular file. Check after your first `/config` change with
  `[ -L ~/.claude/settings.json ] && echo link || echo file`. If it is a file,
  diff it against the repo before re-running `install.sh`, which would
  otherwise back it up and relink the repo copy.

## Agent teams

`settings.json` ships with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` set to `"0"`
(present, off). To enable, set it to `"1"` in `settings.json` (portable) or
export it in your shell (one machine). Agent teams run each teammate as its own
Claude instance and cost roughly 7x the tokens of a normal session.

## Using /goal and /loop

**`/goal`** sets a completion condition that a small model checks after every
turn, reading the conversation. It runs no commands itself, so phrase the
condition as something Claude's own output shows:

```
/goal scripts/validate.sh exits 0 and the last line of /verify output is VERIFY: PASS, or stop after 15 turns
```

Requirements: the workspace is trusted (accept the dialog once) and hooks are
not disabled (`disableAllHooks` must not be `true`). Both are satisfied by
this repo's settings.

**`/verify`** is this repo's skill. A personal skill named `verify` replaces the
built-in `/verify`, and Claude Code also runs a skill of that name before each
commit it makes (documented in the skills reference). In a repo with no
detectable stack it prints `VERIFY: FAIL`, which is the intended answer: add a
`scripts/test.sh` or a test script so there is something to run.

It detects the stack (npm/pnpm/yarn/bun, pytest, go, terraform),
runs lint + typecheck + tests, and prints a block ending in `VERIFY: PASS` or
`VERIFY: FAIL` with every command and exit code. That block is the evidence a
`/goal` condition reads. It never passes when nothing ran, and fails when only
lint or formatting ran and no test-class step did.

**`/loop`** with no prompt follows `loop.md`: finish unfinished work, tend the
current branch's PR (review comments, red CI, merge conflicts), run the repair
graph, then small cleanup. `/loop 10m` repeats on an interval; bare `/loop`
self-paces.

## The repair graph

`/loop` is the outer layer: the clock, PR tending, commits, and state.
`workflows/harness-repair.js` is the inner layer: one deterministic graph run
per iteration. Code routes between nodes; agents are leaves and never call
each other.

```
check --FAIL--> fix --> check            (the fixer's own verify run is never the gate)
check --PASS--> review --nothing HIGH/CRITICAL--> done
review --HIGH/CRITICAL--> advisor confirms --real--> fix --> check --> review (touched files only)
same failure twice in a row --> advisor unsticks once --> fix with its strategy, else escalate
```

| Role         | Who                        | Model  | Effort | Called                          |
|--------------|----------------------------|--------|--------|---------------------------------|
| Orchestrator | the `/loop` session        | opus   | session| every iteration                 |
| Advisor      | `agents/advisor.md`        | fable  | high   | blocking findings, stuck loops  |
| Checker      | `agents/checker.md`        | haiku  | low    | every check                     |
| Fixer        | `agents/fixer.md`          | sonnet | medium | each fix round                  |
| Reviewer     | `agents/reviewer.md`       | sonnet | medium | after each passing check        |

`settings.json` sets `model: opus` and `advisorModel: fable`, so the
orchestrator's own advisor tool is Fable too. Models are aliases; in CLI
2.1.308 they resolve to Opus 5.5, Fable 5.1, Sonnet 5.5, and Haiku 5.5. To pin
exact versions, put full IDs (`claude-sonnet-5-5`) in the agent files and in
`NODES` at the top of the workflow; `scripts/test-workflow.sh` fails if the two
disagree.

Routing rules, all in code and all tested:
- Every node returns a schema. The gate reads the last line of the verbatim
  `VERIFY` block, not the checker's own verdict field.
- At most `maxFixRounds` (default 3) fix rounds per run. A failure whose
  signature (step, exit code, first error) repeats goes to the advisor once;
  if it repeats after the advisor's strategy, the run escalates.
- Blocking findings are confirmed by the advisor in one batched call before a
  fix round is spent. Refuted ones are recorded, not fixed. MEDIUM/LOW are
  noted, not fixed.
- A node that returns nothing escalates; nothing crashes the loop.
- The run returns a ledger. `/loop` stores it in
  `$(git rev-parse --git-path harness-loop)/ledger.json` and passes escalated
  signatures back as `knownStuckSigs`, so a stuck failure costs one checker
  call per iteration until a human changes something.

Known limits:
- Repo content (test output, file text) flows verbatim into the fixer's and
  advisor's prompts, and the fixer can write files and run Bash. Run the
  unattended loop only on branches whose code you trust.
- `reviewer` and `advisor` are read-only by instruction, not by tool list:
  both have Bash so they can run `git diff` and friends.
- Before committing, `/loop` re-runs `/verify` itself rather than trusting the
  checker's transcribed block.

Cost and speed: a clean iteration is two calls (haiku check, sonnet review).
Fable runs only at decision points, and its confirmations are batched.
Fixes run one at a time on one working tree; no worktrees, no merge step.

**Agents** (`~/.claude/agents/`): `checker` (haiku) runs verify and reports
failures; `fixer` (sonnet) implements fixes and re-verifies; `reviewer`
(sonnet) reviews diffs, read-only; `advisor` (fable) confirms findings,
unsticks loops, and answers judgment calls, read-only.

## Repo checks

```bash
scripts/test.sh           # runs all four below; ends with TEST: PASS|FAIL
scripts/validate.sh       # JSON valid, frontmatter complete, no secrets, no machine paths
scripts/test-install.sh   # install / re-install / uninstall against a temp HOME
scripts/test-secrets.sh   # proves the scanner and pre-commit hook block real key formats
scripts/test-workflow.sh  # runs each workflow against scripted agents and asserts the routing
scripts/check-secrets.sh  # the scanner itself (prints "check-secrets: clean" or lists hits); also the pre-commit hook
```

The test scripts end with an explicit `PASS`/`FAIL` line.
