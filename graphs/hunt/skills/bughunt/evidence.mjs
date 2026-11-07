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
// list, never as shell text. Each arm runs in a fresh export of its commit
// (git archive, so the repo itself is never touched), with only an allowlist
// of the environment, a timeout, and, where unshare works, no network and its
// own PID namespace (see isolation()).
// It writes <state dir>/evidence/F<n>.json and prints lines ending with
//   EVIDENCE: REPRODUCED|PREEXISTING|NOT_REPRODUCED|ERROR F<n>
// recheck re-runs every reproduction the ledger relies on and corrects the
// ledger to what the runs show (findings.mjs reconcile). It ends with
// RECHECK: PASS (nothing changed) or RECHECK: CORRECTED <n>.
// Exit 0 when it ran, 1 on an error it could not run past, 2 on usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, symlinkSync, realpathSync, openSync, closeSync } from 'node:fs'
import { join, dirname, extname, normalize, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { git } from '../../../build/skills/build-app/driver/proc.mjs'
import { TEST_FILE } from '../../../build/skills/build-app/driver/checks.mjs'
import { readLedger, writeLedger, reconcile } from '../../../../core/skills/findings/findings.mjs'

export const VERDICTS = ['REPRODUCED', 'PREEXISTING', 'NOT_REPRODUCED', 'ERROR']
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TEST_BYTES = 200_000
const TAIL_LINES = 40
const ID = /^F[1-9][0-9]*$/

// Only an allowlist of the environment reaches the code under test: what a
// toolchain needs to find itself. Never a credential, a database URL, a
// webhook, or how this machine signs in to Claude.
const ENV_ALLOW = /^(PATH|HOME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TMPDIR|TMP|TEMP|USER|LOGNAME|SHELL|TZ|NODE_ENV|NODE_PATH|GOPATH|GOROOT|GOCACHE|GOMODCACHE|GOFLAGS|GOTOOLCHAIN|PYTHONPATH|PYTHONHOME|VIRTUAL_ENV|CONDA_PREFIX|JAVA_HOME|CARGO_HOME|RUSTUP_HOME)$/
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION)/i
export function sandboxEnv(base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base)) if (ENV_ALLOW.test(key) && !SECRET.test(key)) env[key] = value
  return Object.assign(env, { CI: 'true', NO_COLOR: '1' })
}

// What this machine can isolate, probed once. Measured on WSL2 (2026-11-06):
// - unshare -rnpf --kill-child gives a fresh PID namespace, so every process a
//   test starts, detached ones included, dies with the run;
// - inside it, `ip link set lo up` brings loopback back, so a test can start a
//   local server while the outside network stays unreachable;
// - GNU timeout -s KILL ends the whole group at the limit.
// Without the namespace, killing only the runner left a node --test child
// spinning forever, and a detached grandchild survived the run.
let probed = null
export function isolation() {
  if (probed) return probed
  const ok = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
  const pidns = ok('unshare', ['-rnpf', '--kill-child', '--mount-proc', 'true'])
  probed = {
    pidns,
    network: pidns || ok('unshare', ['-rn', 'true']),
    loopback: pidns && ok('unshare', ['-rnpf', '--kill-child', '--mount-proc', 'sh', '-c', 'ip link set lo up']),
    timeout: ok('timeout', ['-s', 'KILL', '5', 'true']),
  }
  return probed
}
// The command line around a runner's argv. The shell string is fixed; the argv
// follows it as positional arguments, never as shell text.
function wrap(argv, seconds) {
  const i = isolation()
  const timed = i.timeout ? ['timeout', '-s', 'KILL', String(seconds), ...argv] : argv
  if (i.pidns) return ['unshare', '-rnpf', '--kill-child', '--mount-proc', 'sh', '-c', `${i.loopback ? 'ip link set lo up 2>/dev/null; ' : ''}exec "$@"`, 'sh', ...timed]
  return i.network ? ['unshare', '-rn', ...timed] : timed
}

