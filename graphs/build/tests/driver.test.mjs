// driver.test.mjs — the /build-app driver end to end against a throwaway git repo
// and a fake `claude` (fixtures/fake-claude.mjs). Run by scripts/test-workflow.mjs.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(here, '..', 'skills', 'build-app', 'driver', 'driver.mjs')
const FAKE = join(here, 'fixtures', 'fake-claude.mjs')
const FAKE_GH = join(here, 'fixtures', 'fake-gh.mjs')
const APP = 'toy'
const INT = `integration/${APP}`
// The driver's own verify: passes unless the slice committed a file named FAILVERIFY.
// A committed make-junk file makes it leave an untracked junk.out behind.
const VERIFY = 'if [ -e make-junk ]; then touch junk.out; fi; if [ -e FAILVERIFY ]; then echo "VERIFY: FAIL"; else echo "VERIFY: PASS"; fi'

const ac = id => [{ id: `${id}-AC1`, criterion: `${id} works`, fails_when: `${id} breaks` }]
const slice = (n, deps) => ({ id: `S${n}`, title: `slice ${n}`, goal: `build ${n}`, requirements: [`R${n}`], acceptance: ac(`S${n}`), depends_on: deps })
// S1; S2 needs S1; S3 is independent.
const BACKLOG = { version: 1, app: APP, integrationBranch: INT, requirements: ['R1', 'R2', 'R3'], slices: [slice(1, []), slice(2, ['S1']), slice(3, [])] }

