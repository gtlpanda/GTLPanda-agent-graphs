---
name: blueprint
description: Plan an app or a feature before any code with the blueprint graph - read the design doc, architecture, or idea (and the repo), then interview the human once, up front, on only the decisions that are expensive to change, record the answers as binding decisions, then design the app behind an advisor gate. Use when the user says "/blueprint <idea>", "/blueprint --doc <path>", "plan this app", or "design this feature before we build it". The backlog (run 3) is not built yet.
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
(which folder is the project, and whether to replace a saved interview) and
the design gate's questions in section 4, which the advisor asks only when a
decision cannot hold. Every other stop is a report.

**Never ask for a secret value.** Preflight items (API keys, credentials) are
recorded by name only; the human supplies values through the environment when
a build needs them. Redact before anything leaves your hands: the request
text (once, in section 1; the redacted text is what the workflow gets), every
answer, and every returned ledger before it is written to `run1.json` or
`run2.json`. Redacting
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
   `mkdir -p "$S"`. It holds `request.json`, `run1.json`, `state.json`, and
   `run2.json`, inside `.git`, never committed. If `state.json` exists, say an
   earlier interview is saved there and ask whether to start over, design from
   it (go to section 4), or stop. Starting over deletes all four first, so no
   answer from the old request survives next to the new one.
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
   "assumptions": [...], "preflight": [{"what", "why", "needed_by", "have": true|false}]}`.
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
     entry in `notes` (findings the advisor did not send back). Nothing
     is approved or written to the repo here: the one approval comes with the
     backlog (run 3, not built yet).
   - `needs-human`: the advisor found a decision or assumption that cannot
     hold. Ask every `ledger.questions` entry in one message, each with the id
     it challenges (`about`); the human answers in their own words (redacted
     as above). Each answer replaces what it challenges, so the old answer
     never stays next to the new one, in `state.json`:
     - `about` is a decision id: set that decision's `answer`, and
       `note: "design gate"`.
     - `about` is an assumption id: remove the assumption and add a decision
       with the same id, the question, the answer, `resolves` empty, and
       `note: "design gate"`.
     - `about` is null: add a decision with the next unused id `D1`, `D2`, ...,
       the same way.
     Then run this section again. The gate asks at most twice per request:
     count the rounds in `state.json` as `gateRounds`; on a third
     `needs-human`, report the questions and stop.
   - `escalate`: section 5.

## 5. On `escalate`

Stop and report `reason`, any `issues` the last design round left open, any
`notes`, and
what the human must change (usually the documents: a missing path, or more
contradiction questions than an interview can hold). Do not ask.

## 6. Report

End with: the number of decisions recorded, assumptions taken, preflight
items still owed, the design's status, and the paths to `state.json` and
`run2.json`. Say plainly that the backlog (run 3) is not built yet, so nothing
has been sliced or written to the repo.