export const markerFor = id => `BUGHUNT-${id}`

// Problems with the reproducer's declared test path, as plain strings. No
// component may start with "-", so the path can never be read as a flag.
export function testFileProblems(testFile) {
  if (typeof testFile !== 'string' || !testFile.trim()) return ['repro.json has no test_file']
  const p = []
  if (testFile.startsWith('/') || testFile.includes('\\') || testFile.includes('\0') || normalize(testFile) !== testFile || testFile.split('/').includes('..')) p.push(`test_file must be a plain repo-relative path, got ${JSON.stringify(testFile)}`)
  if (testFile.split('/').some(part => part.startsWith('-'))) p.push(`no part of test_file may start with "-", got ${JSON.stringify(testFile)}`)
  if (!TEST_FILE.test(testFile)) p.push(`test_file must be a test file by this repo's naming (tests/, __tests__/, *.test.*, *_test.go, test_*.py), got ${JSON.stringify(testFile)}`)
  return p
}

// Whether a tool is installed, asked where no code under review can answer: from
// an empty temp directory, in Python's isolated mode (-I: no current directory
// or user site on the path), with the sandbox environment and a short limit. A
// probe run inside the export once imported a pytest.py the PR committed, with
// the full environment and no sandbox (found in review, 2026-11-06).
function toolInstalled(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore', cwd: tmpdir(), env: sandboxEnv(), timeout: 20_000, killSignal: 'SIGKILL' }).status === 0
}

// The package a JavaScript test belongs to: the nearest directory above it
// with a package.json ('.' for the root). A monorepo has several.
export function packageDirOf(testFile, dir) {
  let d = dirname(testFile)
  while (d !== '.' && !existsSync(join(dir, d, 'package.json'))) d = dirname(d)
  return d
}

// The command for one test file, chosen from its language and the exported
// tree's own setup. Returns {argv, cwd} or {error}.
export function runnerFor(testFile, dir) {
  const ext = extname(testFile)
  if (/^\.(m|c)?(j|t)s$/.test(ext)) {
    const pkgDir = packageDirOf(testFile, dir)
    const root = pkgDir === '.' ? dir : join(dir, pkgDir)
    const rel = pkgDir === '.' ? testFile : testFile.slice(pkgDir.length + 1)
    let pkg = {}
    try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { /* no package.json: plain node */ }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const bin = name => [join(root, 'node_modules', '.bin', name), join(dir, 'node_modules', '.bin', name)].find(b => existsSync(b))
    if (deps.vitest) return bin('vitest') ? { argv: [bin('vitest'), 'run', rel], cwd: root } : { error: 'the package uses vitest but node_modules/.bin/vitest is not installed' }
    if (deps.jest) return bin('jest') ? { argv: [bin('jest'), '--runTestsByPath', rel], cwd: root } : { error: 'the package uses jest but node_modules/.bin/jest is not installed' }
    return { argv: [process.execPath, '--test', rel], cwd: root }
  }
  if (ext === '.py') {
    if (!toolInstalled('python3', ['-I', '-c', 'import pytest'])) return { error: 'pytest is not installed for python3' }
    return { argv: ['python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', testFile], cwd: dir }
  }
  if (testFile.endsWith('_test.go')) {
    if (!toolInstalled('go', ['version'])) return { error: 'go is not installed' }
    return { argv: ['go', 'test', `./${dirname(testFile)}`], cwd: dir }
  }
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
  return null
}

// Installed dependencies are not in git: link the repo's own, at the root and
// for the test's package.
function linkDeps(repo, dir, pkgDir) {
  for (const d of new Set(['.', pkgDir])) {
    const from = join(repo, d, 'node_modules')
    const to = join(dir, d, 'node_modules')
    if (existsSync(from) && existsSync(join(dir, d)) && !existsSync(to)) symlinkSync(from, to)
  }
}