function repo(backlog = BACKLOG) {
  const root = mkdtempSync(join(tmpdir(), 'build-app-'))
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'README.md'), 'toy\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-c', INT)
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'backlog.json'), JSON.stringify(backlog, null, 2))
  git('add', '-A')
  git('commit', '-q', '-m', 'blueprint: design and backlog for toy')
  return root
}
const gitOut = (root, ...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const stateDir = root => join(root, '.git', 'harness-build', APP)
const ledger = root => JSON.parse(readFileSync(join(stateDir(root), 'ledger.json'), 'utf8'))
const status = root => JSON.parse(readFileSync(join(stateDir(root), 'status.json'), 'utf8'))
const driverLog = root => readFileSync(join(stateDir(root), 'logs', 'driver.log'), 'utf8')

function env(root, script, extra = {}) {
  const scriptFile = join(dirname(root), `${root.split('/').pop()}-script.json`)
  writeFileSync(scriptFile, JSON.stringify(script))
  rmSync(`${scriptFile}.n`, { force: true })
  rmSync(`${scriptFile}.calls`, { force: true })
  return {
    scriptFile,
    env: {
      ...process.env, CLAUDE_CODE_INHERITED: 'from-the-parent', HARNESS_BUILD_CLAUDE_BIN: FAKE, FAKE_CLAUDE_SCRIPT: scriptFile,
      HARNESS_BUILD_VERIFY: VERIFY, HARNESS_BUILD_MAX_SLEEP_MS: '50', PANDASTACK_NOTIFY: '', ...extra,
    },
  }
}
// --no-pr unless a test asks for the push and the PR.
function drive(root, script, extra = {}, flags = ['--no-pr']) {
  const { scriptFile, env: e } = env(root, script, extra)
  const r = spawnSync(process.execPath, [DRIVER, 'run', '--repo', root, '--app', APP, ...flags], { encoding: 'utf8', env: e, timeout: 60_000 })
  const calls = existsSync(`${scriptFile}.calls`) ? readFileSync(`${scriptFile}.calls`, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  return { code: r.status, out: r.stdout + r.stderr, calls }
}
// The final QA session, finding nothing to fix.
const QA = { qa: 'done' }
// A /dev session that lands slice `id` with one source file and one test file.
const good = (id, extra = {}) => ({ dev: 'done', commits: [{ subject: `${id}: C1: build ${id}`, files: { [`src/${id}.js`]: `export const ${id} = 1\n`, [`tests/${id}.test.js`]: `test ${id}\n` } }], ...extra })

console.log('== build-app driver: landing slices')
await test('every slice lands in order on the integration branch, each from a fresh headless /dev session', () => {
  const root = repo()
  const { code, calls, out } = drive(root, [good('S1'), good('S2'), good('S3'), QA])
  assert.equal(code, 0, out)
  // The first ready slice in build order: S2 is ready once S1 lands, and comes before S3.
  const prompts = calls.map(c => c.args[c.args.indexOf('-p') + 1])
  assert.deepEqual(prompts.slice(0, 3), ['S1', 'S2', 'S3'].map(id => `/dev --slice ${id} --base integration/toy --unattended`))
  assert.match(prompts[3], /^Final QA pass of an unattended \/build-app build/)
  assert.match(prompts[3], /name "harness-repair".*"base": "main"/)
  assert.deepEqual(gitOut(root, 'log', '--format=%s', `main..${INT}`).split('\n').reverse(), ['blueprint: design and backlog for toy', 'S1: C1: build S1', 'S2: C1: build S2', 'S3: C1: build S3'])
  const l = ledger(root)
  assert.deepEqual(Object.fromEntries(Object.entries(l.slices).map(([k, v]) => [k, [v.status, v.frozen]])), { S1: ['done', ['tests/S1.test.js']], S2: ['done', ['tests/S2.test.js']], S3: ['done', ['tests/S3.test.js']] })
  assert.equal(gitOut(root, 'rev-parse', '--abbrev-ref', 'HEAD'), INT)
  assert.equal(gitOut(root, 'branch', '--list', 'slice/*'), '', 'slice branches are deleted once landed')
  assert.equal(status(root).state, 'done')
  assert.equal(status(root).exitCode, 0)
  // Four sessions at $0.01 each, every result line counted once though the log repeats it.
  assert.equal(status(root).costUsd, 0.04)
  assert.match(driverLog(root), /S1: landed \(exit 0, \$0\.01\)/)
})
await test('each session gets bypassPermissions, the injected settings, and a clean env without the parent\'s CLAUDE_CODE_*', () => {
  const root = repo({ ...BACKLOG, requirements: ['R1'], slices: [slice(1, [])] })
  const { code, calls } = drive(root, [good('S1'), QA])
  assert.equal(code, 0)
  const [c] = calls
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'bypassPermissions')
  assert.equal(c.cwd, root)
  assert.equal(c.env.CLAUDE_CODE_INHERITED, undefined)
  assert.equal(c.env.HARNESS_BUILD_ACTIVE, '1')
  // A headless session would stop the /dev Workflow 10 minutes after its last turn;
  // the final QA session runs a Workflow too.
  assert.equal(c.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0')
  assert.equal(calls[1].env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0')
  assert.ok(c.args.includes('--append-system-prompt'))
  const settings = JSON.parse(readFileSync(c.args[c.args.indexOf('--settings') + 1], 'utf8'))
  assert.deepEqual(settings.env, { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0', CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: '', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' })
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /hooks\/guard\.mjs"$/)
  assert.match(settings.hooks.StopFailure[0].hooks[0].command, /hooks\/stop-failure\.mjs"$/)
  assert.ok(settings.permissions.deny.includes('Bash(git push *)'))
  assert.ok(existsSync(c.env.HARNESS_BUILD_GUARD))
})

console.log('== build-app driver: the independent checks')
const one = () => repo({ ...BACKLOG, requirements: ['R1', 'R2'], slices: [slice(1, []), slice(2, ['S1'])] })
await test('a later slice that changes a frozen test does not land; the attempt is kept; a clean retry lands', () => {
  const root = one()
  const tamper = { dev: 'done', commits: [{ subject: 'S2: C1: build S2', files: { 'tests/S1.test.js': 'weakened\n', 'src/S2.js': 'x\n' } }] }
  const { code, out } = drive(root, [good('S1'), tamper, good('S2'), QA])
  assert.equal(code, 0, out)
  assert.match(driverLog(root), /S2: escalated .*frozen tests from earlier slices changed: tests\/S1\.test\.js/)
  assert.equal(readFileSync(join(root, 'tests', 'S1.test.js'), 'utf8'), 'test S1\n', 'the frozen test on integration is unchanged')
  assert.match(gitOut(root, 'branch', '--list', 'attempt/S2-*'), /attempt\/S2-/)
  // Renamed away (review of #23): git's rename detection would list only the new name.
  const moved = one()
  drive(moved, [good('S1'), { dev: 'done', commits: [{ subject: 'S2: C1: tidy tests', sh: 'git mv tests/S1.test.js tests/S1-moved.test.js', files: { 'src/S2.js': 'x\n' } }] }, good('S2')])
  assert.match(driverLog(moved), /S2: escalated .*frozen tests from earlier slices changed: tests\/S1\.test\.js/)
  const { calls } = drive(one(), [good('S1'), good('S2'), QA])
  assert.deepEqual(calls.map(c => c.guard.frozen), [[], ['tests/S1.test.js'], ['tests/S1.test.js', 'tests/S2.test.js']], 'the guard gets every frozen test before each session')
  assert.deepEqual(ledger(root).slices.S2.reasons.length, 1)
})
await test('a commit without the S<n>: prefix, no commit, or a failing verify never lands, whatever /dev says', () => {
  const cases = [
    [{ dev: 'done', commits: [{ subject: 'C1: build S1', files: { 'src/a.js': '1\n' } }] }, /commits that do not start with "S1: ": "C1: build S1"/],
    [{ dev: 'done' }, /no commits on slice\/S1/],
    [{ dev: 'done', commits: [{ subject: 'S1: C1: x', files: { FAILVERIFY: '1\n' } }] }, /the driver's own verify did not pass \(last line "VERIFY: FAIL"\)/],
    [{ dev: 'escalate', reason: 'acceptance S1-AC1 unmet' }, /\/dev escalate: acceptance S1-AC1 unmet/],
    // Clean-looking commits never outvote /dev's own report, and never excuse leftovers.
    [{ ...good('S1'), dev: 'escalate', reason: 'QA found a HIGH' }, /\/dev escalate: QA found a HIGH/],
    [{ ...good('S1'), dirty: { 'src/extra.js': 'x\n' } }, /uncommitted changes were left:\n\?\? src\/extra\.js/],
    [{ ...good('S1'), commits: [{ subject: 'S1: C1: x', files: { 'src/a.js': '1\n', 'make-junk': '1\n' } }] }, /the driver's own verify left files git does not ignore: .*junk\.out/],
  ]
  for (const [bad, why] of cases) {
    const root = one()
    drive(root, [bad, good('S1'), good('S2')])
    assert.match(driverLog(root), why, String(why))
    assert.equal(ledger(root).slices.S1.status, 'done', 'the clean retry landed')
    assert.equal(ledger(root).slices.S1.reasons.length, 1)
  }
})
await test('uncommitted work a session leaves is kept on an attempt branch and the tree is clean for the next one', () => {
  const root = one()
  drive(root, [{ dev: 'escalate', reason: 'verify failed twice', dirty: { 'src/half.js': 'half\n' } }, good('S1'), good('S2')])
  const attempt = gitOut(root, 'branch', '--list', '--format=%(refname:short)', 'attempt/S1-*')
  assert.ok(attempt, 'an attempt branch')
  assert.equal(gitOut(root, 'show', `${attempt}:src/half.js`), 'half')
  assert.equal(existsSync(join(root, 'src', 'half.js')), false)
  assert.equal(gitOut(root, 'status', '--porcelain'), '')
})

console.log('== build-app driver: humans, brakes, and the way back')
await test('needs-human blocks the slice and its dependents; independent work lands; then the build brakes', () => {
  const root = repo()
  const { code } = drive(root, [{ dev: 'needs-human', questions: ['S1: which database?'] }, good('S3')])
  assert.equal(code, 3)
  const l = ledger(root)
  assert.equal(l.slices.S1.status, 'blocked')
  assert.deepEqual(l.slices.S1.questions, ['S1: which database?'])
  assert.equal(l.slices.S3.status, 'done')
  assert.equal(l.slices.S2, undefined, 'S2 waits on S1, never attempted')
  assert.match(status(root).message, /brake: every remaining slice is blocked: S1, S2/)
})
await test('three different slices escalating with none landing stops the build', () => {
  const root = repo({ ...BACKLOG, slices: [slice(1, []), slice(2, []), slice(3, [])] })
  const esc = { dev: 'escalate', reason: 'shared fixture broken' }
  const { code } = drive(root, [esc, esc, esc])
  assert.equal(code, 3)
  assert.match(status(root).message, /3 different slices escalated with none landing in between \(S1, S2, S3\)/)
})
await test('running again resumes from the ledger: landed slices are not rebuilt', () => {
  const root = one()
  drive(root, [good('S1'), { error: 'You\'ve hit your monthly spend limit' }])
  const { code, calls } = drive(root, [good('S2'), QA])
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.match(calls[0].args.join(' '), /--slice S2/)
  assert.equal(status(root).costUsd, 0.04, 'the total carries over from the earlier run (2 sessions there, 2 here)')
})

console.log('== build-app driver: limits and the API')
await test('a usage limit with a reset time waits and retries the same slice, not counted', () => {
  const root = one()
  const reset = new Date(Date.now() + 60 * 60_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()
  const { code, out } = drive(root, [{ limit: `You've hit your session limit · resets ${reset}` }, good('S1'), good('S2'), QA])
  assert.equal(code, 0, out)
  assert.match(driverLog(root), /S1: usage limit .*not counted/)
  assert.match(driverLog(root), /waiting until .*then retrying S1/)
  assert.deepEqual(ledger(root).slices.S1.reasons, [])
})
await test('a usage limit without a reset time probes until usage is back', () => {
  const root = one()
  const { code, out } = drive(root, [{ limit: "You've hit your session limit" }, { ok: true }, good('S1'), good('S2'), QA], { HARNESS_BUILD_PROBE_MINUTES: '1' })
  assert.equal(code, 0, out)
  assert.match(driverLog(root), /probing again/)
  assert.match(driverLog(root), /available again/)
})
await test('billing stops (9), auth stops (10), a far reset pauses (8); none is counted against the slice', () => {
  for (const [text, exit, extra] of [
    ["You've hit your monthly spend limit", 9, {}],
    ['Not logged in · Please run /login', 10, {}],
    ["You've hit your weekly limit · resets in 40h", 8, {}],
  ]) {
    const root = one()
    const { code } = drive(root, [{ error: text }], extra)
    assert.equal(code, exit, text)
    assert.equal(existsSync(join(stateDir(root), 'ledger.json')), false, 'nothing counted')
    assert.equal(gitOut(root, 'status', '--porcelain'), '')
    assert.equal(gitOut(root, 'rev-parse', '--abbrev-ref', 'HEAD'), INT)
  }
})
await test('an API that stays overloaded pauses the build (7) and never counts against the slice', () => {
  const root = one()
  const over = { error: 'API Error: Repeated 529 Overloaded errors' }
  const { code } = drive(root, [over, over, over, over])
  assert.equal(code, 7)
  assert.equal(existsSync(join(stateDir(root), 'ledger.json')), false, 'nothing counted')
  assert.equal(status(root).state, 'paused')
})
await test('an overloaded API is retried after a wait, not counted', () => {
  const root = one()
  const { code } = drive(root, [{ error: 'API Error: Repeated 529 Overloaded errors' }, good('S1'), good('S2'), QA])
  assert.equal(code, 0)
  assert.match(driverLog(root), /API overloaded or server error .*retry 1\/3, not counted/)
})

console.log('== build-app driver: after a crash')
await test('a slice that landed before its ledger was written is recorded, not rebuilt', () => {
  const root = one()
  execFileSync('git', ['-C', root, 'checkout', '-q', INT])
  mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, 'tests', 'S1.test.js'), 'test S1\n')
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'S1: C1: build S1'])
  const { code, calls } = drive(root, [good('S2'), QA])
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.match(calls[0].args.join(' '), /--slice S2/)
  assert.deepEqual(ledger(root).slices.S1.frozen, ['tests/S1.test.js'])
  assert.match(driverLog(root), /S1: already on integration\/toy .*recorded as landed/)
})
await test('commits a killed driver left on slice/S<n> are kept on an attempt branch before the retry', () => {
  const root = one()
  execFileSync('git', ['-C', root, 'branch', '-q', 'slice/S1', INT])
  execFileSync('git', ['-C', root, 'checkout', '-q', 'slice/S1'])
  writeFileSync(join(root, 'half.js'), 'half\n')
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'S1: C1: half done'])
  const sha = gitOut(root, 'rev-parse', 'HEAD')
  execFileSync('git', ['-C', root, 'checkout', '-q', INT])
  assert.equal(drive(root, [good('S1'), good('S2'), QA]).code, 0)
  const kept = gitOut(root, 'branch', '--list', '--format=%(refname:short)', 'attempt/S1-*-recovered')
  assert.ok(kept)
  assert.equal(gitOut(root, 'rev-parse', kept), sha)
})
await test('a session still running from a killed driver blocks a new one (11)', () => {
  const root = one()
  mkdirSync(stateDir(root), { recursive: true })
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', FAKE])
  writeFileSync(join(stateDir(root), 'session.pid'), String(orphan.pid))
  const { code, calls } = drive(root, [good('S1')])
  orphan.kill()
  assert.equal(code, 11)
  assert.equal(calls.length, 0)
})

console.log('== build-app driver: the finish')
await test('the final QA pass lands its "final: " fixes on integration; --no-pr pushes nothing', () => {
  const root = one()
  const { code } = drive(root, [good('S1'), good('S2'), { qa: 'done', commits: [{ subject: 'final: QA fixes', files: { 'src/S1.js': 'export const S1 = 2\n' } }] }])
  assert.equal(code, 0)
  assert.equal(gitOut(root, 'log', '-1', '--format=%s', INT), 'final: QA fixes')
  assert.match(status(root).message, /the final QA passed; --no-pr, so nothing was pushed/)
  assert.match(driverLog(root), /final QA over the whole branch against main/)
  assert.equal(gitOut(root, 'branch', '--list', 'slice/*'), '')
})
await test('a final QA that escalates, commits off-prefix, or writes no report brakes; every slice stays landed; a rerun repeats only the QA', () => {
  for (const [qa, why] of [
    [{ qa: 'escalate', reason: 'a HIGH finding the advisor confirmed' }, /the final QA did not pass \(escalate: a HIGH finding the advisor confirmed\)/],
    [{ qa: 'done', commits: [{ subject: 'QA fixes', files: { 'src/x.js': '1\n' } }] }, /commits that do not start with "final: "/],
    [{ error: 'something unexpected' }, /the final QA session wrote no report/],
  ]) {
    const root = one()
    assert.equal(drive(root, [good('S1'), good('S2'), qa]).code, 3, String(why))
    assert.match(status(root).message, why)
    assert.match(status(root).message, /every slice stays landed/)
    assert.deepEqual(Object.values(ledger(root).slices).map(x => x.status), ['done', 'done'])
    assert.equal(gitOut(root, 'rev-parse', '--abbrev-ref', 'HEAD'), INT)
    const again = drive(root, [QA])
    assert.equal(again.code, 0)
    assert.equal(again.calls.length, 1, 'only the QA runs again')
  }
})
await test('without --no-pr: the driver pushes integration/<app> and opens one PR to the default branch', () => {
  const root = one()
  const remote = mkdtempSync(join(tmpdir(), 'build-app-remote-'))
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote])
  const ghLog = join(dirname(root), `${root.split('/').pop()}-gh.log`)
  const { code } = drive(root, [good('S1'), good('S2'), QA], { HARNESS_BUILD_GH: FAKE_GH, FAKE_GH_LOG: ghLog }, [])
  assert.equal(code, 0, status(root).message)
  assert.equal(status(root).pr, 'https://github.com/example/toy/pull/7')
  assert.equal(gitOut(remote, 'rev-parse', INT), gitOut(root, 'rev-parse', INT), 'the branch was pushed')
  const gh = readFileSync(ghLog, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const create = gh.find(a => a[1] === 'create')
  assert.deepEqual(create.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', INT, '--title', 'toy: built from the backlog'])
  assert.match(create[9], /- \*\*S1\*\* slice 1: 1 criteria\n- \*\*S2\*\* slice 2: 1 criteria/)
  assert.match(create[9], /nothing here is merged or deployed automatically/)
  // An open PR for the branch is reused, never duplicated.
  const reuse = one()
  const remote2 = mkdtempSync(join(tmpdir(), 'build-app-remote-'))
  execFileSync('git', ['init', '-q', '--bare', remote2])
  execFileSync('git', ['-C', reuse, 'remote', 'add', 'origin', remote2])
  rmSync(ghLog, { force: true })
  drive(reuse, [good('S1'), good('S2'), QA], { HARNESS_BUILD_GH: FAKE_GH, FAKE_GH_LOG: ghLog, FAKE_GH_EXISTING: 'https://github.com/example/toy/pull/3' }, [])
  assert.equal(status(reuse).pr, 'https://github.com/example/toy/pull/3')
  assert.equal(readFileSync(ghLog, 'utf8').includes('"create"'), false)
})
await test('no origin remote: everything is built, nothing pushed, exit 13 with the reason', () => {
  const root = one()
  const { code } = drive(root, [good('S1'), good('S2'), QA], {}, [])
  assert.equal(code, 13)
  assert.match(status(root).message, /the final QA passed, but the repo has no origin remote/)
})
await test('a rejected push: nothing is opened, exit 13 with git\'s reason', () => {
  const root = one()
  const remote = mkdtempSync(join(tmpdir(), 'build-app-remote-'))
  execFileSync('git', ['init', '-q', '--bare', remote])
  // The remote already has an unrelated integration/toy, so the push is not a fast-forward.
  const other = one()
  execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', 'unrelated'])
  execFileSync('git', ['-C', other, 'push', '-q', remote, INT])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote])
  const ghLog = join(dirname(root), `${root.split('/').pop()}-gh.log`)
  const { code } = drive(root, [good('S1'), good('S2'), QA], { HARNESS_BUILD_GH: FAKE_GH, FAKE_GH_LOG: ghLog }, [])
  assert.equal(code, 13)
  assert.match(status(root).message, /but git push failed: .*(rejected|non-fast-forward|fetch first)/s)
  assert.equal(existsSync(ghLog), false, 'no PR call after a failed push')
})

