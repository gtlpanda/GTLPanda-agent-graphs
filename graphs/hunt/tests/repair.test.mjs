// repair.test.mjs — evidence.mjs's repair commands (fix, adversarial, commit,
// revert, and recheck of a committed fix) run for real in a throwaway Node
// project whose suite is `npm test` (node --test), through the verify skill.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { mergeFindings, writeLedger, readLedger, emptyLedger } from '../../../core/skills/findings/findings.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(here, '..', 'skills', 'bughunt', 'evidence.mjs')
const INTAKE = join(here, '..', 'skills', 'bughunt', 'intake.mjs')
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const ev = (...args) => spawnSync('node', [EVIDENCE, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV } })
const lastLine = out => out.trim().split('\n').at(-1)

// main: sum adds, double doubles, one passing test of double. feature: sum
// subtracts (the bug). The fix worktree is a branch at the feature head.
const repo = mkdtempSync(join(tmpdir(), 'repair-test-'))
sh(repo, 'init', '-q', '-b', 'main')
put(join(repo, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }))
put(join(repo, 'src/sum.mjs'), 'export const sum = (a, b) => a + b\n')
put(join(repo, 'src/double.mjs'), 'export const double = n => n * 2\n')
put(join(repo, 'tests/double.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { double } from '../src/double.mjs'\ntest('double', () => assert.equal(double(2), 4))\n")
sh(repo, 'add', '.')
sh(repo, 'commit', '-qm', 'base')
sh(repo, 'checkout', '-q', '-b', 'feature')
put(join(repo, 'src/sum.mjs'), 'export const sum = (a, b) => a - b\n')
sh(repo, 'commit', '-qam', 'bug')
const STATE = dirname(spawnSync('node', [INTAKE, repo], { encoding: 'utf8' }).stdout.split('\n')[0])
const HEAD = sh(repo, 'rev-parse', 'HEAD')
const FIX = join(STATE, 'fix')
const TEST_FILE = 'tests/bughunt-f1.test.mjs'
put(join(STATE, 'repro', 'F1', 'repro.json'), JSON.stringify({ test_file: TEST_FILE }))
put(join(STATE, 'repro', 'F1', 'files', TEST_FILE), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from '../src/sum.mjs'\ntest('sum', () => assert.equal(sum(2, 2), 4, 'BUGHUNT-F1 sum subtracts'))\n")
const record = () => JSON.parse(readFileSync(join(STATE, 'evidence', 'F1.json'), 'utf8'))
const reset = () => { sh(FIX, 'reset', '-q', '--hard', 'HEAD'); sh(FIX, 'clean', '-fdq') }
const RIGHT = 'export const sum = (a, b) => a + b\n'

console.log('== repair: before a worktree exists')
await test('no fix worktree -> FIX: ERROR, saying who makes it', () => {
  const r = ev('fix', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'FIX: ERROR F1')
  assert.match(r.stdout, /no fix worktree .*\/bughunt --propose or --fix makes it/)
})
await test('a worktree of another repo at <state>/fix -> FIX: ERROR', () => {
  const other = mkdtempSync(join(tmpdir(), 'other-'))
  sh(other, 'init', '-q', '-b', 'main')
  put(join(other, 'a'), 'a')
  sh(other, 'add', '.')
  sh(other, 'commit', '-qm', 'x')
  sh(other, 'worktree', 'add', '-q', FIX, 'HEAD')
  const r = ev('fix', STATE, 'F1')
  sh(other, 'worktree', 'remove', '--force', FIX)
  assert.equal(lastLine(r.stdout), 'FIX: ERROR F1')
  assert.match(r.stdout, /is not a worktree of/)
})

sh(repo, 'worktree', 'add', '-q', '-b', 'bughunt/test', FIX, HEAD)

console.log('== repair: the fix check')
await test('a repair that changes nothing -> FAIL', () => {
  const r = ev('fix', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /changed nothing/)
})
await test('a change that does not remove the bug: the reproduction still fails with its marker -> FAIL', () => {
  appendFileSync(join(FIX, 'src/sum.mjs'), '// looked at it\n')
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /still fails with its marker: the bug is still there/)
  assert.ok(record().runs.some(x => x.kind === 'fix' && x.arm === 'fixed' && x.marker))
})
await test('a repair that edits an existing test -> FAIL, before anything runs', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  appendFileSync(join(FIX, 'tests/double.test.mjs'), '// weakened\n')
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /changed an existing test, tests\/double\.test\.mjs/)
})
await test('a repair that writes its own version of the reproduction test -> FAIL', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  put(join(FIX, TEST_FILE), "import { test } from 'node:test'\ntest('sum', () => {})\n")
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /changed the reproduction test/)
})
await test('a reproduction that passes without the repair cannot tell a fix from no fix -> FAIL', () => {
  put(join(STATE, 'repro', 'F4', 'repro.json'), JSON.stringify({ test_file: 'tests/bughunt-f4.test.mjs' }))
  put(join(STATE, 'repro', 'F4', 'files', 'tests/bughunt-f4.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { double } from '../src/double.mjs'\ntest('d', () => assert.equal(double(2), 4, 'BUGHUNT-F4'))\n")
  appendFileSync(join(FIX, 'src/double.mjs'), '// a change\n')
  const r = ev('fix', STATE, 'F4')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F4')
  assert.match(r.stdout, /cannot tell a fix from no fix/)
})
await test('a repair that fixes the bug but breaks the suite -> FAIL, naming the step', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  put(join(FIX, 'src/double.mjs'), 'export const double = n => n * 3\n')
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /breaks the suite: .*npm run test/)
})
await test('the right repair: passes with it, fails without it, the suite passes -> PASS; the reproduction joins the change', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  const r = ev('fix', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'FIX: PASS F1', r.stdout)
  assert.match(r.stdout, /passes with the repair and fails without it; the suite passes/)
  assert.ok(existsSync(join(FIX, TEST_FILE)), 'the reproduction test is part of the change')
  const fx = record().fix
  assert.equal(fx.verdict, 'PASS')
  assert.match(fx.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(fx.files.sort(), ['src/sum.mjs', TEST_FILE].sort())
  const arms = record().runs.filter(x => x.kind === 'fix').map(x => [x.arm, x.exit === 0])
  assert.deepEqual(arms, [['fixed', true], ['without', false], ['suite with the repair', true]])
  assert.ok(record().runs.every(x => x.kind === 'fix'), 'only fix runs exist yet for this finding')
})

