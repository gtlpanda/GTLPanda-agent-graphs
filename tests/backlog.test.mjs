// backlog.test.mjs — the backlog format, the build ledger, and the next-step
// rules (core/skills/backlog/backlog.mjs).
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import {
  validateBacklog, sliceTask, ledgerPath, readLedger, writeLedger, emptyLedger, sliceState, nextSlice, blockedClosure,
  frozenFiles, recordOutcome, brake, unblock, resume, MAX_REPLANS, MAX_ESCALATED_SLICES,
} from '../core/skills/backlog/backlog.mjs'

const SKILL = join(REPO, 'core', 'skills', 'backlog')
const SCRIPT = join(SKILL, 'backlog.mjs')

const AC = (id, k) => ({ id: `${id}-AC${k}`, criterion: `criterion ${k} of ${id}`, fails_when: `observable failure ${k}` })
const SLICE = (n, extra = {}) => ({
  id: `S${n}`, title: `Slice ${n}`, goal: `Build part ${n}.`, requirements: [`R${n}`], acceptance: [AC(`S${n}`, 1)], depends_on: n > 1 ? [`S${n - 1}`] : [], ...extra,
})
const BACKLOG = (n = 3) => ({
  version: 1, app: 'reading-list', integrationBranch: 'integration/reading-list',
  requirements: Array.from({ length: n }, (_, i) => `R${i + 1}`),
  slices: Array.from({ length: n }, (_, i) => SLICE(i + 1)),
})
// A copy with one change applied by `edit`, so each test states only what differs.
const variant = edit => { const b = BACKLOG(); edit(b); return b }
const problems = b => validateBacklog(b)

