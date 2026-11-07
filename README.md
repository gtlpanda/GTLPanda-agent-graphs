# PandaStack

> **TL;DR** Hand Claude Code a task, or a whole app idea, and get back a change
> that is planned, built tests-first, reviewed, bug-hunted, QA'd, and released
> on your approval. Graphs of agents do the work; code, not prompts, decides
> what runs next, and every step is gated on real test results, never on an
> agent's word.
>
> ```
> /blueprint <idea>   read the doc or idea → one up-front interview → binding decisions → gated design → gated backlog → your one approval
> /build-app          the approved backlog, unattended: one /dev per slice → final QA → /bughunt --fix → one PR
> /dev <task>         plan it (you approve) → build it tests-first → prove every acceptance criterion → QA
> /loop               keep a branch green: check → fix → review → QA, until it passes or needs you
> /release-pr [PR#]   docs into the PR → you approve the exact commit → merge once → verify the deploy
> /bughunt [PR#]      impact map → specialist hunters → blind skeptic + referee → a failing test per bug, run in a sandbox → (--fix) a proven, independently verified repair on its own branch
> ```
>
> Install: `git clone https://github.com/gtlpanda/PandaStack.git && cd PandaStack && ./install.sh`

## What drives it

- **Code routes, agents are leaves.** Each graph is a workflow script that
  reads every agent's structured output and decides the next step. Agents never
  call each other, so a stuck loop, a skipped check, or a hallucinated "done"
  cannot steer the run.
- **Gates on evidence.** A step passes on the verify script's own last line, a
  passing assertion at `file:line`, or a CI result for the exact commit. An
  agent saying it passed counts for nothing.
- **The right model for each job.** An Opus orchestrator owns state, commits,
  and your approvals; a Fable advisor is called only at decision points
  (confirm a finding, gate a plan, unstick a loop, diagnose a failed deploy);
  Sonnet and Haiku subagents do the focused work. Every node is configured for high effort.
- **You stay in charge of the irreversible.** You approve every plan and every
  merge (for one exact commit); a rollback is only ever recommended, with evidence.

| Family | Graph | Run it with | What it does | Status |
|--------|-------|-------------|--------------|--------|
| build | [`graphs/blueprint/`](graphs/blueprint/README.md) | `/blueprint <idea>` | extractor (brief from doc, repo, request) → questioner (ranked interview, preflight, assumptions) → you answer once → architect designs, slicer cuts the backlog, advisor gates each → your one approval commits both on `integration/<app>`; research not built yet | interview, design, and backlog live-run |
| build | [`graphs/dev/`](graphs/dev/README.md) | `/dev <task>` | planner → advisor plan gate → you approve → scouts → implementer per component, tests first → acceptance auditor → the QA graph | live-tested |
| build | [`graphs/qa/`](graphs/qa/README.md) | `/loop` | checker → fixer → reviewer → qa-auditor, with the advisor confirming blocking findings before any fix | live-tested |
| build | [`graphs/release/`](graphs/release/README.md) | `/release-pr [PR#]` | scribe (docs in the PR) → readiness on the exact head → merger, once → deploy-watcher, evidence for the merge commit | tested with mocked agents |
| build | [`graphs/hunt/`](graphs/hunt/README.md) | `/bughunt [PR# \| branch \| a..b]` | intake (exact commits, hunks, routing signals, a worktree at the head) → impact-mapper → one hunter per lens the change calls for (logic, contract, concurrency, security, errors, regression), in parallel → findings merged under stable ids in code → a blind skeptic per finding, the advisor refereeing the contested ones → a reproducer's failing test, run by `evidence.mjs` at the head and the merge-base in a sandbox, then re-run by the session → (`--propose`, `--fix`) a root-cause repair per reproduced bug in an isolated worktree, proven by the reproduction (passes with it, fails without it) and the suite, and in fix mode reviewed by an independent verifier with adversarial tests → a report with a computed disposition | live-run on a 10-case benchmark: 6 of 6 planted bugs found and reproduced, 0 false positives on bug-free changes, $9.64 for discovery |
| build | [`graphs/build/`](graphs/build/README.md) | `/build-app` | the driver, detached: one fresh headless `/dev --slice` session per backlog slice, its own checks (commit prefix, clean tree, frozen tests, its own verify), fast-forward onto `integration/<app>`, usage-limit waits, the backlog brakes; then one QA pass over the whole branch, the push, and one PR for you | live-run once end to end: a 7-slice CLI in 1 h 40 min (retro 24) |
| marketing | [`graphs/seo/`](graphs/seo/README.md) | `seo-check.mjs check <dir> --site <url>` | so far only the check: a built site's title, description, canonical, Open Graph, and JSON-LD tags, duplicates across pages, the sitemaps (which decide the strict pages), and robots.txt, `SEO-CHECK: PASS\|FAIL`; the audit graph not built yet | check tested offline |

