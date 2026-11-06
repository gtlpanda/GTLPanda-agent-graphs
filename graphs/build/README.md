# Build graph (`/build-app` driver)

Builds an approved backlog unattended. `/blueprint` approves the design and the
backlog and commits them on `integration/<app>`. The driver then runs each slice
in a fresh headless `claude -p "/dev --slice S<n> --base integration/<app> --unattended"`
session. It lands a slice on `integration/<app>` only after its own checks pass,
and stops on the brakes in `core/skills/backlog`.

Entry point: the `/build-app` skill (start, status, stop, resume, unblock),
which launches the driver detached and reads its state.

Status: **the driver and the skill** are tested against a fake `claude` and a
fake `gh` over throwaway git repos. `scripts/smoke-build.sh` runs one real
slice (opt-in, never in `scripts/test.sh`).

## Graph

Code routes; the session is a leaf. The rules for the next slice, the ledger,
and the brakes are `backlog.mjs`'s.

```
preflight (integration/<app> exists, its docs/backlog.json passes, the app matches, the tree is clean, claude is found,
           one driver per app, no session left running by a killed driver; a slice already on integration is recorded as landed)
loop: brake? --> stop (exit 3)
      nextSlice --none--> finish:
          slice/final from integration; claude -p (the QA graph, harness-repair, once over the whole
          branch against the default branch; its fixes committed as "final: QA fixes")
          --QA done + the same checks (no commits is fine)--> fast-forward, then push integration/<app>
            and open one PR to the default branch (reused if one is open; skipped with --no-pr) (exit 0)
          --anything else--> brake (exit 3), every slice stays landed; a rerun repeats only the finish
      slice/S<n> fresh from integration/<app>
      claude -p "/dev --slice S<n> --base integration/<app> --unattended"
        --usage limit--> wait for the reset (or probe), retry the same slice, not counted
        --billing / auth--> stop (exit 9 / 10)
        --overloaded--> wait, retry up to 3 times, then pause (exit 7); never counted
        --ended normally--> the driver's own checks:
            on slice/S<n>; tree clean; builds on integration; every commit starts "S<n>: ";
            no frozen test changed, renamed, or deleted; the driver's own verify ends VERIFY: PASS
            and leaves no untracked files
          /dev done + checks pass --> fast-forward integration/<app>, freeze the slice's test files
          /dev needs-human        --> the slice and its dependents block; the rest keep building
          anything else           --> escalated (two re-plan it, two more block it as stuck)
        a failed attempt is kept on attempt/S<n>-<time>, never discarded; so are commits a killed
        driver left on slice/S<n> (attempt/S<n>-<time>-recovered)
```

## Sessions

| What | Value | Why |
|------|-------|-----|
| Permission mode | `bypassPermissions` | nobody is there to approve a prompt |
| Guard | `hooks/guard.mjs` (PreToolUse: Bash, Edit, Write, MultiEdit, NotebookEdit) | denies, in the common spellings (quoted words, `bash -c`, `$(...)`, `xargs`, `env`), git push, remote changes, history rewrites, forced branch changes, `git clean -f`, touching `integration/`, `rm -rf` of `/` `~` `$HOME`, edits in `.git`, and edits to frozen tests. Commit messages and heredocs are data, never commands. Measured: a hook deny holds under `bypassPermissions` in headless `claude -p`, also in subagents. The driver's checks are the backstop for any spelling it misses |
| Deny rules | `git push`, `git remote`, `git reset --hard`, `git rebase`, `rm -rf /` `~` | a second layer: rules match command text only |
| StopFailure hook | `hooks/stop-failure.mjs` | records `rate_limit` and other API errors, so the driver waits instead of counting a failure |
| Model env | `CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5`, `..._FORCE=0`, `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=""` | pinned agents keep their pins; a set workflow model forces every workflow agent onto it (measured) |
| Background wait | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, in the env and the settings | a headless `claude -p` stops a running Workflow 10 minutes after its last turn (measured: it killed a design run), and a `/dev` slice runs for an hour or more |
| Env | the parent's `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT` removed, except auth and provider settings (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`, client certs) | a session started from a session would inherit its settings; an unattended box still needs to log in |
| Main model | `opus` (`HARNESS_BUILD_MODEL`) | the `/dev` orchestrator |
| Timeout | 6 h per session (`HARNESS_BUILD_SESSION_TIMEOUT_MS`), then SIGTERM, then SIGKILL | `/dev` notes: ~30 min planning plus 55-85 min per 7-8-component build |

## Command line

`node driver.mjs run|status|stop|resume --repo <path> --app <slug>` (`--no-pr`: run
only), and `unblock --repo <path> --app <slug> --slice S<n> --answer <text>...`.
`resume` starts the brake counters over; `unblock` gives a blocked slice the
answers and a fresh start; both refuse while a driver runs. State lives in
`$(git rev-parse --git-path harness-build)/<app>/`: `ledger.json`, `status.json`,
`driver.pid`, and `logs/` (`driver.log` and one `S<n>-<time>.jsonl` per session).
None of it is committed. `PANDASTACK_NOTIFY`, when set, is a command that gets
one line per landing, a slice that needs a human or gets stuck, a brake, and the
end of a run. The pid files count only while their process's command line is
still the driver's (or the session's), so a reused pid is never stopped or
waited on.

Exit codes: 0 every slice landed; 3 a brake (the reason is in `status.json`);
6 preflight failed; 7 the API stayed overloaded; 8 a usage limit resets past the 26 h wait cap (run again
after it); 9 billing or spend limit; 10 auth; 11 another driver runs for this
app; 12 a git state the driver will not touch; 13 the push or the PR failed;
130 stopped.

## Files

- `skills/build-app/SKILL.md`: the `/build-app` skill.
- `skills/build-app/driver/driver.mjs`: the loop, preflight, landing, the finish, and the CLI.
- `skills/build-app/driver/finish.mjs`: the final QA prompt, the PR body, the push and the PR.
- `skills/build-app/driver/checks.mjs`: the independent checks and the outcome.
- `skills/build-app/driver/session.mjs`: settings, starting a session, reading its result, the probe.
- `skills/build-app/driver/limits.mjs`: usage-limit classification and reset times, ported verbatim.
- `skills/build-app/driver/proc.mjs`: the session env and process helpers.
- `skills/build-app/driver/hooks/`: `guard.mjs` with `guard-rules.mjs`, and `stop-failure.mjs`.
- `tests/`: `driver.test.mjs` (end to end, a fake `claude` and `gh` in `fixtures/`), `guard.test.mjs`, `limits.test.mjs`.
- `../../scripts/smoke-build.sh`: one real slice on a throwaway repo, with its cost and models.

## Credits

`limits.mjs` is ported verbatim from the user's autobuild kit (`~/.autobuild`). The
fake-`claude` tests, the stop-failure hook, `buildEnv`, the pid lock, and the
SIGTERM-then-SIGKILL stop follow that kit's shape.