console.log('== backlog: the format')
await test('a well-formed backlog passes, also against the design\'s own requirement ids', () => {
  assert.deepEqual(problems(BACKLOG()), [])
  assert.deepEqual(validateBacklog(BACKLOG(), ['R1', 'R2', 'R3']), [])
})
await test('the example in SKILL.md passes, so the doc and the code cannot drift', () => {
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8')
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(skill)[1])
  assert.deepEqual(problems(example), [])
})
await test('anything but an object is one problem, never a crash', () => {
  for (const bad of [null, undefined, 0, 1, '', 'backlog', [], [BACKLOG()], true]) {
    assert.deepEqual(problems(bad), ['the backlog is not a JSON object'], JSON.stringify(bad))
  }
})
await test('version, app slug, and integration branch', () => {
  assert.deepEqual(problems(variant(b => { b.version = 2 })), ['version must be 1, got 2'])
  assert.deepEqual(problems(variant(b => { b.version = '1' })), ['version must be 1, got "1"'])
  for (const app of ['Reading-List', 'reading_list', '-reading', 'reading-', 'reading--list', '', 'a b', 7]) {
    const got = problems(variant(b => { b.app = app }))
    assert.equal(got.length, 1, `${JSON.stringify(app)}: ${got}`)
    assert.match(got[0], /^app must be a lowercase slug/)
  }
  assert.deepEqual(problems(variant(b => { b.integrationBranch = 'integration/other' })), ['integrationBranch must be "integration/reading-list", got "integration/other"'])
  assert.deepEqual(problems(variant(b => { delete b.integrationBranch })), ['integrationBranch must be "integration/reading-list", got undefined'])
})
await test('requirements: present, R<n> ids, unique, all covered, and matching the design when given', () => {
  assert.ok(problems(variant(b => { b.requirements = [] })).includes('requirements must list the design\'s requirement ids (R1, R2, ...)'))
  for (const id of ['r1', 'R', 'R1a', ' R1', 'Q1', 1]) {
    assert.ok(problems(variant(b => { b.requirements.push(id) })).includes(`${JSON.stringify(id)} is not a requirement id (R1, R2, ...)`), JSON.stringify(id))
  }
  assert.deepEqual(problems(variant(b => { b.requirements.push('R1') })), ['requirement R1 is listed twice'])
  assert.deepEqual(problems(variant(b => { b.requirements.push('R9') })), ['requirement R9 is in no slice'])
  assert.deepEqual(validateBacklog(BACKLOG(), ['R1', 'R2', 'R3', 'R4']), ['design requirement R4 is missing from requirements'])
  assert.deepEqual(validateBacklog(BACKLOG(), ['R1', 'R2']), ['requirement "R3" is not in the design'])
})
await test('slices: present, at most 40, ids S1..Sn in order', () => {
  assert.ok(problems(variant(b => { b.slices = [] })).includes('the backlog has no slices'))
  const many = BACKLOG(41)
  assert.ok(problems(many).includes('41 slices is more than 40: split the app or merge slices'))
  assert.deepEqual(problems(BACKLOG(40)), [])
  for (const id of ['S01', 's2', 'S3', '2', null]) {
    const got = problems(variant(b => { b.slices[1].id = id }))
    assert.deepEqual(got, [`slice 2 must have id S2 (ids run S1, S2, ... in build order), got ${JSON.stringify(id)}`], JSON.stringify(id))
  }
  assert.deepEqual(problems(variant(b => { b.slices[1] = 'S2' })), ['slice 2 is not an object', 'requirement R2 is in no slice'])
})
await test('a slice needs a title and a goal, and a goal never says "stop and ask"', () => {
  assert.deepEqual(problems(variant(b => { b.slices[0].title = '  ' })), ['S1: title is empty'])
  assert.deepEqual(problems(variant(b => { delete b.slices[0].goal })), ['S1: goal is empty'])
  for (const goal of ['Build it, then stop and ask the user.', 'STOP AND ASK first', 'stop\nand  ask', 'stop-and-ask before saving']) {
    assert.deepEqual(problems(variant(b => { b.slices[0].goal = goal })), ['S1: goal says "stop and ask", which would make an unattended /dev wait for a human'], goal)
  }
  // The whole slice is /dev's task text, so every field is checked, and one problem names them all.
  const everywhere = variant(b => {
    b.slices[0].title = 'Stop and ask'
    b.slices[0].acceptance[0].criterion = 'it should stop and ask the user'
    b.slices[1].acceptance[0].fails_when = 'it does not stop-and-ask'
  })
  assert.deepEqual(problems(everywhere), [
    'S1: title, AC1 criterion says "stop and ask", which would make an unattended /dev wait for a human',
    'S2: AC1 fails_when says "stop and ask", which would make an unattended /dev wait for a human',
  ])
  for (const goal of ['Add a Stop button and an Ask dialog.', 'Never stop; ask nothing.', 'Stop asking for the title twice.']) {
    assert.deepEqual(problems(variant(b => { b.slices[0].goal = goal })), [], goal)
  }
})
await test('slice requirements: a list of known ids, each once; an empty list is a scaffold slice', () => {
  assert.deepEqual(problems(variant(b => { b.slices[0].requirements.push('R9') })), ['S1 names "R9", which is not in requirements'])
  assert.deepEqual(problems(variant(b => { b.slices[0].requirements = ['R1', 'R1'] })), ['S1 names a requirement twice'])
  assert.deepEqual(problems(variant(b => { b.slices[0].requirements = 'R1' })), ['S1: requirements must be a list (it may be empty)', 'requirement R1 is in no slice'])
  assert.deepEqual(problems(variant(b => { b.slices[0].requirements = []; b.slices[1].requirements = ['R1', 'R2'] })), [])
})
await test('acceptance: 1 to 8 criteria, ids S<n>-AC<k> in order, each with a criterion and fails_when', () => {
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance = [] })), ['S1: acceptance is empty (at least one pass/fail criterion)'])
  assert.deepEqual(problems(variant(b => { delete b.slices[0].acceptance })), ['S1: acceptance is empty (at least one pass/fail criterion)'])
  const nine = Array.from({ length: 9 }, (_, k) => AC('S1', k + 1))
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance = nine })), ['S1: 9 criteria is more than 8: split the slice'])
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance = nine.slice(0, 8) })), [])
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance[0].id = 'S2-AC1' })), ['S1: criterion 1 must have id S1-AC1, got "S2-AC1"'])
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance.push(AC('S1', 3)) })), ['S1: criterion 2 must have id S1-AC2, got "S1-AC3"'])
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance[0].criterion = '' })), ['S1-AC1: criterion is empty'])
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance[0].fails_when = ' ' })), ['S1-AC1: fails_when is empty (what observable result fails it)'])
  assert.deepEqual(problems(variant(b => { b.slices[0].acceptance = [null] })), ['S1-AC1 is not an object'])
})
await test('depends_on names only earlier slices, each once, so a cycle is impossible', () => {
  const msg = (id, d, i) => `${id} depends on ${JSON.stringify(d)}: a slice may depend only on earlier slices (S1..S${i})`
  assert.deepEqual(problems(variant(b => { b.slices[1].depends_on = ['S2'] })), [msg('S2', 'S2', 1)], 'itself')
  assert.deepEqual(problems(variant(b => { b.slices[1].depends_on = ['S3'] })), [msg('S2', 'S3', 1)], 'a later slice')
  assert.deepEqual(problems(variant(b => { b.slices[0].depends_on = ['S1'] })), [msg('S1', 'S1', 0)])
  for (const d of ['S0', 'S01', 's1', 'S1 ', 1, null]) {
    assert.deepEqual(problems(variant(b => { b.slices[2].depends_on = [d] })), [msg('S3', d, 2)], JSON.stringify(d))
  }
  assert.deepEqual(problems(variant(b => { b.slices[2].depends_on = ['S1', 'S1'] })), ['S3 depends on a slice twice'])
  assert.deepEqual(problems(variant(b => { b.slices[2].depends_on = 'S2' })), ['S3: depends_on must be a list (it may be empty)'])
  assert.deepEqual(problems(variant(b => { b.slices[2].depends_on = ['S1', 'S2'] })), [])
})
await test('validateBacklog uses nothing outside its own source, so the backlog stage can copy it verbatim', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  const start = src.indexOf('function validateBacklog(')
  const block = src.slice(start, src.indexOf('\n}\n', start) + 3)
  const isolated = new Function(`"use strict"; ${block}; return validateBacklog`)()
  assert.deepEqual(isolated(BACKLOG()), [])
  assert.deepEqual(isolated(variant(b => { b.slices[0].goal = '' })), ['S1: goal is empty'])
  assert.doesNotMatch(block, /Date\.now|Math\.random|new Date\(\)/, 'workflow scripts reject these')
})

