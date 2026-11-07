// repair.test.mjs — evidence.mjs's repair commands (fix, adversarial, commit,
// revert, and recheck of a committed fix) run for real in a throwaway Node
// project whose suite is `npm test` (node --test), through the verify skill.
// Every attack the PR #29 review found has a test here.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { mergeFindings, writeLedger, readLedger, emptyLedger } from '../../../core/skills/findings/findings.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(here, '..', 'skills', 'bughunt', 'evidence.mjs')
const INTAKE = join(here, '..', 'skills', 'bughunt', 'intake.mjs')
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
// The tests' own git calls never run the PR's hooks or fsmonitor, so only the
// code under test can trip the trap.
const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const ev = (...args) => spawnSync('node', [EVIDENCE, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV } })
const lastLine = out => out.trim().split('\n').at(-1)
const T = (imp, body) => `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${imp}\ntest('t', () => { ${body} })\n`

// main: sum adds, double doubles, one passing test of double. feature: sum
// subtracts (the bug). The repo sets a relative core.hooksPath and
// core.fsmonitor (.githooks/...), so a hook or fsmonitor script the PR commits
// would run if any git call let it.
const repo = mkdtempSync(join(tmpdir(), 'repair-test-'))
const TRAP = join(mkdtempSync(join(tmpdir(), 'hook-trap-')), 'ran')
sh(repo, 'init', '-q', '-b', 'main')
sh(repo, 'config', 'core.hooksPath', '.githooks')
put(join(repo, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }))
put(join(repo, 'src/sum.mjs'), 'export const sum = (a, b) => a + b\n')
put(join(repo, 'src/double.mjs'), 'export const double = n => n * 2\n')
put(join(repo, 'tests/double.test.mjs'), T("import { double } from '../src/double.mjs'", 'assert.equal(double(2), 4)'))
sh(repo, 'add', '.')
sh(repo, 'commit', '-qm', 'base')
sh(repo, 'checkout', '-q', '-b', 'feature')
put(join(repo, 'src/sum.mjs'), 'export const sum = (a, b) => a - b\n')
put(join(repo, '.githooks/post-commit'), `#!/bin/sh\necho "post-commit $HOME" >> ${TRAP}\n`)
put(join(repo, '.githooks/fsmon'), `#!/bin/sh\necho "fsmonitor $HOME" >> ${TRAP}\nexit 1\n`)
chmodSync(join(repo, '.githooks/post-commit'), 0o755)
chmodSync(join(repo, '.githooks/fsmon'), 0o755)
sh(repo, 'add', '.')
sh(repo, 'commit', '-q', '--no-verify', '-m', 'bug, a hook, and an fsmonitor script')
sh(repo, 'config', 'core.fsmonitor', '.githooks/fsmon')
const STATE = dirname(spawnSync('node', [INTAKE, repo], { encoding: 'utf8' }).stdout.split('\n')[0])
const HEAD = sh(repo, 'rev-parse', 'HEAD')
const FIX = join(STATE, 'fix')
const reproduce = (id, file, text) => {
  put(join(STATE, 'repro', id, 'repro.json'), JSON.stringify({ test_file: file }))
  put(join(STATE, 'repro', id, 'files', file), text)
  return lastLine(ev('repro', STATE, id).stdout)
}
const SUM_TEST = T("import { sum } from '../src/sum.mjs'", "assert.equal(sum(2, 2), 4, 'BUGHUNT-F1 sum subtracts')")
const record = id => JSON.parse(readFileSync(join(STATE, 'evidence', `${id}.json`), 'utf8'))
const reset = () => { sh(FIX, 'reset', '-q', '--hard', 'HEAD'); sh(FIX, 'clean', '-fdqx') }
const RIGHT = 'export const sum = (a, b) => a + b\n'

console.log('== repair: setup')
await test('F1 is reproduced first (the fix check trusts only a recorded REPRODUCED)', () => {
  assert.equal(reproduce('F1', 'tests/bughunt-f1.test.mjs', SUM_TEST), 'EVIDENCE: REPRODUCED F1')
})

