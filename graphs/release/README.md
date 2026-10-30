# Release graph (`release-flow`)

Takes a pull request that the dev and QA graphs already made green, and gets it
from "PR green" to "merged, deployed, verified, documented". Entry point: the
`/release-pr` skill. It never decides a merge or a rollback on its own; you
approve the merge for one exact commit, and a rollback is only ever a
recommendation with evidence.

Status: **design**. Nothing below is built yet; this is the spec the build follows.

## Graph

Code routes; agents are leaves and never call each other. One workflow, four
stages. **Every stage is an instant snapshot; nothing in the graph waits.** The
orchestrator owns the clock: it waits for CI and deploys with background
commands (`gh pr checks --watch`, `gh run watch`) and re-invokes the next stage
when they finish. Bash calls cap at 10 minutes and foreground `sleep` is
blocked, so a 20-minute wait inside an agent would be an expensive
model-driven poll at best.

```
docs:    release-checker --blocker--> blocked (reasons)
                         --> scribe (docs, in the repo's own format) --> docs-ready      (/release-pr commits + pushes them)
ready:   release-checker on the new head --CI pending--> waiting {ci}                     (/release-pr waits, re-runs ready)
                         --blocker--> blocked
                         --> ready-to-merge {pr, head, base}                              (/release-pr asks you)
land:    release-checker reads the PR first --already MERGED--> merged (merger skipped; resumable)
                         --head or base changed, or CI not green on head--> stale (approval void)
         --> merger (once; never replayed) --MERGED--> merged {merge_sha, targets to wait on}
                                           --NOT_MERGED or UNKNOWN--> escalate (state read back, reported)
verify:  deploy-watcher, after /release-pr waited --still deploying--> waiting {deploy}
             all targets DEPLOYED or UNVERIFIED --> done
             any DEGRADED, BROKEN, or DEPLOY-FAILED --> advisor (is it this change?) --> rollback-recommended | done-with-concerns
```

## Roles

| Role            | Who                            | Model  | Effort | Called                                     |
|-----------------|--------------------------------|--------|--------|--------------------------------------------|
| Orchestrator    | the `/release-pr` session      | opus   | high   | commits docs, pushes, asks for approval    |
| Release checker | `agents/release-checker.md`    | haiku  | high   | before docs, before approval, before merge |
| Scribe          | `agents/scribe.md`             | sonnet | high   | once per release                           |
| Merger          | `agents/merger.md`             | sonnet | high   | at most once per approved head             |
| Deploy watcher  | `agents/deploy-watcher.md`     | sonnet | high   | each `verify` stage                        |

The merger is the one agent in these graphs that performs an irreversible
action (everywhere else, agents never commit, push, or merge; orchestrators do).
It is allowed here because it acts only on an approval you gave for one exact
`{pr, head, base}`, and because putting it in the graph lets code enforce
"never replay a merge", which a prompt cannot.
| Advisor         | `core/agents/advisor.md`       | fable  | high   | only when a deploy looks unhealthy         |

## Rules the code enforces

- **Readiness is GitHub's own gate plus ours.** The checker reports
  `state`, `headRefOid`, `baseRefName`, `mergeStateStatus`, `reviewDecision`,
  and every check run on the head SHA. `mergeStateStatus` other than `CLEAN`
  (branch protection: required reviews, required checks, behind base) is a
  blocker, with `reviewDecision` as the reason when that is the cause.
- **Approval is bound to `{pr, head, base}`.** Before merging, the checker reads
  them again; any change voids the approval (`stale`) and the run starts over.
- **CI evidence is for the exact head SHA.** Every required check passed on that
  commit; a check for another commit does not count.
- **A merge is never replayed.** `land` reads the PR's state before anything
  else: if it is already `MERGED` (by an earlier run or a person), the merger is
  skipped and the run continues from the PR's merge commit. The merger runs at
  most once per run; after any error it reads the PR's real state back and
  reports `MERGED`, `NOT_MERGED`, or `UNKNOWN`. `UNKNOWN` escalates. No
  `--admin`, no force-push.
- **Deploy evidence is for the merge commit.** A reachable URL or an HTTP 200
  is not proof that this revision deployed. A target with no way to tie it to
  the SHA is `UNVERIFIED`, reported as such, never as a pass.
