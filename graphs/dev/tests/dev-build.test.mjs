// dev-build.test.mjs — routing tests for the dev-build graph against scripted
// agents and a scripted QA child workflow. Run by scripts/test-workflow.mjs.
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, load, run, agentField } from '../../../scripts/workflow-harness.mjs'

// ---------- fixtures ----------
const PASS_BLOCK = '  [0] scripts/test.sh\nVERIFY: PASS'
const FAIL_BLOCK = '  [1] npm run test\nVERIFY: FAIL'
const pass_ = () => ({ verdict: 'PASS', verify_block: PASS_BLOCK, failures: [] })
const failWith = key => ({ verdict: 'FAIL', verify_block: FAIL_BLOCK, failures: [{ step: 'npm run test', exit: 1, error_key: key, excerpt: `AssertionError ${key}` }] })
const criterion = id => ({ id, criterion: `${id} holds`, protects: 'p', fails_when: 'f', no_claim: 'n' })
const component = (id, files, deps = []) => ({ id, title: `build ${id}`, files, depends_on: deps, tests: ['t'] })
const PLAN = (over = {}) => ({
  goal: 'non-owners cannot delete',
  acceptance: [criterion('AC1'), criterion('AC2')],
  components: [component('C1', ['src/a.js']), component('C2', ['src/b.js'], ['C1'])],
  behavior_changes: ['DELETE returns 404 for non-owners'],
  out_of_scope: [], risks: [], questions: [],
  ...over,
})
const approve = { verdict: 'approve', issues: [], questions: [] }
// revise() leaves blocking unset on purpose: a missing blocking must count as blocking.
const revise = (...issues) => ({ verdict: 'revise', issues: issues.map((issue, i) => ({ n: i + 1, issue, fix: 'fix it' })), questions: [] })
const nits = (...issues) => ({ verdict: 'revise', issues: issues.map((issue, i) => ({ n: i + 1, issue, fix: 'fix it', blocking: false })), questions: [] })
const brief = () => ({ reuse: [], must_preserve: [], interfaces: [], edge_cases: [], test_patterns: 'node --test' })
const built = (touched = ['src/a.js'], over = {}) => ({ done: true, touched, tests_added: [], test_changes: [], verify_verdict: 'PASS', unchecked: [], summary: 'ok', ...over })
const met = (ids = ['AC1', 'AC2']) => ({ criteria: ids.map(id => ({ id, status: 'MET', evidence: `test/a.test.js:3 asserts ${id}; node --test passes` })), behavior_changes_missing: [] })
const QA_DONE = { status: 'done', reason: 'VERIFY: PASS and no HIGH/CRITICAL review or QA findings', touched: ['src/a.js'], stuckSig: null }
const QA = 'workflow:harness-repair'
const ARGS = { repo: '/tmp/fixture', task: 'add a delete route', approval: 'advisor' }
const types = calls => calls.map(c => c.agentType).join(',')
// The whole happy path after an approved plan, for a two-component plan.
const BUILD_OK = () => ({
  scout: [brief(), brief()],
  implementer: [built(['src/a.js']), built(['src/b.js'])],
  checker: [pass_(), pass_()],
  'acceptance-auditor': [met()],
  [QA]: [QA_DONE],
})

const here = dirname(fileURLToPath(import.meta.url))
const wfFile = join(here, '..', 'workflows', 'dev-build.js')
const { meta, fn, src } = load(wfFile)