console.log('== repair: the fix worktree')
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
  assert.match(r.stdout, /is not the linked worktree of .* it claims to be/)
})
sh(repo, 'worktree', 'add', '-q', '-b', 'bughunt/test', FIX, HEAD)
await test('a .git redirected at the repo itself is refused: commit and revert can never reach the user\'s branch', () => {
  const linkFile = readFileSync(join(FIX, '.git'), 'utf8')
  writeFileSync(join(FIX, '.git'), `gitdir: ${join(repo, '.git')}\n`)
  const outs = ['fix', 'commit', 'revert'].map(cmd => lastLine(ev(cmd, STATE, 'F1').stdout))
  writeFileSync(join(FIX, '.git'), linkFile)
  assert.deepEqual(outs, ['FIX: ERROR F1', 'COMMIT: FAIL F1', 'REVERT: FAIL F1'])
  assert.equal(sh(repo, 'rev-parse', 'feature'), HEAD)
  assert.equal(sh(repo, 'status', '--porcelain'), '')
})

await test('a .git pointed at the user\'s own linked worktree, or a fix dir that is a symlink to it, is refused', () => {
  const mine = mkdtempSync(join(tmpdir(), 'users-own-'))
  rmSync(mine, { recursive: true, force: true })
  sh(repo, 'worktree', 'add', '-q', '-b', 'mywork', mine, HEAD)
  put(join(mine, 'wip.txt'), 'the user\'s work\n')
  sh(mine, 'add', 'wip.txt')
  const admin = sh(mine, 'rev-parse', '--absolute-git-dir')
  const linkFile = readFileSync(join(FIX, '.git'), 'utf8')
  writeFileSync(join(FIX, '.git'), `gitdir: ${admin}\n`)
  const viaGitFile = ['fix', 'commit', 'revert'].map(cmd => lastLine(ev(cmd, STATE, 'F1').stdout))
  writeFileSync(join(FIX, '.git'), linkFile)
  assert.deepEqual(viaGitFile, ['FIX: ERROR F1', 'COMMIT: FAIL F1', 'REVERT: FAIL F1'])
  const real = `${FIX}.real`
  spawnSync('mv', [FIX, real])
  symlinkSync(mine, FIX)
  const viaSymlink = ['fix', 'commit', 'revert'].map(cmd => lastLine(ev(cmd, STATE, 'F1').stdout))
  rmSync(FIX)
  spawnSync('mv', [real, FIX])
  assert.deepEqual(viaSymlink, ['FIX: ERROR F1', 'COMMIT: FAIL F1', 'REVERT: FAIL F1'])
  assert.equal(sh(repo, 'rev-parse', 'mywork'), HEAD, 'the user\'s branch never moved')
  assert.equal(sh(mine, 'status', '--porcelain'), 'A  wip.txt', 'the user\'s staged work is untouched')
  sh(repo, 'worktree', 'remove', '--force', mine)
  sh(repo, 'branch', '-q', '-D', 'mywork')
})

