#!/usr/bin/env node
// driver.mjs — the /build-app driver: builds an approved backlog unattended, one
// slice per fresh headless `claude -p "/dev --slice ..."` session, landing each on
// integration/<app> only after its own checks pass.
//
//   node driver.mjs run    --repo <path> --app <slug>   build until done, a brake, or a stop
//   node driver.mjs status --repo <path> --app <slug>   print status.json
//   node driver.mjs stop   --repo <path> --app <slug>   stop a running driver (and its session)
//
// State: <git dir>/harness-build/<app>/ (ledger.json, status.json, driver.pid,
// logs/), never committed. The next-step rules and the brakes are backlog.mjs's.
// The loop's shape (lock, usage-limit waits, independent checks) follows the
// autobuild kit's lib/loop.mjs.
//
// Exit codes: 0 every slice landed   3 a brake (the reason is in status.json)
//   6 preflight failed   7 the API stayed overloaded (run again later)
//   8 a usage limit resets too far away (run again later)
//   9 billing or spend limit   10 auth problem   11 another driver runs for this app
//   12 the repo is in a state the driver will not touch   130 stopped
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateBacklog, ledgerPath, readLedger, writeLedger, nextSlice, frozenFiles, recordOutcome, brake, sliceState,
} from '../../../../../core/skills/backlog/backlog.mjs'
import { parseResetTime, planLimitWait } from './limits.mjs'
import { buildEnv, git, run } from './proc.mjs'
import { sessionSettings, sliceArgs, runClaude, sessionVerdict, probeUntilAvailable, stopSessions, writeJson } from './session.mjs'
import { sliceChecks, devReport, outcomeOf, TEST_FILE } from './checks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || '', '.claude')
export const EXIT = { done: 0, brake: 3, preflight: 6, apiDown: 7, limitTooFar: 8, billing: 9, auth: 10, locked: 11, gitState: 12, stopped: 130 }

// Everything a test may change comes from the environment, with these defaults.
function settingsFromEnv(env = process.env) {
  const num = (k, d) => (env[k] !== undefined && Number.isFinite(Number(env[k])) ? Number(env[k]) : d)
  return {
    bin: env.HARNESS_BUILD_CLAUDE_BIN || 'claude',
    model: env.HARNESS_BUILD_MODEL || 'opus',
    verifyCommand: env.HARNESS_BUILD_VERIFY || `bash "${join(CONFIG_DIR, 'skills', 'verify', 'verify.sh')}"`,
    sessionTimeoutMs: num('HARNESS_BUILD_SESSION_TIMEOUT_MS', 6 * 3_600_000),
    maxSleepMs: num('HARNESS_BUILD_MAX_SLEEP_MS', Infinity),
    maxLimitWaitHours: num('HARNESS_BUILD_MAX_LIMIT_WAIT_HOURS', 26),
    probeMinutes: num('HARNESS_BUILD_PROBE_MINUTES', 30),
    marginMinutes: 3,
    transientWaitMinutes: num('HARNESS_BUILD_TRANSIENT_WAIT_MINUTES', 10),
    maxTransientRetries: 3,
    notify: env.PANDASTACK_NOTIFY || '',
  }
}

export function stateDirOf(repo, app) {
  const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'harness-build'])
  if (!r.ok) throw new Error(`${repo} is not a git repo`)
  return dirname(ledgerPath(r.stdout.trim(), app))
}