console.log('== dev-build: shape')
await test('meta is a pure literal with name matching the filename', () => {
  assert.equal(meta.name, basename(wfFile, '.js'))
  assert.ok(meta.description && meta.description.length > 10)
})
await test('every phase() title used in the script is declared in meta.phases', () => {
  const declared = new Set(meta.phases.map(p => p.title))
  const used = [...src.matchAll(/phase\('([^']+)'\)|phase: '([^']+)'/g)].map(m => m[1] || m[2])
  assert.ok(used.length > 0)
  for (const t of used) assert.ok(declared.has(t), `phase '${t}' not in meta.phases`)
})
// Scripts cannot import each other, so these helpers are copied from the QA
// graph. A fix to one copy that misses the other would split the gate logic.
await test('helpers marked shared are identical to harness-repair.js', () => {
  const qa = readFileSync(join(here, '..', '..', 'qa', 'workflows', 'harness-repair.js'), 'utf8')
  const blockOf = (text, start) => {
    const m = text.match(start)
    assert.ok(m, `not found: ${start}`)
    return text.slice(m.index, text.indexOf('\n}\n', m.index) + 3)
  }
  for (const start of [/^const CHECK_SCHEMA = \{$/m, /^function finish\(/m, /^\/\/ Returns the node's structured result/m,
    /^function nodeFailure\(/m, /^\/\/ The gate reads the verbatim block/m, /^function addUnique\(/m, /^function checkPrompt\(/m]) {
    assert.equal(blockOf(src, start), blockOf(qa, start), `shared block drifted: ${start}`)
  }
  assert.ok(src.includes("const where = `Repo: ${REPO}. cd there before anything else.`"))
})
await test('every node pins agentType + model + effort at high, matching the agent files', async () => {
  const { calls } = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK() }, ARGS)
  const seen = new Set()
  for (const c of calls.filter(c => !c.agentType.startsWith('workflow:'))) {
    assert.ok(c.agentType && c.model && c.effort, `unpinned call: ${c.label}`)
    assert.ok(c.schema && c.schema.type === 'object', `call without schema: ${c.label}`)
    assert.equal(c.model, agentField(c.agentType, 'model'), `${c.agentType}: model drift`)
    assert.equal(c.effort, agentField(c.agentType, 'effort'), `${c.agentType}: effort drift`)
    assert.equal(c.effort, 'high', `${c.agentType}: every node runs at high`)
    seen.add(c.agentType)
  }
  assert.deepEqual([...seen].sort(), ['acceptance-auditor', 'advisor', 'checker', 'implementer', 'planner', 'scout'])
})
await test("every test the implementer adds must report its bite: the break it made and the assertion that failed", async () => {
  const { calls } = await run(fn, BUILD_OK(), { repo: '/tmp/fixture', plan: PLAN(), planApproved: true })
  const impl = calls.find(c => c.agentType === 'implementer')
  assert.ok(impl.schema.properties.tests_added.items.required.includes('bite'))
  assert.match(impl.prompt, /"the function did not exist" is not a bite/)
})
await test('meta.phases models match the model each phase actually runs', async () => {
  const declared = Object.fromEntries(meta.phases.map(p => [p.title, p.model]))
  const { calls } = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK() }, ARGS)
  for (const c of calls.filter(c => !c.agentType.startsWith('workflow:'))) {
    assert.equal(c.model, declared[c.phase], `phase ${c.phase}: meta says ${declared[c.phase]}, node runs ${c.model}`)
  }
})

console.log('== dev-build: QA handoff contract')
await test('the QA child gets exactly repo, base, maxFixRounds, knownStuckSigs from the caller', async () => {
  const { calls } = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK() },
    { ...ARGS, base: 'main', maxFixRounds: 2, knownStuckSigs: ['qa|src/a.js#x', 7] })
  const handoff = calls.find(c => c.agentType === QA)
  assert.deepEqual(handoff.args, { repo: '/tmp/fixture', base: 'main', maxFixRounds: 2, knownStuckSigs: ['qa|src/a.js#x'] })
})
await test('unset or invalid pass-through args are omitted, so the QA graph uses its own defaults', async () => {
  const { calls } = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK() }, { ...ARGS, maxFixRounds: '9' })
  assert.deepEqual(calls.find(c => c.agentType === QA).args, { repo: '/tmp/fixture' })
})
await test('QA done -> done; the child ledger and its touched files reach ours', async () => {
  const { result } = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK(), [QA]: [{ ...QA_DONE, touched: ['src/c.js'] }] }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(result.qa.status, 'done')
  assert.deepEqual(result.touched, ['src/a.js', 'src/b.js', 'src/c.js'])
})
await test("QA escalate -> escalate, carrying the child's stuckSig for /loop", async () => {
  const { result } = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK(),
    [QA]: [{ status: 'escalate', reason: 'confirmed findings survived a fix round unchanged', touched: [], stuckSig: 'qa|src/a.js#race' }] }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /QA graph escalated: confirmed findings survived/)
  assert.equal(result.stuckSig, 'qa|src/a.js#race')
})
await test('the QA child throwing or returning nothing -> escalate, never a crash', async () => {
  const thrown = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK(), [QA]: [{ throws: "workflow 'harness-repair' not found" }] }, ARGS)
  assert.equal(thrown.result.status, 'escalate')
  assert.match(thrown.result.reason, /QA graph failed to run: workflow 'harness-repair' not found/)
  const empty = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK(), [QA]: [null] }, ARGS)
  assert.match(empty.result.reason, /QA graph returned no ledger/)
})

