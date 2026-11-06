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
function drive(root, script, extra = {}) {
  const { scriptFile, env: e } = env(root, script, extra)
  const r = spawnSync(process.execPath, [DRIVER, 'run', '--repo', root, '--app', APP], { encoding: 'utf8', env: e, timeout: 60_000 })
  const calls = existsSync(`${scriptFile}.calls`) ? readFileSync(`${scriptFile}.calls`, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  return { code: r.status, out: r.stdout + r.stderr, calls }
}
// A /dev session that lands slice `id` with one source file and one test file.
const good = (id, extra = {}) => ({ dev: 'done', commits: [{ subject: `${id}: C1: build ${id}`, files: { [`src/${id}.js`]: `export const ${id} = 1\n`, [`tests/${id}.test.js`]: `test ${id}\n` } }], ...extra })

console.log('== build-app driver: landing slices')
await test('every slice lands in order on the integration branch, each from a fresh headless /dev session', () => {
  const root = repo()
  const { code, calls, out } = drive(root, [good('S1'), good('S2'), good('S3')])
  assert.equal(code, 0, out)
  // The first ready slice in build order: S2 is ready once S1 lands, and comes before S3.
  assert.deepEqual(calls.map(c => c.args[c.args.indexOf('-p') + 1]), ['S1', 'S2', 'S3'].map(id => `/dev --slice ${id} --base integration/toy --unattended`))
  assert.deepEqual(gitOut(root, 'log', '--format=%s', `main..${INT}`).split('\n').reverse(), ['blueprint: design and backlog for toy', 'S1: C1: build S1', 'S2: C1: build S2', 'S3: C1: build S3'])
  const l = ledger(root)
  assert.deepEqual(Object.fromEntries(Object.entries(l.slices).map(([k, v]) => [k, [v.status, v.frozen]])), { S1: ['done', ['tests/S1.test.js']], S2: ['done', ['tests/S2.test.js']], S3: ['done', ['tests/S3.test.js']] })
  assert.equal(gitOut(root, 'rev-parse', '--abbrev-ref', 'HEAD'), INT)
  assert.equal(gitOut(root, 'branch', '--list', 'slice/*'), '', 'slice branches are deleted once landed')
  assert.equal(status(root).state, 'done')
  assert.equal(status(root).exitCode, 0)
})
await test('each session gets bypassPermissions, the injected settings, and a clean env without the parent\'s CLAUDE_CODE_*', () => {
  const root = repo({ ...BACKLOG, requirements: ['R1'], slices: [slice(1, [])] })
  const { code, calls } = drive(root, [good('S1')])
  assert.equal(code, 0)
  const [c] = calls
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'bypassPermissions')
  assert.equal(c.cwd, root)
  assert.equal(c.env.CLAUDE_CODE_INHERITED, undefined)
  assert.equal(c.env.HARNESS_BUILD_ACTIVE, '1')
  assert.ok(c.args.includes('--append-system-prompt'))
  const settings = JSON.parse(readFileSync(c.args[c.args.indexOf('--settings') + 1], 'utf8'))
  assert.deepEqual(settings.env, { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0', CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: '' })
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
  const { code, out } = drive(root, [good('S1'), tamper, good('S2')])
  assert.equal(code, 0, out)
  assert.match(driverLog(root), /S2: escalated .*frozen tests from earlier slices changed: tests\/S1\.test\.js/)
  assert.equal(readFileSync(join(root, 'tests', 'S1.test.js'), 'utf8'), 'test S1\n', 'the frozen test on integration is unchanged')
  assert.match(gitOut(root, 'branch', '--list', 'attempt/S2-*'), /attempt\/S2-/)
  const { calls } = drive(one(), [good('S1'), good('S2')])
  assert.deepEqual(calls.map(c => c.guard.frozen), [[], ['tests/S1.test.js']], 'the guard gets every frozen test before each session')
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
  const { code, calls } = drive(root, [good('S2')])
  assert.equal(code, 0)
  assert.equal(calls.length, 1)
  assert.match(calls[0].args.join(' '), /--slice S2/)
})

console.log('== build-app driver: limits and the API')
await test('a usage limit with a reset time waits and retries the same slice, not counted', () => {
  const root = one()
  const reset = new Date(Date.now() + 60 * 60_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()
  const { code, out } = drive(root, [{ limit: `You've hit your session limit · resets ${reset}` }, good('S1'), good('S2')])
  assert.equal(code, 0, out)
  assert.match(driverLog(root), /S1: usage limit .*not counted/)
  assert.match(driverLog(root), /waiting until .*then retrying S1/)
  assert.deepEqual(ledger(root).slices.S1.reasons, [])
})
await test('a usage limit without a reset time probes until usage is back', () => {
  const root = one()
  const { code, out } = drive(root, [{ limit: "You've hit your session limit" }, { ok: true }, good('S1'), good('S2')], { HARNESS_BUILD_PROBE_MINUTES: '1' })
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
await test('an overloaded API is retried after a wait, not counted', () => {
  const root = one()
  const { code } = drive(root, [{ error: 'API Error: Repeated 529 Overloaded errors' }, good('S1'), good('S2')])
  assert.equal(code, 0)
  assert.match(driverLog(root), /API overloaded or server error .*retry 1\/3, not counted/)
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
await test('one driver per app: a live pid in driver.pid -> 11, and nothing runs', () => {
  const root = one()
  mkdirSync(stateDir(root), { recursive: true })
  const sleeper = spawn('sleep', ['30'])
  writeFileSync(join(stateDir(root), 'driver.pid'), String(sleeper.pid))
  const { code, calls } = drive(root, [good('S1')])
  sleeper.kill()
  assert.equal(code, 11)
  assert.equal(calls.length, 0)
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
