---
name: backlog
description: The format of an app's backlog (docs/backlog.json) - ordered /dev-sized slices with requirements, pass/fail acceptance criteria, and earlier-only dependencies - plus the build ledger and the rules for which slice runs next, when a slice is re-planned or blocked, and when an unattended build stops. Used by /blueprint (writes the backlog) and /build-app (builds it); use when writing, checking, or reasoning about a backlog.
---

# backlog

A backlog turns an approved design into slices that `/dev` can build one at a
time, unattended. `/blueprint` writes it to `docs/backlog.json` in the app's
repo, after the human's one approval, and nothing else writes it. `/build-app`
reads it and keeps its progress in a ledger inside `.git`.

`backlog.mjs` in this skill owns every rule below. Check a file with:

```
node ~/.claude/skills/backlog/backlog.mjs check docs/backlog.json
```

It prints one line per problem, then `BACKLOG: PASS` or `BACKLOG: FAIL`.

`/dev --slice S<n>` gets its task from the same file:

```
node ~/.claude/skills/backlog/backlog.mjs task docs/backlog.json S2 [ledger.json]
```

It prints `{slice, app, task, requiredCriteria}` as JSON: the task text (the
slice's goal and every criterion, plus each earlier reason and answer from the
build ledger) and the criteria the plan must carry unchanged.

## The format

```json
{
  "version": 1,
  "app": "reading-list",
  "integrationBranch": "integration/reading-list",
  "requirements": ["R1", "R2"],
  "slices": [
    {
      "id": "S1",
      "title": "Book list storage",
      "goal": "Store books with title, author, and read state, and list them newest first.",
      "requirements": ["R1"],
      "acceptance": [
        { "id": "S1-AC1", "criterion": "A saved book is listed with its title and author", "fails_when": "the list is empty or shows another book after saving one" }
      ],
      "depends_on": []
    },
    {
      "id": "S2",
      "title": "Mark a book read",
      "goal": "Toggle a book between to-read and read, and keep it across restarts.",
      "requirements": ["R2"],
      "acceptance": [
        { "id": "S2-AC1", "criterion": "Marking a book read moves it to the read list", "fails_when": "the book stays in to-read after marking it" },
        { "id": "S2-AC2", "criterion": "Read state survives a restart", "fails_when": "a restart resets a read book to to-read" }
      ],
      "depends_on": ["S1"]
    }
  ]
}
```

Rules the check enforces:
- `app` is a lowercase slug, and `integrationBranch` is `integration/<app>`.
- `requirements` lists every requirement id of the design (`R<n>`), each once, and
  every one is in at least one slice.
- Slice ids run `S1`, `S2`, ... in build order. A slice has a title, a goal, a
  `requirements` list (it may be empty, for a scaffold slice), 1 to 8
  acceptance criteria with ids `S<n>-AC1`, `S<n>-AC2`, ... and a non-empty
  `fails_when` each, and `depends_on` naming only earlier slices, so there is
  never a cycle.
- At most 40 slices.
- A goal never says "stop and ask", and neither does a title, criterion, or
  `fails_when`: a slice is `/dev`'s task text, `/dev` lets task text override
  its no-ask rule, and an unattended build has no one to ask.

What the check cannot see is the advisor's job at the backlog gate: whether
each slice is small enough for one `/dev` run, whether the criteria really
prove the requirements, and whether the order builds each owner before its users.

## The ledger and the next step

The `/build-app` driver keeps `.git/harness-build/ledger.json`, never
committed: per slice its status (`pending`, `done`, `blocked`), escalations,
re-plans, reasons, questions, and the test files it froze when it landed.

- **Next slice:** the first slice in order that is pending, not blocked, and
  whose dependencies are all done. A slice that escalated since the last
  landing goes after the others, so one stuck slice does not hold up
  independent work.
- **Blocked:** a slice is blocked when only a human can unblock it (`/dev`
  returned questions), or when it is stuck: it escalated twice, was re-planned
  from scratch with every reason so far, and escalated twice again. Every slice
  that depends on a blocked slice is blocked too. The rest keep building.
- **Frozen tests:** when a slice lands, its test files freeze. A later slice
  that changes one does not land.
- **Brakes:** the build stops and pings the human on the first of
  - a third re-plan in the app (the design or the backlog is wrong),
  - three different slices escalating with none landing in between
    (something shared is broken),
  - every remaining slice blocked.
- **The way back in:** after a brake, `resume` starts the first two counters
  over (the human has looked). A blocked slice stays blocked until `unblock`
  gives it the human's answers; it then starts from a fresh plan with fresh
  counts, and keeps its earlier reasons and every earlier answer.
