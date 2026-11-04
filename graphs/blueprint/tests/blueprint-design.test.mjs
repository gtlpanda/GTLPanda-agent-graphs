// blueprint-design.test.mjs — routing tests for the blueprint graph's intake and
// interview (run 1) against scripted agents. Run by scripts/test-workflow.mjs.
import { readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, load, run, agentField } from '../../../scripts/workflow-harness.mjs'

// ---------- fixtures ----------
const req = (id, over = {}) => ({ id, text: `${id} must hold`, source: 'docs/design.md:3', ...over })
const BRIEF = (over = {}) => ({
  goal: 'appraisers price cards from recent sales',
  mode: 'app',
  users: ['appraiser'],
  requirements: [req('R1'), req('R2', { source: 'request' })],
  decided: [{ decision: 'PostgreSQL', source: 'docs/design.md:9' }],
  gaps: ['tenancy is unstated'],
  contradictions: [],
  constraints: [],
  existing_stack: 'greenfield: empty repo',
  ...over,
})
const q = (id, over = {}) => ({
  id,
  question: `decide ${id}?`,
  stakes: 'a migration later',
  options: [{ label: 'Option A', description: 'a' }, { label: 'Option B', description: 'b' }],
  recommended: 'Option A',
  default_if_unasked: 'Option A',
  resolves: [],
  ...over,
})
const QS = (questions = [q('Q1'), q('Q2'), q('Q3')], over = {}) => ({
  questions,
  preflight: [{ what: 'STRIPE_SECRET_KEY', why: 'billing', needed_by: 'R2' }],
  assumptions: [{ assumption: 'UTC timestamps', why: 'cheap to change' }],
  ...over,
})
const ARGS = { repo: '/tmp/fixture', request: 'build a card pricing app', docs: ['docs/design.md'] }
const types = calls => calls.map(c => c.agentType).join(',')

const here = dirname(fileURLToPath(import.meta.url))
const wfFile = join(here, '..', 'workflows', 'blueprint-design.js')
const { meta, fn, src } = load(wfFile)

