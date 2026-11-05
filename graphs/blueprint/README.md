# Blueprint graph (`blueprint-design`)

Plans an app or a feature before any code exists. It reads what you give it (a
design doc, an architecture, a feature request, or a bare idea, plus the repo),
asks you once, up front, about only the decisions that are expensive to change,
records the answers as binding decisions, then designs against them behind the
advisor's design gate. Entry point: the `/blueprint` skill.

Status: **run 1 (intake and interview)** passed its first live run (a reading-list
app: 8 questions in about a minute). **Run 2 (design and the advisor's design gate)**
passed its live run on the same app. The first attempt took 21 minutes and escalated, because the
second gate reviewed the whole design again. With the re-gate, it was approved in round 2 with 6
notes (retro 14). Research and spikes (run 2's evidence) and run 3 (backlog of `/dev`-sized
slices, the knowledge map, preflight, your one approval) are planned, not built.

## Graph (run 1: `stage: interview`, the default)

Code routes; agents are leaves and never call each other.

```
extractor --malformed brief--> extractor (once, with the problems) --still--> escalate
          --brief--> questioner --malformed--> questioner (once) --still--> escalate
                                --questions--> cap at 12 (contradictions always asked)
                                               --> needs-human: /blueprint asks, saves binding decisions
```

## Graph (run 2: `stage: design`)

```
architect --structure problems--> architect (next round)
          --well formed--> advisor (Gating a design) --approve--> design-ready (reported, nothing written)
                                                     --revise--> architect (next round) --> re-gate: checks only the
                                                                  blocking issues it sent back; anything else is a note
                                                     --blocked--> needs-human: each question names the id it challenges;
                                                                  /blueprint asks, the answer replaces that id, reruns (2 rounds max)
at most 3 architect rounds, then escalate with the open issues
```

## Roles

| Role         | Who                     | Model  | Effort | Called                         |
|--------------|-------------------------|--------|--------|--------------------------------|
| Orchestrator | the `/blueprint` session | opus  | high   | once per request; asks, saves  |
| Extractor    | `agents/extractor.md`   | sonnet | high   | once, plus one revision        |
| Questioner   | `agents/questioner.md`  | sonnet | high   | once, plus one revision        |
| Architect    | `agents/architect.md`   | sonnet | high   | once, plus up to two revisions |
| Design gate  | `core/agents/advisor.md` | fable | high   | after each well-formed design  |

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

**ledger:** `status` (`needs-human` | `escalate` | `design-ready`), `reason`, `brief`, `questions`, `preflight`,
`assumptions` (each with an `id`: `A<n>`, or the `Q<n>` of a question past the cap, so an override
names it exactly), `design`, `gate`, `designRounds`, `issues`, `history`. In stage design,
`questions` holds the gate's `{about, question}` entries.

**design args:** `repo`, `stage: "design"`, `statePath` (absolute `state.json`), `mode`, `requirements` (ids),
`decisions` (`{id, answer}`), `assumptions` (ids); the skill builds them with one pinned command. Decision
and assumption ids are any unique non-empty strings (`Q<n>`, `A<n>` overrides, `D<n>` gate answers); one id
cannot be both.

**design** (architect): `{summary, modules[] {id: M1.., name, responsibility, requirements[], boundary, shapes[] {name, sketch}, pick, depth_reason},
failure_modes[] {id: F1.., what, module, silent, tested, handled, plan}, adrs[] {id: ADR1.., title, options[], decision, reason},
departures[] {what, default, reason, adr}, honors[] {id, how}, knowledge[] {id: K1.., knowledge, kind, owner, used_by[], changes_together_because},
premises[] {claim, evidence, status: VERIFIED|UNVERIFIED}, conflicts[] {id, why}}`. A decision or assumption that cannot
hold goes in `conflicts` instead of `honors`; an unverified premise only lacks evidence.
Code rejects: no modules; a requirement in no module or an unknown one; a boundary with fewer than two distinct shapes, a pick that
is not one of them, or no depth reason; a failure id not shaped `F<n>` or used twice; a failure that is silent, untested, and unhandled (critical gap); an ADR with
fewer than two options, a decision outside them, or no reason; more than 3 departures (innovation tokens) or one without
an ADR; any decision or assumption id in neither `honors` nor `conflicts`, unknown, listed twice, or in both; a knowledge item with a kind the
`knowledge-map` skill does not define, no `changes_together_because`, a `utils`/`helpers`/`common`/`shared` owner (directory or file), an
unknown user, or (outside `authn`, `authz`, `input-validation`, `money`) fewer than two users. Each goes back as a
blocking issue. The advisor then screens the 8 red flags, premises, and surfaces; `GATE_SCHEMA` is shared with `dev-build.js`.
An `approve` that carries a blocking issue, or leaves any id in `conflicts`, counts as `revise`. Only the first gate reviews the
whole design. A re-gate's blocking issue must start with `#<n>:` (an issue it sent back) or a decision or assumption id; any other
finding becomes a `notes` entry for the human, and a re-gate `revise` with nothing in scope is `design-ready`. A `blocked` question must start with the id it challenges
(`Q2: ...`) or `new: `, or the run escalates; the ledger returns `questions[] {about, question}`.

Default stack: `core/skills/default-stack` (one owner, preloaded by the questioner, architect, and
advisor): the `scaffold-app` stack, or the repo's own in an existing repo. A question about the stack is
asked only when a requirement may force a departure.

## Files

- `workflows/blueprint-design.js`: the graph. Helpers marked `// shared` are copied verbatim from the
  QA graph's script, and a test fails if they drift.
- `agents/`: extractor, questioner, architect.
- `skills/blueprint/SKILL.md`: the `/blueprint` orchestrator. State lives in
  `$(git rev-parse --path-format=absolute --git-path harness-blueprint)` (`request.json`, `run1.json`,
  `state.json`, `run2.json`), never committed. The interview is the only AskUserQuestion use: preflight
  and assumption overrides come back in one reply.
- `tests/blueprint-design.test.mjs`: routing tests, run by `scripts/test-workflow.sh`.
- Run 2 gets ids in args and reads `state.json` itself: the ids are about 0.5 KB, so it needs no injected seam.

## Credits

The one-choice-per-question rule, the two-shapes check, the eight red flags, and the
critical-gap rule are adapted from gstack's `plan-eng-review`
([gstack](https://github.com/garrytan/gstack), MIT, © Garry Tan), which derives the
red flags from pstack's architect skill (MIT, © Lauren Tan).
