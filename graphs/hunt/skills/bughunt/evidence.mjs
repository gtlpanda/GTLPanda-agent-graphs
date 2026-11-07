#!/usr/bin/env node
// evidence.mjs - the only thing in /bughunt that runs code. It runs a
// reproduction test at the head and at the merge-base and decides, from real
// exit codes and a marker in the output, whether the finding is reproduced. No
// model's word goes into the result.
//   node evidence.mjs repro <state dir> F<n> [--timeout-ms <ms>]
//   node evidence.mjs recheck <state dir> [--timeout-ms <ms>]
//
// repro reads the reproducer's files under <state dir>/repro/F<n>/:
//   repro.json         {"test_file": "<repo-relative path of a new test file>"}
//   files/<test_file>  the test
// It never takes a command from anyone: the runner is chosen here from the
// test's language and the repo's own test setup, and called with an argument
// list, never through a shell. Each arm runs in a fresh export of its commit
// (git archive, so the repo itself is never touched), with secrets stripped
// from the environment, a timeout, and no network where `unshare -rn` works.
// It writes <state dir>/evidence/F<n>.json and prints lines ending with
//   EVIDENCE: REPRODUCED|PREEXISTING|NOT_REPRODUCED|ERROR F<n>
// recheck re-runs every reproduction the ledger relies on and corrects the
// ledger to what the runs show (findings.mjs reconcile). It ends with
// RECHECK: PASS (nothing changed) or RECHECK: CORRECTED <n>.
// Exit 0 when it ran, 1 on an error it could not run past, 2 on usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, symlinkSync, realpathSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildEnv, git } from '../../../build/skills/build-app/driver/proc.mjs'
import { TEST_FILE } from '../../../build/skills/build-app/driver/checks.mjs'
import { readLedger, writeLedger, reconcile } from '../../../../core/skills/findings/findings.mjs'

export const VERDICTS = ['REPRODUCED', 'PREEXISTING', 'NOT_REPRODUCED', 'ERROR']
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TEST_BYTES = 200_000
const TAIL_LINES = 40
const ID = /^F[1-9][0-9]*$/

// Anything that looks like a credential never reaches the code under test,
// including how this machine signs in to Claude.
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION)|^(AWS|GH|GITHUB|ANTHROPIC|OPENAI|NPM|CLAUDE|AZURE|GOOGLE|GCP|SSH)_/i
export function sandboxEnv(base = process.env) {
  const env = buildEnv({}, base)
  for (const key of Object.keys(env)) if (SECRET.test(key)) delete env[key]
  return Object.assign(env, { CI: 'true', NO_COLOR: '1' })
}

let netBlockable = null
function canBlockNetwork() {
  if (netBlockable === null) netBlockable = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' }).status === 0
  return netBlockable
}
// Test runners start children (node --test runs each file in one, go test runs
// a compiled binary), and killing only the runner left an endless test running
// forever (measured 2026-11-06). GNU timeout signals its whole process group,
// so it is the wrapper wherever it exists; elsewhere Node's own timeout is the
// fallback, and the evidence says which.
let groupTimeout = null
function canKillGroup() {
  if (groupTimeout === null) groupTimeout = spawnSync('timeout', ['-s', 'KILL', '5', 'true'], { stdio: 'ignore' }).status === 0
  return groupTimeout
}

export const markerFor = id => `BUGHUNT-${id}`

// Problems with the reproducer's declared test path, as plain strings.
export function testFileProblems(testFile) {
  if (typeof testFile !== 'string' || !testFile.trim()) return ['repro.json has no test_file']
  const p = []
  if (testFile.startsWith('/') || testFile.includes('\\') || normalize(testFile) !== testFile || testFile.split('/').includes('..')) p.push(`test_file must be a plain repo-relative path, got ${testFile}`)
  if (!TEST_FILE.test(testFile)) p.push(`test_file must be a test file by this repo's naming (tests/, __tests__/, *.test.*, *_test.go, test_*.py), got ${testFile}`)
  return p
}

// The command for one test file, chosen from its language and the exported
// tree's own setup. Returns {argv} or {error}.
export function runnerFor(testFile, dir) {
  const ext = extname(testFile)
  if (/^\.(m|c)?(j|t)s$/.test(ext)) {
    let pkg = {}
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { /* no package.json: plain node */ }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const bin = name => join(dir, 'node_modules', '.bin', name)
    if (deps.vitest) return existsSync(bin('vitest')) ? { argv: [bin('vitest'), 'run', testFile] } : { error: 'the repo uses vitest but node_modules/.bin/vitest is not installed' }
    if (deps.jest) return existsSync(bin('jest')) ? { argv: [bin('jest'), '--runTestsByPath', testFile] } : { error: 'the repo uses jest but node_modules/.bin/jest is not installed' }
    return { argv: [process.execPath, '--test', testFile] }
  }
  if (ext === '.py') return { argv: ['python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', testFile] }
  if (testFile.endsWith('_test.go')) return { argv: ['go', 'test', `./${dirname(testFile)}`] }
  return { error: `no runner for ${ext || 'files without an extension'}` }
}

