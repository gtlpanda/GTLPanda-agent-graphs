// dev-build.test.mjs — routing tests for the dev-build graph against scripted
// agents and a scripted QA child workflow. Run by scripts/test-workflow.mjs.
import { readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
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
const revise = (...issues) => ({ verdict: 'revise', issues: issues.map((issue, i) => ({ n: i + 1, issue, fix: 'fix it' })), questions: [] })
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
  for (const bad of [PLAN({ acceptance: [] }), PLAN({ components: [component('C1', [])] }), PLAN({ components: [component('C1', ['a']), component('C1', ['b'])] })]) {
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
await test('an unplanned behavior change triggers the rework too', async () => {
  const { result } = await run(fn, {
    ...BUILD_OK(),
    implementer: [built(), built(['src/b.js']), p => { assert.match(p, /Behavior changes the plan does not list/); assert.match(p, /GET now returns 410/); return built() }],
    checker: [pass_(), pass_(), pass_()],
    'acceptance-auditor': [{ ...met(), behavior_changes_missing: [{ change: 'GET now returns 410', file: 'src/a.js', line: 4 }] }, met()],
  }, APPROVED)
  assert.equal(result.status, 'done')
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
  ]) {
    const { result } = await run(fn, script, a)
    assert.equal(result.status, 'escalate', who)
    assert.match(result.reason, new RegExp(who), who)
  }
})