// The backlog as the integration branch holds it: slice branches may change the
// working tree's copy, never the one the driver builds from.
function readBacklogAt(repo, integration) {
  const shown = git(repo, ['show', `${integration}:docs/backlog.json`])
  if (!shown.ok) return { problems: [`${integration} has no docs/backlog.json`] }
  let backlog
  try { backlog = JSON.parse(shown.stdout) } catch (e) { return { problems: [`docs/backlog.json on ${integration} is not valid JSON: ${e.message}`] } }
  return { backlog, problems: validateBacklog(backlog) }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// A pid file outlives a SIGKILL or a reboot, and pids are reused: a live pid
// counts only when its command line is still ours (Linux /proc; elsewhere,
// alive is all we can tell).
export function isOurs(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return false
  const cmdline = `/proc/${pid}/cmdline`
  if (!existsSync('/proc/self/cmdline')) return true
  try { return readFileSync(cmdline, 'utf8').split('\0').some(a => a.includes(marker)) } catch { return false }
}
function readPid(file) {
  return existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : 0
}

// After a crash: a pending slice whose `S<n>: ` commits are already on
// integration landed before the ledger was written. Record it, with the test
// files those commits touched, instead of building it again.
function reconcile(repo, integration, backlog, ledger, log) {
  const subjects = git(repo, ['log', '--format=%H %s', integration]).stdout.split('\n').filter(Boolean)
  for (const sl of backlog.slices) {
    if (sliceState(ledger, sl.id).status !== 'pending') continue
    const shas = subjects.filter(l => l.slice(41).startsWith(`${sl.id}: `)).map(l => l.slice(0, 40))
    if (!shas.length) continue
    const files = shas.flatMap(sha => git(repo, ['show', '--name-only', '--no-renames', '--format=', sha]).stdout.split('\n').filter(Boolean))
    const frozen = [...new Set(files)].filter(f => TEST_FILE.test(f) && existsSync(join(repo, f)))
    ledger = recordOutcome(ledger, sl.id, { kind: 'landed', frozen })
    log(`${sl.id}: already on ${integration} (the driver stopped before recording it); recorded as landed`)
  }
  return ledger
}

export async function runDriver({ repo: given, app }, cfg = settingsFromEnv()) {
  // One real path: the guard compares file paths against it.
  const repo = realpathSync(resolve(given))
  const integration = `integration/${app}`
  const state = stateDirOf(repo, app)
  const logs = join(state, 'logs')
  mkdirSync(logs, { recursive: true })
  const files = {
    ledger: join(state, 'ledger.json'), status: join(state, 'status.json'), pid: join(state, 'driver.pid'),
    settings: join(state, 'session-settings.json'), guard: join(state, 'guard.json'), stopFailure: join(state, 'stop-failure.json'), session: join(state, 'session.pid'),
    driverLog: join(logs, 'driver.log'), probe: join(logs, 'probe.jsonl'),
    devLedger: join(git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'harness-dev']).stdout.trim(), 'ledger.json'),
  }
  const log = message => {
    const line = `[${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}] ${message}`
    console.log(line)
    appendFileSync(files.driverLog, `${line}\n`)
  }
  const status = (fields) => writeJson(files.status, { app, integration, pid: process.pid, updatedAt: new Date().toISOString(), ...fields })
  const notify = message => {
    if (!cfg.notify) return
    const r = run('bash', ['-c', `${cfg.notify} "$1"`, 'notify', `build-app ${app}: ${message}`], { timeoutMs: 60_000 })
    if (!r.ok) log(`notify failed (exit ${r.status}): ${r.out.trim().slice(0, 300)}`)
  }
  // Waits end early on a stop, so a stop during an hours-long limit wait is prompt.
  let wake = () => {}
  const sleepMs = ms => new Promise(r => {
    const t = setTimeout(r, Math.min(ms, cfg.maxSleepMs))
    wake = () => { clearTimeout(t); r() }
  })
  const end = (code, state_, message) => {
    log(message)
    status({ state: state_, exitCode: code, message })
    notify(message)
    return code
  }

  // One driver per app, and no session left running by one that was killed.
  const other = readPid(files.pid)
  if (other !== process.pid && isOurs(other, 'driver.mjs')) { log(`another driver (pid ${other}) is building ${app}`); return EXIT.locked }
  const orphan = readPid(files.session)
  if (isOurs(orphan, cfg.bin)) { log(`a session an earlier driver started (pid ${orphan}) is still running in ${repo}; stop it first`); return EXIT.locked }
  writeFileSync(files.pid, String(process.pid))
  let stopping = false
  const onSignal = () => {
    if (stopping) return
    stopping = true
    log('stop requested; ending the running session')
    wake()
    stopSessions().catch(() => {})
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    // ----- preflight -----
    if (!git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${integration}`]).ok) return end(EXIT.preflight, 'failed', `preflight: no branch ${integration}; approve the backlog with /blueprint first`)
    const { backlog, problems } = readBacklogAt(repo, integration)
    if (problems.length) return end(EXIT.preflight, 'failed', `preflight: the backlog on ${integration} does not pass its check: ${problems.join('; ')}`)
    if (backlog.app !== app) return end(EXIT.preflight, 'failed', `preflight: the backlog on ${integration} is for ${JSON.stringify(backlog.app)}, not ${app}`)
    if (git(repo, ['status', '--porcelain']).stdout.trim()) return end(EXIT.preflight, 'failed', 'preflight: the working tree has uncommitted changes; commit or stash them first')
    if (!run('bash', ['-c', `command -v ${JSON.stringify(cfg.bin)}`]).ok) return end(EXIT.preflight, 'failed', `preflight: ${cfg.bin} not found`)
    let ledger
    try { ledger = readLedger(files.ledger) } catch (e) { return end(EXIT.preflight, 'failed', `preflight: ${e.message}`) }
    const reconciled = reconcile(repo, integration, backlog, ledger, log)
    if (reconciled !== ledger) { ledger = reconciled; writeLedger(files.ledger, ledger) }
    writeJson(files.settings, sessionSettings(join(HERE, 'hooks')))
    log(`building ${app}: ${backlog.slices.length} slice(s), ${backlog.slices.filter(s => sliceState(ledger, s.id).status === 'done').length} already landed`)

    let transient = 0
    let limitWaitedMs = 0
    for (;;) {
      if (stopping) return end(EXIT.stopped, 'stopped', 'stopped by request; finished slices stay landed')
      const why = brake(backlog, ledger)
      if (why) return end(EXIT.brake, 'braked', `brake: ${why}`)
      const slice = nextSlice(backlog, ledger)
      if (!slice) return end(EXIT.done, 'done', `every slice landed on ${integration}`)

      // A fresh branch from integration for every attempt. One left by a driver
      // that died mid-attempt is kept first, never reset.
      const branch = `slice/${slice.id}`
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
      if (git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok && git(repo, ['rev-list', '--count', `${integration}..${branch}`]).stdout.trim() !== '0') {
        git(repo, ['branch', '-q', '-f', `attempt/${slice.id}-${stamp}-recovered`, branch])
        log(`${slice.id}: kept the commits a stopped driver left on ${branch} as attempt/${slice.id}-${stamp}-recovered`)
      }
      if (!git(repo, ['checkout', '-q', '-B', branch, integration]).ok) return end(EXIT.gitState, 'failed', `could not create ${branch} from ${integration}`)
      rmSync(files.devLedger, { force: true })
      rmSync(files.stopFailure, { force: true })
      writeJson(files.guard, { repo, frozen: frozenFiles(ledger) })
      const attempt = `${slice.id}-${stamp}`
      const logFile = join(logs, `${attempt}.jsonl`)
      const prompt = `/dev --slice ${slice.id} --base ${integration} --unattended`
      status({ state: 'running', slice: slice.id, message: `building ${slice.id}: ${slice.title}`, log: logFile })
      log(`${slice.id}: ${slice.title} (${prompt})`)
      const code = await runClaude({
        bin: cfg.bin, repo, logFile, timeoutMs: cfg.sessionTimeoutMs, pidFile: files.session,
        args: sliceArgs({ prompt, model: cfg.model, settingsFile: files.settings }),
        env: buildEnv({ HARNESS_BUILD_ACTIVE: '1', HARNESS_BUILD_GUARD: files.guard, HARNESS_BUILD_STOP_FAILURE: files.stopFailure }),
      })
      if (stopping) { setAside(repo, branch, integration, attempt, log); return end(EXIT.stopped, 'stopped', `stopped by request during ${slice.id}; its work is kept on attempt/${attempt}`) }

      const report = devReport(files.devLedger)
      const verdict = sessionVerdict(logFile, files.stopFailure)
      // A session that ended on the API, not on its own work, is not counted.
      if (!report && verdict.kind !== 'normal') {
        setAside(repo, branch, integration, attempt, log)
        if (verdict.kind === 'billing') return end(EXIT.billing, 'failed', `spend or credit limit (${verdict.message}); the driver never spends past a limit`)
        if (verdict.kind === 'auth') return end(EXIT.auth, 'failed', `authentication problem (${verdict.message}); log in again, then resume`)
        if (verdict.kind === 'transient') {
          // An outage is never the slice's failure: past the retries, pause uncounted.
          if (transient >= cfg.maxTransientRetries) return end(EXIT.apiDown, 'paused', `the API stayed overloaded after ${cfg.maxTransientRetries} retries (${verdict.message}); run /build-app resume later`)
          transient += 1
          log(`${slice.id}: API overloaded or server error (${verdict.message}); waiting ${cfg.transientWaitMinutes} min, retry ${transient}/${cfg.maxTransientRetries}, not counted`)
          await sleepMs(cfg.transientWaitMinutes * 60_000)
          continue
        }
        if (verdict.kind === 'usage_limit') {
          const resetAt = parseResetTime(verdict.message)
          const plan = planLimitWait({ resetAt, maxWaitHours: cfg.maxLimitWaitHours - limitWaitedMs / 3_600_000, marginMinutes: cfg.marginMinutes, probeEveryMinutes: cfg.probeMinutes })
          log(`${slice.id}: usage limit (${verdict.message || 'no message'}); not counted`)
          if (plan.action === 'give_up') return end(EXIT.limitTooFar, 'paused', `the usage limit resets around ${plan.resumeAt.toISOString()}, past the ${cfg.maxLimitWaitHours} h wait cap; run /build-app resume after it`)
          status({ state: 'waiting', slice: slice.id, message: `usage limit; retrying ${slice.id}${plan.resumeAt ? ` after ${plan.resumeAt.toISOString()}` : ' when a probe succeeds'}` })
          if (plan.action === 'wait') {
            log(`waiting until ${plan.resumeAt.toISOString()}, then retrying ${slice.id}`)
            limitWaitedMs += plan.waitMs
            await sleepMs(plan.waitMs)
          } else if (!stopping) {
            const waited = await probeUntilAvailable({ bin: cfg.bin, repo, probeLog: files.probe, probeMinutes: cfg.probeMinutes, maxWaitHours: cfg.maxLimitWaitHours, marginMinutes: cfg.marginMinutes, sleepMs, log, stopped: () => stopping })
            limitWaitedMs += waited.ms
            if (!waited.ok && !stopping) return end(EXIT.limitTooFar, 'paused', `usage still unavailable after ${cfg.maxLimitWaitHours} h of probing; run /build-app resume later`)
          }
          continue
        }
      }
      transient = 0
      limitWaitedMs = 0

      const checks = sliceChecks({ repo, integration, branch, sliceId: slice.id, frozen: frozenFiles(ledger), verifyCommand: cfg.verifyCommand })
      const outcome = outcomeOf(report, checks)
      ledger = recordOutcome(ledger, slice.id, outcome)
      if (outcome.kind === 'landed') {
        const landed = git(repo, ['checkout', '-q', integration]).ok && git(repo, ['merge', '-q', '--ff-only', branch]).ok
        if (!landed) return end(EXIT.gitState, 'failed', `${slice.id} passed its checks but could not be fast-forwarded onto ${integration}; nothing was recorded`)
        // A crash right here is repaired by reconcile() on the next run.
        writeLedger(files.ledger, ledger)
        git(repo, ['branch', '-q', '-D', branch])
        log(`${slice.id}: landed (exit ${code}); froze ${outcome.frozen.length} test file(s)`)
        notify(`${slice.id} landed`)
      } else {
        setAside(repo, branch, integration, attempt, log)
        writeLedger(files.ledger, ledger)
        const s = sliceState(ledger, slice.id)
        if (outcome.kind === 'needs-human') {
          log(`${slice.id}: needs a human (${outcome.questions.join(' | ')}); it and its dependents wait, the rest keep building`)
          notify(`${slice.id} needs a human: ${outcome.questions.join(' | ')}`)
        } else {
          log(`${slice.id}: escalated (exit ${code}): ${outcome.reason}${s.stuck ? '; stuck after its re-plan, blocked' : s.replan ? '; next attempt re-plans from scratch' : ''}`)
          if (s.stuck) notify(`${slice.id} is stuck after its re-plan and blocked; it and its dependents wait`)
        }
      }
    }
  } finally {
    rmSync(files.pid, { force: true })
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

// Keeps a failed attempt for a human to read and leaves the tree on integration,
// clean: uncommitted work is committed onto attempt/<id>, never discarded.
function setAside(repo, branch, integration, attempt, log) {
  const dirty = git(repo, ['status', '--porcelain']).stdout.trim()
  if (dirty) {
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '--no-verify', '-m', `build-app: uncommitted work of attempt ${attempt}`])
  }
  const ahead = git(repo, ['rev-list', '--count', `${integration}..HEAD`]).stdout.trim()
  if (ahead !== '0') {
    git(repo, ['branch', '-q', '-f', `attempt/${attempt}`, 'HEAD'])
    log(`kept the attempt on attempt/${attempt}`)
  }
  git(repo, ['checkout', '-q', '-f', integration])
  git(repo, ['branch', '-q', '-D', branch])
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--repo', '--app'].includes(rest[i]) || rest[i + 1] === undefined) return null
    opts[rest[i].slice(2)] = rest[i + 1]
  }
  if (!['run', 'status', 'stop'].includes(cmd) || !opts.repo || !opts.app || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(opts.app)) return null
  return { cmd, repo: opts.repo, app: opts.app }
}

export async function main(argv) {
  const a = parseArgs(argv)
  if (!a) {
    console.error('usage: driver.mjs run|status|stop --repo <path> --app <slug>')
    return 2
  }
  let state
  try { state = stateDirOf(a.repo, a.app) } catch (e) { console.error(`driver: ${e.message}`); return EXIT.preflight }
  if (a.cmd === 'run') return runDriver(a)
  if (a.cmd === 'status') {
    const file = join(state, 'status.json')
    console.log(existsSync(file) ? readFileSync(file, 'utf8').trim() : JSON.stringify({ app: a.app, state: 'never run' }))
    return 0
  }
  const pid = readPid(join(state, 'driver.pid'))
  if (!isOurs(pid, 'driver.mjs')) { console.log(`no driver is running for ${a.app}`); return 0 }
  process.kill(pid, 'SIGTERM')
  console.log(`asked the driver (pid ${pid}) to stop; it ends the running session first`)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code })
}
