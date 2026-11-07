# Lens: integration and contracts

lens-token: contract-r8v2

Hunt for places where the change and the code around it no longer agree.

- **Changed signatures.** For every function, method, route, event, or command
  whose parameters, defaults, return shape, or thrown errors the change alters,
  find every caller (`grep` the name across the repo, not just the diff) and
  check each one against the new contract.
- **Shapes over a boundary.** JSON fields renamed, removed, retyped, or made
  optional; enum values added that a consumer's `switch` does not handle; a
  response that is now sometimes a list and sometimes an object; null where
  there was a default.
- **Serialization.** Write a value and read it back: dates, big numbers,
  `undefined` versus missing, ordering, and character encoding. Compare the
  writer and the reader in the same change.
- **Schemas and migrations.** A column, index, or constraint the code now
  assumes but no migration adds, or a migration the code does not match.
- **Dependencies.** A library call used with arguments its version does not
  accept, or a return value used as if it were a different type. Read the
  installed library's code or types, not your memory of it.
- **Configuration.** A new environment variable or setting read without a
  default where the old code had one, or under a different name than where it
  is set.

A finding here names the caller (or consumer) and the callee at `file:line`
and the exact mismatch. "Callers might break" with no caller named is not a
finding.