console.log('== repair: the fix check')
await test('a repair that changes nothing -> FAIL', () => {
  assert.match(ev('fix', STATE, 'F1').stdout, /FIX F1: the repair changed nothing\nFIX: FAIL F1/)
})
await test('a change that does not remove the bug: the reproduction still fails with its marker -> FAIL', () => {
  appendFileSync(join(FIX, 'src/sum.mjs'), '// looked at it\n')
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /still fails with its marker: the bug is still there/)
})
await test('editing an existing test, or deleting one by renaming it away -> FAIL', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  appendFileSync(join(FIX, 'tests/double.test.mjs'), '// weakened\n')
  let r = ev('fix', STATE, 'F1')
  reset()
  assert.match(r.stdout, /changed an existing test, tests\/double\.test\.mjs/)
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  sh(FIX, 'mv', 'tests/double.test.mjs', 'src/dbl.mjs')
  r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /changed an existing test, tests\/double\.test\.mjs/)
})
await test('changing what the suite runs (package.json\'s test script) -> FAIL', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  put(join(FIX, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'true' } }))
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /changed package\.json, which defines what the suite runs/)
})
await test('edits hidden from git status by skip-worktree are still judged: they are in the staged tree', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  sh(FIX, 'update-index', '--skip-worktree', 'package.json', 'tests/double.test.mjs')
  put(join(FIX, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'true' } }))
  const r = ev('fix', STATE, 'F1')
  sh(FIX, 'update-index', '--no-skip-worktree', 'package.json', 'tests/double.test.mjs')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1', r.stdout)
  assert.match(r.stdout, /changed package\.json, which defines what the suite runs/)
})
await test('a .gitattributes export-ignore cannot hide a broken test from the check: exports ignore attributes', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  put(join(FIX, 'src/double.mjs'), 'export const double = n => n * 3\n')
  put(join(FIX, '.gitattributes'), 'tests/double.test.mjs export-ignore\n')
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1', r.stdout)
  assert.match(r.stdout, /breaks the suite/)
})
await test('a repair that writes its own version of the reproduction test -> FAIL', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  put(join(FIX, 'tests/bughunt-f1.test.mjs'), "import { test } from 'node:test'\ntest('sum', () => {})\n")
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.match(r.stdout, /changed the reproduction test/)
})
await test('a fix hidden in a git-ignored file is not what would be committed, so the check fails it', () => {
  put(join(FIX, '.gitignore'), 'src/patch.mjs\n')
  put(join(FIX, 'src/patch.mjs'), RIGHT)
  put(join(FIX, 'src/sum.mjs'), "export { sum } from './patch.mjs'\n")
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1', r.stdout)
})
await test('a repair that fixes the bug but breaks the suite -> FAIL, naming the step', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  put(join(FIX, 'src/double.mjs'), 'export const double = n => n * 3\n')
  const r = ev('fix', STATE, 'F1')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F1')
  assert.match(r.stdout, /breaks the suite: .*npm run test/)
})
await test('the right repair: passes with it, fails without it, the suite passes -> PASS, fingerprinted by its staged tree', () => {
  put(join(FIX, 'src/sum.mjs'), RIGHT)
  const r = ev('fix', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'FIX: PASS F1', r.stdout)
  assert.match(r.stdout, /passes with the repair and fails without it; the suite passes/)
  assert.ok(existsSync(join(FIX, 'tests/bughunt-f1.test.mjs')), 'the reproduction test joins the change')
  assert.match(record('F1').fix.tree, /^[0-9a-f]{40}$/)
  assert.deepEqual(record('F1').runs.filter(x => x.kind === 'fix').map(x => [x.arm, x.exit === 0]), [['fixed', true], ['without', false], ['suite with the repair', true]])
  assert.equal(record('F1').verdict, 'REPRODUCED', 'the reproduction record survives the fix runs')
})