## The build-app loop

The graphs above are the parts of one loop that builds an app or a feature end
to end. You describe the idea and answer one interview. You approve the design
and the backlog once, then leave. The work comes back as one PR to approve.

```
/blueprint  interview → design → backlog of /dev-sized slices          ← you approve the design + backlog
/build-app  per slice: /dev on integration/<app> → /verify → fast-forward
            done → one harness-repair over the branch → /bughunt --fix over the branch
                 → one PR, with what the hunt found and fixed → /release-pr   ← you approve the merge
/loop       a PR whose head changed → /bughunt (discover) → report
```

- A slice that gets stuck is marked blocked, and the other slices keep
  building. Two escalations on one slice re-plan it, and your decisions stay
  fixed; two more after the re-plan mark it stuck. A design call or a missing environment variable name sends you one
  ping.
- `docs/backlog.json` holds the plan, and only `/blueprint` writes it. Progress
  lives in a ledger inside `.git`, and each slice commit starts with `S<n>:`.
  A tested `backlog.mjs` ([core/skills/backlog](core/skills/backlog/SKILL.md))
  owns the format and the next-step rules.
- Three brakes stop the run and ping you:
  - a third re-plan of one app;
  - every remaining slice blocked;
  - three different slices escalating with none landing in between.
- Production deploys are never autonomous.

Built so far: `/blueprint` run 1 (interview), run 2a (design behind the
advisor gate), and run 3 (the backlog behind the same gate, and your one
approval), plus `/dev` (with a slice mode: one backlog slice, unattended, on
`integration/<app>`), `/loop`, `/release-pr`, and the backlog format and its
next-step rules (`backlog.mjs`), `/build-app` (the driver, the final QA pass, the bug hunt, the PR),
and `/bughunt` (discover, propose, fix: specialist hunters, a blind skeptic, a referee,
reproductions run in a sandbox, proven repairs; wired into `/build-app` and `/loop`).
The whole loop has run live once: a one-sentence request became a 7-slice CLI with 143
passing tests in 2 h 14 min and $57, with no human between the approval and the end
(retro 24). `/bughunt` has run live on a 10-case benchmark: all 6 planted bugs found and
reproduced, no false positives on the 4 bug-free changes, $9.64 for discovery (retro 29).
Next: research and spikes before the design, a look at the advisor's share of the cost (63% of
that build), and `/bughunt` on a real codebase's PRs, beyond the benchmark's tiny fixtures.

Families: **build** graphs change your code. **Marketing** graphs (SEO first) change what you
own, like your site and content, and their fixes ship as code PRs. **Sales** graphs (research,
scout, and sdr are planned) reach other people, so you approve every send. Marketing and sales
work from one brief per product, `docs/gtm.md` in that product's repo; the format is
[`core/skills/gtm-brief`](core/skills/gtm-brief/SKILL.md), and `gtm-brief.mjs check` checks a
brief's format.

It also carries the shared user-level config the graphs run on
(`settings.json`, `CLAUDE.md`, `loop.md`, the `verify` gate): one repo,
symlinked into `~/.claude/` on every machine.

## Layout

```
install.sh  settings.json  CLAUDE.md  loop.md   shared config, linked into ~/.claude/
core/skills/                                    skills more than one graph uses (verify, harness-review, knowledge-map, default-stack, gtm-brief, backlog, findings, bug-lenses)
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
git clone https://github.com/gtlpanda/PandaStack.git
cd PandaStack
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
cd PandaStack && git pull && ./install.sh
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
