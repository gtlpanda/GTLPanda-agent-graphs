# Lens: error handling and reliability

lens-token: errors-b5n4

Hunt for what goes wrong when something fails: a call, a parse, a disk, a
network, or the input itself.

- **Swallowed errors.** A `catch` that logs and continues as if it worked, a
  callback error argument ignored, or a returned error value never checked. Name
  what the caller then believes that is false.
- **Wrong error.** An exception type or status code a caller does not handle,
  or a success status on failure.
- **Cleanup on failure paths.** A lock, file handle, connection, temp file,
  subscription, or child process opened on the happy path and not released when
  a later step throws. Look for a missing `finally`, `defer`, or `with`.
- **Partial failure.** Step one of two succeeds and step two fails, leaving data
  half-written, a counter incremented, or a message sent with the record never
  saved.
- **Fallbacks.** A default or fallback that hides the failure and produces a
  wrong result, such as an empty list when the fetch failed, or a cached value
  past its validity.
- **Recovery state.** A retry, resume, or restart that reads state the failure
  left corrupt.
- **Resource growth.** A buffer, map, listener, or queue that the change adds to
  on every call and never trims.

A finding here names the failure (the call that throws and why it can) and what
the code then does wrong. "Should handle errors" with no failure that breaks
something is not a finding.