console.log('== repair: adversarial tests, commit, revert')
const ADV = join(STATE, 'repro', 'F1', 'adversarial')
await test('no adversarial tests -> PASS; one that passes -> PASS; one that fails -> FAIL, naming it', () => {
  assert.equal(lastLine(ev('adversarial', STATE, 'F1').stdout), 'ADVERSARIAL: PASS F1')
  put(join(ADV, 'adversarial.json'), JSON.stringify({ test_files: ['tests/adv-neg.test.mjs'] }))
  put(join(ADV, 'files', 'tests/adv-neg.test.mjs'), T("import { sum } from '../src/sum.mjs'", 'assert.equal(sum(-1, 1), 0)'))
  assert.equal(lastLine(ev('adversarial', STATE, 'F1').stdout), 'ADVERSARIAL: PASS F1')
  put(join(ADV, 'adversarial.json'), JSON.stringify({ test_files: ['tests/adv-neg.test.mjs', 'tests/adv-wrong.test.mjs'] }))
  put(join(ADV, 'files', 'tests/adv-wrong.test.mjs'), T("import { sum } from '../src/sum.mjs'", 'assert.equal(sum(1, 2), 4)'))
  const r = ev('adversarial', STATE, 'F1')
  assert.equal(lastLine(r.stdout), 'ADVERSARIAL: FAIL F1')
  assert.match(r.stdout, /tests\/adv-wrong\.test\.mjs fails against the repair/)
  assert.ok(!existsSync(join(FIX, 'tests/adv-neg.test.mjs')), 'adversarial tests never enter the worktree')
})
await test('a change after the check (content, a symlink retargeted, a mode) makes adversarial and commit refuse', () => {
  for (const tamper of [
    () => appendFileSync(join(FIX, 'src/sum.mjs'), '// sneaked in\n'),
    () => chmodSync(join(FIX, 'src/sum.mjs'), 0o755),
    () => symlinkSync('/etc/passwd', join(FIX, 'src/link.mjs')),
  ]) {
    tamper()
    assert.match(ev('adversarial', STATE, 'F1').stdout, /the worktree changed after the fix check/)
    assert.equal(lastLine(ev('commit', STATE, 'F1').stdout), 'COMMIT: FAIL F1')
    rmSync(join(FIX, 'src/link.mjs'), { force: true })
    chmodSync(join(FIX, 'src/sum.mjs'), 0o644)
    put(join(FIX, 'src/sum.mjs'), RIGHT)
  }
})
await test('commit commits exactly the checked tree, runs no hook, and never moves the branch under review', () => {
  const c = ev('commit', STATE, 'F1')
  const m = lastLine(c.stdout).match(/^COMMIT: DONE F1 ([0-9a-f]{40})$/)
  assert.ok(m, c.stdout)
  assert.equal(sh(FIX, 'rev-parse', 'HEAD'), m[1])
  assert.equal(sh(FIX, 'rev-parse', 'bughunt/test'), m[1], 'the fix branch moved')
  assert.equal(sh(FIX, 'rev-parse', `${m[1]}^{tree}`), record('F1').fix.tree)
  assert.equal(sh(FIX, 'status', '--porcelain'), '')
  assert.deepEqual(sh(FIX, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['src/sum.mjs', 'tests/bughunt-f1.test.mjs'])
  assert.match(sh(FIX, 'log', '-1', '--format=%B'), /^bughunt: fix F1\n\nRegression test: tests\/bughunt-f1\.test\.mjs/)
  assert.ok(!existsSync(TRAP), `the PR's hook or fsmonitor script ran: ${existsSync(TRAP) ? readFileSync(TRAP, 'utf8') : ''}`)
  assert.equal(sh(repo, 'rev-parse', 'feature'), HEAD)
})
await test('commit refuses a repair that never passed its check', () => {
  assert.equal(lastLine(ev('commit', STATE, 'F9').stdout), 'COMMIT: FAIL F9')
})
await test('revert puts the worktree back at its last commit: untracked, ignored, skip-worktree, and nested repos included', () => {
  appendFileSync(join(FIX, 'src/double.mjs'), '// a failed attempt\n')
  put(join(FIX, 'src/new.mjs'), 'x\n')
  put(join(FIX, '.gitignore'), 'out/\n')
  put(join(FIX, 'out/stale.js'), 'x\n')
  sh(FIX, 'update-index', '--skip-worktree', 'src/sum.mjs')
  put(join(FIX, 'src/sum.mjs'), '// hidden from status\n')
  mkdirSync(join(FIX, 'leftover'))
  sh(join(FIX, 'leftover'), 'init', '-q')
  put(join(FIX, 'leftover/a'), 'a')
  sh(join(FIX, 'leftover'), 'add', '.')
  sh(join(FIX, 'leftover'), 'commit', '-qm', 'nested')
  assert.equal(lastLine(ev('revert', STATE, 'F1').stdout), 'REVERT: DONE F1')
  assert.equal(sh(FIX, 'status', '--porcelain', '--ignored'), '')
  assert.ok(!existsSync(join(FIX, 'leftover')), 'the nested repo is gone')
  assert.equal(readFileSync(join(FIX, 'src/sum.mjs'), 'utf8'), RIGHT, 'the skip-worktree file is restored')
  assert.equal(sh(FIX, 'ls-files', '-v', 'src/sum.mjs').slice(0, 1), 'H', 'and no longer marked skip-worktree')
})

console.log('== repair: what blocks a repair')
await test('a reproduction an earlier fix already committed a test over -> BLOCKED (never overwritten)', () => {
  assert.equal(reproduce('F2', 'tests/bughunt-f1.test.mjs', SUM_TEST.replace('BUGHUNT-F1', 'BUGHUNT-F2')), 'EVIDENCE: REPRODUCED F2')
  appendFileSync(join(FIX, 'src/double.mjs'), '// a change\n')
  const r = ev('fix', STATE, 'F2')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: BLOCKED F2')
  assert.match(r.stdout, /already exists in the fix worktree/)
})
await test('a REPRODUCED finding whose reproduction is now unreadable -> BLOCKED, never a suite-only pass', () => {
  assert.equal(reproduce('F3', 'tests/bughunt-f3.test.mjs', SUM_TEST.replace('BUGHUNT-F1', 'BUGHUNT-F3')), 'EVIDENCE: REPRODUCED F3')
  writeFileSync(join(STATE, 'repro', 'F3', 'repro.json'), '{broken')
  appendFileSync(join(FIX, 'src/double.mjs'), '// nothing\n')
  const r = ev('fix', STATE, 'F3')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: BLOCKED F3')
  assert.match(r.stdout, /the reproduction that proved this finding is unreadable/)
})
await test('a reproduction an earlier fix already makes pass cannot tell this fix from no fix -> FAIL', () => {
  assert.equal(reproduce('F4', 'tests/bughunt-f4.test.mjs', SUM_TEST.replace('BUGHUNT-F1', 'BUGHUNT-F4')), 'EVIDENCE: REPRODUCED F4')
  appendFileSync(join(FIX, 'src/double.mjs'), '// a change\n')
  const r = ev('fix', STATE, 'F4')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: FAIL F4')
  assert.match(r.stdout, /cannot tell a fix from no fix/)
})
await test('a finding no test reproduced (approved by the human) is checked against the suite only', () => {
  put(join(FIX, 'src/double.mjs'), 'export const double = n => n + n\n')
  const r = ev('fix', STATE, 'F5')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: PASS F5', r.stdout)
  assert.match(r.stdout, /no reproduction proved this finding \(the human approved it\); the suite passes/)
})
await test('a suite that already fails without the repair -> BLOCKED: a regression inside it cannot be told apart', () => {
  put(join(FIX, 'tests/broken.test.mjs'), "import { test } from 'node:test'\ntest('already broken', () => { throw new Error('old') })\n")
  sh(FIX, 'add', '.')
  sh(FIX, 'commit', '-q', '--no-verify', '-m', 'a failing test the PR carries')
  put(join(FIX, 'src/double.mjs'), 'export const double = n => n + n\n')
  const r = ev('fix', STATE, 'F5')
  reset()
  assert.equal(lastLine(r.stdout), 'FIX: BLOCKED F5', r.stdout)
  assert.match(r.stdout, /the suite already fails without the repair, at npm run test/)
})

console.log('== repair: recheck of a committed fix')
await test('recheck re-proves a fix from its commit while it is kept, and takes it back once nothing keeps it', () => {
  const fixCommit = sh(FIX, 'log', '--format=%H', '--grep=^bughunt: fix F1').split('\n')[0]
  const cand = {
    file_path: 'src/sum.mjs', line_range: [1, 1], bug_category: 'logic', severity: 'HIGH', confidence: 90, title: 'sum subtracts', description: 'd',
    failure_scenario: { trigger: 't', path: 'p', observable: 'o' }, expected_behavior: 'e', actual_behavior: 'a', evidence: [{ file: 'src/sum.mjs', line: 1, quote: 'x' }], source_agent: 'hunter:logic',
  }
  const f = mergeFindings([], [cand], HEAD).findings[0]
  Object.assign(f, { verification_status: 'reproduced', reproduction_artifact: { written: true, test_file: 'tests/bughunt-f1.test.mjs' }, fix_status: 'verified', fix_artifact: { commit: fixCommit, branch: 'bughunt/test' } })
  const ledgerFile = join(STATE, 'ledger.json')
  writeLedger(ledgerFile, { ...emptyLedger(JSON.parse(readFileSync(join(STATE, 'intake.json'), 'utf8')).key), findings: [f] })
  let r = ev('recheck', STATE)
  assert.match(r.stdout, new RegExp(`RECHECK F1 fix ${fixCommit.slice(0, 7)}: PASS`))
  assert.equal(readLedger(ledgerFile, 'x').findings[0].fix_status, 'verified')
  // The human clears the worktree and the branch: the commit still exists, but nothing keeps it.
  sh(repo, 'worktree', 'remove', '--force', FIX)
  sh(repo, 'branch', '-q', '-D', 'bughunt/test')
  r = ev('recheck', STATE)
  assert.match(r.stdout, /RECHECK F1 fix [0-9a-f]{7}: FAIL \(the fix commit [0-9a-f]{7} is no longer on the fix worktree or bughunt\/test\)/)
  assert.equal(readLedger(ledgerFile, 'x').findings[0].fix_status, 'rejected')
})
await test('no git call in intake, repro, fix, adversarial, commit, revert, or recheck ran the PR\'s hooks or fsmonitor', () => {
  assert.ok(!existsSync(TRAP), existsSync(TRAP) ? readFileSync(TRAP, 'utf8') : '')
})