console.log('== blueprint-design: shape')
await test('meta is a pure literal with name matching the filename; every phase used is declared', () => {
  assert.equal(meta.name, basename(wfFile, '.js'))
  const declared = new Set(meta.phases.map(p => p.title))
  const used = [...src.matchAll(/phase: '([^']+)'/g)].map(m => m[1])
  assert.ok(used.length > 0)
  for (const t of used) assert.ok(declared.has(t), `phase '${t}' not in meta.phases`)
})
// Scripts cannot import each other, so these helpers are copied from the QA
// graph. A fix to one copy that misses the other would split the node handling.
await test('helpers marked shared are identical to harness-repair.js', () => {
  const qa = readFileSync(join(here, '..', '..', 'qa', 'workflows', 'harness-repair.js'), 'utf8')
  const blockOf = (text, start) => {
    const m = text.match(start)
    assert.ok(m, `not found: ${start}`)
    return text.slice(m.index, text.indexOf('\n}\n', m.index) + 3)
  }
  for (const start of [/^function finish\(/m, /^\/\/ Returns the node's structured result/m, /^function nodeFailure\(/m]) {
    assert.equal(blockOf(src, start), blockOf(qa, start), `shared block drifted: ${start}`)
  }
})
await test('every node pins agentType, model, effort high, and a schema, matching the agent files', async () => {
  const { calls } = await run(fn, { extractor: [BRIEF()], questioner: [QS()] }, ARGS)
  for (const c of calls) {
    assert.ok(c.schema && c.schema.type === 'object', `call without schema: ${c.label}`)
    assert.equal(c.model, agentField(c.agentType, 'model'), `${c.agentType}: model drift`)
    assert.equal(c.effort, agentField(c.agentType, 'effort'), `${c.agentType}: effort drift`)
    assert.equal(c.effort, 'high')
  }
  assert.equal(types(calls), 'extractor,questioner')
})

console.log('== blueprint-design: interview')
await test('doc mode: brief -> ranked questions -> needs-human with brief, questions, preflight, assumptions', async () => {
  const { result, calls } = await run(fn, {
    extractor: [p => {
      assert.match(p, /docs\/design\.md/)
      assert.match(p, /never redesign what is decided/i)
      return BRIEF()
    }],
    questioner: [p => { assert.match(p, /"R1"/); return QS() }],
  }, ARGS)
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.questions.map(x => x.id), ['Q1', 'Q2', 'Q3'])
  assert.equal(result.brief.goal, BRIEF().goal)
  assert.deepEqual(result.preflight, QS().preflight)
  assert.deepEqual(result.assumptions, QS().assumptions.map((a, i) => ({ id: `A${i + 1}`, ...a })), 'the questioner\'s assumptions get ids A1, A2, ...')
  assert.equal(types(calls), 'extractor,questioner')
})
await test('greenfield: no documents, the extractor is told so and the interview still runs', async () => {
  const { result } = await run(fn, {
    extractor: [p => { assert.match(p, /No documents were given/); return BRIEF() }],
    questioner: [QS()],
  }, { repo: '/tmp/fixture', request: 'a habit tracker' })
  assert.equal(result.status, 'needs-human')
})
await test('more than 12 questions: the 12 highest-ranked are asked, the rest become assumptions with their defaults', async () => {
  const many = Array.from({ length: 15 }, (_, i) => q(`Q${i + 1}`, { default_if_unasked: `default ${i + 1}` }))
  const { result } = await run(fn, { extractor: [BRIEF()], questioner: [QS(many)] }, ARGS)
  assert.deepEqual(result.questions.map(x => x.id), many.slice(0, 12).map(x => x.id))
  const trimmed = result.assumptions.filter(a => a.from)
  assert.deepEqual(trimmed.map(a => [a.id, a.from, a.assumption]), [['Q13', 'Q13', 'default 13'], ['Q14', 'Q14', 'default 14'], ['Q15', 'Q15', 'default 15']])
  assert.equal(result.assumptions[0].id, 'A1', 'the questioner\'s own assumptions come first, numbered from A1')
  assert.match(trimmed[0].why, /not asked/)
})
await test('a question that resolves a contradiction is always asked, even when it ranks below the cap', async () => {
  const brief = BRIEF({ contradictions: [{ id: 'X1', a: 'single tenant', b: 'per-team billing', sources: ['docs/design.md:4', 'docs/design.md:20'] }] })
  const many = Array.from({ length: 13 }, (_, i) => q(`Q${i + 1}`, i === 12 ? { resolves: ['X1'] } : {}))
  const { result } = await run(fn, { extractor: [brief], questioner: [QS(many)] }, ARGS)
  assert.equal(result.questions.length, 12)
  assert.ok(result.questions.some(x => x.id === 'Q13'), 'the contradiction question was kept')
  assert.ok(!result.questions.some(x => x.id === 'Q12'), 'the lowest-ranked other question made room')
  assert.deepEqual(result.questions.map(x => x.id).slice(-2), ['Q11', 'Q13'], 'rank order is kept')
})
await test('more than 12 contradictions -> escalate: the documents need fixing before an interview', async () => {
  const xs = Array.from({ length: 13 }, (_, i) => ({ id: `X${i + 1}`, a: 'a', b: 'b', sources: ['d:1', 'd:2'] }))
  const qs = xs.map((x, i) => q(`Q${i + 1}`, { resolves: [x.id] }))
  const { result } = await run(fn, { extractor: [BRIEF({ contradictions: xs })], questioner: [QS(qs)] }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /13 questions resolve contradictions, more than the 12-question interview holds/)
})

console.log('== blueprint-design: structure checks')
await test('a malformed brief goes back to the extractor once with the problems, then escalates', async () => {
  const bad = BRIEF({ requirements: [req('R1'), req('R1'), req('R3', { source: '' }), req('X', { text: '' })] })
  const { result, calls } = await run(fn, {
    extractor: [bad, p => {
      assert.match(p, /requirement id R1 is used twice/)
      assert.match(p, /R3 has no source/)
      assert.match(p, /"X" is not a requirement id/)
      return bad
    }],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /brief is malformed after one revision/)
  assert.equal(types(calls), 'extractor,extractor')
})
await test('a brief with no requirements, or a bad mode, is malformed', async () => {
  for (const [bad, why] of [[BRIEF({ requirements: [] }), /no requirements/], [BRIEF({ mode: 'service' }), /mode must be app or feature/]]) {
    const { result } = await run(fn, { extractor: [bad, bad] }, ARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, why)
  }
})
await test('malformed questions go back to the questioner once, and a fixed set is asked', async () => {
  const bad = QS([
    q('Q1', { recommended: 'Option C' }),
    q('Q1'),
    q('Q3', { options: [{ label: 'Only', description: 'x' }] }),
    q('Q4', { default_if_unasked: '' }),
  ])
  const { result, calls } = await run(fn, {
    extractor: [BRIEF()],
    questioner: [bad, p => {
      assert.match(p, /Q1: recommended "Option C" is not one of its options/)
      assert.match(p, /question id Q1 is used twice/)
      assert.match(p, /Q3: needs 2 to 4 options/)
      assert.match(p, /Q4: default_if_unasked is empty/)
      return QS()
    }],
  }, ARGS)
  assert.equal(result.status, 'needs-human')
  assert.equal(types(calls), 'extractor,questioner,questioner')
})
await test('a contradiction no question resolves is a problem the questioner must fix', async () => {
  const brief = BRIEF({ contradictions: [{ id: 'X1', a: 'a', b: 'b', sources: ['d:1', 'd:2'] }] })
  const { result } = await run(fn, {
    extractor: [brief],
    questioner: [QS(), p => { assert.match(p, /contradiction X1 is not resolved by any question/); return QS() }],
  }, ARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /questions are malformed after one revision: .*X1/)
})
await test('a missing, non-list, or empty questions list is malformed, never a crash', async () => {
  for (const bad of [null, 'x', [], {}]) {
    const answer = { ...QS(), questions: bad }
    const { result, calls } = await run(fn, {
      extractor: [BRIEF()],
      questioner: [answer, p => { assert.match(p, /questions must be a non-empty list/); return answer }],
    }, ARGS)
    assert.equal(result.status, 'escalate', JSON.stringify(bad))
    assert.match(result.reason, /questions are malformed after one revision/)
    assert.equal(types(calls), 'extractor,questioner,questioner')
  }
})
await test('resolves may name only the brief\'s contradictions, so a stray id cannot make a question undroppable', async () => {
  const { result } = await run(fn, {
    extractor: [BRIEF()],
    questioner: [QS([q('Q1', { resolves: ['X99'] }), q('Q2', { resolves: ['R1'] })]), p => {
      assert.match(p, /Q1 resolves "X99", which is not a contradiction in the brief/)
      assert.match(p, /Q2 resolves "R1", which is not a contradiction in the brief/)
      return QS()
    }],
  }, ARGS)
  assert.equal(result.status, 'needs-human')
})
await test('the recommended option is moved first, so the skill can mark it as recommended', async () => {
  const { result } = await run(fn, { extractor: [BRIEF()], questioner: [QS([q('Q1', { recommended: 'Option B' })])] }, ARGS)
  assert.deepEqual(result.questions[0].options.map(o => o.label), ['Option B', 'Option A'])
})

console.log('== blueprint-design: args and node failures')
await test('missing or relative repo, or neither request nor docs -> escalate before any agent runs', async () => {
  for (const a of [undefined, {}, { request: 'x' }, { repo: 'rel', request: 'x' }, { repo: '/r' }, { repo: '/r', request: '  ', docs: [] }, { repo: '/r', docs: 'd.md' }]) {
    const { result, calls } = await run(fn, {}, a)
    assert.equal(result.status, 'escalate', JSON.stringify(a))
    assert.equal(calls.length, 0)
  }
  // With a valid request, a bad docs value is still refused rather than silently dropped.
  for (const docs of ['d.md', [''], [7]]) {
    const { result, calls } = await run(fn, {}, { repo: '/r', request: 'x', docs })
    assert.match(result.reason, /args\.docs must be a list of non-empty paths/, JSON.stringify(docs))
    assert.equal(calls.length, 0)
  }
})
await test('a node that returns nothing or throws -> escalate naming it, never a crash', async () => {
  for (const [script, who] of [
    [{ extractor: [null] }, /extractor returned no result/],
    [{ extractor: [BRIEF()], questioner: [{ throws: "agent type 'questioner' not found" }] }, /questioner failed: agent type 'questioner' not found \(run install\.sh/],
  ]) {
    const { result } = await run(fn, script, ARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, who)
  }
})
