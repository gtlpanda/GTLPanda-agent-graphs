// harness-repair.test.mjs — routing tests for the harness-repair graph against
// scripted agents. Run by scripts/test-workflow.mjs.
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, load, run, agentField } from '../../../scripts/workflow-harness.mjs'

// ---------- fixtures ----------
const PASS_BLOCK = '  [0] scripts/test.sh\nVERIFY: PASS'
const FAIL_BLOCK = '  [1] npm run test\nVERIFY: FAIL'
const pass_ = () => ({ verdict: 'PASS', verify_block: PASS_BLOCK, failures: [] })
const failWith = key => ({ verdict: 'FAIL', verify_block: FAIL_BLOCK, failures: [{ step: 'npm run test', exit: 1, error_key: key, excerpt: `AssertionError ${key}` }] })
const fixed = (touched = ['src/a.js'], items = ['x']) => ({ fixed: items, unfixed: [], touched, verify_verdict: 'PASS', summary: 'ok' })
const finding = (severity, title, file = 'src/a.js') => ({ severity, title, file, line: 10, why: 'w', fix: 'f' })
const review = findings => ({ files_reviewed: 2, findings })
const ARGS = { repo: '/tmp/fixture' }
const types = calls => calls.map(c => c.agentType).join(',')

// ---------- harness-repair ----------
const wfFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'harness-repair.js')
const { meta, fn, src } = load(wfFile)

console.log('== harness-repair: shape')
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