console.log('== dev-build: plan and gate')
await test('default approval is human: planner -> advisor approves -> plan-ready, nothing built', async () => {
  const { result, calls } = await run(fn, { planner: [PLAN()], advisor: [p => { assert.match(p, /Gating a plan/); assert.match(p, /2 distinct file/); return approve }] },
    { repo: '/tmp/fixture', task: 'add a delete route' })
  assert.equal(result.status, 'plan-ready')
  assert.equal(types(calls), 'planner,advisor')
  assert.deepEqual(result.plan.components.map(c => c.id), ['C1', 'C2'])
})
await test('approval advisor: approved plan goes straight to scouts, build, accept, QA in order', async () => {
  const { result, calls } = await run(fn, { planner: [p => { assert.match(p, /add a delete route/); return PLAN() }], advisor: [approve], ...BUILD_OK() }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), `planner,advisor,scout,scout,implementer,checker,implementer,checker,acceptance-auditor,${QA}`)
  assert.deepEqual(result.completed, ['C1', 'C2'])
})
await test('an approved plan from args skips planner and gate', async () => {
  const { calls } = await run(fn, BUILD_OK(), { repo: '/tmp/fixture', plan: PLAN(), planApproved: true })
  assert.equal(types(calls), `scout,scout,implementer,checker,implementer,checker,acceptance-auditor,${QA}`)
})
await test('a plan from args without planApproved is gated, not re-planned', async () => {
  const { result, calls } = await run(fn, { advisor: [approve] }, { repo: '/tmp/fixture', plan: PLAN() })
  assert.equal(result.status, 'plan-ready')
  assert.equal(types(calls), 'advisor')
})
await test('completed components are skipped: no scout and no build for them', async () => {
  const { result, calls } = await run(fn, {
    scout: [brief()],
    implementer: [p => { assert.match(p, /"id": "C2"/); assert.match(p, /Already built: \[\n  "C1"\n\]/); return built(['src/b.js']) }],
    checker: [pass_()], 'acceptance-auditor': [met()], [QA]: [QA_DONE],
  }, { repo: '/tmp/fixture', plan: PLAN(), planApproved: true, completed: ['C1'] })
  assert.equal(types(calls), `scout,implementer,checker,acceptance-auditor,${QA}`)
  assert.deepEqual(result.completed, ['C1', 'C2'])
})
await test('revise -> the planner gets its plan and every issue back -> approve', async () => {
  const { result, calls } = await run(fn, {
    planner: [PLAN(), p => { assert.match(p, /Revise this plan/); assert.match(p, /AC2 is not pass\/fail/); return PLAN() }],
    advisor: [revise('AC2 is not pass/fail'), approve],
  }, { repo: '/tmp/fixture', task: 't' })
  assert.equal(result.status, 'plan-ready')
  assert.equal(types(calls), 'planner,advisor,planner,advisor')
  assert.equal(result.planRounds, 2)
})
await test('still not approved after 3 planner rounds -> escalate, last plan and gate kept', async () => {
  const { result, calls } = await run(fn, { planner: [PLAN(), PLAN(), PLAN()], advisor: [revise('a'), revise('b'), revise('c')] }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /not approved after 3 planner round/)
  assert.equal(calls.filter(c => c.agentType === 'planner').length, 3)
  assert.equal(result.gate.issues[0].issue, 'c')
  assert.equal(result.planSettled, false)
})
await test('at the cap with only non-blocking issues: one final ungated revision, then the build runs', async () => {
  const { result, calls } = await run(fn, {
    planner: [PLAN(), PLAN(), PLAN(), p => { assert.match(p, /Revise this plan/); assert.match(p, /AC8 wording/); return PLAN() }],
    advisor: [revise('a'), revise('b'), nits('AC8 wording', 'count is 3')],
    ...BUILD_OK(),
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), `planner,advisor,planner,advisor,planner,advisor,planner,scout,scout,implementer,checker,implementer,checker,acceptance-auditor,${QA}`)
  assert.equal(result.planRounds, 4)
  assert.equal(result.planSettled, true)
  assert.equal(calls.filter(c => c.label === 'plan #4 (final)').length, 1)
})
await test('at the cap, one blocking issue among non-blocking ones -> escalate, no final revision', async () => {
  const mixed = nits('wording', 'missing failure path')
  mixed.issues[1].blocking = true
  const { result, calls } = await run(fn, { planner: [PLAN(), PLAN(), PLAN()], advisor: [revise('a'), revise('b'), mixed] }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /not approved after 3 planner round/)
  assert.equal(calls.filter(c => c.agentType === 'planner').length, 3)
  assert.equal(result.planSettled, false)
})
await test('at the cap, a non-boolean blocking or a revise with no issues counts as blocking -> escalate', async () => {
  const stringy = nits('wording')
  stringy.issues[0].blocking = 'false'
  for (const last of [stringy, nits()]) {
    const { result, calls } = await run(fn, { planner: [PLAN(), PLAN(), PLAN()], advisor: [revise('a'), revise('b'), last] }, ARGS)
    assert.equal(result.status, 'escalate')
    assert.equal(calls.filter(c => c.agentType === 'planner').length, 3)
  }
})
await test('at the cap, a final revision that breaks structure -> escalate, nothing built', async () => {
  const broken = PLAN({ components: [component('C1', ['src/a.js'], ['C2']), component('C2', ['src/b.js'])] })
  const { result, calls } = await run(fn, {
    planner: [PLAN(), PLAN(), PLAN(), broken],
    advisor: [revise('a'), revise('b'), nits('wording')],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /final plan revision is malformed: component C1 depends on C2/)
  assert.equal(types(calls), 'planner,advisor,planner,advisor,planner,advisor,planner')
  assert.equal(result.planSettled, false)
})
await test('at the cap with human approval: the settled plan stops at plan-ready and says it was settled, not approved', async () => {
  const { result, calls } = await run(fn, {
    planner: [PLAN(), PLAN(), PLAN(), PLAN()],
    advisor: [revise('a'), revise('b'), nits('wording')],
  }, { repo: '/tmp/fixture', task: 't' })
  assert.equal(result.status, 'plan-ready')
  assert.match(result.reason, /settled by a final revision of non-blocking issues/)
  assert.equal(types(calls), 'planner,advisor,planner,advisor,planner,advisor,planner')
})
await test('planApproved is true once the build starts, even when the build escalates, and false for every planning stop', async () => {
  const buildFails = await run(fn, { planner: [PLAN()], advisor: [approve], scout: [brief(), brief()],
    implementer: [built(['src/a.js']), built(['src/a.js'])], checker: [failWith('x'), failWith('x')] }, ARGS)
  assert.equal(buildFails.result.status, 'escalate')
  assert.equal(buildFails.result.planApproved, true)
  const stops = [
    await run(fn, { planner: [PLAN()], advisor: [approve] }, { repo: '/tmp/fixture', task: 't' }),
    await run(fn, { planner: [PLAN(), PLAN(), PLAN()], advisor: [revise('a'), revise('b'), revise('c')] }, ARGS),
    await run(fn, { planner: [PLAN()], advisor: [{ verdict: 'blocked', issues: [], questions: ['q'] }] }, ARGS),
  ]
  assert.deepEqual(stops.map(s => [s.result.status, s.result.planApproved]), [['plan-ready', false], ['escalate', false], ['needs-human', false]])
})
await test('structural issues the code raises are blocking, so they never use the final revision', async () => {
  const outOfOrder = PLAN({ components: [component('C1', ['src/a.js'], ['C2']), component('C2', ['src/b.js'])] })
  const { result, calls } = await run(fn, {
    planner: [PLAN(), PLAN(), outOfOrder],
    advisor: [nits('a'), nits('b')],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /not approved after 3 planner round/)
  assert.equal(calls.filter(c => c.agentType === 'planner').length, 3)
})
await test('blocked -> needs-human with the advisor questions, nothing built', async () => {
  const { result, calls } = await run(fn, { planner: [PLAN()], advisor: [{ verdict: 'blocked', issues: [], questions: ['soft or hard delete?'] }] }, ARGS)
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.questions, ['soft or hard delete?'])
  assert.equal(types(calls), 'planner,advisor')
})
await test('a structurally broken plan goes back to the planner without spending an advisor call', async () => {
  const outOfOrder = PLAN({ components: [component('C1', ['src/a.js'], ['C2']), component('C2', ['src/b.js'])] })
  const { result, calls } = await run(fn, {
    planner: [outOfOrder, p => { assert.match(p, /C1 depends on C2, which is not an earlier component/); return PLAN() }],
    advisor: [approve],
  }, { repo: '/tmp/fixture', task: 't' })
  assert.equal(result.status, 'plan-ready')
  assert.equal(types(calls), 'planner,planner,advisor')
})
await test('a malformed plan in args -> escalate before any agent runs', async () => {
  for (const bad of [PLAN({ acceptance: [] }), PLAN({ components: [component('C1', [])] }), PLAN({ components: [component('C1', ['a']), component('C1', ['b'])] }), PLAN({ behavior_changes: 'none' }), PLAN({ kept_changes: 'x' })]) {
    const { result, calls } = await run(fn, {}, { repo: '/tmp/fixture', plan: bad, planApproved: true })
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, /args\.plan is malformed/)
    assert.equal(calls.length, 0)
  }
})
await test('missing repo, or neither task nor plan -> escalate before any agent runs', async () => {
  for (const a of [undefined, {}, { task: 't' }, { repo: 'rel', task: 't' }, { repo: '/r' }, { repo: '/r', task: '   ' }]) {
    const { result, calls } = await run(fn, {}, a)
    assert.equal(result.status, 'escalate')
    assert.equal(calls.length, 0)
  }
})