- **Health checks are absolute in v1** (the configured URL answers with the
  expected status within its timeout, and shows the expected content if
  configured), and a target is unhealthy only after **two consecutive failing
  checks**.
- **Blockers and warnings are separate.** Any blocker ends the stage. Warnings
  go to you with the approval question.
- **A stacked PR is blocked** until its parent merges (its base must be the
  default branch).

## Docs (before the merge, in the PR)

The scribe updates only the conventions the repo already has, found from its
files, never created: a dated `changelogs/YYYY-MM-DD.md` or a `CHANGELOG.md`,
`retro.md`, `tasks/lessons.md`, `ARCHITECTURE.md` or architecture docs, and a
README section the diff makes wrong. Rules: real numbers only (count the
tests); no invented lessons; edit changelog entries, never regenerate them;
factual updates only, and anything narrative or a removal is listed for you
instead. It also drafts release notes for people outside the repo; they are
returned, never sent.

## Deploy configuration

Read from a `## Deploy Configuration` section in the repo's `CLAUDE.md`
(platform, production URLs, deploy workflows **by name**, health checks, merge
method), kept to a few lines because target repos cap `CLAUDE.md` size. If it
is missing, the release checker proposes one from the repo's files
(`render.yaml`, `vercel.json`, `fly.toml`, and workflows triggered by pushes to
the default branch or by pull requests closing into it) and the run stops with
`needs-config`; `/release-pr` shows the proposal and writes it only after you
confirm. Detection only proposes; the config decides. Secrets are checked for
presence, never printed.

## Contracts

**args:** `repo` (absolute), `pr` (number), `stage` (`docs` | `ready` | `land` |
`verify`), `approval` (`{pr, head, base}`, for `land`), `mergeSha` (for
`verify`), `verifyRound` (how many `verify` stages ran; the orchestrator stops
waiting after its deploy budget, default 20 minutes).

**ledger:** `status` (`blocked` | `needs-config` | `docs-ready` | `waiting` |
`ready-to-merge` | `stale` | `merged` | `done` | `done-with-concerns` |
`rollback-recommended` | `escalate`), `wait_for[]` (`{kind: ci|deploy, ...}`
with what to watch), `reason`, `pr`, `head`, `base`,
`blockers[]`, `warnings[]`, `docs` (`{touched[], notes, for_human[]}`),
`merge` (`{outcome, method, merge_sha}`), `deploy` (per target
`{name, verdict, evidence}`), `advice`, `history[]`.

## `/release-pr` (orchestrator skill)

State lives in `$(git rev-parse --git-path harness-release)/<pr>/ledger.json`
(inside `.git`, never committed), so the approval and merge SHA carry across
invocations and a crashed run resumes.

1. Find the PR (argument, or the current branch's). Run stage `docs`.
2. `docs-ready`: show what the scribe changed, commit those files by name,
   push, and run stage `ready`. With squash merges, the docs and code land as
   one commit, which is how "docs in the same commit" holds after the fact.
3. `waiting`: wait with a background command for what `wait_for` names, then
   re-run the same stage. Stop after the time budget and report.
4. `ready-to-merge`: show head, base, CI, warnings, and the release notes; ask
   to merge this exact head. Approve runs stage `land` with the approval.
5. `stale`: say what changed and start again at `ready`.
6. `merged`: wait for the deploy targets, then run stage `verify`.
7. `done` / `done-with-concerns` / `rollback-recommended`: report the merge,
   each deploy target's verdict and evidence, and the release notes. A rollback
   happens only if you ask for one: a revert PR through the same graphs.

## Not in v1

Version bumps and tags (none of the repos this was built against use them),
baseline comparison and browser canaries with screenshots, and automatic
rollback.

## Build order

Each step is a commit with `VERIFY: PASS`:
1. `validate.sh`: names unique across skills and workflows (both show up as skills).
2. Release agents.
3. `release-flow.js` and its routing tests, starting with "land on an
   already-merged PR skips the merger".
4. `/release-pr` skill; this README moves from design to as-built.

## Credits

The merge, deploy-evidence, canary, and docs rules are adapted from
[gstack](https://github.com/garrytan/gstack) (MIT, © Garry Tan):
`land-and-deploy`, `canary`, `document-release`, and `setup-deploy`. The docs
rules also follow the user's own `release` skill.
