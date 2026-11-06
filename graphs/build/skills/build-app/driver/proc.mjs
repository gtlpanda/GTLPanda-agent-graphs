// Process helpers for the /build-app driver. buildEnv follows the autobuild kit
// (~/.autobuild/lib/proc.mjs): a headless session must not inherit the parent
// session's identity or settings env.
import { spawnSync } from 'node:child_process'

// A Claude session exports its settings env (CLAUDE_CODE_*) into its process, so
// a driver started from one would pass on, for example, an old
// CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL that forces every workflow agent onto one
// model (measured 2026-11-05). Nested sessions also misbehave on CLAUDECODE.
export function buildEnv(extra = {}, base = process.env) {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)) delete env[key]
  }
  return Object.assign(env, extra)
}

// Runs a command synchronously; never throws.
export function run(cmd, args, { cwd, env, timeoutMs = 10 * 60_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env || buildEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs })
  return { ok: r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', error: r.error ? r.error.message : null }
}

export function git(repo, args, opts = {}) {
  return run('git', ['-C', repo, ...args], opts)
}

// The last lines of `text`, for a log or a reason.
export function tail(text, lines = 20) {
  return String(text || '').trimEnd().split('\n').slice(-lines).join('\n')
}