// The test's directory, walked part by part in the export: a part the commit
// made a symlink (or a file) would send the write outside the export.
function unsafeTestPath(dir, testFile) {
  let cur = dir
  for (const part of testFile.split('/')) {
    cur = join(cur, part)
    let st
    try { st = lstatSync(cur) } catch { return null }
    if (st.isSymbolicLink()) return `${relative(dir, cur)} is a symlink in this commit`
    if (cur !== join(dir, testFile) && !st.isDirectory()) return `${relative(dir, cur)} is a file in this commit, not a directory`
  }
  return null
}

function runArm(repo, sha, arm, testFile, testText, workDir, timeoutMs, marker) {
  const dir = join(workDir, arm)
  const fail = error => ({ arm, sha, exit: null, timedOut: false, marker: false, error, tail: '' })
  const err = exportTree(repo, sha, dir)
  if (err) return fail(err)
  const unsafe = unsafeTestPath(dir, testFile)
  if (unsafe) return fail(unsafe)
  mkdirSync(dirname(join(dir, testFile)), { recursive: true })
  writeFileSync(join(dir, testFile), testText)
  linkDeps(repo, dir, packageDirOf(testFile, dir))
  const runner = runnerFor(testFile, dir)
  if (runner.error) return fail(runner.error)
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const argv = wrap(runner.argv, seconds)
  // Output goes to a file, not a pipe: a child that keeps the pipe open can
  // never hold the run past its own end.
  const outFile = join(workDir, `${arm}.out`)
  const fd = openSync(outFile, 'w')
  const started = Date.now()
  let r
  try {
    r = spawnSync(argv[0], argv.slice(1), { cwd: runner.cwd, env: sandboxEnv(), stdio: ['ignore', fd, fd], timeout: isolation().timeout ? (seconds + 15) * 1000 : timeoutMs, killSignal: 'SIGKILL' })
  } finally {
    closeSync(fd)
  }
  const out = readFileSync(outFile, 'utf8')
  const killed = r.signal === 'SIGKILL' || r.status === 137 || r.status === 124
  const timedOut = Boolean((r.error && r.error.code === 'ETIMEDOUT') || (killed && Date.now() - started >= seconds * 1000 - 100))
  // 126 and 127 are the shell's and timeout's "could not run it": no test ran.
  const notRun = !timedOut && (r.status === 126 || r.status === 127)
  const i = isolation()
  return {
    arm, sha, command: runner.argv.map(a => a.replace(dir + '/', '')),
    network: i.network ? `blocked${i.loopback ? ', loopback up' : ''}` : 'not blocked', processes: i.pidns ? 'own PID namespace' : i.timeout ? 'process group' : 'runner only',
    exit: r.status, timedOut, marker: out.includes(marker),
    error: r.error && !timedOut ? r.error.message : notRun ? `the runner could not start (exit ${r.status})` : null,
    tail: out.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'),
  }
}