console.log('== harness-repair: routing')
await test('PASS + clean review -> done in two calls (haiku checker, sonnet reviewer)', async () => {
  const { result, calls, leftover } = await run(fn, { checker: [pass_()], reviewer: [review([])] }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), 'checker,reviewer')
  assert.equal(result.lastVerify, PASS_BLOCK)
  assert.deepEqual(leftover, [])
})
await test('every node pins agentType + model + effort, and both match the agent files', async () => {
  const { calls } = await run(fn, {
    checker: [failWith('t1'), failWith('t1'), pass_()],
    fixer: [fixed(), fixed()],
    advisor: [{ action: 'retry', diagnosis: 'd', strategy: 's' }],
    reviewer: [review([])],
  }, ARGS)
  const seen = new Set()
  for (const c of calls) {
    assert.ok(c.agentType && c.model && c.effort, `unpinned call: ${c.label}`)
    assert.ok(c.schema && c.schema.type === 'object', `call without schema: ${c.label}`)
    assert.equal(c.model, agentField(c.agentType, 'model'), `${c.agentType}: workflow model ${c.model} != agents/${c.agentType}.md model ${agentField(c.agentType, 'model')}`)
    assert.equal(c.effort, agentField(c.agentType, 'effort'), `${c.agentType}: workflow effort ${c.effort} != agents/${c.agentType}.md effort ${agentField(c.agentType, 'effort')}`)
    seen.add(c.agentType)
  }
  assert.deepEqual([...seen].sort(), ['advisor', 'checker', 'fixer', 'reviewer'])
  assert.equal(calls.find(c => c.agentType === 'advisor').model, 'fable')
  for (const c of calls) assert.equal(c.effort, 'high', `${c.agentType}: effort ${c.effort}, the graph runs every node at high`)
})
await test('MEDIUM/LOW findings only -> done, findings noted, no fix', async () => {
  const { result, calls } = await run(fn, { checker: [pass_()], reviewer: [review([finding('MEDIUM', 'm'), finding('LOW', 'l')])] }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(result.noted.length, 2)
  assert.equal(types(calls), 'checker,reviewer')
})
await test('FAIL -> fix -> PASS -> review -> done; the fixer gets the failure', async () => {
  const { result, calls } = await run(fn, {
    checker: [failWith('add_test'), pass_()],
    fixer: [p => { assert.match(p, /add_test/); assert.match(p, /never commit/); return fixed() }],
    reviewer: [review([])],
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), 'checker,fixer,checker,reviewer')
  assert.equal(result.fixRounds, 1)
  assert.deepEqual(result.touched, ['src/a.js'])
})
await test("the gate reads the VERIFY line, not the checker's verdict field", async () => {
  const lying = { verdict: 'PASS', verify_block: FAIL_BLOCK, failures: [] }
  const { result, calls, logs } = await run(fn, { checker: [lying, pass_()], fixer: [fixed()], reviewer: [review([])] }, ARGS)
  assert.equal(types(calls), 'checker,fixer,checker,reviewer')
  assert.equal(result.status, 'done')
  assert.ok(logs.some(l => /using the block/.test(l)))
})
await test('VERIFY block without a verdict line -> escalate, no fix', async () => {
  const { result, calls } = await run(fn, { checker: [{ verdict: 'PASS', verify_block: 'all good', failures: [] }] }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /no VERIFY/)
  assert.equal(types(calls), 'checker')
})
await test('same failure twice -> advisor once -> its strategy reaches the fixer -> done', async () => {
  const { result, calls } = await run(fn, {
    checker: [failWith('t1'), failWith('t1'), pass_()],
    fixer: [fixed(), p => { assert.match(p, /follow this strategy:\nuse the other parser/); return fixed() }],
    advisor: [p => { assert.match(p, /t1/); return { action: 'retry', diagnosis: 'd', strategy: 'use the other parser' } }],
    reviewer: [review([])],
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), 'checker,fixer,checker,advisor,fixer,checker,reviewer')
})
await test('advisor says escalate -> escalate with its diagnosis and the stuck signature', async () => {
  const { result, calls } = await run(fn, {
    checker: [failWith('t1'), failWith('t1')],
    fixer: [fixed()],
    advisor: [{ action: 'escalate', diagnosis: 'needs DATABASE_URL', strategy: '' }],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /needs DATABASE_URL/)
  assert.equal(result.stuckSig, 'verify|npm run test#1#t1')
  assert.equal(types(calls), 'checker,fixer,checker,advisor')
})
await test('advisor retry with an empty strategy is treated as escalate', async () => {
  const { result } = await run(fn, {
    checker: [failWith('t1'), failWith('t1')], fixer: [fixed()],
    advisor: [{ action: 'retry', diagnosis: 'unsure', strategy: '  ' }],
  }, ARGS)
  assert.equal(result.status, 'escalate')
})
await test('failure unchanged after the advisor strategy -> escalate, advisor not asked twice', async () => {
  const { result, calls } = await run(fn, {
    checker: [failWith('t1'), failWith('t1'), failWith('t1')],
    fixer: [fixed(), fixed()],
    advisor: [{ action: 'retry', diagnosis: 'd', strategy: 's' }],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /even after the advisor/)
  assert.equal(calls.filter(c => c.agentType === 'advisor').length, 1)
})
await test('changing failures hit the fix-round cap (default 3) without consulting the advisor', async () => {
  const { result, calls } = await run(fn, {
    checker: [failWith('a'), failWith('b'), failWith('c'), failWith('d')],
    fixer: [fixed(), fixed(), fixed()],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /cap \(3\)/)
  assert.equal(result.fixRounds, 3)
  assert.equal(calls.filter(c => c.agentType === 'advisor').length, 0)
})
await test('maxFixRounds arg is honored; bad values fall back to 3', async () => {
  const one = await run(fn, { checker: [failWith('a'), failWith('b')], fixer: [fixed()] }, { ...ARGS, maxFixRounds: 1 })
  assert.equal(one.result.fixRounds, 1)
  assert.match(one.result.reason, /cap \(1\)/)
  const bad = await run(fn, { checker: [failWith('a'), failWith('b'), failWith('c'), failWith('d')], fixer: [fixed(), fixed(), fixed()] }, { ...ARGS, maxFixRounds: '9' })
  assert.match(bad.result.reason, /cap \(3\)/)
})
await test('a signature from an earlier escalated iteration -> escalate immediately, no fix', async () => {
  const { result, calls } = await run(fn, { checker: [failWith('t1')] }, { ...ARGS, knownStuckSigs: ['verify|npm run test#1#t1'] })
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /earlier iteration/)
  assert.equal(types(calls), 'checker')
})
await test('HIGH confirmed -> fix -> check -> review scoped to touched files -> done', async () => {
  const { result, calls } = await run(fn, {
    checker: [pass_(), pass_()],
    reviewer: [
      review([finding('HIGH', 'Unawaited write'), finding('LOW', 'naming')]),
      p => { assert.match(p, /ONLY the uncommitted changes/); assert.match(p, /src\/store\.js/); assert.match(p, /Unawaited write/); return review([]) },
    ],
    advisor: [p => { assert.match(p, /"index": 0/); return { verdicts: [{ index: 0, real: true, reason: 'src/a.js:10 drops the promise' }] } }],
    fixer: [p => { assert.match(p, /Unawaited write/); return fixed(['src/store.js']) }],
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), 'checker,reviewer,advisor,fixer,checker,reviewer')
  assert.equal(result.noted.length, 1)
})
await test('advisor refutes every blocking finding -> done, refuted recorded, no fix', async () => {
  const { result, calls } = await run(fn, {
    checker: [pass_()],
    reviewer: [review([finding('CRITICAL', 'SQL injection')])],
    advisor: [{ verdicts: [{ index: 0, real: false, reason: 'src/a.js:10 uses a bound parameter' }] }],
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(result.refuted.length, 1)
  assert.equal(result.refuted[0].refutedBecause, 'src/a.js:10 uses a bound parameter')
  assert.equal(calls.filter(c => c.agentType === 'fixer').length, 0)
})
await test('a finding the advisor gave no verdict for is treated as real', async () => {
  const { calls } = await run(fn, {
    checker: [pass_(), pass_()],
    reviewer: [review([finding('HIGH', 'one'), finding('HIGH', 'two')]), review([])],
    advisor: [{ verdicts: [{ index: 0, real: false, reason: 'r' }] }],
    fixer: [p => { assert.match(p, /"title": "two"/); assert.doesNotMatch(p, /"title": "one"/); return fixed() }],
  }, ARGS)
  assert.equal(calls.filter(c => c.agentType === 'fixer').length, 1)
})
await test('confirmed finding survives its fix -> escalate', async () => {
  const { result } = await run(fn, {
    checker: [pass_(), pass_()],
    reviewer: [review([finding('HIGH', 'leak')]), review([finding('HIGH', 'leak')])],
    advisor: [{ verdicts: [{ index: 0, real: true, reason: 'r' }] }, { verdicts: [{ index: 0, real: true, reason: 'r' }] }],
    fixer: [fixed()],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /survived a fix round/)
})
await test('fixer touches nothing for confirmed findings -> escalate', async () => {
  const { result } = await run(fn, {
    checker: [pass_()],
    reviewer: [review([finding('HIGH', 'leak')])],
    advisor: [{ verdicts: [{ index: 0, real: true, reason: 'r' }] }],
    fixer: [fixed([])],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /changed no files/)
})
await test('a review fix that breaks verify: fix it, then review the union of touched files', async () => {
  const { result, calls } = await run(fn, {
    checker: [pass_(), failWith('broke'), pass_()],
    reviewer: [review([finding('HIGH', 'leak')]), p => { assert.match(p, /src\/a\.js/); assert.match(p, /src\/b\.js/); return review([]) }],
    advisor: [{ verdicts: [{ index: 0, real: true, reason: 'r' }] }],
    fixer: [fixed(['src/a.js']), fixed(['src/b.js'])],
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(types(calls), 'checker,reviewer,advisor,fixer,checker,fixer,checker,reviewer')
  assert.deepEqual(result.touched, ['src/a.js', 'src/b.js'])
  assert.deepEqual(result.fixed, ['x'], 'fixed items are aggregated and deduped for the commit message')
})
await test('a node returning null (skipped or died) -> escalate, never a crash', async () => {
  for (const [script, who] of [
    [{ checker: [null] }, 'checker'],
    [{ checker: [failWith('x')], fixer: [null] }, 'fixer'],
    [{ checker: [pass_()], reviewer: [null] }, 'reviewer'],
    [{ checker: [pass_()], reviewer: [review([finding('HIGH', 'h')])], advisor: [null] }, 'advisor'],
  ]) {
    const { result } = await run(fn, script, ARGS)
    assert.equal(result.status, 'escalate', who)
    assert.match(result.reason, new RegExp(who), who)
  }
})
await test('agent() throwing (e.g. agent type not found) -> escalate with the error, never a crash', async () => {
  const { result } = await run(fn, { checker: [{ throws: "agent type 'checker' not found" }] }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /checker failed: agent type 'checker' not found/)
  assert.match(result.reason, /run install.sh/)
  const late = await run(fn, { checker: [failWith('x')], fixer: [{ throws: 'quota' }] }, ARGS)
  assert.equal(late.result.status, 'escalate')
  assert.match(late.result.reason, /fixer failed: quota/)
  assert.equal(late.result.history.at(-1).error, 'quota')
})
await test('missing, relative, or non-object args -> escalate before any agent runs', async () => {
  for (const a of [undefined, {}, { repo: 'relative/path' }, '/tmp/x', ['/tmp/x']]) {
    const { result, calls } = await run(fn, {}, a)
    assert.equal(result.status, 'escalate')
    assert.equal(calls.length, 0)
  }
})
await test('base branch reaches the branch-scope review prompt', async () => {
  await run(fn, { checker: [pass_()], reviewer: [p => { assert.match(p, /Base branch: develop\./); return review([]) }] }, { ...ARGS, base: 'develop' })
})

await test('meta.phases models match the model each phase actually runs', async () => {
  const declared = Object.fromEntries(meta.phases.map(p => [p.title, p.model]))
  const { calls } = await run(fn, {
    checker: [failWith('t1'), failWith('t1'), pass_(), pass_()],
    fixer: [fixed(), fixed(), fixed()],
    advisor: [{ action: 'retry', diagnosis: 'd', strategy: 's' }, { verdicts: [{ index: 0, real: true, reason: 'r' }] }],
    reviewer: [review([finding('HIGH', 'leak')]), review([])],
  }, ARGS)
  for (const c of calls) assert.equal(c.model, declared[c.phase], `phase ${c.phase}: meta says ${declared[c.phase]}, node runs ${c.model}`)
})
await test('review path: fix-round cap reached with confirmed findings open -> escalate', async () => {
  const { result, calls } = await run(fn, {
    checker: [failWith('a'), pass_()],
    fixer: [fixed()],
    reviewer: [review([finding('HIGH', 'leak')])],
    advisor: [{ verdicts: [{ index: 0, real: true, reason: 'r' }] }],
  }, { ...ARGS, maxFixRounds: 1 })
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /cap \(1\) reached with confirmed findings open/)
  assert.equal(calls.filter(c => c.agentType === 'fixer').length, 1)
})
await test('review path: confirmed findings escalated by an earlier iteration -> escalate, no fix', async () => {
  const { result, calls } = await run(fn, {
    checker: [pass_()],
    reviewer: [review([finding('HIGH', 'Leak ')])],
    advisor: [{ verdicts: [{ index: 0, real: true, reason: 'r' }] }],
  }, { ...ARGS, knownStuckSigs: ['review|src/a.js#leak'] })
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /earlier iteration/)
  assert.equal(result.stuckSig, 'review|src/a.js#leak')
  assert.equal(calls.filter(c => c.agentType === 'fixer').length, 0)
})
await test('noted findings are deduped across reviews', async () => {
  const { result } = await run(fn, {
    checker: [pass_(), pass_()],
    reviewer: [review([finding('HIGH', 'leak'), finding('LOW', 'naming')]), review([finding('LOW', 'Naming')])],
    advisor: [{ verdicts: [{ index: 0, real: true, reason: 'r' }] }],
    fixer: [fixed()],
  }, ARGS)
  assert.equal(result.status, 'done')
  assert.equal(result.noted.length, 1)
})
await test('fixed items from review fixes and verify fixes both reach the ledger', async () => {
  const { result } = await run(fn, {
    checker: [pass_(), failWith('broke'), pass_()],
    reviewer: [review([finding('HIGH', 'leak')]), review([])],
    advisor: [{ verdicts: [{ index: 0, real: true, reason: 'r' }] }],
    fixer: [fixed(['src/a.js'], ['closed the leak']), fixed(['src/b.js'], ['repaired the test'])],
  }, ARGS)
  assert.deepEqual(result.fixed, ['closed the leak', 'repaired the test'])
})
await test('FAIL with no failing step gets a block-based signature, distinct per block', async () => {
  const noStack = { verdict: 'FAIL', verify_block: '  no stack detected in /r\nVERIFY: FAIL', failures: [] }
  const noTests = { verdict: 'FAIL', verify_block: '  [0] npm run lint\n  no test step ran\nVERIFY: FAIL', failures: [] }
  const a = await run(fn, { checker: [noStack, noStack], fixer: [fixed()], advisor: [{ action: 'escalate', diagnosis: 'add tests', strategy: '' }] }, ARGS)
  assert.equal(a.result.stuckSig, 'verify|block|no stack detected in /r|VERIFY: FAIL')
  // A different step-less failure is not mistaken for the stuck one: it gets a fix round, then hits the cap.
  const b = await run(fn, { checker: [noTests, noTests], fixer: [fixed()] }, { ...ARGS, maxFixRounds: 1, knownStuckSigs: [a.result.stuckSig] })
  assert.match(b.result.reason, /cap \(1\)/)
  assert.equal(b.result.stuckSig, 'verify|block|[0] npm run lint|no test step ran|VERIFY: FAIL')
})
