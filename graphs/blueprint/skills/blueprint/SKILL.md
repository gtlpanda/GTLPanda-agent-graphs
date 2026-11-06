---
name: blueprint
description: Plan an app or a feature before any code with the blueprint graph - read the design doc, architecture, or idea (and the repo), then interview the human once, up front, on only the decisions that are expensive to change, record the answers as binding decisions, then design the app and cut it into a backlog of /dev-sized slices, each behind an advisor gate, and ask for one approval that commits the design and the backlog on a new integration/<app> branch. Use when the user says "/blueprint <idea>", "/blueprint --doc <path>", "plan this app", or "design this feature before we build it".
---

# /blueprint

You are the orchestrator for the `blueprint-design` workflow. The workflow
reads and plans; you own the interview, the saved state, and every message to
the human. Invoking `/blueprint` is the user's opt-in to the Workflow tool for
this task.

Arguments: the request text (an idea, or what to add to the current repo),
plus `--doc <path>` any number of times for design documents or architecture
notes. At least one of the two.

## When to ask

The interview comes in section 3, once, before anything is designed. Its
answers become binding decisions: later stages build on them and may not
reverse them. The only other questions are the two preflight ones in section 1
(which folder is the project, and whether to replace a saved interview), the
gates' questions in sections 4 and 5, which the advisor asks only when a
decision cannot hold, and the one approval in section 6. Every other stop is a
report.

**Never ask for a secret value.** Preflight items (API keys, credentials) are
recorded by name only; the human supplies values through the environment when
a build needs them. Redact before anything leaves your hands: the request
text (once, in section 1; the redacted text is what the workflow gets), every
answer, and every returned ledger before it is written to `run1.json`,
`run2.json`, or `run3.json`. Redacting
means finding anything shaped like a credential (a token prefix such as `sk_`,
`ghp_`, `AKIA`, a private key block, a long random string after `=` or `:`) and
replacing it with `<redacted: what it is>`; tell the human to rotate it. Never
repeat it.

## 1. Preflight

1. Which folder is the project:
   `HERE="$(pwd -P)"`; `TOP="$(git rev-parse --show-toplevel 2>/dev/null)"`.
   - `TOP` is empty (not inside a repo): a new app. Offer `git init` in `HERE`
     (it changes nothing else); stop if declined.
   - `TOP` equals `HERE`: this repo is the project.
   - `TOP` is another directory (`HERE` sits inside a bigger repo): if
     `[ -z "$(ls -A "$HERE")" ]` or the only files in `HERE` are the `--doc`
     files, it is a new app: offer `git init` in `HERE`. Otherwise ask which
     is meant: a feature in the repo at `TOP`, or a new app in `HERE`
     (`git init` there).
   Then `REPO="$(git rev-parse --show-toplevel)"` from the chosen folder.
2. Every `--doc` path, resolved against `HERE` with `~` expanded, must exist.
   A missing one: stop and say which. Pass the absolute paths on.
3. State: `S="$(git rev-parse --path-format=absolute --git-path harness-blueprint)"`;
   `mkdir -p "$S"`. It holds `request.json`, `run1.json`, `state.json`,
   `run2.json`, and `run3.json`, inside `.git`, never committed. If
   `state.json` exists, say an earlier interview is saved there and ask
   whether to start over, design from it (go to section 4), or stop. Starting
   over deletes all five first, so no answer from the old request survives
   next to the new one.
4. Redact the request text, then save `{"request": <redacted text or null>,
   "docs": [<absolute paths>]}` to `$S/request.json`.

## 2. Run the interview graph

Workflow tool with `name: "blueprint-design"` (if not found, `scriptPath` set
to the absolute path of `~/.claude/workflows/blueprint-design.js`; if that is
missing too, tell the human to run `./install.sh` in their PandaStack checkout
and stop). Args:
`{"repo": REPO, "request": <the redacted text, omitted if none>, "docs": [<absolute paths>]}`.
Say at launch that the first live run took about a minute.

Redact the returned ledger, write it to `$S/run1.json`, then act on `status`.

## 3. On `needs-human`: the interview

1. Summarize the brief in five lines or fewer: goal, mode, how many
   requirements, what is already decided, and the open gaps.
2. Ask `ledger.questions` in order, four per AskUserQuestion call. For each:
   header `Q<n>` (its id); the question text followed by its `stakes`; the
   options as given, with ` (Recommended)` appended to the first option's
   label (the graph already put the recommended option first). The human may
   answer with "Other"; keep their words, redacted as above.
3. In one message, with no further AskUserQuestion call (the interview is
   capped at the questions above): show the preflight list
   (`ledger.preflight`: what, why, needed by; names only, never values) and
   `ledger.assumptions`, each shown with its `id` (`A1`, ... or the `Q<n>` of
   a question past the cap). Ask the human to reply with the preflight items
   they already have and any assumption they want to override, by id. Say the
   reply is optional: "none" keeps every assumption and marks every preflight
   item owed, and nothing is built in this step. Skip a list that is empty.
4. Apply the reply. A preflight item they name gets `have: true`; every other
   item `have: false` (owed). An override becomes a decision with the
   overridden assumption's `id` and is removed from `assumptions`.
5. Save `$S/state.json`:
   `{"request", "docs", "brief": ledger.brief, "decisions": [{"id", "question", "answer", "resolves", "note"}],
   "assumptions": [...], "preflight": [{"what", "why", "needed_by", "have": true|false}], "gateRounds": 0}`.
   `resolves` copies the question's contradiction ids (empty for an override).
   `decisions` are binding. Then go to section 4.