console.log('== dev-build: knowledge-map owners')
const MAP = 'docs/knowledge-map.json'
const owning = (id, files, used, created, deps = []) => ({ ...component(id, files, deps), owners_used: used, owners_created: created })
const OWNER_PLAN = () => PLAN({ components: [owning('C1', ['src/a.js', MAP], [], ['K1']), owning('C2', ['src/b.js'], ['K1'], [], ['C1'])] })
const owners = (status, ...ids) => ids.map(id => ({ id, status, evidence: status === 'RECORDED' ? `${MAP} parses; ${id} built at src/a.js` : `${MAP} does not parse` }))
const metWith = (...o) => ({ ...met(), owners: o })
await test('a plan that breaks the one-owner rules is malformed, each with its reason', async () => {
  const cases = [
    [[owning('C1', ['src/a.js', MAP], [], ['K1']), owning('C2', ['src/b.js', MAP], [], ['K1'], ['C1'])], /K1 is created by both C1 and C2/],
    [[owning('C1', ['src/a.js', MAP], ['K1'], ['K1'])], /C1 both uses and creates K1/],
    [[owning('C1', ['src/a.js'], [], ['K1'])], /C1 creates owners but does not list docs\/knowledge-map\.json/],
    [[owning('C1', ['src/a.js'], 'K1', [])], /C1: owners_used must be a list/],
    [[owning('C1', ['src/a.js'], ['K1'], []), owning('C2', ['src/b.js', MAP], [], ['K1'], ['C1'])], /C1 uses K1 before C2 creates it/],
    ...['k1', 'K', '', 'K1a', 7].map(bad => [[owning('C1', ['src/a.js'], [bad], [])], /C1: .* is not a knowledge-map id/]),
  ]
  for (const [components, why] of cases) {
    const { result, calls } = await run(fn, {}, { repo: '/tmp/fixture', plan: PLAN({ components }), planApproved: true })
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, why)
    assert.equal(calls.length, 0)
  }
})
await test('a valid owner plan builds; the map file never counts toward the file cap; implementer gets its owners', async () => {
  const components = [owning('C1', ['src/a.js', MAP], [], ['K1']), owning('C2', ['src/b.js'], ['K1'], [], ['C1'])]
  const { result, calls } = await run(fn, {
    planner: [PLAN({ components })],
    advisor: [p => { assert.match(p, /touches 2 distinct file\(s\)/); return approve }],
    ...BUILD_OK(),
    'acceptance-auditor': [metWith(...owners('RECORDED', 'K1'))],
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.match(calls.find(c => c.agentType === 'implementer').prompt, /"owners_created": \[\s*"K1"\s*\]/)
})
await test('planner, scout, and gate carry the owners contract and point at the map', async () => {
  const { calls } = await run(fn, { planner: [PLAN()], advisor: [approve], ...BUILD_OK() }, ARGS)
  const of = t => calls.find(c => c.agentType === t)
  assert.deepEqual(of('planner').schema.properties.components.items.required.filter(k => k.startsWith('owners_')), ['owners_used', 'owners_created'])
  assert.ok(of('scout').schema.required.includes('owners'))
  for (const t of ['planner', 'scout', 'advisor']) assert.match(of(t).prompt, /docs\/knowledge-map\.json/, `${t} prompt`)
  assert.match(of('advisor').prompt, /has docs\/knowledge-map\.json, check every component against it/)
  assert.match(of('advisor').prompt, /if it has none, every owners_used and owners_created must be empty/)
})
await test('a rework after an owner plan is told each component\'s owners and not to edit the map', async () => {
  const components = [owning('C1', ['src/a.js', MAP], [], ['K1']), owning('C2', ['src/b.js'], ['K1'], [], ['C1'])]
  const { result } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), p => {
      assert.match(p, /"owners_created": \[\s*"K1"\s*\]/)
      assert.match(p, /do not edit docs\/knowledge-map\.json in a rework/)
      return built(['test/b.test.js'])
    }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [{ criteria: [{ id: 'AC1', status: 'MET', evidence: 'e' }, { id: 'AC2', status: 'UNMET', evidence: 'gap' }], behavior_changes_missing: [], owners: owners('RECORDED', 'K1') }, metWith(...owners('RECORDED', 'K1'))],
  }, { repo: '/tmp/fixture', plan: PLAN({ components }), planApproved: true })
  assert.equal(result.status, 'done')
})
await test('an owner the audit finds unrecorded gets one rework that may fix only that entry, then passes', async () => {
  const { result, calls } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), p => {
      const note = p.slice(p.indexOf('Owner records missing'))
      assert.match(note, /"id": "K1"/)
      assert.match(note, /does not parse/)
      assert.match(p, /edit docs\/knowledge-map\.json only to fix the missing owner records below/)
      assert.match(note, /create or move it if needed/)
      assert.match(note, /does not parse, first repair its syntax only/)
      assert.doesNotMatch(p, /Unmet criteria/, 'no criterion was unmet')
      return built([MAP])
    }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [metWith(...owners('MISSING', 'K1')), metWith(...owners('RECORDED', 'K1'))],
  }, { repo: '/tmp/fixture', plan: OWNER_PLAN(), planApproved: true })
  assert.equal(result.status, 'done')
  assert.ok(types(calls).endsWith(`acceptance-auditor,implementer,checker,acceptance-auditor,${QA}`))
})
await test('an owner the audit never reports counts as missing; still missing after the rework -> escalate naming it', async () => {
  const { result, calls } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), built([MAP])],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [met(), metWith()],
    [QA]: [],
  }, { repo: '/tmp/fixture', plan: OWNER_PLAN(), planApproved: true })
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /owner record\(s\) missing: K1/)
  assert.ok(!types(calls).includes(QA), 'no QA while an owner is unrecorded')
})
await test('a contradictory audit (one id both RECORDED and MISSING) counts as missing, in either order', async () => {
  for (const report of [[...owners('RECORDED', 'K1'), ...owners('MISSING', 'K1')], [...owners('MISSING', 'K1'), ...owners('RECORDED', 'K1')]]) {
    const { result } = await run(fn, {
      ...BUILD_OK(), implementer: [built(), built(['src/b.js']), built([MAP])], checker: [pass_(), pass_(), pass_()],
      'acceptance-auditor': [metWith(...report), metWith(...report)], [QA]: [],
    }, { repo: '/tmp/fixture', plan: OWNER_PLAN(), planApproved: true })
    assert.match(result.reason, /owner record\(s\) missing: K1/)
  }
})
await test('a blocking triage escalation also names owner records that are missing', async () => {
  const stray = { change: 'adds entry K9', file: MAP, line: 12 }
  const { result } = await run(fn, {
    ...BUILD_OK(), [QA]: [],
    'acceptance-auditor': [{ ...metWith(...owners('MISSING', 'K1')), behavior_changes_missing: [stray] }],
    advisor: [{ decisions: [{ n: 1, decision: 'blocking', serves: '', reason: 'only /blueprint adds entries' }] }],
  }, { repo: '/tmp/fixture', plan: OWNER_PLAN(), planApproved: true })
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /need a human decision; owner record\(s\) also missing: K1/)
})
await test('a map change triage says to remove reaches a rework that may undo it', async () => {
  const stray = { change: 'adds entry K9', file: MAP, line: 12 }
  const { result } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), p => {
      assert.match(p, /edit docs\/knowledge-map\.json only to undo the map changes listed for removal above/)
      assert.doesNotMatch(p, /Owner records missing/)
      return built([MAP])
    }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [{ ...metWith(...owners('RECORDED', 'K1')), behavior_changes_missing: [stray] }, metWith(...owners('RECORDED', 'K1'))],
    advisor: [{ decisions: [{ n: 1, decision: 'remove', serves: '', reason: 'only /blueprint adds entries' }] }],
  }, { repo: '/tmp/fixture', plan: OWNER_PLAN(), planApproved: true })
  assert.equal(result.status, 'done')
})
await test('a missing record and a map change to remove, together: the rework may do both, with no contradiction', async () => {
  const stray = { change: 'adds entry K9', file: MAP, line: 12 }
  const { result } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), p => {
      assert.match(p, /edit docs\/knowledge-map\.json only to fix the missing owner records below and to undo the map changes listed for removal above/)
      assert.match(p, /change no other entry except to undo the map changes listed for removal above/)
      return built([MAP])
    }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [{ ...metWith(...owners('MISSING', 'K1')), behavior_changes_missing: [stray] }, metWith(...owners('RECORDED', 'K1'))],
    advisor: [{ decisions: [{ n: 1, decision: 'remove', serves: '', reason: 'only /blueprint adds entries' }] }],
  }, { repo: '/tmp/fixture', plan: OWNER_PLAN(), planApproved: true })
  assert.equal(result.status, 'done')
})
await test('the audit is told which owners to check only when the plan builds some', async () => {
  const withOwners = await run(fn, { ...BUILD_OK(), 'acceptance-auditor': [metWith(...owners('RECORDED', 'K1'))] }, { repo: '/tmp/fixture', plan: OWNER_PLAN(), planApproved: true })
  const ownerAudit = withOwners.calls.find(c => c.agentType === 'acceptance-auditor')
  assert.match(ownerAudit.prompt, /Owners this plan builds: \[\s*"K1"\s*\]/)
  assert.match(ownerAudit.prompt, /RECORDED only if docs\/knowledge-map\.json parses/)
  assert.ok(ownerAudit.schema.required.includes('owners'))
  const without = await run(fn, BUILD_OK(), { repo: '/tmp/fixture', plan: PLAN(), planApproved: true })
  const plainAudit = without.calls.find(c => c.agentType === 'acceptance-auditor')
  assert.match(plainAudit.prompt, /owners: empty/)
  assert.doesNotMatch(plainAudit.prompt, /Owners this plan builds/)
})