console.log('== backlog: the command line')
const dir = mkdtempSync(join(tmpdir(), 'backlog-test-'))
const cli = (args, opts = {}) => spawnSync(process.execPath, [...(opts.node || []), opts.script || SCRIPT, ...args], { encoding: 'utf8' })
await test('check: PASS exits 0, FAIL lists each problem and exits 1, bad usage exits 2', () => {
  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify(BACKLOG()))
  let r = cli(['check', good])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout.trim().split('\n').pop(), 'BACKLOG: PASS')
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, JSON.stringify(variant(b => { b.slices[0].title = '' })))
  r = cli(['check', bad])
  assert.equal(r.status, 1)
  assert.deepEqual(r.stdout.trim().split('\n'), [`backlog: ${bad}: S1: title is empty`, 'BACKLOG: FAIL'])
  for (const args of [[], ['check'], ['lint', good], ['check', good, 'extra']]) {
    r = cli(args)
    assert.equal(r.status, 2, JSON.stringify(args))
    assert.match(r.stderr, /usage: backlog\.mjs check <backlog\.json> \| backlog\.mjs task <backlog\.json> <S<n>> \[build state dir\]/)
  }
})
await test('check: a missing or unparseable file is a FAIL with the reason, not a crash', () => {
  let r = cli(['check', join(dir, 'missing.json')])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /cannot read .*missing\.json: ENOENT\nBACKLOG: FAIL/)
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{"version": 1,')
  r = cli(['check', broken])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /broken\.json is not valid JSON/)
})
await test('check runs through a symlink, the way install.sh links the skill', () => {
  const link = join(dir, 'linked-backlog.mjs')
  symlinkSync(SCRIPT, link)
  const good = join(dir, 'good.json')
  const r = cli(['check', good], { script: link })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout.trim(), 'BACKLOG: PASS')
})

