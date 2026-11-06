// One headless Claude session: the settings it runs with, starting it, and
// reading its result. runClaude, readResult, and probeUntilAvailable follow the
// autobuild kit's lib/loop.mjs; the settings are this driver's own.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnv } from './proc.mjs'
import { classifyOutcome, parseResetTime, planLimitWait } from './limits.mjs'

// Pinned agents keep their pins (haiku, fable), unpinned ones get Sonnet, and an
// inherited CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL is blanked: set, it forces every
// workflow agent onto one model (measured 2026-11-05). --settings overrides the
// user's settings.json env.
export const SESSION_ENV = {
  CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5',
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0',
  CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: '',
}
// A second layer under the guard hook; command-text rules alone are not a boundary.
export const DENY = ['Bash(git push)', 'Bash(git push *)', 'Bash(git remote *)', 'Bash(git reset --hard*)', 'Bash(git rebase*)', 'Bash(rm -rf /*)', 'Bash(rm -rf ~*)']

export function sessionSettings(hooksDir) {
  const hook = (file, timeout) => ({ type: 'command', command: `node "${join(hooksDir, file)}"`, timeout })
  return {
    env: SESSION_ENV,
    hooks: {
      PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [hook('guard.mjs', 30)] }],
      StopFailure: [{ hooks: [hook('stop-failure.mjs', 30)] }],
    },
    permissions: { deny: DENY },
  }
}

// What a slice session is told besides the /dev command. The user's own
// CLAUDE.md may ask for plan mode, questions, or worktrees; nobody is there.
export const SYSTEM_PROMPT = 'UNATTENDED BUILD (PandaStack /build-app). No human is present. Run the /dev command you were given exactly, and stop when it reports. Never enter plan mode, never ask a question, never push, never switch branches. Where user-level instructions conflict (plan mode, asking before acting, worktree isolation, retro or changelog updates), the /dev skill wins in this session.'

// Running sessions, so stopping the driver stops them instead of orphaning them.
const sessions = new Set()
const sleep = ms => new Promise(r => setTimeout(r, ms))

// SIGTERM every running session, then SIGKILL any still running after `graceMs`.
export async function stopSessions(graceMs = 30_000) {
  const closed = [...sessions].map(child => new Promise(r => { child.once('close', r); child.kill('SIGTERM') }))
  await Promise.race([Promise.all(closed), sleep(graceMs)])
  for (const child of sessions) child.kill('SIGKILL')
}

// Starts `bin` and resolves its exit code (124 on timeout, 127 if it cannot start).
// stdout goes to logFile (stream-json), stderr to logFile.stderr.
export async function runClaude({ bin, repo, args, env, logFile, timeoutMs }) {
  const out = openSync(logFile, 'w')
  const err = openSync(`${logFile}.stderr`, 'w')
  try {
    return await new Promise(resolve => {
      const child = spawn(bin, args, { cwd: repo, env, stdio: ['ignore', out, err] })
      sessions.add(child)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 30_000).unref() }, timeoutMs)
      child.on('close', code => { clearTimeout(timer); sessions.delete(child); resolve(timedOut ? 124 : (code ?? 1)) })
      child.on('error', () => { clearTimeout(timer); sessions.delete(child); resolve(127) })
    })
  } finally {
    closeSync(out)
    closeSync(err)
  }
}

export function sliceArgs({ prompt, model, settingsFile }) {
  return ['-p', prompt, '--model', model, '--permission-mode', 'bypassPermissions', '--settings', settingsFile,
    '--append-system-prompt', SYSTEM_PROMPT, '--output-format', 'stream-json', '--verbose']
}

// The session's final result line, or null.
export function readResult(file) {
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf8').trim().split('\n').reverse()
  for (const line of lines) {
    if (!line.includes('"type":"result"')) continue
    try { return JSON.parse(line) } catch { /* keep looking */ }
  }
  return null
}

export function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').slice(-20000) : ''
}

// How the session ended, from the API's point of view: only error channels are
// read, since the transcript itself may discuss "limits" in product code.
export function sessionVerdict(logFile, stopFailureFile) {
  const result = readResult(logFile)
  const errored = result && (result.is_error || result.subtype !== 'success') ? result : null
  let stopFailure = null
  try { stopFailure = existsSync(stopFailureFile) ? JSON.parse(readFileSync(stopFailureFile, 'utf8')) : null } catch { stopFailure = null }
  return { result, ...classifyOutcome({ stopFailure, result: errored, text: readText(`${logFile}.stderr`) }) }
}

// After a usage limit with no reset time: a one-turn session every probeMinutes
// until usage is back, up to maxWaitHours, or until stopped() is true. Returns { ok, ms }.
export async function probeUntilAvailable({ bin, repo, probeLog, probeMinutes, maxWaitHours, marginMinutes, sleepMs, log, stopped = () => false }) {
  const started = Date.now()
  const deadline = started + maxWaitHours * 3_600_000
  while (Date.now() < deadline && !stopped()) {
    log(`usage limit: reset time unknown; probing again in ${probeMinutes} min`)
    await sleepMs(probeMinutes * 60_000)
    if (stopped()) break
    const code = await runClaude({ bin, repo, args: ['-p', 'Reply with OK.', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--output-format', 'stream-json', '--verbose'], env: buildEnv(), logFile: probeLog, timeoutMs: 5 * 60_000 })
    const result = readResult(probeLog)
    const errored = result && (result.is_error || result.subtype !== 'success') ? result : null
    const verdict = classifyOutcome({ result: errored })
    if (code === 0 && result && result.subtype === 'success' && !result.is_error && verdict.kind === 'normal') {
      log('usage limit: available again')
      return { ok: true, ms: Date.now() - started }
    }
    if (verdict.kind === 'usage_limit') {
      const resetAt = parseResetTime(verdict.message)
      const plan = resetAt && planLimitWait({ resetAt, maxWaitHours: (deadline - Date.now()) / 3_600_000, marginMinutes })
      if (plan && plan.action === 'wait') {
        log(`usage limit: the probe reports a reset at ${resetAt.toISOString()}; waiting until ${plan.resumeAt.toISOString()}`)
        await sleepMs(plan.waitMs)
        return { ok: true, ms: Date.now() - started }
      }
    }
  }
  return { ok: false, ms: Date.now() - started }
}

export function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