console.log('== dev-build: build failures')
const APPROVED = { repo: '/tmp/fixture', plan: PLAN(), planApproved: true }
await test('a component failing verify gets one retry with the VERIFY block, then the build continues', async () => {
  const { result, calls } = await run(fn, {
    scout: [brief(), brief()],
    implementer: [built(), p => { assert.match(p, /previous attempt failed verification/); assert.match(p, /AssertionError t1/); assert.match(p, /do not loosen any test/); return built() }, built(['src/b.js'])],
    checker: [failWith('t1'), pass_(), pass_()],
    'acceptance-auditor': [met()], [QA]: [QA_DONE],
  }, APPROVED)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), `scout,scout,implementer,checker,implementer,checker,implementer,checker,acceptance-auditor,${QA}`)
  assert.equal(result.components.C1.builds.length, 2)
})
await test('failing verify twice -> escalate, resumable: completed lists only what passed', async () => {
  const { result, calls } = await run(fn, {
    scout: [brief(), brief()],
    implementer: [built(), built(['src/b.js']), built(['src/b.js'])],
    checker: [pass_(), failWith('t2'), failWith('t2')],
  }, APPROVED)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /C2 still fails verification after one retry; resume with completed=/)
  assert.deepEqual(result.completed, ['C1'])
  assert.equal(calls.filter(c => c.agentType === QA).length, 0, 'never hands a red branch to QA')
})
await test("the gate reads the VERIFY line, not the checker's verdict field", async () => {
  const lying = { verdict: 'PASS', verify_block: FAIL_BLOCK, failures: [] }
  const { result, logs } = await run(fn, {
    scout: [brief(), brief()], implementer: [built(), built(), built(['src/b.js'])],
    checker: [lying, pass_(), pass_()], 'acceptance-auditor': [met()], [QA]: [QA_DONE],
  }, APPROVED)
  assert.equal(result.status, 'done')
  assert.equal(result.components.C1.builds.length, 2, 'the lying PASS triggered a retry')
  assert.ok(logs.some(l => /using the block/.test(l)))
})
await test('implementer reports done=false -> escalate with its reason, no check spent', async () => {
  const { result, calls } = await run(fn, { scout: [brief(), brief()], implementer: [built([], { done: false, summary: 'needs a DB migration the plan omits' })] }, APPROVED)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /could not finish C1: needs a DB migration/)
  assert.equal(calls.filter(c => c.agentType === 'checker').length, 0)
})
await test('a scout returning nothing does not stop the build; the implementer is told', async () => {
  const { result } = await run(fn, {
    scout: [null, brief()],
    implementer: [p => { assert.match(p, /the scout returned nothing/); return built() }, built(['src/b.js'])],
    checker: [pass_(), pass_()], 'acceptance-auditor': [met()], [QA]: [QA_DONE],
  }, APPROVED)
  assert.equal(result.status, 'done')
})