// The verdict from the two arms. Only a test that passes at the head is
// NOT_REPRODUCED. A failure without the marker is no evidence either way
// (ERROR): a missing tool, an environment problem, or a test that breaks for
// another reason. After a marked failure at the head, the merge-base decides:
// passing, or failing without the marker (the code under test is new), means
// this change introduced it; failing with the marker means it was already there.
export function verdictOf(head, base) {
  if (head.error) return ['ERROR', `the test could not run at the head: ${head.error}`]
  if (head.timedOut) return ['ERROR', 'the test timed out at the head']
  if (head.exit === 0) return ['NOT_REPRODUCED', 'the test passes at the head']
  if (!head.marker) return ['ERROR', 'the test fails at the head without its marker: it fails for another reason, which is no evidence either way']
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

// Runs one finding's reproduction and writes its evidence file. Never throws
// past a finding: anything that goes wrong is an ERROR verdict. Returns
// {id, verdict, reason, runs, lines}.
export function repro(stateDir, id, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const lines = []
  const intake = readIntake(stateDir)
  const done = (verdict, reason, extra = {}) => {
    lines.push(`EVIDENCE ${id}: ${reason}`, `EVIDENCE: ${verdict} ${id}`)
    const record = { finding_id: id, head: intake.target.head, verdict, reason, at: new Date().toISOString(), runs: [], ...extra }
    mkdirSync(join(stateDir, 'evidence'), { recursive: true })
    const path = join(stateDir, 'evidence', `${id}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n')
    renameSync(`${path}.tmp`, path)
    return { id, verdict, reason, runs: record.runs, lines }
  }
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
  try {
    const head = runArm(intake.repo, intake.target.head, 'head', testFile, text, work, timeoutMs, marker)
    lines.push(`EVIDENCE ${id} runner: ${(head.command || []).join(' ') || 'none'} (network ${head.network || 'n/a'}; ${head.processes || 'n/a'})`)
    lines.push(`EVIDENCE ${id} head ${intake.target.head.slice(0, 7)}: ${head.timedOut ? 'timed out' : head.error ? `error: ${head.error}` : `exit ${head.exit}`}${head.marker ? `, ${marker} seen` : ''}`)
    const needBase = !head.error && !head.timedOut && head.exit !== 0 && head.marker
    const base = needBase ? runArm(intake.repo, intake.target.mergeBase, 'merge-base', testFile, text, work, timeoutMs, marker) : null
    if (base) lines.push(`EVIDENCE ${id} merge-base ${intake.target.mergeBase.slice(0, 7)}: ${base.timedOut ? 'timed out' : base.error ? `error: ${base.error}` : `exit ${base.exit}`}${base.marker ? `, ${marker} seen` : ''}`)
    const [verdict, reason] = verdictOf(head, base)
    return done(verdict, reason, { test_file: testFile, runs: [head, base].filter(Boolean).map(r => ({ kind: 'repro', ...r })) })
  } catch (e) {
    return done('ERROR', `the run failed: ${e.message}`, { test_file: testFile })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Re-runs every reproduction the ledger relies on and corrects the ledger to
// match, writing it after each finding so a cut-off recheck keeps what it
// proved. A status that claims a run (reproduced, preexisting, not_reproduced)
// with no written reproduction behind it at this head is an ERROR, which takes
// the finding back to confirmed. Returns {checked, corrected, lines}.
export function recheck(stateDir, opts = {}) {
  const intake = readIntake(stateDir)
  const ledgerFile = join(stateDir, 'ledger.json')
  let ledger = readLedger(ledgerFile, intake.key)
  const lines = []
  const corrected = []
  let checked = 0
  for (const f of ledger.findings) {
    if (f.stale || !['confirmed', 'reproduced', 'preexisting', 'not_reproduced'].includes(f.verification_status)) continue
    const written = Boolean(f.reproduction_artifact && f.reproduction_artifact.written === true)
    const claimsRun = f.verification_status !== 'confirmed'
    if (!written && !claimsRun) continue
    let r
    if (!written || !existsSync(join(stateDir, 'repro', f.finding_id, 'repro.json'))) {
      r = { verdict: 'ERROR', reason: 'no reproduction was written for this finding at this head, so its status has no run behind it', runs: [] }
    } else {
      try { r = repro(stateDir, f.finding_id, opts) } catch (e) { r = { verdict: 'ERROR', reason: `the recheck failed: ${e.message}`, runs: [] } }
    }
    checked += 1
    lines.push(`RECHECK ${f.finding_id}: ${r.verdict} (the ledger said ${f.verification_status})`)
    const out = reconcile(ledger, { [f.finding_id]: { verdict: r.verdict, reason: r.reason, runs: r.runs } })
    ledger = out.ledger
    writeLedger(ledgerFile, ledger)
    corrected.push(...out.corrected)
  }
  for (const c of corrected) lines.push(`RECHECK ${c.finding_id}: corrected ${c.from} -> ${c.to}`)
  lines.push(corrected.length ? `RECHECK: CORRECTED ${corrected.length}` : 'RECHECK: PASS')
  return { checked, corrected: corrected.length, lines }
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
