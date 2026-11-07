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
// recheck re-runs every reproduction and committed fix the ledger relies on and
// corrects the ledger to what the runs show (findings.mjs reconcile). It ends
// with RECHECK: PASS (nothing changed) or RECHECK: CORRECTED <n>.
//
// The repair commands work on the fix worktree, always <state dir>/fix (made by
// /bughunt or the /build-app driver, never by an agent):
//   node evidence.mjs fix <state dir> F<n>          FIX: PASS|FAIL|BLOCKED|ERROR F<n>
//   node evidence.mjs adversarial <state dir> F<n>  ADVERSARIAL: PASS|FAIL|ERROR F<n>
//   node evidence.mjs commit <state dir> F<n>       COMMIT: DONE|FAIL F<n> [<commit>]
//   node evidence.mjs revert <state dir> F<n>       REVERT: DONE|FAIL F<n>
// fix proves a repair three ways: the reproduction passes with it, fails again
// without it (the worktree's last commit), and the repo's own suite passes. It
// stages the repair as a git tree in a private index; the arms run on that tree,
// and commit commits that same tree (no hooks), so what is checked is what is
// committed. Every git call in the fix worktree runs without hooks or
// fsmonitor, in the sandbox environment.
// Exit 0 when it ran, 1 on an error it could not run past, 2 on usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, symlinkSync, realpathSync, openSync, closeSync } from 'node:fs'
import { join, dirname, extname, normalize, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { git as rawGit } from '../../../build/skills/build-app/driver/proc.mjs'
import { TEST_FILE } from '../../../build/skills/build-app/driver/checks.mjs'
import { createHash } from 'node:crypto'
import { readLedger, writeLedger, reconcile, reconcileFix } from '../../../../core/skills/findings/findings.mjs'

export const VERDICTS = ['REPRODUCED', 'PREEXISTING', 'NOT_REPRODUCED', 'ERROR']
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TEST_BYTES = 200_000
const TAIL_LINES = 40
const ID = /^F[1-9][0-9]*$/
// Every git call here runs without hooks or fsmonitor. Both are config the
// user's repo may set with a relative path, and that path resolves inside the
// checkout git runs in: the PR's own code. Measured 2026-11-06: `git status` in
// a worktree of the PR ran a committed fsmonitor script; with these flags it
// did not.
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const git = (dir, args, opts) => rawGit(dir, [...SAFE_GIT, ...args], opts)
const MAX_FIX_FILES = 8                 // source files one repair may change
const MAX_ADVERSARIAL = 5
const SUITE_TIMEOUT_MS = 15 * 60_000
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
const VERIFY_SH = join(HERE, '..', '..', '..', '..', 'core', 'skills', 'verify', 'verify.sh')

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

// One test run in a fresh export of `source.sha` (a commit, or the staged
// tree of a repair).
function runArm(repo, source, arm, testFile, testText, workDir, timeoutMs, marker) {
  const dir = join(workDir, arm)
  const sha = source.sha
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

// The evidence file for one finding, merged by kind: a repro run never erases
// the fix runs, and the reverse. Top-level head, verdict, reason, and test_file
// describe the reproduction; `fix`, `adversarial`, and `commit` carry theirs.
export function readEvidenceRecord(stateDir, id) {
  try { return JSON.parse(readFileSync(join(stateDir, 'evidence', `${id}.json`), 'utf8')) } catch { return { finding_id: id, runs: [] } }
}
function writeEvidence(stateDir, id, kind, runs, fields) {
  const record = readEvidenceRecord(stateDir, id)
  const at = new Date().toISOString()
  if (kind === 'repro') Object.assign(record, fields, { at })
  else record[kind] = { ...fields, at }
  record.finding_id = id
  record.runs = [...(record.runs || []).filter(r => (r.kind || 'repro') !== kind), ...runs.map(r => ({ kind, ...r }))]
  mkdirSync(join(stateDir, 'evidence'), { recursive: true })
  const path = join(stateDir, 'evidence', `${id}.json`)
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n')
  renameSync(`${path}.tmp`, path)
  return record
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
    const runs = extra.runs || []
    writeEvidence(stateDir, id, 'repro', runs, { head: intake.target.head, verdict, reason, test_file: extra.test_file || null })
    return { id, verdict, reason, runs, lines }
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
    const head = runArm(intake.repo, { sha: intake.target.head }, 'head', testFile, text, work, timeoutMs, marker)
    lines.push(`EVIDENCE ${id} runner: ${(head.command || []).join(' ') || 'none'} (network ${head.network || 'n/a'}; ${head.processes || 'n/a'})`)
    lines.push(`EVIDENCE ${id} head ${intake.target.head.slice(0, 7)}: ${head.timedOut ? 'timed out' : head.error ? `error: ${head.error}` : `exit ${head.exit}`}${head.marker ? `, ${marker} seen` : ''}`)
    const needBase = !head.error && !head.timedOut && head.exit !== 0 && head.marker
    const base = needBase ? runArm(intake.repo, { sha: intake.target.mergeBase }, 'merge-base', testFile, text, work, timeoutMs, marker) : null
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
    // test_results carry every run on file for this finding: the reproduction, and any fix runs.
    const all = written ? readEvidenceRecord(stateDir, f.finding_id).runs || r.runs : r.runs
    const out = reconcile(ledger, { [f.finding_id]: { verdict: r.verdict, reason: r.reason, runs: all } })
    ledger = out.ledger
    writeLedger(ledgerFile, ledger)
    corrected.push(...out.corrected)
  }
  // A committed repair is proven again from its commit.
  for (const f of ledger.findings) {
    const sha = f.fix_artifact && f.fix_artifact.commit
    if (f.stale || !sha || !['verified', 'proposed'].includes(f.fix_status)) continue
    const r = recheckFix(stateDir, intake, f.finding_id, sha, f.fix_artifact.branch, opts)
    checked += 1
    lines.push(`RECHECK ${f.finding_id} fix ${sha.slice(0, 7)}: ${r.verdict} (${r.reason})`)
    const out = reconcileFix(ledger, { [f.finding_id]: r })
    ledger = out.ledger
    writeLedger(ledgerFile, ledger)
    corrected.push(...out.corrected)
  }
  for (const c of corrected) lines.push(`RECHECK ${c.finding_id}: corrected ${c.from} -> ${c.to}`)
  lines.push(corrected.length ? `RECHECK: CORRECTED ${corrected.length}` : 'RECHECK: PASS')
  return { checked, corrected: corrected.length, lines }
}

// ---------- repair ----------

// git in the fix worktree, which holds the PR's code: SAFE_GIT, no system
// config, and the sandbox environment. A post-commit hook the PR committed once
// ran here with the full environment (found in review).
function wgit(dir, args, extraEnv = {}) {
  const r = spawnSync('git', ['-C', dir, ...SAFE_GIT, ...args], { encoding: 'utf8', env: { ...sandboxEnv(), GIT_CONFIG_NOSYSTEM: '1', ...extraEnv }, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' }
}

// The fix worktree, checked: <state dir>/fix must be a linked worktree of this
// repo (its .git a plain file pointing into the repo's worktrees/), whose last
// commit descends from the head under review. A .git redirected at the repo
// itself once made commit and revert act on the user's branch (found in
// review). Returns {dir, head} or {error}.
function fixWorktree(stateDir, intake) {
  const dir = join(stateDir, 'fix')
  if (!existsSync(dir)) return { error: `no fix worktree at ${dir}; /bughunt --propose or --fix makes it` }
  let dotgit
  try { dotgit = lstatSync(join(dir, '.git')) } catch { return { error: `${dir} is not a git worktree` } }
  if (!dotgit.isFile()) return { error: `${dir}/.git must be a linked worktree's .git file` }
  const repoCommon = git(intake.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()
  const gitDir = wgit(dir, ['rev-parse', '--absolute-git-dir']).stdout.trim()
  const top = wgit(dir, ['rev-parse', '--show-toplevel']).stdout.trim()
  let inside = false
  try { inside = realpathSync(gitDir).startsWith(`${realpathSync(repoCommon)}/worktrees/`) && realpathSync(top) === realpathSync(dir) } catch { inside = false }
  if (!inside) return { error: `${dir} is not a linked worktree of ${intake.repo}` }
  const head = wgit(dir, ['rev-parse', 'HEAD']).stdout.trim()
  if (!wgit(dir, ['merge-base', '--is-ancestor', intake.target.head, head]).ok) return { error: `the fix worktree's commit ${head.slice(0, 7)} does not descend from the head under review` }
  return { dir, head }
}

// Every path the worktree changed since its last commit, untracked included.
// No rename detection: a rename is a delete plus an add, so a test "moved" away
// is seen as deleted. [{status, path}].
function changesOf(dir) {
  const r = wgit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  if (!r.ok) throw new Error(`git status failed in ${dir}`)
  return r.stdout.split('\0').filter(Boolean).map(e => ({ status: e.slice(0, 2), path: e.slice(3) }))
}

// The tree the repair would commit: HEAD plus every change, ignored files
// excluded, modes and symlink targets included, staged in a private index so
// the worktree's own index is untouched. Both the fingerprint and the arms the
// checks run come from it, so what is checked is what is committed.
function stagedTree(dir, work) {
  mkdirSync(work, { recursive: true })
  const index = { GIT_INDEX_FILE: join(work, `index-${process.pid}`) }
  try {
    if (!wgit(dir, ['read-tree', 'HEAD'], index).ok) throw new Error('git read-tree failed')
    if (!wgit(dir, ['add', '-A'], index).ok) throw new Error('git add failed')
    const t = wgit(dir, ['write-tree'], index)
    if (!t.ok) throw new Error('git write-tree failed')
    return t.stdout.trim()
  } finally {
    rmSync(index.GIT_INDEX_FILE, { force: true })
  }
}

// Files that define what the suite runs or expects. A repair may add one but
// never edit or delete one: changing the test script to "true" made a broken
// repair pass (found in review).
const SUITE_FILE = /(^|\/)(package\.json|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|go\.mod|Makefile|\.mocharc[^/]*|(jest|vitest|vite|karma|playwright|cypress|babel)\.config\.[^/]+|tsconfig[^/]*\.json)$|\.snap$|(^|\/)__snapshots__\/|(^|\/)scripts\/(test|validate)\.sh$/

// The reproduction behind a finding, when one proved it. A finding the
// evidence shows REPRODUCED must have a readable reproduction, or the check
// fails closed; any other finding (approved by the human) is checked without
// one. Returns {repro} | {none: true} | {error}.
function reproFor(stateDir, id) {
  const rec = readEvidenceRecord(stateDir, id)
  if (rec.verdict !== 'REPRODUCED') return { none: true }
  try {
    const spec = JSON.parse(readFileSync(join(stateDir, 'repro', id, 'repro.json'), 'utf8'))
    if (testFileProblems(spec.test_file).length || spec.test_file !== rec.test_file) throw new Error('its repro.json no longer names the test that reproduced it')
    const src = join(stateDir, 'repro', id, 'files', spec.test_file)
    if (!lstatSync(src).isFile()) throw new Error('the test is not a regular file')
    return { repro: { testFile: spec.test_file, text: readFileSync(src) } }
  } catch (e) {
    return { error: `the reproduction that proved this finding is unreadable: ${e.message}` }
  }
}

// The repo's own suite (the verify skill) in `dir`, sandboxed. Returns
// {pass, failing: [step], timedOut, tail}.
function runSuite(dir, workDir, name, timeoutMs) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const argv = wrap(['bash', VERIFY_SH, '.'], seconds)
  const outFile = join(workDir, `${name}.out`)
  const fd = openSync(outFile, 'w')
  const started = Date.now()
  let r
  try {
    r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env: sandboxEnv(), stdio: ['ignore', fd, fd], timeout: (seconds + 15) * 1000, killSignal: 'SIGKILL' })
  } finally { closeSync(fd) }
  const lines = readFileSync(outFile, 'utf8').trimEnd().split('\n')
  const last = lines[lines.length - 1] || ''
  const failing = lines.map(l => l.match(/^  \[(\d+)\] (.+)$/)).filter(m => m && m[1] !== '0').map(m => m[2])
  const timedOut = (r.signal === 'SIGKILL' || r.status === 137 || r.status === 124) && Date.now() - started >= seconds * 1000 - 100
  return { pass: last === 'VERIFY: PASS', failing, timedOut, tail: lines.slice(-TAIL_LINES).join('\n') }
}

// Prints `<KIND> F<n>: <reason>` then `<KIND>: <verdict> F<n>[ <extra>]`.
function report(kind, id, verdict, reason, extra = '') {
  return [`${kind} ${id}: ${reason}`, `${kind}: ${verdict} ${id}${extra ? ` ${extra}` : ''}`]
}

// One command's wall clock: the runner agent's Bash call allows 10 minutes, so
// every arm and suite gets what is left of FIX_BUDGET_MS. A suite that cannot
// fit is BLOCKED, never a guess.
const FIX_BUDGET_MS = 9 * 60_000
function clock(budgetMs) {
  const until = Date.now() + budgetMs
  return { left: () => until - Date.now() }
}

// Proves the repair in the fix worktree for one finding. PASS: commit may
// follow. FAIL: this attempt is wrong (feedback, retry). BLOCKED: no attempt
// can pass the check as things stand (a human decides). ERROR: the check
// cannot run at all.
export function fix(stateDir, id, { timeoutMs = DEFAULT_TIMEOUT_MS, suiteTimeoutMs = SUITE_TIMEOUT_MS, budgetMs = FIX_BUDGET_MS } = {}) {
  const intake = readIntake(stateDir)
  const time = clock(budgetMs)
  const out = (verdict, reason, fields = {}, runs = []) => {
    writeEvidence(stateDir, id, 'fix', runs, { verdict, reason, ...fields })
    return { verdict, reason, lines: report('FIX', id, verdict, reason) }
  }
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return out('ERROR', wt.error)
  // A fresh check: adversarial tests from an earlier attempt never judge this one.
  rmSync(join(stateDir, 'repro', id, 'adversarial'), { recursive: true, force: true })
  const proof = reproFor(stateDir, id)
  if (proof.error) return out('BLOCKED', proof.error)
  const repro = proof.repro || null
  const changes = changesOf(wt.dir)
  if (!changes.length) return out('FAIL', 'the repair changed nothing')
  // A fix may add tests and suite files; it never edits or deletes one that
  // exists, which is how a counterfeit fix makes a suite pass.
  for (const c of changes) {
    if (repro && c.path === repro.testFile) {
      if (!existsSync(join(wt.dir, c.path)) || !readFileSync(join(wt.dir, c.path)).equals(repro.text)) return out('FAIL', `the repair changed the reproduction test ${c.path}; it must stay as written`)
      continue
    }
    const existed = wgit(wt.dir, ['cat-file', '-e', `HEAD:${c.path}`]).ok
    if (existed && TEST_FILE.test(c.path)) return out('FAIL', `the repair changed an existing test, ${c.path}; a fix may add tests, never edit or delete one`)
    if (existed && SUITE_FILE.test(c.path)) return out('FAIL', `the repair changed ${c.path}, which defines what the suite runs; a fix never edits it`)
  }
  const source = changes.filter(c => !TEST_FILE.test(c.path))
  if (source.length > MAX_FIX_FILES) return out('FAIL', `the repair changed ${source.length} source files; a minimal fix changes at most ${MAX_FIX_FILES}`)
  // The reproduction joins the change as its regression test, at a path no
  // earlier fix already took.
  if (repro) {
    if (wgit(wt.dir, ['cat-file', '-e', `HEAD:${repro.testFile}`]).ok) return out('BLOCKED', `${repro.testFile} already exists in the fix worktree (an earlier fix committed a test there); this reproduction needs its own path`)
    const unsafe = unsafeTestPath(wt.dir, repro.testFile)
    if (unsafe) return out('FAIL', unsafe)
    mkdirSync(dirname(join(wt.dir, repro.testFile)), { recursive: true })
    writeFileSync(join(wt.dir, repro.testFile), repro.text)
  }
  const work = join(stateDir, 'work', `${id}-fix`)
  rmSync(work, { recursive: true, force: true })
  const runs = []
  try {
    const tree = stagedTree(wt.dir, work)
    const files = changesOf(wt.dir).map(c => c.path)
    const marker = markerFor(id)
    const armTime = () => Math.min(timeoutMs, time.left())
    if (repro) {
      const fixed = runArm(intake.repo, { sha: tree }, 'fixed', repro.testFile, repro.text, work, armTime(), marker)
      runs.push(fixed)
      if (fixed.error || fixed.timedOut) return out('FAIL', `with the repair the reproduction could not finish: ${fixed.error || 'timed out'}`, { tree }, runs)
      if (fixed.exit !== 0) return out('FAIL', `with the repair the reproduction still fails${fixed.marker ? ' with its marker: the bug is still there' : ' (for another reason)'}`, { tree }, runs)
      const without = runArm(intake.repo, { sha: wt.head }, 'without', repro.testFile, repro.text, work, armTime(), marker)
      runs.push(without)
      if (without.error || without.timedOut || without.exit === 0 || !without.marker) return out('FAIL', 'without the repair the reproduction does not fail with its marker, so it cannot tell a fix from no fix', { tree }, runs)
    }
    // The suite with the repair must pass. Without it, the suite decides only
    // whether the failure is new (FAIL) or was already there (BLOCKED: a
    // regression inside a failing step cannot be told apart, so no such repair
    // is ever committed).
    const suiteTime = () => Math.min(suiteTimeoutMs, time.left() - 5_000)
    if (suiteTime() < 30_000) return out('BLOCKED', 'no time is left in this check for the suite; the suite must fit in what the 9-minute check leaves', { tree }, runs)
    const err = exportTree(intake.repo, tree, join(work, 'suite-fixed'))
    if (err) return out('ERROR', err, { tree }, runs)
    linkDeps(intake.repo, join(work, 'suite-fixed'), '.')
    const withFix = runSuite(join(work, 'suite-fixed'), work, 'suite-fixed', suiteTime())
    runs.push({ arm: 'suite with the repair', sha: tree, exit: withFix.pass ? 0 : 1, timedOut: withFix.timedOut, marker: false, error: null, failing: withFix.failing, tail: withFix.tail })
    if (withFix.pass) return out('PASS', `${repro ? 'the reproduction passes with the repair and fails without it; ' : 'no reproduction proved this finding (the human approved it); '}the suite passes`, { tree, files }, runs)
    if (withFix.timedOut) return out('BLOCKED', 'the suite did not finish in the time this check allows', { tree }, runs)
    if (suiteTime() < 30_000) return out('BLOCKED', 'the suite fails with the repair, and no time is left to see whether it failed without it', { tree }, runs)
    const baseErr = exportTree(intake.repo, wt.head, join(work, 'suite-base'))
    if (baseErr) return out('ERROR', baseErr, { tree }, runs)
    linkDeps(intake.repo, join(work, 'suite-base'), '.')
    const base = runSuite(join(work, 'suite-base'), work, 'suite-base', suiteTime())
    runs.push({ arm: 'suite without the repair', sha: wt.head, exit: base.pass ? 0 : 1, timedOut: base.timedOut, marker: false, error: null, failing: base.failing, tail: base.tail })
    const worse = withFix.failing.filter(step => !base.failing.includes(step))
    if (base.pass || worse.length) return out('FAIL', `the repair breaks the suite: ${worse.length ? worse.join('; ') : 'it passes without the repair and fails with it'}`, { tree }, runs)
    return out('BLOCKED', `the suite already fails without the repair, at ${base.failing.join('; ') || 'a step it could not name (no stack detected?)'}; a regression inside those steps cannot be told apart, so this repair is left for a human`, { tree }, runs)
  } catch (e) {
    return out('ERROR', `the check failed: ${e.message}`, {}, runs)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Runs the fix verifier's adversarial tests against the checked repair. They
// assert correct behavior, so each must pass; the staged tree must be exactly
// the one fix checked (the verifier never edits the worktree).
export function adversarial(stateDir, id, { timeoutMs = DEFAULT_TIMEOUT_MS, budgetMs = FIX_BUDGET_MS } = {}) {
  const intake = readIntake(stateDir)
  const time = clock(budgetMs)
  const out = (verdict, reason, runs = []) => {
    writeEvidence(stateDir, id, 'adversarial', runs, { verdict, reason })
    return { verdict, reason, lines: report('ADVERSARIAL', id, verdict, reason) }
  }
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return out('ERROR', wt.error)
  const checked = readEvidenceRecord(stateDir, id).fix
  if (!checked || checked.verdict !== 'PASS') return out('FAIL', 'the repair has not passed its fix check')
  const work = join(stateDir, 'work', `${id}-adv`)
  rmSync(work, { recursive: true, force: true })
  const runs = []
  try {
    if (stagedTree(wt.dir, work) !== checked.tree) return out('FAIL', 'the worktree changed after the fix check; adversarial tests are run against the checked repair only')
    const dir = join(stateDir, 'repro', id, 'adversarial')
    if (!existsSync(join(dir, 'adversarial.json'))) return out('PASS', 'no adversarial tests were written')
    let files
    try { files = JSON.parse(readFileSync(join(dir, 'adversarial.json'), 'utf8')).test_files } catch (e) { return out('FAIL', `adversarial.json is unreadable: ${e.message}`) }
    if (!Array.isArray(files) || files.length > MAX_ADVERSARIAL) return out('FAIL', `adversarial.json must list at most ${MAX_ADVERSARIAL} test_files`)
    for (const [i, file] of files.entries()) {
      const problems = testFileProblems(file)
      if (problems.length) return out('FAIL', problems.join('; '), runs)
      if (wgit(wt.dir, ['cat-file', '-e', `${checked.tree}:${file}`]).ok) return out('FAIL', `${file} already exists; an adversarial test is a new file`, runs)
      const src = join(dir, 'files', file)
      let st
      try { st = lstatSync(src) } catch { return out('FAIL', `the adversarial test is missing at ${src}`, runs) }
      if (!st.isFile() || st.size > MAX_TEST_BYTES) return out('FAIL', `the adversarial test at ${src} must be a regular file under ${MAX_TEST_BYTES} bytes`, runs)
      if (time.left() < 10_000) return out('FAIL', 'no time is left in this check for the remaining adversarial tests', runs)
      const r = runArm(intake.repo, { sha: checked.tree }, `adversarial-${i + 1}`, file, readFileSync(src), work, Math.min(timeoutMs, time.left()), '\0never')
      runs.push({ ...r, test_file: file })
      if (r.error || r.timedOut || r.exit !== 0) return out('FAIL', `${file} fails against the repair: ${r.error || (r.timedOut ? 'timed out' : `exit ${r.exit}`)}`, runs)
    }
    return out('PASS', `${files.length} adversarial test(s) pass against the repair`, runs)
  } catch (e) {
    return out('ERROR', `the run failed: ${e.message}`, runs)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Commits exactly the tree fix checked, with plumbing (commit-tree and
// update-ref), so no hook can run and nothing unchecked rides along.
export function commit(stateDir, id) {
  const intake = readIntake(stateDir)
  const out = (verdict, reason, sha = '') => {
    writeEvidence(stateDir, id, 'commit', [], { verdict, reason, commit: sha || null })
    return { verdict, reason, sha, lines: report('COMMIT', id, verdict, reason, sha) }
  }
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return out('FAIL', wt.error)
  const checked = readEvidenceRecord(stateDir, id).fix
  if (!checked || checked.verdict !== 'PASS') return out('FAIL', 'the repair has not passed its fix check')
  const work = join(stateDir, 'work', `${id}-commit`)
  try {
    if (stagedTree(wt.dir, work) !== checked.tree) return out('FAIL', 'the worktree changed after the fix check')
    const proof = reproFor(stateDir, id)
    const msg = `bughunt: fix ${id}\n\n${proof.repro ? `Regression test: ${proof.repro.testFile} (fails without this change, passes with it).\n` : ''}Checked by evidence.mjs fix; see the bughunt ledger for the finding.`
    const who = wgit(wt.dir, ['config', 'user.email']).stdout.trim() ? {} : { GIT_AUTHOR_NAME: 'bughunt', GIT_AUTHOR_EMAIL: 'bughunt@localhost', GIT_COMMITTER_NAME: 'bughunt', GIT_COMMITTER_EMAIL: 'bughunt@localhost' }
    const made = wgit(wt.dir, ['commit-tree', checked.tree, '-p', wt.head, '-m', msg], who)
    if (!made.ok) return out('FAIL', `git commit-tree failed: ${made.out.trim()}`)
    const sha = made.stdout.trim()
    const moved = wgit(wt.dir, ['update-ref', '-m', `bughunt: fix ${id}`, 'HEAD', sha, wt.head])
    const synced = moved.ok && wgit(wt.dir, ['reset', '-q']).ok
    if (!synced) return out('FAIL', `could not move the fix worktree to ${sha.slice(0, 7)}: ${moved.out.trim()}`)
    return out('DONE', 'committed in the fix worktree', sha)
  } catch (e) {
    return out('FAIL', `the commit failed: ${e.message}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Puts the fix worktree back to its last commit, ignored files included,
// dropping a failed repair.
export function revert(stateDir, id) {
  const intake = readIntake(stateDir)
  const wt = fixWorktree(stateDir, intake)
  if (wt.error) return { verdict: 'FAIL', lines: report('REVERT', id, 'FAIL', wt.error) }
  const reset = wgit(wt.dir, ['reset', '-q', '--hard', 'HEAD'])
  const clean = wgit(wt.dir, ['clean', '-fdqx'])
  if (!reset.ok || !clean.ok) return { verdict: 'FAIL', lines: report('REVERT', id, 'FAIL', `${reset.out}${clean.out}`.trim()) }
  return { verdict: 'DONE', lines: report('REVERT', id, 'DONE', `the fix worktree is back at ${wt.head.slice(0, 7)}`) }
}

// A committed repair, re-proven from its commit: the commit is still on a
// branch the run kept (the fix worktree's HEAD, or `branch`), the reproduction
// passes at it and fails at its parent. Returns {verdict: PASS|FAIL, reason}.
function recheckFix(stateDir, intake, id, sha, branch, opts) {
  if (!git(intake.repo, ['cat-file', '-e', `${sha}^{commit}`]).ok) return { verdict: 'FAIL', reason: `the fix commit ${sha.slice(0, 7)} no longer exists` }
  const wt = fixWorktree(stateDir, intake)
  const onWorktree = !wt.error && git(intake.repo, ['merge-base', '--is-ancestor', sha, wt.head]).ok
  const onBranch = typeof branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(branch) && git(intake.repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok && git(intake.repo, ['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`]).ok
  if (!onWorktree && !onBranch) return { verdict: 'FAIL', reason: `the fix commit ${sha.slice(0, 7)} is no longer on the fix worktree or ${branch || 'any kept branch'}` }
  const proof = reproFor(stateDir, id)
  if (proof.error) return { verdict: 'FAIL', reason: proof.error }
  if (!proof.repro) return { verdict: 'PASS', reason: 'the commit is kept; no reproduction proved this finding (the human approved it)' }
  const repro = proof.repro
  const parent = git(intake.repo, ['rev-parse', `${sha}^`]).stdout.trim()
  const work = join(stateDir, 'work', `${id}-refix`)
  try {
    const marker = markerFor(id)
    const fixed = runArm(intake.repo, { sha }, 'fixed', repro.testFile, repro.text, work, opts.timeoutMs || DEFAULT_TIMEOUT_MS, marker)
    if (fixed.error || fixed.timedOut || fixed.exit !== 0) return { verdict: 'FAIL', reason: `at the fix commit the reproduction does not pass (${fixed.error || (fixed.timedOut ? 'timed out' : `exit ${fixed.exit}`)})` }
    const without = runArm(intake.repo, { sha: parent }, 'without', repro.testFile, repro.text, work, opts.timeoutMs || DEFAULT_TIMEOUT_MS, marker)
    if (without.error || without.timedOut || without.exit === 0 || !without.marker) return { verdict: 'FAIL', reason: 'at the fix commit\'s parent the reproduction does not fail with its marker' }
    return { verdict: 'PASS', reason: 'the reproduction passes at the fix commit and fails at its parent' }
  } catch (e) {
    return { verdict: 'FAIL', reason: `the recheck failed: ${e.message}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const USAGE = 'usage: evidence.mjs repro|fix|adversarial|commit|revert <state dir> F<n> [--timeout-ms <ms>] | evidence.mjs recheck <state dir> [--timeout-ms <ms>]'
const COMMANDS = { repro, fix, adversarial, commit: (d, id) => commit(d, id), revert: (d, id) => revert(d, id) }

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
    if (COMMANDS[cmd] && stateDir && ID.test(id || '') && !rest.length) {
      for (const l of COMMANDS[cmd](stateDir, id, opts).lines) console.log(l)
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
