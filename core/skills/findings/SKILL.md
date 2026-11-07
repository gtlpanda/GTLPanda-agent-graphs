---
name: findings
description: The record /bughunt keeps for one pull request (a ledger inside .git) - the finding schema every bug hunter, skeptic, reproducer, and repairer fills, stable finding ids across re-runs, the allowed status moves, the computed disposition (pass, changes requested, manual review), the metrics, and the report that keeps confirmed bugs apart from unverified ones. Use when writing, checking, or reasoning about bug findings.
---

# findings

`findings.mjs` in this skill owns every rule below. `/bughunt` keeps one ledger
per pull request at `<git common dir>/bughunt/<key>/ledger.json`, inside `.git`
and never committed. `<key>` is `pr-<n>` for a pull request. For a branch it is
the branch name as a slug plus a short hash of the exact name, so `feat/x` and
`feat-x` never share one. A detached HEAD uses `detached-<commit>`. Only the
detached case keys on a commit; every other key survives a new head, so a new
head finds the same ledger.

```
node ~/.claude/skills/findings/findings.mjs check <ledger.json>
node ~/.claude/skills/findings/findings.mjs save <ledger.json> <intake.json> <result.json> [--repo <tree>]
node ~/.claude/skills/findings/findings.mjs report <ledger.json> [evidence dir]
```

- `check` prints one line per problem, then `FINDINGS: PASS` or `FINDINGS: FAIL`.
- `save` folds one `bughunt-flow` result into the ledger.
  - With `--repo`, it checks each evidence quote against the file it cites at the analysed head.
  - It flags any quote that is not there.
- `report` prints the markdown report.
  - Test results in it come only from the evidence files `evidence.mjs` writes, never from what an agent said.

## A finding

A hunter reports a candidate with these fields. A candidate missing any of them
is dropped before anyone spends a call on it:

- `file_path` (repo-relative) and `line_range` (`[start, end]`).
- `bug_category`: one lens, `logic`, `contract`, `concurrency`, `security`,
  `errors`, or `regression`.
- `title`, `description`, `expected_behavior`, and `actual_behavior`.
- `failure_scenario`: the `trigger` (the input or event), the `path` (the
  code that mishandles it), and the `observable` wrong result. A finding that
  cannot name all three is not a finding.
- `evidence`: at least one `{file, line, quote}` read from the code.
- `severity`: `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`. `CRITICAL` means data
  loss, a security or authorization bypass, or a crash on a normal path.
  `HIGH` means a broken feature or a wrong result in normal use. `MEDIUM` means
  it breaks on an edge case you can name. `LOW` means it is real but contained.
- `confidence`: 0 to 100. Below 60 a candidate is dropped. No finding claims
  more than 79 until a test reproduces it.

The ledger adds the rest of the record, field by field:

- `finding_id`: `F1`, `F2`, and so on, assigned in code.
- `source_agent` and `sources`: the hunter that first found it, and every hunter that found it.
- `verification_status` and `reproduction_artifact`.
- `root_cause`.
- `fix_status` and `fix_artifact`.
- `test_results`: filled only from execution.
- `head`: the commit it was found at.
- `stale`.
- `duplicates`.
- `history`: every status move, with why.

## Ids that survive a re-run

A candidate is the same bug as a known finding when both are in the same file
and either of these holds:

- the titles match once normalized;
- the line ranges are within 5 lines of each other, and the category matches or the titles share half their words.

When a candidate matches a known finding:

- **Same head:** the candidate only adds its hunter to `sources`. A second hunter finding it in the same run counts as a duplicate.
- **New head:** the finding takes the new location and evidence, and goes back to `candidate` to be verified again. One the skeptic refuted stays refuted.
- **Not re-found at the new head:** a known finding is marked `stale`.

## Status moves

| Field | From | To |
|-------|------|----|
| verification_status | candidate | refuted, confirmed, contested |
| | contested | refuted, confirmed |
| | confirmed | reproduced, preexisting, not_reproduced, refuted (folded into a confirmed duplicate) |
| | not_reproduced | reproduced, preexisting |
| fix_status | none | proposed |
| | proposed | verified, rejected |
| | rejected | proposed, unresolved |

`reproduced` means a test failed at the head for the stated reason (its marker
in the output) and passed at the merge-base. `preexisting` means the test also
failed at the merge-base, so the PR did not introduce the bug. Any other move
is an error.

## Disposition

Computed in code, never chosen by a model:

- **manual review:** the last run stopped early.
  - A stopped run never replaces the saved findings; `save` keeps them as they were.
- **changes requested:** a confirmed or reproduced bug above `LOW` is still open.
- **manual review:** a `HIGH` or `CRITICAL` finding is unsettled (a candidate, contested, or not reproduced), or a lens that should have run was not fully covered.
- **pass:** otherwise.

A bug reported twice is one finding when it is in the same file and either of
these holds:

- the lines are within 5 of each other, and the category matches or the titles are similar;
- the title, the category, and a quoted line all match. This catches a bug that a new head moved.

The same generic title far apart in one file is two bugs.

Refuted, pre-existing, stale, and fixed-and-verified findings are never open.