## 4. Design (run 2)

1. Build the design args from the saved state with exactly this command, and
   stop if it fails (the state is missing or malformed):
   `node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({mode:s.brief.mode,requirements:s.brief.requirements.map(r=>r.id),decisions:s.decisions.map(d=>({id:d.id,answer:d.answer})),assumptions:s.assumptions.map(a=>a.id)}))' "$S/state.json"`
2. Run the same workflow with those args plus `"repo": REPO`,
   `"stage": "design"`, and `"statePath": "$S/state.json"` (absolute).
   Say at launch that the first live design run took about 20 minutes.
   Redact the returned ledger, write it to `$S/run2.json`, then act on `status`:
   - `design-ready`: report the design compactly: `summary`; each module with
     its responsibility and requirement ids; for each boundary, the pick and
     the shape it beat; each ADR's decision; departures from the default stack;
     knowledge items with their owners; every `UNVERIFIED` premise; and every
     entry in `notes` (findings the advisor did not send back). Nothing is
     approved here: go to section 5, and the one approval comes with the
     backlog.
   - `needs-human`: the advisor found a decision or assumption that cannot
     hold (the same steps answer the backlog gate's questions in section 5).
     Ask every `ledger.questions` entry in one message, each with the id
     it challenges (`about`); the human answers in their own words (redacted
     as above). Each answer replaces what it challenges, so the old answer
     never stays next to the new one, in `state.json`:
     - `about` is a decision id: set that decision's `answer`, and
       `note: "design gate"`.
     - `about` is an assumption id: remove the assumption and add a decision
       with the same id, the question, the answer, `resolves` empty, and
       `note: "design gate"`.
     - `about` is null: add a decision with the next unused `D<n>` id (after
       every `D` id already in `decisions`), the same way.
     Then add 1 to `gateRounds` in `state.json` and run this section again.
     The gates ask at most twice per request, both gates together: on a
     `needs-human` when `gateRounds` is already 2, report the questions and
     stop.
   - `escalate`: section 7.

## 5. Backlog (run 3)

1. Build the backlog args with exactly this command, and stop if it fails:
   `node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const r=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(r.status!=="design-ready")throw new Error("run2.json is not design-ready");console.log(JSON.stringify({mode:s.brief.mode,requirements:s.brief.requirements.map(x=>x.id),decisions:s.decisions.map(d=>({id:d.id,answer:d.answer})),assumptions:s.assumptions.map(a=>a.id),knowledge:(r.design.knowledge||[]).map(k=>k.id)}))' "$S/state.json" "$S/run2.json"`
2. Run the same workflow with those args plus `"repo": REPO`,
   `"stage": "backlog"`, `"statePath": "$S/state.json"`, and
   `"designPath": "$S/run2.json"` (both absolute). Say at launch that the
   backlog has not been live-run yet. Redact the returned ledger, write it to
   `$S/run3.json`, then act on `status`:
   - `backlog-ready`: section 6.
   - `needs-human`: answer it as in section 4 (the questions name the ids
     they challenge, and the same `gateRounds` limit holds), then go back to
     section 4: a changed decision can change the design.
   - `escalate`: section 7.

## 6. The one approval

1. Show, compactly: the app slug and its branch `integration/<app>`; each
   slice as `S<n> <title>: <goal>` with its requirement ids, `depends_on`, and
   number of criteria; each knowledge item with the slice that builds its
   owner (`built_in`); the backlog gate's `notes`; and the preflight items
   still owed (names only).
2. One AskUserQuestion, header `Approval`: "Approve the design and the
   backlog?" with the options `Approve (Recommended)` (create
   `integration/<app>` and commit the design and the backlog to it), `Edit`
   (say what to change; it is designed again), and `Stop` (nothing is
   written).
3. `Approve`:
   1. `git status --porcelain` must print nothing, and
      `git rev-parse --verify -q "refs/heads/integration/<app>"` must fail.
      Otherwise stop and report why: nothing of anyone else's goes into the
      commit, and an existing branch is never reused.
   2. A repo with no commit yet (`git rev-parse -q --verify HEAD` fails) gets
      one first: `git commit --allow-empty -m "blueprint: start <app>"`.
   3. `git switch -c "integration/<app>"`, then
      `node ~/.claude/skills/blueprint/write-docs.mjs "$S/run2.json" "$S/run3.json" "$REPO"`.
      Its output must start with `write-docs: wrote `. Otherwise report it,
      `git switch -` back, `git branch -D "integration/<app>"`, and stop.
   4. `git add --` the paths it printed, and
      `git commit -m "blueprint: design and backlog for <app>"`. Nothing else
      is staged.
4. `Edit`: the human's words (redacted) become a decision with the next
   unused `D<n>` id, `question: "approval edit"`, `resolves` empty, and
   `note: "approval edit"`, saved in `state.json`. Then go to section 4.
5. `Stop`: nothing is written to the repo; the state stays in `$S`.

## 7. On `escalate`

Stop and report `reason`, any `issues` the last design round left open, any
`notes`, and
what the human must change (usually the documents: a missing path, or more
contradiction questions than an interview can hold). Do not ask.

## 8. Report

End with: the number of decisions recorded, assumptions taken, preflight
items still owed, the design's and the backlog's status, and the paths to
`state.json`, `run2.json`, and `run3.json`. After an approval, add the branch,
the commit, and the files written. Say plainly that the unattended build of
the backlog (`/build-app`) is not built yet.