console.log('== repair: adversarial tests, commit, revert')
const ADV = join(STATE, 'repro', 'F1', 'adversarial')
await test('no adversarial tests -> PASS, saying so', () => {
  assert.equal(lastLine(ev('adversarial', STATE, 'F1').stdout), 'ADVERSARIAL: PASS F1')
})
await test('an adversarial test that passes on the repair -> PASS; one that fails -> FAIL, naming it', () => {
  put(join(ADV, 'adversarial.json'), JSON.stringify({ test_files: ['tests/adv-negative.test.mjs'] }))
  put(join(ADV, 'files', 'tests/adv-negative.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from '../src/sum.mjs'\ntest('negatives', () => assert.equal(sum(-1, 1), 0))\n")
  let r = ev('adversarial', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'ADVERSARIAL: PASS F1', r.stdout)
  put(join(ADV, 'adversarial.json'), JSON.stringify({ test_files: ['tests/adv-negative.test.mjs', 'tests/adv-wrong.test.mjs'] }))
  put(join(ADV, 'files', 'tests/adv-wrong.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from '../src/sum.mjs'\ntest('three', () => assert.equal(sum(1, 2), 4))\n")
  r = ev('adversarial', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'ADVERSARIAL: FAIL F1')
  assert.match(r.stdout, /tests\/adv-wrong\.test\.mjs fails against the repair/)
  assert.ok(!existsSync(join(FIX, 'tests/adv-negative.test.mjs')), 'adversarial tests never enter the worktree')
})
await test('a worktree changed after the fix check: adversarial and commit both refuse', () => {
  appendFileSync(join(FIX, 'src/sum.mjs'), '// sneaked in after the check\n')
  assert.match(ev('adversarial', STATE, 'F1').stdout, /ADVERSARIAL F1: the worktree changed after the fix check/)
  const c = ev('commit', STATE, 'F1')
  assert.equal(lastLine(c.stdout), 'COMMIT: FAIL F1')
  put(join(FIX, 'src/sum.mjs'), RIGHT)   // back to the checked state
})
await test('commit commits exactly the checked state and prints the commit', () => {
  const c = ev('commit', STATE, 'F1')
  const m = lastLine(c.stdout).match(/^COMMIT: DONE F1 ([0-9a-f]{40})$/)
  assert.ok(m, c.stdout)
  assert.equal(sh(FIX, 'rev-parse', 'HEAD'), m[1])
  assert.equal(sh(FIX, 'status', '--porcelain'), '')
  assert.deepEqual(sh(FIX, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['src/sum.mjs', TEST_FILE].sort())
  assert.match(sh(FIX, 'log', '-1', '--format=%B'), /^bughunt: fix F1\n\nRegression test: tests\/bughunt-f1\.test\.mjs/)
  assert.equal(sh(repo, 'rev-parse', 'feature'), HEAD, 'the branch under review never moves')
})
await test('commit refuses a repair that never passed its check', () => {
  put(join(STATE, 'repro', 'F2', 'repro.json'), JSON.stringify({ test_file: 'tests/bughunt-f2.test.mjs' }))
  assert.equal(lastLine(ev('commit', STATE, 'F2').stdout), 'COMMIT: FAIL F2')
})
await test('revert puts the worktree back at its last commit, untracked files included', () => {
  appendFileSync(join(FIX, 'src/double.mjs'), '// a failed attempt\n')
  put(join(FIX, 'src/new.mjs'), 'export const x = 1\n')
  const r = ev('revert', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'REVERT: DONE F1')
  assert.equal(sh(FIX, 'status', '--porcelain'), '')
})
await test('a suite that already failed without the repair at the same step is tolerated, and the report says why', () => {
  put(join(FIX, 'tests/broken.test.mjs'), "import { test } from 'node:test'\ntest('already broken', () => { throw new Error('old') })\n")
  sh(FIX, 'add', '.')
  sh(FIX, 'commit', '-qm', 'a failing test the PR carries')
  // A second bug for F3 on top: double triples, reproduced by a new test.
  put(join(FIX, 'src/double.mjs'), 'export const double = n => n * 3\n')
  sh(FIX, 'commit', '-qam', 'bug two')
  put(join(STATE, 'repro', 'F3', 'repro.json'), JSON.stringify({ test_file: 'tests/bughunt-f3.test.mjs' }))
  put(join(STATE, 'repro', 'F3', 'files', 'tests/bughunt-f3.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { double } from '../src/double.mjs'\ntest('d', () => assert.equal(double(3), 6, 'BUGHUNT-F3'))\n")
  put(join(FIX, 'src/double.mjs'), 'export const double = n => n * 2\n')
  const r = ev('fix', STATE, 'F3')
  assert.equal(lastLine(r.stdout), 'FIX: PASS F3', r.stdout)
  assert.match(r.stdout, /the suite already failed without the repair, at the same steps \(npm run test\)/)
  reset()
})

console.log('== repair: recheck of a committed fix')
await test('recheck re-proves a committed fix from its commit, and takes back one that does not hold', () => {
  const fixCommit = sh(FIX, 'log', '--format=%H', '--grep=^bughunt: fix F1').split('\n')[0]
  const cand = {
    file_path: 'src/sum.mjs', line_range: [1, 1], bug_category: 'logic', severity: 'HIGH', confidence: 90, title: 'sum subtracts', description: 'd',
    failure_scenario: { trigger: 't', path: 'p', observable: 'o' }, expected_behavior: 'e', actual_behavior: 'a', evidence: [{ file: 'src/sum.mjs', line: 1, quote: 'x' }], source_agent: 'hunter:logic',
  }
  const f = mergeFindings([], [cand], HEAD).findings[0]
  Object.assign(f, { verification_status: 'reproduced', reproduction_artifact: { written: true, test_file: TEST_FILE }, fix_status: 'verified', fix_artifact: { commit: fixCommit } })
  const ledgerFile = join(STATE, 'ledger.json')
  writeLedger(ledgerFile, { ...emptyLedger(JSON.parse(readFileSync(join(STATE, 'intake.json'), 'utf8')).key), findings: [f] })
  let r = ev('recheck', STATE)
  assert.match(r.stdout, new RegExp(`RECHECK F1 fix ${fixCommit.slice(0, 7)}: PASS`))
  assert.equal(readLedger(ledgerFile, 'x').findings[0].fix_status, 'verified')
  // A "fix" commit that does not fix anything: the commit adding the broken test.
  const notAFix = sh(FIX, 'log', '--format=%H', '--grep=^a failing test').split('\n')[0]
  const l = readLedger(ledgerFile, 'x')
  l.findings[0].fix_artifact = { commit: notAFix }
  writeLedger(ledgerFile, l)
  r = ev('recheck', STATE)
  assert.match(r.stdout, /RECHECK F1: corrected fix verified -> fix rejected/)
  assert.equal(readLedger(ledgerFile, 'x').findings[0].fix_status, 'rejected')
})
