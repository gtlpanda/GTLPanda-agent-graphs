# Lens: regression and specification

lens-token: regression-k2c8

Hunt for behavior that worked at the merge-base and does not at the head.

- **Changed behavior.** For each function the change edits, compare the old
  version (`git show <merge-base>:<file>`) with the new one for the same input.
  A difference the PR's stated intent (title, description, commit messages,
  tests) does not ask for is a candidate.
- **Invariants.** Something the old code guaranteed (sorted output, a non-null
  field, an idempotent call, a bounded size, a permission check) that callers
  rely on and the new code drops.
- **Tests.** An existing test the change deletes, weakens (a looser assertion,
  a skip, a catch-all), or rewrites to match new behavior that is itself wrong.
  The test's old assertion is the specification it broke.
- **Compatibility.** Stored data, files, flags, or messages written by the old
  version that the new version can no longer read; or a default that changed
  under existing users.
- **New edge cases.** A new feature that works for the case the PR describes and
  breaks an existing case that now flows through it.
- **Protections the PR must keep.** The impact analysis lists them. Check each
  one still holds.

A finding here names the input, the old result at the merge-base, and the new
result at the head. Intended behavior changes the PR describes are not
regressions.