console.log('== dev-build: acceptance')
await test('UNMET -> one rework with the gap -> check -> re-audit MET -> QA', async () => {
  const { result, calls } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), p => {
      const unmetSection = p.slice(p.indexOf('Unmet criteria'))
      assert.match(unmetSection, /"id": "AC2"/)
      assert.match(unmetSection, /no test asserts the 404/)
      assert.doesNotMatch(unmetSection, /"id": "AC1"/, 'only unmet criteria are sent as gaps')
      assert.doesNotMatch(p, /knowledge-map/, 'a plan without owners gets the rework prompt it always had')
      return built(['test/b.test.js'])
    }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [{ criteria: [{ id: 'AC1', status: 'MET', evidence: 'e' }, { id: 'AC2', status: 'UNMET', evidence: 'no test asserts the 404' }], behavior_changes_missing: [] }, met()],
  }, APPROVED)
  assert.equal(result.status, 'done')
  assert.ok(types(calls).endsWith(`acceptance-auditor,implementer,checker,acceptance-auditor,${QA}`))
  assert.ok(result.touched.includes('test/b.test.js'))
})
await test('a criterion the auditor did not report on counts as unmet', async () => {
  const { calls } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), p => { assert.match(p, /not reported by the auditor/); return built() }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [met(['AC1']), met()],
  }, APPROVED)
  assert.equal(calls.filter(c => c.agentType === 'acceptance-auditor').length, 2)
})
const change = (text, line = 4) => ({ change: text, file: 'src/a.js', line })
const withChanges = (...cs) => ({ ...met(), behavior_changes_missing: cs })
const decide = (...ds) => ({ decisions: ds.map(([decision, serves], i) => ({ n: i + 1, decision, serves, reason: `because ${i + 1}` })) })
await test('an unplanned change the advisor says to remove goes to the rework, with its reason', async () => {
  const { result, calls } = await run(fn, {
    ...BUILD_OK(),
    advisor: [decide(['remove', ''])],
    implementer: [built(), built(['src/b.js']), p => { assert.match(p, /advisor decided must go/); assert.match(p, /GET now returns 410/); assert.match(p, /because 1/); return built() }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [withChanges(change('GET now returns 410')), met()],
  }, APPROVED)
  assert.equal(result.status, 'done')
  assert.ok(types(calls).endsWith(`acceptance-auditor,advisor,implementer,checker,acceptance-auditor,${QA}`))
  assert.deepEqual(result.keptChanges, [])
})
await test('every unplanned change kept: no rework, no second audit; the plan, ledger, and log record them', async () => {
  const { result, calls, logs } = await run(fn, {
    ...BUILD_OK(),
    advisor: [p => {
      assert.match(p, /Triaging unplanned behavior changes/)
      assert.match(p, /"n": 1,\s+"change": "409 marks the row"/)
      assert.match(p, /"file": "src\/a.js"/)
      return decide(['keep', 'AC2'], ['keep', 'goal'])
    }],
    'acceptance-auditor': [withChanges(change('409 marks the row'), change('poll stops on unmount', 9))],
  }, APPROVED)
  assert.equal(result.status, 'done')
  assert.ok(types(calls).endsWith(`acceptance-auditor,advisor,${QA}`))
  const triage = calls.find(c => c.label === 'triage: unplanned changes')
  assert.deepEqual([triage.phase, triage.model, triage.effort], ['Triage', agentField('advisor', 'model'), 'high'])
  assert.deepEqual(result.keptChanges.map(k => [k.change, k.serves]), [['409 marks the row', 'AC2'], ['poll stops on unmount', 'goal']])
  assert.equal(result.plan.behavior_changes.length, 3)
  assert.match(result.plan.behavior_changes[1], /^409 marks the row \(kept by the advisor; serves AC2: because 1\) \[src\/a.js:4\]$/)
  assert.ok(logs.some(l => /advisor kept 2 unplanned change\(s\)/.test(l)))
  assert.deepEqual(APPROVED.plan, PLAN(), 'the caller\'s args.plan is never changed')
})
await test('keep and remove mixed: only the removes reach the rework, and the re-audit sees the keeps as planned', async () => {
  const { result } = await run(fn, {
    ...BUILD_OK(),
    advisor: [decide(['keep', 'goal'], ['remove', ''])],
    implementer: [built(), built(['src/b.js']), p => {
      const gaps = p.slice(p.indexOf('advisor decided must go'))
      assert.match(gaps, /stale flag/)
      assert.doesNotMatch(gaps, /409 marks the row/, 'a kept change is never sent to be undone')
      return built()
    }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [withChanges(change('409 marks the row'), change('stale flag', 7)), p => { assert.match(p, /409 marks the row \(kept by the advisor/); return met() }],
  }, APPROVED)
  assert.equal(result.status, 'done')
})
await test('any blocking decision -> escalate with the blocked changes, no rework, no QA', async () => {
  const { result, calls } = await run(fn, {
    ...BUILD_OK(), implementer: [built(), built(['src/b.js'])], [QA]: [],
    advisor: [decide(['keep', 'goal'], ['blocking', ''])],
    'acceptance-auditor': [withChanges(change('409 marks the row'), change('scan poll spans pages', 153))],
  }, APPROVED)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /1 unplanned behavior change\(s\) need a human decision/)
  assert.deepEqual(result.blockedChanges.map(b => b.change), ['scan poll spans pages'])
  assert.equal(calls.filter(c => c.agentType === 'implementer').length, 2)
  assert.deepEqual(result.keptChanges.map(k => k.change), ['409 marks the row'], 'keeps survive a blocking exit')
  assert.ok(result.plan.behavior_changes.some(b => b.startsWith('409 marks the row (kept by the advisor')), 'and are in the saved plan')
})
await test('code overrules a bad triage: no decision, two decisions, or a keep citing nothing real -> blocking', async () => {
  const twice = decide(['remove', ''])
  twice.decisions.push({ n: 1, decision: 'keep', serves: 'goal', reason: 'r' })
  for (const [triage, why] of [
    [{ decisions: [] }, /no decision/],
    [twice, /conflicting decisions/],
    [decide(['keep', 'AC9']), /kept without citing the goal or an acceptance id \(serves: "AC9"\)/],
    [decide(['keep', '']), /kept without citing/],
  ]) {
    const { result } = await run(fn, {
      ...BUILD_OK(), implementer: [built(), built(['src/b.js'])], [QA]: [],
      advisor: [triage], 'acceptance-auditor': [withChanges(change('GET now returns 410'))],
    }, APPROVED)
    assert.equal(result.status, 'escalate')
    assert.match(result.blockedChanges[0].reason, why)
  }
})
await test('kept changes survive an escalation and a --resume: the saved plan carries them and done reports them', async () => {
  const first = await run(fn, {
    ...BUILD_OK(), [QA]: [],
    advisor: [decide(['keep', 'goal'], ['remove', ''])],
    implementer: [built(), built(['src/b.js']), built()],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [withChanges(change('409 marks the row'), change('stale flag', 7)), withChanges(change('stale flag', 7))],
  }, APPROVED)
  assert.equal(first.result.status, 'escalate')
  assert.deepEqual(first.result.plan.kept_changes.map(k => k.change), ['409 marks the row'])
  const saved = JSON.parse(JSON.stringify(first.result.plan))   // what /dev writes to plan.json
  const resumed = await run(fn, { 'acceptance-auditor': [met()], [QA]: [QA_DONE] },
    { repo: '/tmp/fixture', plan: saved, planApproved: true, completed: ['C1', 'C2'] })
  assert.equal(resumed.result.status, 'done')
  assert.deepEqual(resumed.result.keptChanges.map(k => [k.change, k.serves]), [['409 marks the row', 'goal']])
})
await test('a new unplanned change on the re-audit escalates; triage runs only once', async () => {
  const { result, calls } = await run(fn, {
    ...BUILD_OK(), [QA]: [],
    advisor: [decide(['remove', ''])],
    implementer: [built(), built(['src/b.js']), built()],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [withChanges(change('a')), withChanges(change('b'))],
  }, APPROVED)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /acceptance still failing after one rework: 1 unplanned/)
  assert.equal(calls.filter(c => c.label === 'triage: unplanned changes').length, 1)
  assert.deepEqual(result.blockedChanges.map(b => [b.change, b.file, b.reason]), [['b', 'src/a.js', 'still in the code after the acceptance rework']])
})
await test('still failing acceptance after the rework -> escalate naming the gaps, no QA', async () => {
  const unmet2 = { criteria: [{ id: 'AC1', status: 'MET', evidence: 'e' }, { id: 'AC2', status: 'UNMET', evidence: 'x' }], behavior_changes_missing: [] }
  const { result, calls } = await run(fn, {
    ...BUILD_OK(), implementer: [built(), built(['src/b.js']), built()], checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [unmet2, unmet2], [QA]: [],
  }, APPROVED)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /acceptance still failing after one rework: unmet AC2/)
  assert.equal(calls.filter(c => c.agentType === QA).length, 0)
})
await test('a rework that breaks verify -> escalate, no QA', async () => {
  const { result } = await run(fn, {
    ...BUILD_OK(), implementer: [built(), built(['src/b.js']), built()], checker: [pass_(), pass_(), failWith('broke')],
    'acceptance-auditor': [met(['AC1'])], [QA]: [],
  }, APPROVED)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /rework broke verification/)
})

