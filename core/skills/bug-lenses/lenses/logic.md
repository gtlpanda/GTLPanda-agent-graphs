# Lens: logic and correctness

lens-token: logic-q4m7

Hunt for code in the change that computes the wrong answer for an input it will
really get.

- **Conditions.** An inverted test, `&&` where `||` was meant, a missing
  `else`, an early `return` that skips work the later code depends on, or a
  `switch` without a `default` or with a fall-through.
- **Boundaries.** Empty, one, many, and the maximum. Zero, negative, NaN, very
  large, and the exact limit (`<` versus `<=`). The first and last element,
  inclusive versus exclusive ranges, and an index used after the length
  changed.
- **Null paths.** A value that can be missing (optional field, failed lookup,
  `find` that returns undefined, empty config) used without a check on a path
  the change adds.
- **State.** A transition the change adds or reorders: what guards it, what
  happens when it runs twice, and what happens when it starts from a state the
  author did not expect.
- **Data transformation.** Mapping, parsing, rounding, unit, encoding, time
  zone, sort order, and stable versus unstable sort. Compare a round trip.
- **Business rules.** The change's own stated intent (the PR title, the commit
  message, a test name) against what the code does.
- **Siblings.** When one of a pair changes (create and update, add and remove,
  the min and max branch), check that the other still agrees.

Trace with real values. Pick the input, walk the lines, and write down the
value at each step. If the result is right, there is no finding.
