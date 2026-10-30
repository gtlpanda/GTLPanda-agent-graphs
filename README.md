# GTLPanda-agent-graphs

Agent graphs for Claude Code: teams of agents wired together by code, each
with an Opus orchestrator, a Fable advisor for judgment calls, and focused
subagents. Plus the shared user-level config they run on (`settings.json`,
`CLAUDE.md`, `loop.md`, the `verify` gate). One repo, symlinked into
`~/.claude/` on every machine. Built for unattended, self-verifying work with
`/goal` and `/loop`.

| Graph | Status | What it does |
|-------|--------|--------------|
| [`graphs/qa/`](graphs/qa/README.md) | working | check → fix → review → advisor-confirm loop that makes a branch green and clean |
| [`graphs/dev/`](graphs/dev/README.md) | working, one live run | plan (you approve) → build tests-first → prove acceptance → QA graph; run with `/dev <task>` |
| [`graphs/release/`](graphs/release/README.md) | built, mock-tested | docs into the PR → you approve the exact head → merge once → deploy evidence for the merge commit; run with `/release-pr [PR#]` |

## Layout

```
install.sh  settings.json  CLAUDE.md  loop.md   shared config, linked into ~/.claude/
core/skills/                                    skills every graph uses (verify, harness-review)
core/agents/                                    agents more than one graph uses (advisor, checker)
graphs/<graph>/agents/                          that graph's agents
graphs/<graph>/workflows/                       that graph's workflow script
graphs/<graph>/tests/                           that graph's routing tests (*.test.mjs)
graphs/<graph>/README.md                        roles, models, routing
scripts/                                        repo checks (test.sh, validate, install/secret/workflow tests)
```

Every agent, skill, and workflow lands in one flat `~/.claude/<dir>/`, so each
name must be unique across `core/` and all graphs. `validate.sh` and
`install.sh` both refuse duplicates.

## Install

```bash
git clone https://github.com/gtlpanda/GTLPanda-agent-graphs.git
cd GTLPanda-agent-graphs
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

| Repo path                                    | Target                          | How                          |
|----------------------------------------------|---------------------------------|------------------------------|
| `settings.json`                              | `~/.claude/settings.json`       | one symlink                  |
| `CLAUDE.md`                                  | `~/.claude/CLAUDE.md`           | one symlink                  |
| `loop.md`                                    | `~/.claude/loop.md`             | one symlink                  |
| `core/skills/<name>/`, `graphs/*/skills/<name>/` | `~/.claude/skills/<name>`   | one symlink **per skill**    |
| `core/agents/<name>.md`, `graphs/*/agents/<name>.md` | `~/.claude/agents/<name>.md` | one symlink **per agent** |
| `core/workflows/<name>.js`, `graphs/*/workflows/<name>.js` | `~/.claude/workflows/<name>.js` | one symlink **per workflow** |

`--skip` uses the target name (`--skip=agents/fixer.md`), not the repo path.

Skills, agents, and workflows are linked per entry, not as whole directories,
so entries installed by other tools (plugins, gstack, your own one-offs) keep
working alongside these. The review skill is named `harness-review` so it does
not collide with gstack's `review`.

## Update

```bash
cd GTLPanda-agent-graphs && git pull && ./install.sh
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

## Graphs

Each graph documents its own roles, models, and routing in its README. The QA
graph is [graphs/qa/README.md](graphs/qa/README.md).

To add a graph: create `graphs/<name>/` with `agents/`, `workflows/`, `tests/`,
and a `README.md`, give every agent and workflow a name no other graph uses,
run `scripts/test.sh`, then `./install.sh`.

## Repo checks

```bash
scripts/test.sh           # runs all four below; ends with TEST: PASS|FAIL
scripts/validate.sh       # JSON valid, frontmatter complete, no secrets, no machine paths
scripts/test-install.sh   # install / re-install / uninstall against a temp HOME
scripts/test-secrets.sh   # proves the scanner and pre-commit hook block real key formats
scripts/test-workflow.sh  # runs every graphs/*/tests/*.test.mjs against scripted agents; checks every workflow parses
scripts/check-secrets.sh  # the scanner itself (prints "check-secrets: clean" or lists hits); also the pre-commit hook
```

The test scripts end with an explicit `PASS`/`FAIL` line.