await test('--no-pr is remembered: a resumed build never pushes; --pr opts back in', () => {
  const root = one()
  const remote = mkdtempSync(join(tmpdir(), 'build-app-remote-'))
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote])
  const ghLog = join(dirname(root), `${root.split('/').pop()}-gh.log`)
  const gh = { HARNESS_BUILD_GH: FAKE_GH, FAKE_GH_LOG: ghLog }
  assert.equal(drive(root, [{ dev: 'needs-human', questions: ['S1: which?'] }], gh, ['--no-pr']).code, 3)
  assert.equal(status(root).noPr, true)
  execFileSync(process.execPath, [DRIVER, 'unblock', '--repo', root, '--app', APP, '--slice', 'S1', '--answer', 'this one'])
  assert.equal(drive(root, [good('S1'), good('S2'), QA], gh, []).code, 0)
  assert.match(status(root).message, /--no-pr, so nothing was pushed/)
  assert.equal(existsSync(ghLog), false)
  assert.equal(drive(root, [QA], gh, ['--pr']).code, 0)
  assert.equal(status(root).pr, 'https://github.com/example/toy/pull/7')
  assert.equal(status(root).noPr, false)
})

console.log('== build-app driver: resume and unblock')
const cli = (root, ...args) => spawnSync(process.execPath, [DRIVER, ...args, '--repo', root, '--app', APP], { encoding: 'utf8' })
await test('unblock gives a blocked slice the answers and a fresh start; the next run builds it with them', () => {
  const root = one()
  assert.equal(drive(root, [{ dev: 'needs-human', questions: ['S1: which database?'] }]).code, 3)
  assert.equal(cli(root, 'unblock', '--slice', 'S2', '--answer', 'x').status, 1, 'S2 is not blocked')
  const u = cli(root, 'unblock', '--slice', 'S1', '--answer', 'SQLite', '--answer', 'port 3000')
  assert.equal(u.status, 0, u.stderr)
  assert.deepEqual(ledger(root).slices.S1.answers, ['SQLite', 'port 3000'])
  assert.equal(drive(root, [good('S1'), good('S2'), QA]).code, 0)
})
await test('resume starts the brake counters over; blocked slices stay blocked', () => {
  const root = repo({ ...BACKLOG, slices: [slice(1, []), slice(2, []), slice(3, [])] })
  const esc = { dev: 'escalate', reason: 'shared fixture broken' }
  assert.equal(drive(root, [esc, esc, esc]).code, 3)
  const r = cli(root, 'resume')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(ledger(root).escalatedSinceLanding, [])
  assert.equal(drive(root, [good('S1'), good('S2'), good('S3'), QA]).code, 0)
})
await test('status says stale when the driver that wrote "running" is gone; resume on an app never built fails', () => {
  const root = one()
  mkdirSync(stateDir(root), { recursive: true })
  const sleeper = spawn('sleep', ['30'])
  writeFileSync(join(stateDir(root), 'status.json'), JSON.stringify({ app: APP, state: 'running', pid: 999999, message: 'building S1' }))
  const st = JSON.parse(cli(root, 'status').stdout)
  assert.equal(st.state, 'stale')
  assert.match(st.message, /the driver \(pid 999999\) is gone; it was: building S1/)
  writeFileSync(join(stateDir(root), 'status.json'), JSON.stringify({ app: APP, state: 'running', pid: sleeper.pid, message: 'x' }))
  assert.equal(JSON.parse(cli(root, 'status').stdout).state, 'stale', 'a live pid that is not a driver')
  sleeper.kill()
  const typo = cli(root, 'resume')
  assert.equal(typo.status, 1)
  assert.match(typo.stderr, /no build ledger at .*; is the app slug right\?/)
  assert.equal(existsSync(join(stateDir(root), 'ledger.json')), false)
})
await test('resume and unblock refuse while a driver runs; bad unblock usage exits 2', () => {
  const root = one()
  mkdirSync(stateDir(root), { recursive: true })
  const driver = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', DRIVER])
  writeFileSync(join(stateDir(root), 'driver.pid'), String(driver.pid))
  assert.equal(cli(root, 'resume').status, 11)
  driver.kill()
  for (const args of [['unblock'], ['unblock', '--slice', 'S1'], ['unblock', '--answer', 'x'], ['unblock', '--slice', 'S01', '--answer', 'x'], ['resume', '--slice', 'S1'], ['status', '--no-pr'], ['resume', '--pr'], ['run', '--pr', '--no-pr']]) {
    assert.equal(cli(root, ...args).status, 2, JSON.stringify(args))
  }
})

