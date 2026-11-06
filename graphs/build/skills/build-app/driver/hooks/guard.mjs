#!/usr/bin/env node
// PreToolUse guard for /build-app sessions, which run with bypassPermissions.
// Permission rules match command text only (`git -C . push` slips past
// `Bash(git push *)`), so this hook is the boundary; it is inert outside the
// driver. Measured 2026-11-05: a hook deny holds under bypassPermissions in
// headless `claude -p`, also inside subagents. The rules are in guard-rules.mjs;
// the driver's own checks after the session are the backstop for anything else.
import { readFileSync } from 'node:fs'
import { decide } from './guard-rules.mjs'

if (process.env.HARNESS_BUILD_ACTIVE !== '1' || !process.env.HARNESS_BUILD_GUARD) process.exit(0)
let input
let rules
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
  rules = JSON.parse(readFileSync(process.env.HARNESS_BUILD_GUARD, 'utf8'))
} catch {
  process.exit(0)
}
const reason = decide(input.tool_name || '', input.tool_input || {}, rules)
if (reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `build-app guard: ${reason}` } }))
}
process.exit(0)
