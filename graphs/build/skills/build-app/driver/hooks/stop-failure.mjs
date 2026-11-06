#!/usr/bin/env node
// StopFailure hook for /build-app sessions: records why a session ended on an API
// error (rate_limit for a usage limit, billing_error, overloaded, ...) so the driver
// waits for a reset instead of counting a failed slice. Inert outside the driver.
// Follows the autobuild kit's hooks/stop-failure.mjs.
import { readFileSync, writeFileSync } from 'node:fs'

if (process.env.HARNESS_BUILD_ACTIVE === '1' && process.env.HARNESS_BUILD_STOP_FAILURE) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    writeFileSync(process.env.HARNESS_BUILD_STOP_FAILURE, `${JSON.stringify({ ...input, recordedAt: new Date().toISOString() }, null, 2)}\n`)
  } catch {
    // Never fail the session over bookkeeping.
  }
}
process.exit(0)