console.log('== dev-build: node failures')
await test('a node returning null or throwing -> escalate naming it, never a crash', async () => {
  const P = { repo: '/tmp/fixture', task: 't', approval: 'advisor' }
  for (const [script, a, who] of [
    [{ planner: [null] }, P, 'planner'],
    [{ planner: [PLAN()], advisor: [null] }, P, 'advisor'],
    [{ scout: [brief(), brief()], implementer: [null] }, APPROVED, 'implementer'],
    [{ scout: [brief(), brief()], implementer: [built()], checker: [{ throws: "agent type 'checker' not found" }] }, APPROVED, "checker failed: agent type 'checker' not found"],
    [{ ...BUILD_OK(), 'acceptance-auditor': [null], [QA]: [] }, APPROVED, 'acceptance-auditor'],
    [{ ...BUILD_OK(), advisor: [null], 'acceptance-auditor': [{ ...met(), behavior_changes_missing: [{ change: 'c', file: 'f', line: 1 }] }], [QA]: [] }, APPROVED, 'advisor returned no result on the unplanned behavior changes'],
  ]) {
    const { result } = await run(fn, script, a)
    assert.equal(result.status, 'escalate', who)
    assert.match(result.reason, new RegExp(who), who)
  }
})

console.log('== dev-build: run-script.mjs writes the approved plan into a copy')
const RUN_SCRIPT = join(here, '..', '..', '..', 'core', 'skills', 'workflow-state', 'run-script.mjs')
// Same argument order as /dev's call: plan, out, workflow; the seam is always INJECTED_PLAN here.
const runScript = (planPath, outPath, wf) => spawnSync('node', [RUN_SCRIPT, 'INJECTED_PLAN', planPath, wf, outPath].filter(a => a !== undefined), { encoding: 'utf8' })
const tmp = () => mkdtempSync(join(tmpdir(), 'run-script-'))
await test('dev-build.js carries the INJECTED_PLAN seam exactly once', () => {
  assert.equal(src.split('\n').filter(l => l === 'const INJECTED_PLAN = null').length, 1)
})
await test('the generated copy runs the approved plan: no planner, no gate, plan unchanged', async () => {
  const d = tmp()
  writeFileSync(join(d, 'plan.json'), JSON.stringify(PLAN()))
  const r = runScript(join(d, 'plan.json'), join(d, 'run.js'), wfFile)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^run-script: wrote \/.*run\.js \(INJECTED_PLAN \d+ bytes, 1 line changed/)
  const copy = load(join(d, 'run.js'))
  assert.deepEqual(copy.meta, meta)
  const { result, calls } = await run(copy.fn, BUILD_OK(), { repo: '/tmp/fixture', planApproved: true })
  assert.equal(result.status, 'done')
  assert.equal(types(calls), `scout,scout,implementer,checker,implementer,checker,acceptance-auditor,${QA}`)
  assert.deepEqual(result.plan, { ...PLAN(), kept_changes: [] })
})
await test('a "__proto__" key in plan.json survives into the run as a plain key, as JSON.parse reads it', async () => {
  const d = tmp()
  const text = JSON.stringify(PLAN()).replace(/^\{/, '{"__proto__": {"injected": true},')
  writeFileSync(join(d, 'plan.json'), text)
  const r = runScript(join(d, 'plan.json'), join(d, 'run.js'), wfFile)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const { result } = await run(load(join(d, 'run.js')).fn, BUILD_OK(), { repo: '/tmp/fixture', planApproved: true })
  assert.equal(result.status, 'done')
  assert.ok(Object.prototype.hasOwnProperty.call(result.plan, '__proto__'), 'the key is an own property, not the prototype')
  assert.equal(result.plan.injected, undefined, 'the key did not become the prototype')
})
await test('a seam name that is not INJECTED_<NAME> -> FAIL, nothing written', () => {
  const d = tmp()
  writeFileSync(join(d, 'plan.json'), JSON.stringify(PLAN()))
  for (const seam of ['PLAN', 'injected_plan', 'INJECTED_', 'INJECTED_PLAN; x']) {
    const r = spawnSync('node', [RUN_SCRIPT, seam, join(d, 'plan.json'), wfFile, join(d, 'out.js')], { encoding: 'utf8' })
    assert.equal(r.status, 1, seam)
    assert.match(r.stdout, /must look like INJECTED_PLAN/)
    assert.ok(!existsSync(join(d, 'out.js')))
  }
})
await test('bad plan input -> FAIL, exit 1, nothing written', () => {
  const d = tmp()
  writeFileSync(join(d, 'bad.json'), '{"goal": ')
  writeFileSync(join(d, 'arr.json'), '[1]')
  for (const [a, why] of [
    [[join(d, 'missing.json'), join(d, 'out.js'), wfFile], /cannot read state/],
    [[join(d, 'bad.json'), join(d, 'out.js'), wfFile], /not valid JSON/],
    [[join(d, 'arr.json'), join(d, 'out.js'), wfFile], /must be a JSON object/],
    [[join(d, 'arr.json'), join(d, 'out.js')], /usage/],
  ]) {
    const r = runScript(...a)
    assert.equal(r.status, 1, a.join(' '))
    assert.match(r.stdout, why)
    assert.ok(!existsSync(join(d, 'out.js')), 'nothing written on failure')
  }
})
await test('a workflow without the seam, or with it twice -> FAIL, nothing written', () => {
  const d = tmp()
  writeFileSync(join(d, 'plan.json'), JSON.stringify(PLAN()))
  writeFileSync(join(d, 'none.js'), src.replace('const INJECTED_PLAN = null', 'const INJECTED_PLAN = undefined'))
  writeFileSync(join(d, 'twice.js'), src.replace('const INJECTED_PLAN = null', 'const INJECTED_PLAN = null\nconst INJECTED_PLAN = null'))
  for (const [f, n] of [['none.js', 0], ['twice.js', 2]]) {
    const r = runScript(join(d, 'plan.json'), join(d, 'out.js'), join(d, f))
    assert.equal(r.status, 1)
    assert.match(r.stdout, new RegExp(`exactly once; found ${n}`))
    assert.ok(!existsSync(join(d, 'out.js')))
  }
})
await test('a plan both written into the copy and passed in args -> escalate before any agent runs', async () => {
  const d = tmp()
  writeFileSync(join(d, 'plan.json'), JSON.stringify(PLAN()))
  assert.equal(runScript(join(d, 'plan.json'), join(d, 'run.js'), wfFile).status, 0)
  const { result, calls } = await run(load(join(d, 'run.js')).fn, {}, { repo: '/tmp/fixture', plan: PLAN(), planApproved: true })
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /plan given twice/)
  assert.equal(calls.length, 0)
})
