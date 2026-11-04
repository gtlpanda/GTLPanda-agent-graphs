---
name: knowledge-map
description: One owner per piece of shared knowledge - the same-knowledge test, when a rule, type, constant, or client gets a single owning module, the anti-patterns, and the format of a repo's docs/knowledge-map.json. Preloaded by the planner, scout, advisor, and reviewer; use when planning, gating, or reviewing code that could duplicate knowledge.
---

# knowledge-map

DRY is about knowledge, not similar-looking code. Every piece of knowledge a
repo relies on (a rule, a type, a constant, an external client) lives in
exactly one module, its owner. Everything else imports it.

## The test

**Same-knowledge test:** if the rule in one copy changes, must the other copy change too? If yes, it is one piece of knowledge and needs one owner. If no, it is coincidental similarity: leave the copies separate.

## Without a map

When the repo has no `docs/knowledge-map.json`, only the test above applies,
plus the rules each agent already had: reuse what exists, and a new
abstraction needs at least two real callers. The owner table, the
anti-patterns, and the rules by role below apply only when the map exists.
Plans then carry empty `owners_used` and `owners_created`, and nothing creates
the map: `/blueprint` does.

## When knowledge gets an owner

| Kind | Gets one owner from |
|------|---------------------|
| `authn`, `authz`, `input-validation` (untrusted input), `money` | its first caller |
| every other kind | its second caller, counting the callers the map plans (`used_by`) as well as real ones |

Any other kind with one caller and no planned second caller: no owner, it stays local.

Kinds: `authn`, `authz`, `input-validation`, `money`, `limit`, `retry`,
`type`, `constant`, `error-shape`, `client`, `fixture`.

An owner is built inside the first slice or component that uses it, with an
interface designed for every caller the map lists. Never in a speculative
"shared" slice ahead of its callers: the backlog changes, and a wrong
abstraction costs more to undo than a copy.

## Anti-patterns

Each is a finding; cite `file:line`.
- A `utils/`, `helpers/`, `common/`, or `shared/` module as an owner. Owners are
  domain modules named for what they know (`policies/workspace`, `billing/price`).
- One owner serving different callers through a boolean or enum flag, or 4+
  parameters to cover their cases: the callers hold different knowledge. Split it.
- An owner with one caller and no planned second caller, for any kind except
  `authn`, `authz`, `input-validation`, and `money` (those get one from the first).
- Re-implementing an item the map owns, or a second module claiming one.
- The same list or shape kept by hand in two places (frontend and backend types,
  form and API validation): name one source and generate or import the other.

## The map: `docs/knowledge-map.json`

Optional, one per repo. `/blueprint` writes it and is the only thing that adds
entries. `/dev` reads it, and when a component builds a planned owner, it
records the owner's path.

```json
{
  "version": 1,
  "items": [
    {
      "id": "K1",
      "knowledge": "who may edit a workspace",
      "kind": "authz",
      "owner": "server/policies/workspace.js",
      "status": "built",
      "used_by": ["S2", "S5"],
      "changes_together_because": "one permission model; a role change applies to every edit path"
    }
  ]
}
```

- `id`: `K` then digits (`/^K\d+$/`; dev-build.js `planProblems` checks the same
  pattern). Never reused.
- `status`: `planned` (`owner` is the intended path, or null) or `built`
  (`owner` is the real path).
- `used_by`: the slices or modules that use it.
- `changes_together_because`: required. If it cannot be filled in, the item is
  not shared knowledge.
- The map file is bookkeeping, not code: it never counts toward a plan's file
  cap, and two components that both list it do not overlap.

## By role

- **Planner**: read the map when it exists. A component that needs a mapped
  item lists its id in `owners_used`; a component that builds a `planned` owner
  lists its id in `owners_created` and `docs/knowledge-map.json` in its
  `files`. Never invent an id: shared knowledge the map lacks goes in `risks`
  as `unmapped shared knowledge: <what>` for the next `/blueprint` re-plan.
  A component that uses an owner another component creates comes after it.
- **Scout**: report every map item the component must use, with the owner's
  `file:line`. For an owner not built yet, give the map's planned path (or
  `not built yet`) and the component that creates it.
- **Implementer**: take each owner's path from the map's current `owner` field
  when you build: an earlier component may have just built it. The brief is a hint.
- **Advisor** (plan gate): `blocking: true` when a component re-implements a
  mapped item; names an id in `owners_created` that the map lacks or does not
  mark `planned`; names an id in `owners_used` that the map lacks, or that is
  neither `built` nor created by an earlier component of the plan; or builds an
  owner somewhere other than the map's `owner` path when one is set. With no
  map, any non-empty `owners_used` or `owners_created` is `blocking: true`.
- **Reviewer**: a copy of a mapped item is HIGH (see `harness-review`).
