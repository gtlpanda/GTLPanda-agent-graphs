---
name: blueprint
description: Plan an app or a feature before any code with the blueprint graph - read the design doc, architecture, or idea (and the repo), then interview the human once, up front, on only the decisions that are expensive to change, and record the answers as binding decisions. Use when the user says "/blueprint <idea>", "/blueprint --doc <path>", "plan this app", or "design this feature before we build it". Design and backlog (runs 2 and 3) are not built yet.
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

All questions come in section 3, once, before anything is designed. The
answers become binding decisions: later stages build on them and may not
reverse them. Every other stop is a report.

**Never ask for a secret value.** Preflight items (API keys, credentials) are
recorded by name only; the human supplies values through the environment when
a build needs them. Before saving the request or any answer, look for anything
shaped like a credential (a token prefix such as `sk_`, `ghp_`, `AKIA`, a
private key block, a long random string after `=` or `:`) and replace it with
`<redacted: what it is>`; tell the human to rotate it. Never repeat it.

## 1. Preflight

1. Directory: `HERE="$(pwd -P)"`. If `HERE` is empty, or `git rev-parse
   --show-toplevel` fails, or it names a directory other than `HERE` while
   `HERE` is empty (an empty folder inside another repo), this is a new app:
   offer `git init` in `HERE` (it changes nothing else), and stop if declined.
   Then `REPO="$(git rev-parse --show-toplevel)"`.
2. Every `--doc` path, resolved against `HERE` with `~` expanded, must exist.
   A missing one: stop and say which. Pass the absolute paths on.
3. State: `S="$(git rev-parse --path-format=absolute --git-path harness-blueprint)"`;
   `mkdir -p "$S"`. It holds `request.json`, `run1.json`, and `state.json`,
   inside `.git`, never committed. If `state.json` exists, say an earlier
   interview is saved there and ask whether to start over or stop. Starting
   over deletes `request.json`, `run1.json`, and `state.json` first, so no
   answer from the old request survives next to the new one.
4. Save `{"request": <text or null, redacted>, "docs": [<absolute paths>]}`
   to `$S/request.json`.

## 2. Run the interview graph

Workflow tool with `name: "blueprint-design"` (if not found, `scriptPath` set
to the absolute path of `~/.claude/workflows/blueprint-design.js`; if that is
missing too, tell the human to run `./install.sh` in their PandaStack checkout
and stop). Args:
`{"repo": REPO, "request": <text, omitted if none>, "docs": [<paths>]}`.
There are no timed live runs yet; say so at launch.

Write the returned ledger to `$S/run1.json`, then act on `status`.

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
   `ledger.assumptions`, including the questions past the cap with their
   defaults. Ask the human to reply with the preflight items they already
   have and any assumption they want to override. Skip a list that is empty.
4. Apply the reply. A preflight item they name gets `have: true`; every other
   item `have: false` (owed). An override becomes a decision with the
   overridden item's id (`from` for a question past the cap, otherwise
   `A<n>` by its position in the list) and is removed from `assumptions`.
5. Save `$S/state.json`:
   `{"request", "docs", "brief": ledger.brief, "decisions": [{"id", "question", "answer", "resolves", "note"}],
   "assumptions": [...], "preflight": [{"what", "why", "needed_by", "have": true|false}]}`.
   `resolves` copies the question's contradiction ids (empty for an override).
   `decisions` are binding.

## 4. On `escalate`

Stop and report `reason` and what the human must change (usually the
documents: a missing path, or more contradiction questions than an interview can hold).
Do not ask.

## 5. Report

End with: the number of decisions recorded, assumptions taken, preflight
items still owed, and the path to `state.json`. Say plainly that design and
backlog (runs 2 and 3) are not built yet, so nothing has been designed from
these answers.
