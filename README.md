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

Skills and agents are linked per entry, not as whole directories, so skills
installed by other tools (plugins, gstack, your own one-offs) in
`~/.claude/skills/` keep working alongside these.

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
current branch's PR (review comments, red CI, merge conflicts), run `/verify`,
then small cleanup. `/loop 10m` repeats on an interval; bare `/loop` self-paces.

**Agents** (`~/.claude/agents/`): `checker` (haiku) runs verify and reports
failures; `reviewer` (opus) reviews diffs and makes judgment calls, read-only;
`fixer` (sonnet) implements fixes for checker/reviewer findings and re-verifies.

## Repo checks

```bash
scripts/test.sh           # runs all three below; ends with TEST: PASS|FAIL
scripts/validate.sh       # JSON valid, frontmatter complete, no secrets, no machine paths
scripts/test-install.sh   # install / re-install / uninstall against a temp HOME
scripts/test-secrets.sh   # proves the scanner and pre-commit hook block real key formats
scripts/check-secrets.sh  # the scanner itself (prints "check-secrets: clean" or lists hits); also the pre-commit hook
```

The three test scripts end with an explicit `PASS`/`FAIL` line.