// A fresh copy of `sha` in `dir`, from git archive: the repo is never touched,
// so any number of these can run at once.
function exportTree(repo, sha, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tar = spawnSync('git', ['-C', repo, 'archive', '--format=tar', sha], { maxBuffer: 1024 * 1024 * 1024 })
  if (tar.status !== 0) return `git archive ${sha} failed: ${String(tar.stderr).trim()}`
  const x = spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout, maxBuffer: 64 * 1024 * 1024 })
  if (x.status !== 0) return `unpacking ${sha} failed: ${String(x.stderr).trim()}`
  // Installed dependencies are not in git: borrow the repo's, read-only by convention.
  const deps = join(repo, 'node_modules')
  if (existsSync(deps) && !existsSync(join(dir, 'node_modules'))) symlinkSync(deps, join(dir, 'node_modules'))
  return null
}

function runArm(repo, sha, arm, testFile, testText, workDir, timeoutMs, marker) {
  const dir = join(workDir, arm)
  const err = exportTree(repo, sha, dir)
  if (err) return { arm, sha, exit: null, timedOut: false, marker: false, error: err, tail: '' }
  mkdirSync(dirname(join(dir, testFile)), { recursive: true })
  writeFileSync(join(dir, testFile), testText)
  const runner = runnerFor(testFile, dir)
  if (runner.error) return { arm, sha, exit: null, timedOut: false, marker: false, error: runner.error, tail: '' }
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const wrapped = canKillGroup() ? ['timeout', '-s', 'KILL', String(seconds), ...runner.argv] : runner.argv
  const argv = canBlockNetwork() ? ['unshare', '-rn', ...wrapped] : wrapped
  const started = Date.now()
  // Node's timeout is only the backstop when GNU timeout is there.
  const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env: sandboxEnv(), encoding: 'utf8', timeout: canKillGroup() ? (seconds + 10) * 1000 : timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const killed = r.signal === 'SIGKILL' || r.status === 137 || r.status === 124
  const timedOut = (r.error && r.error.code === 'ETIMEDOUT') || (killed && Date.now() - started >= seconds * 1000 - 100)
  return {
    arm, sha, command: runner.argv.map(a => a.replace(dir + '/', '')), network: canBlockNetwork() ? 'blocked' : 'not blocked',
    timeout: canKillGroup() ? 'process group' : 'runner only',
    exit: r.status, timedOut, marker: out.includes(marker),
    error: r.error && !timedOut ? r.error.message : null, tail: out.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'),
  }
}

// The verdict from the two arms. The head must fail with the marker; then the
// merge-base decides: passing, or failing without the marker (the code under
// test is new), means this change introduced it; failing with the marker means
// it was already there.
export function verdictOf(head, base) {
  if (head.error) return ['ERROR', `the test could not run at the head: ${head.error}`]
  if (head.timedOut) return ['ERROR', 'the test timed out at the head']
  if (head.exit === 0) return ['NOT_REPRODUCED', 'the test passes at the head']
  if (!head.marker) return ['NOT_REPRODUCED', 'the test fails at the head without its marker: it fails for another reason']
  if (!base) return ['ERROR', 'the merge-base arm did not run']
  if (base.error) return ['ERROR', `the test could not run at the merge-base: ${base.error}`]
  if (base.timedOut) return ['ERROR', 'the test timed out at the merge-base']
  if (base.exit === 0) return ['REPRODUCED', 'fails at the head with its marker, passes at the merge-base']
  if (!base.marker) return ['REPRODUCED', 'fails at the head with its marker; at the merge-base it fails for another reason (the code under test is new)']
  return ['PREEXISTING', 'fails with its marker at the merge-base too: this change did not introduce it']
}

function readIntake(stateDir) {
  const doc = JSON.parse(readFileSync(join(stateDir, 'intake.json'), 'utf8'))
  if (!doc || !doc.target || !doc.target.head || !doc.target.mergeBase || !doc.repo) throw new Error(`${join(stateDir, 'intake.json')} is not an intake file`)
  return doc
}