console.log('== backlog: the ledger')
await test('a missing ledger is a fresh build; an unreadable or wrong-shaped one throws', () => {
  assert.deepEqual(readLedger(join(dir, 'nope', 'ledger.json')), emptyLedger())
  const broken = join(dir, 'broken-ledger.json')
  writeFileSync(broken, '{"version":')
  assert.throws(() => readLedger(broken), /is not valid JSON/)
  const top = { version: 1, replans: 0, escalatedSinceLanding: [], slices: {} }
  const withSlice = s1 => ({ ...top, slices: { S1: s1 } })
  for (const shape of [[], null, { ...top, version: 2 }, { version: 1, replans: 0, escalatedSinceLanding: [] },
    { ...top, replans: '0' }, { ...top, replans: -1 }, { version: 1, replans: 0, slices: {} }, { ...top, escalatedSinceLanding: [1] },
    { ...top, slices: null }, { ...top, slices: [] }, { ...top, slices: { S01: {} } },
    // A slice entry the rules cannot read would be rebuilt or offered forever: never guess.
    withSlice('done'), withSlice({ status: 'complete' }), withSlice({ escalations: '1' }), withSlice({ replans: 1.5 }),
    withSlice({ replan: 'yes' }), withSlice({ frozen: 'tests/a.test.js' }), withSlice({ answers: [2] })]) {
    writeFileSync(broken, JSON.stringify(shape))
    assert.throws(() => readLedger(broken), /is not a version 1 build ledger: /, JSON.stringify(shape))
  }
  writeFileSync(broken, JSON.stringify(withSlice({ status: 'done', frozen: ['t.js'] })))
  assert.equal(readLedger(broken).slices.S1.status, 'done', 'a well-formed entry still reads')
})
await test('only a missing file is a fresh build: a path that merely contains ENOENT still throws when corrupt', () => {
  const odd = join(dir, 'ENOENTdir', 'ledger.json')
  writeLedger(odd, emptyLedger())
  writeFileSync(odd, '{bad')
  assert.throws(() => readLedger(odd), /is not valid JSON/)
})
await test('writeLedger round-trips, creates the directory, and leaves no temp file', () => {
  const path = join(dir, 'harness-build', 'ledger.json')
  const ledger = recordOutcome(emptyLedger(), 'S1', { kind: 'landed', frozen: ['tests/a.test.js'] })
  writeLedger(path, ledger)
  assert.deepEqual(readLedger(path), ledger)
  assert.equal(existsSync(`${path}.tmp`), false)
  // What readLedger would refuse is never written: the failure shows now, not on resume.
  for (const bad of [{ ...emptyLedger(), slices: { S01: {} } }, { ...emptyLedger(), slices: { S1: { frozen: [3] } } }]) {
    assert.throws(() => writeLedger(join(dir, 'never.json'), bad), /refusing to write a build ledger/, JSON.stringify(bad))
  }
  assert.equal(existsSync(join(dir, 'never.json')), false)
})

