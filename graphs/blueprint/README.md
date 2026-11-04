# Blueprint graph (`blueprint-design`)

Plans an app or a feature before any code exists. It reads what you give it (a
design doc, an architecture, a feature request, or a bare idea, plus the repo),
asks you once, up front, about only the decisions that are expensive to change,
and records the answers as binding decisions. Entry point: the `/blueprint` skill.

Status: **run 1 (intake and interview) built**, routing tested with mocked agents
(`tests/blueprint-design.test.mjs`); no live run yet. Run 2 (research, spikes,
design, the advisor's design gate) and run 3 (backlog of `/dev`-sized slices,
the knowledge map, preflight, your approval) are planned, not built.

## Graph (run 1)

Code routes; agents are leaves and never call each other.

```
extractor --malformed brief--> extractor (once, with the problems) --still--> escalate
          --brief--> questioner --malformed--> questioner (once) --still--> escalate
                                --questions--> cap at 12 (contradictions always asked)
                                               --> needs-human: /blueprint asks, saves binding decisions
```

## Roles

| Role         | Who                     | Model  | Effort | Called                         |
|--------------|-------------------------|--------|--------|--------------------------------|
| Orchestrator | the `/blueprint` session | opus  | high   | once per request; asks, saves  |
| Extractor    | `agents/extractor.md`   | sonnet | high   | once, plus one revision        |
| Questioner   | `agents/questioner.md`  | sonnet | high   | once, plus one revision        |

## Contracts

**args:** `repo` (absolute, required), `request` (text) and/or `docs` (paths, relative to the repo or absolute).

**brief** (extractor): `{goal, mode: app|feature, users[], requirements[] {id: R1.., text, source}, decided[] {decision, source}, gaps[], contradictions[] {id: X1.., a, b, sources[]}, constraints[], existing_stack}`.
Code rejects: no requirements; a requirement id not shaped `R<n>`, used twice, or without text or source;
a bad mode; a contradiction id not shaped `X<n>` or used twice. One revision, then escalate.
Decisions a document already made are reported, never redesigned.

**interview** (questioner): `questions[] {id: Q1.., question, stakes, options[2-4] {label, description}, recommended, default_if_unasked, resolves[]}`,
`preflight[] {what, why, needed_by}` (names, never secret values), `assumptions[] {assumption, why}`.
Code rejects: a missing or empty question list; a question id not shaped `Q<n>` or used twice; fewer than 2 or more than 4 options; a
`recommended` that is not one of the options; an empty default; a contradiction no question resolves.
One revision, then escalate.

**cap:** at most 12 questions (three AskUserQuestion rounds of four), in rank order. A question that
resolves a contradiction is always asked; the lowest-ranked others make room. The rest become
assumptions `{from: Q<n>, assumption: <its default>, why}`. More than 12 questions that resolve
contradictions escalate: the documents need fixing first. A `resolves` id must be a contradiction in the brief. The recommended option is moved first.

**ledger:** `status` (`needs-human` | `escalate`), `reason`, `brief`, `questions`, `preflight`,
`assumptions`, `history`.

Default stack (in the questioner): the `scaffold-app` stack, or the repo's own in an existing repo. A
question about the stack is asked only when a requirement may force a departure.

## Files

- `workflows/blueprint-design.js`: the graph. Helpers marked `// shared` are copied verbatim from the
  QA graph's script, and a test fails if they drift.
- `agents/`: extractor, questioner.
- `skills/blueprint/SKILL.md`: the `/blueprint` orchestrator. State lives in
  `$(git rev-parse --path-format=absolute --git-path harness-blueprint)`, never committed. The interview
  is the only AskUserQuestion use: preflight and assumption overrides come back in one reply.
- `tests/blueprint-design.test.mjs`: routing tests, run by `scripts/test-workflow.sh`.
- Run 2 will receive the saved state through the shared `core/skills/workflow-state` script.

## Credits

The one-choice-per-question rule is adapted from gstack's `plan-eng-review`
([gstack](https://github.com/garrytan/gstack), MIT, © Garry Tan).