// Runs one finding's reproduction and writes its evidence file. Returns
// {id, verdict, reason, runs, lines}.
export function repro(stateDir, id, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const lines = []
  const done = (verdict, reason, extra = {}) => {
    lines.push(`EVIDENCE ${id}: ${reason}`, `EVIDENCE: ${verdict} ${id}`)
    const record = { finding_id: id, verdict, reason, at: new Date().toISOString(), runs: [], ...extra }
    mkdirSync(join(stateDir, 'evidence'), { recursive: true })
    const path = join(stateDir, 'evidence', `${id}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n')
    renameSync(`${path}.tmp`, path)
    return { id, verdict, reason, runs: record.runs, lines }
  }
  const intake = readIntake(stateDir)
  const dir = join(stateDir, 'repro', id)
  let spec
  try { spec = JSON.parse(readFileSync(join(dir, 'repro.json'), 'utf8')) } catch (e) { return done('ERROR', `no readable repro.json in ${dir}: ${e.message}`) }
  const testFile = spec && spec.test_file
  const problems = testFileProblems(testFile)
  if (problems.length) return done('ERROR', problems.join('; '))
  const source = join(dir, 'files', testFile)
  let st
  try { st = lstatSync(source) } catch { return done('ERROR', `the test is missing at ${source}`) }
  if (!st.isFile()) return done('ERROR', `the test at ${source} must be a regular file, not a link or directory`)
  if (st.size > MAX_TEST_BYTES) return done('ERROR', `the test is ${st.size} bytes; the limit is ${MAX_TEST_BYTES}`)
  if (git(intake.repo, ['cat-file', '-e', `${intake.target.head}:${testFile}`]).ok) return done('ERROR', `${testFile} already exists at the head: a reproduction is a new file`)
  // The reproducer may write only its own directory; a changed analysis tree
  // means it wrote where the code under review lives.
  if (intake.tree && existsSync(intake.tree)) {
    const dirty = git(intake.tree, ['status', '--porcelain'])
    if (!dirty.ok || dirty.stdout.trim()) return done('ERROR', 'the analysis tree was modified; reproductions are written only under repro/<id>/', { test_file: testFile })
  }
  const text = readFileSync(source)
  const marker = markerFor(id)
  const work = join(stateDir, 'work', id)
  const head = runArm(intake.repo, intake.target.head, 'head', testFile, text, work, timeoutMs, marker)
  lines.push(`EVIDENCE ${id} runner: ${(head.command || []).join(' ') || 'none'} (network ${head.network || 'n/a'})`)
  lines.push(`EVIDENCE ${id} head ${intake.target.head.slice(0, 7)}: ${head.timedOut ? 'timed out' : head.error ? `error: ${head.error}` : `exit ${head.exit}`}${head.marker ? `, ${marker} seen` : ''}`)
  const needBase = !head.error && !head.timedOut && head.exit !== 0 && head.marker
  const base = needBase ? runArm(intake.repo, intake.target.mergeBase, 'merge-base', testFile, text, work, timeoutMs, marker) : null
  if (base) lines.push(`EVIDENCE ${id} merge-base ${intake.target.mergeBase.slice(0, 7)}: ${base.timedOut ? 'timed out' : base.error ? `error: ${base.error}` : `exit ${base.exit}`}${base.marker ? `, ${marker} seen` : ''}`)
  rmSync(work, { recursive: true, force: true })
  const [verdict, reason] = verdictOf(head, base)
  const runs = [head, base].filter(Boolean).map(r => ({ kind: 'repro', ...r }))
  return done(verdict, reason, { test_file: testFile, runs })
}

// Re-runs every reproduction the ledger relies on, then corrects the ledger to
// match the runs. Returns {checked, corrected, lines}.
export function recheck(stateDir, opts = {}) {
  const intake = readIntake(stateDir)
  const ledgerFile = join(stateDir, 'ledger.json')
  const ledger = readLedger(ledgerFile, intake.key)
  const lines = []
  const evidence = {}
  for (const f of ledger.findings) {
    if (f.stale || !existsSync(join(stateDir, 'repro', f.finding_id, 'repro.json'))) continue
    if (!['confirmed', 'reproduced', 'preexisting', 'not_reproduced'].includes(f.verification_status)) continue
    const r = repro(stateDir, f.finding_id, opts)
    evidence[f.finding_id] = { verdict: r.verdict, reason: r.reason, runs: r.runs }
    lines.push(`RECHECK ${f.finding_id}: ${r.verdict} (the ledger said ${f.verification_status})`)
  }
  const { ledger: next, corrected } = reconcile(ledger, evidence)
  writeLedger(ledgerFile, next)
  for (const c of corrected) lines.push(`RECHECK ${c.finding_id}: corrected ${c.from} -> ${c.to}`)
  lines.push(corrected.length ? `RECHECK: CORRECTED ${corrected.length}` : 'RECHECK: PASS')
  return { checked: Object.keys(evidence).length, corrected: corrected.length, lines }
}

const USAGE = 'usage: evidence.mjs repro <state dir> F<n> [--timeout-ms <ms>] | evidence.mjs recheck <state dir> [--timeout-ms <ms>]'

function main(argv) {
  const opts = {}
  const at = argv.indexOf('--timeout-ms')
  if (at >= 0) {
    const ms = Number(argv[at + 1])
    if (!Number.isInteger(ms) || ms <= 0) { console.error(USAGE); return 2 }
    opts.timeoutMs = ms
    argv = [...argv.slice(0, at), ...argv.slice(at + 2)]
  }
  const [cmd, stateDir, id, ...rest] = argv
  try {
    if (cmd === 'repro' && stateDir && ID.test(id || '') && !rest.length) {
      for (const l of repro(stateDir, id, opts).lines) console.log(l)
      return 0
    }
    if (cmd === 'recheck' && stateDir && id === undefined) {
      for (const l of recheck(stateDir, opts).lines) console.log(l)
      return 0
    }
  } catch (e) {
    console.log(`EVIDENCE: ERROR ${e.message}`)
    return 1
  }
  console.error(USAGE)
  return 2
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
