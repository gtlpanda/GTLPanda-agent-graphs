// evidence.test.mjs — evidence.mjs runs real reproduction tests (node --test)
// in throwaway repos: every verdict, the guards on what it will run, the
// sandbox, and recheck correcting a ledger to what the runs show.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { sandboxEnv, testFileProblems, runnerFor, verdictOf, markerFor } from '../skills/bughunt/evidence.mjs'
import { mergeFindings, writeLedger, readLedger, emptyLedger } from '../../../core/skills/findings/findings.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(here, '..', 'skills', 'bughunt', 'evidence.mjs')
const INTAKE = join(here, '..', 'skills', 'bughunt', 'intake.mjs')
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const ev = (args, env = {}) => spawnSync('node', [EVIDENCE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
const lastLine = out => out.trim().split('\n').at(-1)

// main: sum adds, half divides by 3 (a bug already there). feature: sum
// subtracts (a new bug), double is new and triples, and a test file exists.
const repo = mkdtempSync(join(tmpdir(), 'evidence-test-'))
sh(repo, 'init', '-q', '-b', 'main')
put(join(repo, 'src/sum.mjs'), 'export const sum = (a, b) => a + b\n')
put(join(repo, 'src/half.mjs'), 'export const half = n => n / 3\n')
sh(repo, 'add', '.')
sh(repo, 'commit', '-qm', 'base')
sh(repo, 'checkout', '-q', '-b', 'feature')
put(join(repo, 'src/sum.mjs'), 'export const sum = (a, b) => a - b\n')
put(join(repo, 'src/double.mjs'), 'export const double = n => n * 3\n')
put(join(repo, 'tests/existing.test.mjs'), "import { test } from 'node:test'\ntest('ok', () => {})\n")
sh(repo, 'add', '.')
sh(repo, 'commit', '-qm', 'feature')
const intake = spawnSync('node', [INTAKE, repo], { encoding: 'utf8' })
if (intake.status !== 0) throw new Error(intake.stdout + intake.stderr)
const STATE = dirname(intake.stdout.split('\n')[0])
const worktreesBefore = sh(repo, 'worktree', 'list').split('\n').length

const TEST = (body, imports = '') => `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${imports}\ntest('repro', async () => {\n${body}\n})\n`
const repro = (id, testFile, text) => {
  put(join(STATE, 'repro', id, 'repro.json'), JSON.stringify({ test_file: testFile }))
  if (text !== null) put(join(STATE, 'repro', id, 'files', testFile), text)
}
const evidenceOf = id => JSON.parse(readFileSync(join(STATE, 'evidence', `${id}.json`), 'utf8'))

console.log('== evidence: verdicts from real runs')
await test('a bug the change introduced: fails at the head with its marker, passes at the merge-base -> REPRODUCED', () => {
  repro('F1', 'tests/bughunt-f1.test.mjs', TEST("  assert.equal(sum(2, 2), 4, 'BUGHUNT-F1 sum subtracts')", "import { sum } from '../src/sum.mjs'"))
  const r = ev(['repro', STATE, 'F1'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(lastLine(r.stdout), 'EVIDENCE: REPRODUCED F1')
  assert.match(r.stdout, /EVIDENCE F1 head [0-9a-f]{7}: exit 1, BUGHUNT-F1 seen/)
  assert.match(r.stdout, /EVIDENCE F1 merge-base [0-9a-f]{7}: exit 0/)
  const e = evidenceOf('F1')
  assert.equal(e.verdict, 'REPRODUCED')
  assert.deepEqual(e.runs.map(x => [x.arm, x.exit === 0, x.marker]), [['head', false, true], ['merge-base', true, false]])
  assert.equal(e.test_file, 'tests/bughunt-f1.test.mjs')
})
await test('a bug already at the merge-base -> PREEXISTING', () => {
  repro('F2', 'tests/bughunt-f2.test.mjs', TEST("  assert.equal(half(6), 3, 'BUGHUNT-F2 half divides by three')", "import { half } from '../src/half.mjs'"))
  assert.equal(lastLine(ev(['repro', STATE, 'F2']).stdout), 'EVIDENCE: PREEXISTING F2')
})
await test('a bug in new code: at the merge-base the test fails without its marker (no such module) -> REPRODUCED, saying why', () => {
  repro('F3', 'tests/bughunt-f3.test.mjs', TEST("  const { double } = await import('../src/double.mjs')\n  assert.equal(double(2), 4, 'BUGHUNT-F3 double triples')"))
  const r = ev(['repro', STATE, 'F3'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: REPRODUCED F3')
  assert.match(r.stdout, /the code under test is new/)
})
await test('a test that passes at the head -> NOT_REPRODUCED, and the merge-base never runs', () => {
  repro('F4', 'tests/bughunt-f4.test.mjs', TEST("  assert.equal(sum(2, 0), 2, 'BUGHUNT-F4')", "import { sum } from '../src/sum.mjs'"))
  const r = ev(['repro', STATE, 'F4'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: NOT_REPRODUCED F4')
  assert.doesNotMatch(r.stdout, /merge-base/)
  assert.equal(evidenceOf('F4').runs.length, 1)
})
await test('a test that fails at the head without its marker is no evidence either way -> ERROR, never NOT_REPRODUCED', () => {
  repro('F5', 'tests/bughunt-f5.test.mjs', TEST("  throw new Error('unrelated breakage')"))
  const r = ev(['repro', STATE, 'F5'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F5')
  assert.match(r.stdout, /without its marker/)
})
await test('a test that never ends is killed at the timeout -> ERROR', () => {
  repro('F6', 'tests/bughunt-f6.test.mjs', TEST('  while (true) {}'))
  const r = ev(['repro', STATE, 'F6', '--timeout-ms', '3000'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F6')
  assert.match(r.stdout, /timed out at the head/)
  // node --test runs the file in a child: killing only the runner left it spinning forever.
  const left = spawnSync('pgrep', ['-f', 'bughunt-f6.test.mjs'], { encoding: 'utf8' }).stdout.trim()
  if (left) spawnSync('kill', ['-9', ...left.split('\n')])
  assert.equal(left, '', 'no test process outlives the timeout')
})

console.log('== evidence: what it refuses to run')
await test('a test path outside the repo, absolute, not a test file, or already in the repo -> ERROR, and nothing runs', () => {
  for (const [file, why] of [
    ['../evil.test.mjs', /plain repo-relative path/], ['/tmp/abs.test.mjs', /plain repo-relative path/],
    ['src/notatest.mjs', /must be a test file/], ['tests/existing.test.mjs', /already exists at the head/], ['tests/./x.test.mjs', /plain repo-relative/],
  ]) {
    repro('F7', file, file.startsWith('/') || file.startsWith('..') ? null : TEST("  assert.fail('BUGHUNT-F7')"))
    const r = ev(['repro', STATE, 'F7'])
    assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F7', file)
    assert.match(r.stdout, why, file)
    assert.equal(evidenceOf('F7').runs.length, 0, `${file}: nothing ran`)
  }
})
await test('no repro.json, or a test that is a symlink -> ERROR', () => {
  let r = ev(['repro', STATE, 'F8'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F8')
  assert.match(r.stdout, /no readable repro\.json/)
  put(join(STATE, 'repro', 'F9', 'repro.json'), JSON.stringify({ test_file: 'tests/bughunt-f9.test.mjs' }))
  mkdirSync(join(STATE, 'repro', 'F9', 'files', 'tests'), { recursive: true })
  symlinkSync('/etc/hostname', join(STATE, 'repro', 'F9', 'files', 'tests', 'bughunt-f9.test.mjs'))
  r = ev(['repro', STATE, 'F9'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F9')
  assert.match(r.stdout, /must be a regular file/)
})
await test('a reproducer that wrote into the analysis tree voids the run -> ERROR', () => {
  const tree = join(STATE, 'tree')
  put(join(tree, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b\n')
  repro('F10', 'tests/bughunt-f10.test.mjs', TEST("  assert.equal(sum(2, 2), 4, 'BUGHUNT-F10')", "import { sum } from '../src/sum.mjs'"))
  const r = ev(['repro', STATE, 'F10'])
  sh(tree, 'checkout', '--', '.')
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F10')
  assert.match(r.stdout, /analysis tree was modified/)
})

console.log('== evidence: the sandbox')
await test('secrets never reach the test; ordinary variables do', () => {
  repro('F11', 'tests/bughunt-f11.test.mjs', TEST([
    "  for (const k of ['GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'SLACK_BOT_TOKEN']) assert.equal(process.env[k], undefined, `BUGHUNT-F11 ${k} leaked`)",
    "  for (const k of ['DATABASE_URL', 'SENTRY_DSN', 'STRIPE_KEY', 'KUBECONFIG']) assert.equal(process.env[k], undefined, `BUGHUNT-F11 ${k} leaked`)",
    "  assert.equal(process.env.TZ, 'Etc/UTC', 'BUGHUNT-F11 TZ missing')",
  ].join('\n')))
  const r = ev(['repro', STATE, 'F11'], { GITHUB_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', MY_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'x', DB_PASSWORD: 'x', SLACK_BOT_TOKEN: 'x', DATABASE_URL: 'postgres://u:p@h/db', SENTRY_DSN: 'x', STRIPE_KEY: 'x', KUBECONFIG: '/k', TZ: 'Etc/UTC' })
  assert.equal(lastLine(r.stdout), 'EVIDENCE: NOT_REPRODUCED F11', r.stdout)
})
const unshare = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' }).status === 0
await test(`the test has no network${unshare ? '' : ' (skipped: unshare -rn is not available here)'}`, () => {
  if (!unshare) return
  repro('F12', 'tests/bughunt-f12.test.mjs', TEST([
    "  const net = await import('node:net')",
    "  const reached = await new Promise(res => { const s = net.connect({ host: '1.1.1.1', port: 53, timeout: 3000 }, () => { s.destroy(); res(true) }); s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false) }) })",
    "  assert.equal(reached, false, 'BUGHUNT-F12 the network was reachable')",
  ].join('\n')))
  const r = ev(['repro', STATE, 'F12'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: NOT_REPRODUCED F12', r.stdout)
  assert.match(r.stdout, /network blocked/)
})
await test('the repo under test is never touched: no new worktrees, a clean status, the same branch', () => {
  assert.equal(sh(repo, 'worktree', 'list').split('\n').length, worktreesBefore)
  assert.equal(sh(repo, 'status', '--porcelain'), '')
  assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature')
  assert.ok(!existsSync(join(STATE, 'work', 'F1')), 'each run cleans its exports up')
})

await test('a symlink the commit put in the test\'s path is refused: nothing is written outside the export', () => {
  const victim = mkdtempSync(join(tmpdir(), 'victim-'))
  sh(repo, 'checkout', '-q', '-b', 'with-link')
  symlinkSync(victim, join(repo, 'lnk'))
  sh(repo, 'add', 'lnk')
  sh(repo, 'commit', '-qm', 'link')
  const linked = spawnSync('node', [INTAKE, repo], { encoding: 'utf8' })
  const state = dirname(linked.stdout.split('\n')[0])
  put(join(state, 'repro', 'F1', 'repro.json'), JSON.stringify({ test_file: 'lnk/tests/pwn.test.mjs' }))
  put(join(state, 'repro', 'F1', 'files', 'lnk/tests/pwn.test.mjs'), TEST("  assert.fail('BUGHUNT-F1')"))
  const r = ev(['repro', state, 'F1'])
  sh(repo, 'checkout', '-q', 'feature')
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F1')
  assert.match(r.stdout, /lnk is a symlink in this commit/)
  assert.ok(!existsSync(join(victim, 'tests')), 'nothing was created through the link')
})
await test('a file the commit has where the test\'s directory should be is an ERROR, not a crash', () => {
  repro('F13', 'src/sum.mjs/x.test.mjs', TEST("  assert.fail('BUGHUNT-F13')"))
  const r = ev(['repro', STATE, 'F13'])
  assert.equal(r.status, 0, r.stdout)
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F13')
  assert.match(r.stdout, /src\/sum\.mjs is a file in this commit/)
  assert.ok(!existsSync(join(STATE, 'work', 'F13')), 'the work dir is removed even after an error')
})
// (A grandchild that inherits the test's stdout keeps node --test itself waiting
// on that pipe; that ends as a timeout ERROR, and the namespace still kills it.)
await test('anything that throws during a run is an ERROR verdict with an evidence file, never a crash', () => {
  repro('F16', 'tests/bughunt-f16.test.mjs', TEST("  assert.fail('BUGHUNT-F16')"))
  const work = join(STATE, 'work')
  mkdirSync(work, { recursive: true })
  chmodSync(work, 0o500)   // the export cannot be created
  let r
  try { r = ev(['repro', STATE, 'F16']) } finally { chmodSync(work, 0o755) }
  assert.equal(r.status, 0, r.stdout)
  assert.equal(lastLine(r.stdout), 'EVIDENCE: ERROR F16')
  assert.match(r.stdout, /the run failed: EACCES/)
  assert.equal(evidenceOf('F16').verdict, 'ERROR')
})
await test('a detached grandchild dies with the run, and the run ends when the test does', () => {
  repro('F14', 'tests/bughunt-f14.test.mjs', TEST([
    "  const { spawn } = await import('node:child_process')",
    "  spawn('sleep', ['4' + '43'], { detached: true, stdio: 'ignore' }).unref()",
    "  assert.fail('BUGHUNT-F14 fails right away')",
  ].join('\n')))
  const started = Date.now()
  const r = ev(['repro', STATE, 'F14', '--timeout-ms', '20000'])
  const left = spawnSync('sh', ['-c', "ps -eo pid,args | awk '$2==\"sleep\" && $3==\"443\"{print $1}'"], { encoding: 'utf8' }).stdout.trim()
  if (left) spawnSync('kill', ['-9', ...left.split('\n')])
  assert.notEqual(lastLine(r.stdout), 'EVIDENCE: ERROR F14', r.stdout)
  assert.doesNotMatch(r.stdout, /timed out/)
  assert.ok(Date.now() - started < 15000, 'it finished long before the timeout')
  if (spawnSync('unshare', ['-rnpf', '--kill-child', '--mount-proc', 'true'], { stdio: 'ignore' }).status === 0) assert.equal(left, '', 'no grandchild outlives the run')
})
await test('loopback works inside the sandbox, so a test can start a local server', () => {
  repro('F15', 'tests/bughunt-f15.test.mjs', TEST([
    "  const http = await import('node:http')",
    "  const server = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1')",
    "  await new Promise(r => server.once('listening', r))",
    "  const ok = await new Promise(res => http.get({ host: '127.0.0.1', port: server.address().port }, r => res(r.statusCode === 200)).on('error', () => res(false)))",
    "  server.close()",
    "  assert.equal(ok, true, 'BUGHUNT-F15 loopback unreachable')",
  ].join('\n')))
  const r = ev(['repro', STATE, 'F15'])
  assert.equal(lastLine(r.stdout), 'EVIDENCE: NOT_REPRODUCED F15', r.stdout)
})

console.log('== evidence: recheck')
await test('recheck re-runs what the ledger relies on and corrects a status the runs contradict; a second recheck passes', () => {
  const cand = (id, file) => ({
    file_path: file, line_range: [1, 1], bug_category: 'logic', severity: 'HIGH', confidence: 70, title: `bug ${id}`, description: 'd',
    failure_scenario: { trigger: 't', path: 'p', observable: 'o' }, expected_behavior: 'e', actual_behavior: 'a',
    evidence: [{ file, line: 1, quote: 'x' }], source_agent: 'hunter:logic',
  })
  const head = sh(repo, 'rev-parse', 'HEAD')
  const fs = mergeFindings([], [cand('F1', 'src/sum.mjs'), cand('F2', 'src/half.mjs')], head).findings
  fs[0].verification_status = 'not_reproduced'   // wrong: F1's test reproduces
  fs[1].verification_status = 'preexisting'      // right
  fs[0].reproduction_artifact = { written: true, test_file: 'tests/bughunt-f1.test.mjs' }
  fs[1].reproduction_artifact = { written: true, test_file: 'tests/bughunt-f2.test.mjs' }
  writeLedger(join(STATE, 'ledger.json'), { ...emptyLedger(JSON.parse(readFileSync(join(STATE, 'intake.json'), 'utf8')).key), findings: fs })
  let r = ev(['recheck', STATE])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /RECHECK F1: REPRODUCED \(the ledger said not_reproduced\)/)
  assert.match(r.stdout, /RECHECK F1: corrected not_reproduced -> reproduced/)
  assert.equal(lastLine(r.stdout), 'RECHECK: CORRECTED 1')
  const l = readLedger(join(STATE, 'ledger.json'), 'x')
  assert.equal(l.findings[0].verification_status, 'reproduced')
  assert.equal(l.findings[0].confidence, 90)
  assert.deepEqual(l.findings[0].test_results.map(t => [t.arm, t.marker]), [['head', true], ['merge-base', false]])
  assert.match(l.findings[0].history.at(-1).why, /^evidence recheck/)
  r = ev(['recheck', STATE])
  assert.equal(lastLine(r.stdout), 'RECHECK: PASS')
})
await test('recheck never trusts a claimed run without a written reproduction: it falls back to confirmed', () => {
  const ledgerFile = join(STATE, 'ledger.json')
  const l = readLedger(ledgerFile, 'x')
  l.findings[1].reproduction_artifact = { written: false, reason: 'the reproducer returned nothing' }
  l.findings[1].verification_status = 'reproduced'   // a fabricated runner line, with nothing written
  l.findings[1].confidence = 90
  writeLedger(ledgerFile, l)
  const r = ev(['recheck', STATE])
  assert.match(r.stdout, /RECHECK F2: corrected reproduced -> confirmed/)
  const after = readLedger(ledgerFile, 'x').findings[1]
  assert.equal(after.verification_status, 'confirmed')
  assert.equal(after.confidence, 79)
})

console.log('== evidence: units and usage')
await test('sandboxEnv strips credentials and Claude sign-in, keeps PATH and HOME, sets CI', () => {
  const env = sandboxEnv({ PATH: '/bin', HOME: '/h', LANG: 'C', GOPATH: '/g', GH_TOKEN: 'x', NPM_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', SSH_AUTH_SOCK: 's', STRIPE_SECRET: 'x', SLACK_BOT_TOKEN: 'x', DATABASE_URL: 'x', REDIS_URL: 'x', SLACK_WEBHOOK_URL: 'x', TWILIO_AUTH: 'x', EDITOR: 'vi' })
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'GOPATH', 'HOME', 'LANG', 'NO_COLOR', 'PATH'], 'an allowlist: anything not named is dropped')
})
await test('testFileProblems and runnerFor', () => {
  assert.deepEqual(testFileProblems('tests/a.test.js'), [])
  assert.deepEqual(testFileProblems('pkg/a_test.go'), [])
  assert.ok(testFileProblems('a\\b.test.js').length)
  assert.ok(testFileProblems(undefined).length)
  const d = mkdtempSync(join(tmpdir(), 'runner-'))
  assert.deepEqual(runnerFor('t/a.test.mjs', d), { argv: [process.execPath, '--test', 't/a.test.mjs'], cwd: d })
  const has = cmd => spawnSync('sh', ['-c', cmd], { stdio: 'ignore' }).status === 0
  const py = runnerFor('test_a.py', d)
  if (has('python3 -c "import pytest"')) assert.deepEqual(py.argv.slice(0, 3), ['python3', '-m', 'pytest'])
  else assert.equal(py.error, 'pytest is not installed for python3', 'a missing runner is an error, never a run')
  const go = runnerFor('p/a_test.go', d)
  if (has('go version')) assert.deepEqual(go, { argv: ['go', 'test', './p'], cwd: d })
  else assert.equal(go.error, 'go is not installed')
  assert.ok(testFileProblems('tests/-r.test.js').length, 'no part may start with -')
  assert.ok(testFileProblems('--import=x/a.test.js').length)
  assert.match(runnerFor('a.test.rb', d).error, /no runner for \.rb/)
  writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { vitest: '1' } }))
  assert.match(runnerFor('a.test.ts', d).error, /vitest is not installed/)
})
await test('verdictOf: the merge-base arm decides only after a marked failure at the head', () => {
  const run = (exit, marker, extra = {}) => ({ exit, marker, timedOut: false, error: null, ...extra })
  assert.equal(verdictOf(run(1, true), run(0, false))[0], 'REPRODUCED')
  assert.equal(verdictOf(run(1, true), run(1, true))[0], 'PREEXISTING')
  assert.equal(verdictOf(run(1, true), run(1, false))[0], 'REPRODUCED')
  assert.equal(verdictOf(run(1, true), run(null, false, { timedOut: true }))[0], 'ERROR')
  assert.equal(verdictOf(run(0, true), null)[0], 'NOT_REPRODUCED')
  assert.equal(markerFor('F12'), 'BUGHUNT-F12')
})
await test('usage errors exit 2; a state dir without an intake fails with the reason', () => {
  assert.equal(ev(['repro', STATE, 'X1']).status, 2)
  assert.equal(ev(['repro', STATE]).status, 2)
  assert.equal(ev(['repro', STATE, 'F1', '--timeout-ms', 'soon']).status, 2)
  const r = ev(['repro', mkdtempSync(join(tmpdir(), 'empty-')), 'F1'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^EVIDENCE: ERROR .*intake\.json/m)
})