console.log('== build-app driver: preflight, lock, and stop')
await test('preflight: no integration branch, a dirty tree, a backlog for another app, or no claude -> 6', () => {
  const noBranch = repo()
  execFileSync('git', ['-C', noBranch, 'switch', '-q', 'main'])
  execFileSync('git', ['-C', noBranch, 'branch', '-q', '-D', INT])
  assert.equal(drive(noBranch, []).code, 6)
  assert.match(status(noBranch).message, /no branch integration\/toy/)
  const dirty = repo()
  writeFileSync(join(dirty, 'stray.txt'), 'x')
  assert.equal(drive(dirty, []).code, 6)
  assert.match(status(dirty).message, /uncommitted changes/)
  const other = repo({ ...BACKLOG, app: 'other', integrationBranch: 'integration/other' })
  assert.equal(drive(other, []).code, 6)
  assert.match(status(other).message, /is for "other", not toy/)
  const noBin = repo()
  assert.equal(drive(noBin, [], { HARNESS_BUILD_CLAUDE_BIN: '/nonexistent/claude' }).code, 6)
})
await test('one driver per app: a live driver in driver.pid -> 11, and nothing runs', () => {
  const root = one()
  mkdirSync(stateDir(root), { recursive: true })
  const driver = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', DRIVER])
  writeFileSync(join(stateDir(root), 'driver.pid'), String(driver.pid))
  const { code, calls } = drive(root, [good('S1')])
  driver.kill()
  assert.equal(code, 11)
  assert.equal(calls.length, 0)
})
await test('a stale driver.pid that now names another process neither blocks a run nor gets killed by stop', async () => {
  const root = one()
  mkdirSync(stateDir(root), { recursive: true })
  const sleeper = spawn('sleep', ['30'])
  writeFileSync(join(stateDir(root), 'driver.pid'), String(sleeper.pid))
  const stop = spawnSync(process.execPath, [DRIVER, 'stop', '--repo', root, '--app', APP], { encoding: 'utf8' })
  assert.match(stop.stdout, /no driver is running for toy/)
  assert.equal(sleeper.exitCode, null, 'the unrelated process is alive')
  assert.equal(drive(root, [good('S1'), good('S2'), QA]).code, 0)
  sleeper.kill()
})
await test('a symlinked or relative --repo still gives the guard the real repo path', () => {
  const root = one()
  const link = `${root}-link`
  execFileSync('ln', ['-s', root, link])
  const { code, calls } = drive(link, [good('S1'), good('S2'), QA])
  assert.equal(code, 0)
  assert.equal(calls[0].guard.repo, root)
  const rel = spawnSync(process.execPath, [DRIVER, 'status', '--repo', root.split('/').pop(), '--app', APP], { cwd: dirname(root), encoding: 'utf8' })
  assert.equal(JSON.parse(rel.stdout).state, 'done')
})
await test('PANDASTACK_NOTIFY gets a line per landing and for a slice that gets stuck', () => {
  const root = one()
  const sink = join(dirname(root), `${root.split('/').pop()}-notify.txt`)
  const esc = { dev: 'escalate', reason: 'no' }
  drive(root, [good('S1'), esc, esc, esc, esc], { PANDASTACK_NOTIFY: `bash -c 'echo "$1" >> ${sink}' x` })
  const lines = readFileSync(sink, 'utf8').trim().split('\n')
  assert.deepEqual(lines.slice(0, 2), ['build-app toy: S1 landed', 'build-app toy: S2 is stuck after its re-plan and blocked; it and its dependents wait'])
  assert.match(lines[2], /^build-app toy: brake: every remaining slice is blocked: S2/)
})
await test('stop ends the running session, keeps nothing half-landed, and exits 130', async () => {
  const root = one()
  const { env: e } = env(root, [{ hang: true }])
  const child = spawn(process.execPath, [DRIVER, 'run', '--repo', root, '--app', APP], { env: e, stdio: 'ignore' })
  const until = async cond => { for (let i = 0; i < 200 && !cond(); i += 1) await new Promise(r => setTimeout(r, 50)) }
  await until(() => existsSync(join(stateDir(root), 'status.json')) && status(root).state === 'running')
  const stop = spawnSync(process.execPath, [DRIVER, 'stop', '--repo', root, '--app', APP], { encoding: 'utf8' })
  assert.match(stop.stdout, /asked the driver \(pid \d+\) to stop/)
  const code = await new Promise(r => child.on('close', r))
  assert.equal(code, 130)
  assert.equal(status(root).state, 'stopped')
  assert.equal(gitOut(root, 'rev-parse', '--abbrev-ref', 'HEAD'), INT)
  assert.equal(existsSync(join(stateDir(root), 'driver.pid')), false)
  const st = spawnSync(process.execPath, [DRIVER, 'status', '--repo', root, '--app', APP], { encoding: 'utf8' })
  assert.equal(JSON.parse(st.stdout).state, 'stopped')
})
await test('bad usage exits 2', () => {
  for (const args of [[], ['run'], ['run', '--repo', '/tmp'], ['run', '--repo', '/tmp', '--app', 'Bad App'], ['go', '--repo', '/tmp', '--app', 'toy']]) {
    assert.equal(spawnSync(process.execPath, [DRIVER, ...args]).status, 2, JSON.stringify(args))
  }
})
