# Lens: concurrency and state

lens-token: concurrency-t3x9

Hunt for bugs that appear only when two things happen at once, or in an order
the author did not picture.

- **Unawaited async.** A promise not awaited and not returned, so its errors
  vanish or its result is read before it exists. A `forEach` with an async
  callback. A missing `await` before a check that depends on the write.
- **Check-then-act.** Read a value, decide, then write, with no lock,
  transaction, unique constraint, or compare-and-set between them. Name the
  second actor that can interleave.
- **Shared mutable state.** Module-level variables, caches, singletons, or an
  object passed into a callback that more than one request or job touches.
- **Duplicate processing and idempotency.** A handler a queue, webhook, or retry
  can deliver twice. What happens on the second delivery?
- **Retries and timeouts.** A retry that repeats a non-idempotent side effect, a
  timeout that leaves the work running, or a retry without a bound.
- **Transactions.** Work that must succeed or fail together but is split across
  transactions, or an external call made inside a transaction that can then roll
  back.
- **Ordering.** Events or messages assumed to arrive in order, or a listener
  registered after the event it waits for can fire.

Do not invent races from purely local code. A finding here names a realistic
interleaving: actor A does this at line X, actor B does that at line Y, and the
result is Z. If the code can only run on one thread, one request, or one job at
a time, say so and drop it.