console.log('== backlog: next step')
const land = (ledger, id, frozen = []) => recordOutcome(ledger, id, { kind: 'landed', frozen })
const escalate = (ledger, id, reason = `${id} failed`) => recordOutcome(ledger, id, { kind: 'escalated', reason })
const ask = (ledger, id) => recordOutcome(ledger, id, { kind: 'needs-human', questions: [`${id}: which?`] })
const fan = () => variant(b => { b.slices[1].depends_on = []; b.slices[2].depends_on = [] })   // S2, S3 independent
await test('next slice: build order, only when every dependency is done; null when all are done', () => {
  const b = BACKLOG()
  assert.equal(nextSlice(b, emptyLedger()).id, 'S1')
  assert.equal(nextSlice(b, land(emptyLedger(), 'S1')).id, 'S2')
  assert.equal(nextSlice(b, land(land(land(emptyLedger(), 'S1'), 'S2'), 'S3')), null)
})
await test('next slice: one that escalated since the last landing goes after independent work', () => {
  const b = fan()
  let l = escalate(emptyLedger(), 'S1')
  assert.equal(nextSlice(b, l).id, 'S2', 'S1 escalated, S2 is independent')
  l = escalate(l, 'S2')
  assert.equal(nextSlice(b, l).id, 'S3')
  assert.equal(nextSlice(BACKLOG(), escalate(emptyLedger(), 'S1')).id, 'S1', 'nothing else is ready, so it retries')
  // Four independent slices: S1 escalates, S2 lands. With the queue cleared S1 is first again;
  // without the reset it would still go after S3.
  const four = variant(x => { x.slices.push(SLICE(4)); x.requirements.push('R4'); for (const s of x.slices) s.depends_on = [] })
  assert.equal(nextSlice(four, land(escalate(emptyLedger(), 'S1'), 'S2')).id, 'S1', 'a landing clears the queue order')
})
await test('blocked: transitive through dependencies; independent slices keep building', () => {
  const chain = BACKLOG()
  const l = ask(emptyLedger(), 'S1')
  assert.deepEqual([...blockedClosure(chain, l)], ['S1', 'S2', 'S3'])
  assert.equal(nextSlice(chain, l), null)
  const b = fan()
  assert.deepEqual([...blockedClosure(b, l)], ['S1'])
  assert.equal(nextSlice(b, l).id, 'S2')
})
await test('two escalations re-plan a slice with every reason; two more after the re-plan block it as stuck', () => {
  let l = escalate(emptyLedger(), 'S1', 'verify failed')
  assert.deepEqual(sliceState(l, 'S1'), { status: 'pending', escalations: 1, replans: 0, replan: false, reasons: ['verify failed'], questions: [], answers: [], frozen: [], stuck: false })
  l = escalate(l, 'S1', 'acceptance unmet')
  assert.equal(sliceState(l, 'S1').replan, true)
  assert.equal(sliceState(l, 'S1').escalations, 0)
  assert.deepEqual(sliceState(l, 'S1').reasons, ['verify failed', 'acceptance unmet'])
  assert.equal(l.replans, 1)
  l = escalate(l, 'S1', 'third')
  assert.equal(sliceState(l, 'S1').replan, false, 'the re-plan was one attempt; it is not repeated')
  l = escalate(l, 'S1', 'fourth')
  assert.equal(sliceState(l, 'S1').status, 'blocked')
  assert.equal(sliceState(l, 'S1').stuck, true)
  assert.equal(l.replans, 1, 'blocking is not a re-plan')
  assert.deepEqual(sliceState(l, 'S1').reasons, ['verify failed', 'acceptance unmet', 'third', 'fourth'])
})
await test('landing freezes the slice\'s tests, clears the re-plan flag and the escalation queue', () => {
  let l = escalate(escalate(emptyLedger(), 'S1'), 'S1')
  l = land(l, 'S1', ['tests/b.test.js', 'tests/a.test.js'])
  assert.equal(sliceState(l, 'S1').status, 'done')
  assert.equal(sliceState(l, 'S1').replan, false)
  assert.deepEqual(sliceState(l, 'S1').frozen, ['tests/a.test.js', 'tests/b.test.js'])
  assert.deepEqual(l.escalatedSinceLanding, [])
  l = land(l, 'S2', ['tests/a.test.js', 'tests/c.test.js'])
  assert.deepEqual(frozenFiles(l), ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js'])
  assert.deepEqual(frozenFiles(escalate(emptyLedger(), 'S1')), [], 'only landed slices freeze tests')
})
await test('outcomes are validated, apply only to pending slices, and never change the input ledger', () => {
  const l = emptyLedger()
  const before = JSON.stringify(l)
  escalate(l, 'S1')
  assert.equal(JSON.stringify(l), before)
  for (const bad of [undefined, {}, { kind: 'merged' }, { kind: 'landed' }, { kind: 'landed', frozen: 'a' }, { kind: 'escalated' },
    { kind: 'escalated', reason: ' ' }, { kind: 'needs-human' }, { kind: 'needs-human', questions: [] },
    { kind: 'landed', frozen: [3] }, { kind: 'landed', frozen: [''] }, { kind: 'needs-human', questions: [{ q: 'x' }] }]) {
    assert.throws(() => recordOutcome(l, 'S1', bad), Error, JSON.stringify(bad))
  }
  assert.throws(() => land(land(l, 'S1'), 'S1'), /S1 is done; only a pending slice takes an outcome/)
  assert.throws(() => escalate(ask(l, 'S1'), 'S1'), /S1 is blocked/)
})

console.log('== backlog: the human\'s way back')
await test('unblock: a blocked slice gets the answers, a fresh plan, and fresh counts; nothing else can be unblocked', () => {
  const b = BACKLOG()
  let l = unblock(ask(emptyLedger(), 'S1'), 'S1', ['use SQLite'])
  assert.deepEqual(sliceState(l, 'S1'), { status: 'pending', escalations: 0, replans: 0, replan: true, reasons: [], questions: [], answers: ['use SQLite'], frozen: [], stuck: false })
  assert.equal(nextSlice(b, l).id, 'S1')
  let stuck = emptyLedger()
  for (let i = 0; i < 4; i += 1) stuck = escalate(stuck, 'S1')
  stuck = unblock(stuck, 'S1', ['the fixture needs a seed'])
  assert.equal(sliceState(stuck, 'S1').stuck, false)
  assert.equal(sliceState(stuck, 'S1').replans, 0, 'a fresh re-plan budget, or the next failure would block it at once')
  assert.equal(sliceState(stuck, 'S1').reasons.length, 4, 'the reasons stay for the fresh plan')
  let twice = unblock(ask(emptyLedger(), 'S1'), 'S1', ['use SQLite'])
  twice = unblock(recordOutcome(twice, 'S1', { kind: 'needs-human', questions: ['S1: which port?'] }), 'S1', ['port 3000'])
  assert.deepEqual(sliceState(twice, 'S1').answers, ['use SQLite', 'port 3000'], 'a second unblock never drops the first decision')
  assert.throws(() => unblock(emptyLedger(), 'S1', ['x']), /S1 is pending; only a blocked slice can be unblocked/)
  assert.throws(() => unblock(land(emptyLedger(), 'S1'), 'S1', ['x']), /S1 is done/)
  for (const bad of [undefined, [], [''], [' '], [1], 'yes']) {
    assert.throws(() => unblock(ask(emptyLedger(), 'S1'), 'S1', bad), /needs the human's answers/, JSON.stringify(bad))
  }
  const before = ask(emptyLedger(), 'S1')
  const copy = JSON.stringify(before)
  unblock(before, 'S1', ['x'])
  assert.equal(JSON.stringify(before), copy, 'the input ledger is unchanged')
})
await test('resume clears the first two brakes; blocked slices stay blocked', () => {
  const b = fan()
  let l = escalate(escalate(escalate(emptyLedger(), 'S1'), 'S2'), 'S3')
  assert.ok(brake(b, l))
  assert.equal(brake(b, resume(l)), null)
  l = emptyLedger()
  for (const id of ['S1', 'S2', 'S3']) l = escalate(escalate(l, id), id)
  assert.equal(l.replans, 3)
  assert.equal(resume(l).replans, 0)
  const blocked = resume(ask(emptyLedger(), 'S1'))
  assert.equal(sliceState(blocked, 'S1').status, 'blocked')
  assert.equal(brake(BACKLOG(), blocked), 'every remaining slice is blocked: S1, S2, S3')
})

console.log('== backlog: brakes')
await test('a third re-plan in the app stops the build', () => {
  const b = BACKLOG(4)
  let l = emptyLedger()
  for (const id of ['S1', 'S2']) { l = escalate(escalate(l, id), id); l = land(l, id) }
  assert.equal(l.replans, 2)
  assert.equal(brake(b, l), null)
  l = escalate(escalate(l, 'S3'), 'S3')
  assert.equal(l.replans, MAX_REPLANS)
  assert.match(brake(b, l), /^3 re-plans in this app/)
})
await test('three different slices escalating with none landing between stops the build; one slice retrying does not', () => {
  const b = fan()
  let l = escalate(escalate(emptyLedger(), 'S1'), 'S1')
  l = escalate(l, 'S1')
  assert.equal(brake(b, l), null, 'one slice, three tries: its own limits handle it')
  l = escalate(escalate(l, 'S2'), 'S3')
  assert.equal(l.escalatedSinceLanding.length, MAX_ESCALATED_SLICES)
  assert.match(brake(b, l), /^3 different slices escalated with none landing in between \(S1, S2, S3\)/)
  assert.equal(brake(b, land(escalate(escalate(emptyLedger(), 'S1'), 'S2'), 'S3')), null, 'a landing resets it')
})
await test('every remaining slice blocked stops the build; all done is not a brake', () => {
  const b = BACKLOG()
  assert.equal(brake(b, ask(emptyLedger(), 'S1')), 'every remaining slice is blocked: S1, S2, S3')
  assert.equal(brake(b, ask(land(emptyLedger(), 'S1'), 'S2')), 'every remaining slice is blocked: S2, S3')
  assert.equal(brake(b, land(land(land(emptyLedger(), 'S1'), 'S2'), 'S3')), null)
  assert.equal(brake(fan(), ask(emptyLedger(), 'S1')), null, 'S2 and S3 can still build')
})


console.log('== backlog: a slice as /dev\'s task')
await test('sliceTask: the task names the slice, its goal, and every criterion verbatim, which come back as requiredCriteria', () => {
  const b = variant(x => { x.slices[1].acceptance.push({ id: 'S2-AC2', criterion: 'a read book stays read', fails_when: 'a restart resets it' }) })
  const t = sliceTask(b, 'S2')
  assert.equal(t.slice, 'S2')
  assert.equal(t.app, 'reading-list')
  assert.equal(t.task, [
    'Slice S2 of reading-list: Slice 2', '', 'Build part 2.', '',
    'Requirements: R2. Built before it: S1.', '',
    'Acceptance criteria. The plan carries each one with its id and criterion unchanged, and a test proves it:',
    '- S2-AC1: criterion 1 of S2 (fails when: observable failure 1)',
    '- S2-AC2: a read book stays read (fails when: a restart resets it)',
  ].join('\n'))
  assert.deepEqual(t.requiredCriteria, b.slices[1].acceptance)
  assert.doesNotMatch(t.task, /stop[\s-]+and[\s-]+ask/i)
  const scaffold = sliceTask(variant(x => { x.slices[0].requirements = []; x.slices[1].requirements = ['R1', 'R2'] }), 'S1')
  assert.match(scaffold.task, /Requirements: none \(a scaffold slice\)\. Built before it: nothing\./)
})
await test('sliceTask: a re-planned or unblocked slice carries every earlier reason and answer, oldest first', () => {
  let l = escalate(escalate(emptyLedger(), 'S1', 'verify failed: no db'), 'S1', 'acceptance S1-AC1 unmet')
  l = recordOutcome(l, 'S1', { kind: 'needs-human', questions: ['S1: which db?'] })
  l = unblock(l, 'S1', ['use SQLite'])
  const t = sliceTask(BACKLOG(), 'S1', l).task
  assert.match(t, /Earlier attempts at this slice stopped for these reasons; plan around them:\n- verify failed: no db\n- acceptance S1-AC1 unmet/)
  assert.match(t, /The human answered questions about this slice; the answers are binding:\n- use SQLite$/)
  assert.doesNotMatch(sliceTask(BACKLOG(), 'S2', l).task, /Earlier attempts|answered/, 'another slice\'s history stays out')
})
await test('ledgerPath: one ledger per app in the build state directory; a bad slug never makes a path', () => {
  assert.equal(ledgerPath('/r/.git/harness-build', 'reading-list'), '/r/.git/harness-build/reading-list/ledger.json')
  for (const bad of ['../x', 'Bad', '', undefined, 'a/b']) assert.throws(() => ledgerPath('/s', bad), /is not an app slug/, String(bad))
})
await test('sliceTask: an unknown slice or a backlog that fails its check throws', () => {
  assert.throws(() => sliceTask(BACKLOG(), 'S9'), /"S9" is not a slice of the backlog/)
  assert.throws(() => sliceTask(BACKLOG(), undefined), /is not a slice/)
  assert.throws(() => sliceTask(variant(x => { x.app = 'Bad' }), 'S1'), /the backlog does not pass its check: app must be a lowercase slug/)
})
await test('task command: prints the JSON and exits 0; a bad slice, a broken ledger, or bad usage does not', () => {
  const path = join(dir, 'task-backlog.json')
  writeFileSync(path, JSON.stringify(BACKLOG()))
  const ok = cli(['task', path, 'S2'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(JSON.parse(ok.stdout), sliceTask(BACKLOG(), 'S2'))
  const state = join(dir, 'harness-build')
  writeLedger(ledgerPath(state, 'reading-list'), escalate(emptyLedger(), 'S2', 'no db'))
  writeLedger(ledgerPath(state, 'other-app'), escalate(emptyLedger(), 'S2', 'another app'))
  const withLedger = JSON.parse(cli(['task', path, 'S2', state]).stdout).task
  assert.match(withLedger, /- no db$/)
  assert.doesNotMatch(withLedger, /another app/, 'only this app\'s ledger is read')
  assert.equal(cli(['task', path, 'S2', join(dir, 'no-state-yet')]).status, 0, 'a missing ledger is a first attempt')
  const badState = join(dir, 'bad-state')
  mkdirSync(join(badState, 'reading-list'), { recursive: true })
  writeFileSync(ledgerPath(badState, 'reading-list'), '{')
  const broken = cli(['task', path, 'S2', badState])
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /^backlog: .*ledger\.json is not valid JSON/)
  writeFileSync(join(dir, 'bad-app.json'), JSON.stringify({ ...BACKLOG(), app: '../escape' }))
  assert.match(cli(['task', join(dir, 'bad-app.json'), 'S1', state]).stderr, /the backlog does not pass its check: app must be a lowercase slug/)
  const unknown = cli(['task', path, 'S7'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /"S7" is not a slice/)
  assert.equal(unknown.stdout, '')
  for (const args of [['task', path], ['task', path, 'S1', 'dir', 'extra']]) assert.equal(cli(args).status, 2, JSON.stringify(args))
})
rmSync(dir, { recursive: true, force: true })
