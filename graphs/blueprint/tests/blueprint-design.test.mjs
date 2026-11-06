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

// ---------- stage design (run 2) ----------
const DARGS = {
  repo: '/tmp/fixture',
  stage: 'design',
  statePath: '/tmp/fixture/.git/harness-blueprint/state.json',
  mode: 'app',
  requirements: ['R1', 'R2'],
  decisions: [{ id: 'Q1', answer: 'Email and password' }],
  assumptions: ['A1', 'Q13'],
}
const mod = (id, over = {}) => ({ id, name: `module ${id}`, responsibility: 'one job', requirements: [], boundary: false, shapes: [], pick: '', depth_reason: '', ...over })
const DESIGN = (over = {}) => ({
  summary: 'a reading list',
  modules: [
    mod('M1', { requirements: ['R1'], boundary: true, shapes: [{ name: 'Policy module', sketch: 'canRead(user, book)' }, { name: 'Query filter', sketch: 'scoped(knex, user)' }], pick: 'Policy module', depth_reason: 'one call hides every rule' }),
    mod('M2', { requirements: ['R2'] }),
  ],
  failure_modes: [{ id: 'F1', what: 'database down', module: 'M2', silent: false, tested: true, handled: true, plan: '503 and a log line' }],
  adrs: [{ id: 'ADR1', title: 'query builder', options: ['Knex', 'Prisma'], decision: 'Knex', reason: 'the default stack' }],
  departures: [],
  honors: [{ id: 'Q1', how: 'Passport local' }, { id: 'A1', how: 'default stack' }, { id: 'Q13', how: 'newest first' }],
  knowledge: [{ id: 'K1', knowledge: 'who may read a book', kind: 'authz', owner: 'server/policies/book.js', used_by: ['M1'], changes_together_because: 'one ownership rule' }],
  premises: [],
  conflicts: [],
  ...over,
})
const GATE = (verdict, over = {}) => ({ verdict, issues: [], questions: [], ...over })
const ISSUE = { n: 1, issue: 'M1 leaks the row format', fix: 'parse at the boundary', blocking: true }

console.log('== blueprint-design: stage design')
await test('design path pins architect and advisor with schemas, matching the agent files', async () => {
  const { result, calls } = await run(fn, { architect: [DESIGN()], advisor: [GATE('approve')] }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.equal(types(calls), 'architect,advisor')
  for (const c of calls) {
    assert.ok(c.schema && c.schema.type === 'object', `call without schema: ${c.label}`)
    assert.equal(c.model, agentField(c.agentType, 'model'), `${c.agentType}: model drift`)
    assert.equal(c.effort, agentField(c.agentType, 'effort'), `${c.agentType}: effort drift`)
  }
})
await test('a design that passes the checks and the gate is design-ready in round 1; the prompts carry the state and the binding decisions', async () => {
  const { result } = await run(fn, {
    architect: [p => {
      assert.ok(p.includes(DARGS.statePath), 'the architect reads state.json itself')
      assert.match(p, /Decisions are binding/)
      assert.match(p, /"Email and password"/)
      assert.match(p, /R1, R2/)
      assert.match(p, /A1, Q13/)
      return DESIGN()
    }],
    advisor: [p => {
      assert.match(p, /"Gating a design"/)
      assert.ok(p.includes(DARGS.statePath))
      assert.match(p, /"Policy module"/)
      return GATE('approve')
    }],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.equal(result.designRounds, 1)
  assert.deepEqual(result.design, DESIGN())
})
await test('a bad stage, or bad design args -> escalate before any agent runs', async () => {
  const cases = [
    [{ ...DARGS, stage: 'build' }, /args\.stage must be interview, design, or backlog/],
    [{ ...DARGS, statePath: 'state.json' }, /args\.statePath is required/],
    [{ ...DARGS, mode: 'service' }, /args\.mode must be app or feature/],
    [{ ...DARGS, requirements: [] }, /args\.requirements must be a non-empty list/],
    [{ ...DARGS, requirements: ['R1', 'R1'] }, /args\.requirements/],
    [{ ...DARGS, requirements: ['Q1'] }, /args\.requirements/],
    [{ ...DARGS, decisions: [{ id: 'Q1', answer: '' }] }, /args\.decisions must be a list/],
    [{ ...DARGS, decisions: [{ id: 'Q1', answer: 'a' }, { id: 'Q1', answer: 'b' }] }, /args\.decisions/],
    [{ ...DARGS, decisions: 'Q1' }, /args\.decisions/],
    [{ ...DARGS, assumptions: ['A1', ''] }, /args\.assumptions must be a list/],
    [{ ...DARGS, assumptions: undefined }, /args\.assumptions/],
    [{ ...DARGS, decisions: [{ id: 'A1', answer: 'override' }] }, /A1 is both a decision and an assumption/],
  ]
  for (const [a, why] of cases) {
    const { result, calls } = await run(fn, {}, a)
    assert.equal(result.status, 'escalate', JSON.stringify(a))
    assert.match(result.reason, why, JSON.stringify(a))
    assert.equal(calls.length, 0)
  }
})
await test('decision ids are not shape-checked: an override (A<n>) and a gate answer (D<n>) are honored like Q<n>', async () => {
  const a = { ...DARGS, decisions: [{ id: 'Q1', answer: 'x' }, { id: 'A2', answer: 'y' }, { id: 'D1', answer: 'z' }] }
  const honors = [...DESIGN().honors, { id: 'A2', how: 'h' }, { id: 'D1', how: 'h' }]
  const { result } = await run(fn, { architect: [DESIGN({ honors })], advisor: [GATE('approve')] }, a)
  assert.equal(result.status, 'design-ready')
})
await test('the interview stays the default stage', async () => {
  const { result, calls } = await run(fn, { extractor: [BRIEF()], questioner: [QS()] }, { ...ARGS, stage: 'interview' })
  assert.equal(result.status, 'needs-human')
  assert.equal(types(calls), 'extractor,questioner')
})

console.log('== blueprint-design: design structure checks')
// Each rule: a design that breaks only it goes back to the architect once with
// the problem, then escalates with the problem in issues. The advisor never runs.
const twoShapes = mod('M1', { requirements: ['R1'], boundary: true, shapes: [{ name: 'a', sketch: 'x' }, { name: 'b', sketch: 'y' }], pick: 'a', depth_reason: 'r' })
const RULES = [
  ['no modules', { modules: [] }, /the design has no modules/],
  ['a bad module id', { modules: [mod('X1', { requirements: ['R1', 'R2'] })] }, /"X1" is not a module id/],
  ['a requirement in no module', { modules: [twoShapes] }, /requirement R2 is in no module/],
  ['an unknown requirement', { modules: [twoShapes, mod('M2', { requirements: ['R2', 'R9'] })] }, /M2 names "R9", which is not a requirement/],
  ['a boundary with one shape', { modules: [mod('M1', { requirements: ['R1'], boundary: true, shapes: [{ name: 'a', sketch: 'x' }], pick: 'a', depth_reason: 'r' }), mod('M2', { requirements: ['R2'] })] }, /M1 is a new boundary with 1 distinct shape\(s\)/],
  ['two shapes with one name', { modules: [{ ...twoShapes, shapes: [{ name: 'a', sketch: 'x' }, { name: 'a', sketch: 'y' }] }, mod('M2', { requirements: ['R2'] })] }, /M1 is a new boundary with 1 distinct shape\(s\)/],
  ['a bad failure id', { failure_modes: [{ id: 'E1', what: 'x', module: 'M2', silent: false, tested: true, handled: true, plan: '' }] }, /E1 is not a failure id/],
  ['a failure id used twice', { failure_modes: [1, 2].map(() => ({ id: 'F1', what: 'x', module: 'M2', silent: false, tested: true, handled: true, plan: '' })) }, /failure id F1 is used twice/],
  ['a conflict on an unknown id', { conflicts: [{ id: 'Q9', why: 'w' }] }, /conflicts names "Q9", which is not a decision or assumption/],
  ['a conflict without why', { honors: DESIGN().honors.filter(h => h.id !== 'A1'), conflicts: [{ id: 'A1', why: '' }] }, /conflict A1: say why it cannot hold/],
  ['an id both honored and in conflict', { conflicts: [{ id: 'A1', why: 'w' }] }, /A1 is in both honors and conflicts/],
  ['a grab-bag owner file', { knowledge: [{ ...DESIGN().knowledge[0], owner: 'server/helpers.js' }] }, /K1: owner server\/helpers\.js is a grab-bag module/],
  ['a pick that is not a shape', { modules: [{ ...twoShapes, pick: 'c' }, mod('M2', { requirements: ['R2'] })] }, /M1: pick "c" is not one of its shapes/],
  ['no depth reason', { modules: [{ ...twoShapes, depth_reason: ' ' }, mod('M2', { requirements: ['R2'] })] }, /M1: depth_reason is empty/],
  ['a critical gap', { failure_modes: [{ id: 'F1', what: 'lost write', module: 'M2', silent: true, tested: false, handled: false, plan: '' }] }, /critical gap: failure F1 is silent, untested, and unhandled/],
  ['a failure in no module', { failure_modes: [{ id: 'F1', what: 'x', module: 'M9', silent: false, tested: true, handled: true, plan: '' }] }, /failure F1 names "M9", which is not a module/],
  ['an ADR with one option', { adrs: [{ id: 'ADR1', title: 't', options: ['Knex'], decision: 'Knex', reason: 'r' }] }, /ADR1: needs at least 2 options, has 1/],
  ['an ADR decision outside its options', { adrs: [{ id: 'ADR1', title: 't', options: ['Knex', 'Prisma'], decision: 'Drizzle', reason: 'r' }] }, /ADR1: decision "Drizzle" is not one of its options/],
  ['an ADR without a reason', { adrs: [{ id: 'ADR1', title: 't', options: ['Knex', 'Prisma'], decision: 'Knex', reason: '' }] }, /ADR1: the reason is empty/],
  ['a fourth departure', { departures: ['a', 'b', 'c', 'd'].map(w => ({ what: w, default: 'x', reason: 'r', adr: 'ADR1' })) }, /4 departures from the default stack: at most 3 innovation tokens/],
  ['a departure without an ADR', { departures: [{ what: 'Bun', default: 'Node', reason: 'speed', adr: 'ADR7' }] }, /departure "Bun" names "ADR7", which is not an ADR/],
  ['a decision missing from honors', { honors: [{ id: 'A1', how: 'h' }, { id: 'Q13', how: 'h' }] }, /Q1 is not in honors/],
  ['an assumption missing from honors', { honors: [{ id: 'Q1', how: 'h' }, { id: 'A1', how: 'h' }] }, /Q13 is not in honors/],
  ['an unknown id in honors', { honors: [...DESIGN().honors, { id: 'Q99', how: 'h' }] }, /honors names "Q99", which is not a decision or assumption/],
  ['an id honored twice', { honors: [...DESIGN().honors, { id: 'Q1', how: 'again' }] }, /honors lists Q1 twice/],
  ['honors without how', { honors: [{ id: 'Q1', how: '' }, { id: 'A1', how: 'h' }, { id: 'Q13', how: 'h' }] }, /honors Q1: say how/],
  ['a knowledge kind the map does not have', { knowledge: [{ ...DESIGN().knowledge[0], kind: 'policy' }] }, /K1: kind "policy" is not one of/],
  ['a non-first-caller item with one user', { knowledge: [{ ...DESIGN().knowledge[0], kind: 'limit' }] }, /K1: a limit item with one user stays local/],
  ['a grab-bag owner', { knowledge: [{ ...DESIGN().knowledge[0], owner: 'server/utils/book.js' }] }, /K1: owner server\/utils\/book\.js is a grab-bag module/],
  ['no changes_together_because', { knowledge: [{ ...DESIGN().knowledge[0], changes_together_because: '' }] }, /K1: changes_together_because is empty/],
  ['a user that is not a module', { knowledge: [{ ...DESIGN().knowledge[0], used_by: ['M1', 'S3'] }] }, /K1 is used by "S3", which is not a module/],
  ['a bad knowledge id', { knowledge: [{ ...DESIGN().knowledge[0], id: 'KX' }] }, /"KX" is not a knowledge id/],
]
for (const [name, over, why] of RULES) {
  await test(`rejected: ${name}`, async () => {
    const bad = DESIGN(over)
    const again = p => { assert.match(p, why); return bad }
    const { result, calls } = await run(fn, { architect: [bad, again, again] }, DARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, /design not approved after 3 architect round\(s\)/)
    assert.ok(result.issues.some(i => why.test(i.issue)), `issues: ${JSON.stringify(result.issues)}`)
    assert.equal(types(calls), 'architect,architect,architect')
  })
}
await test('allowed: three departures, a silent failure that is tested, and a first-caller kind with one user', async () => {
  const design = DESIGN({
    departures: ['a', 'b', 'c'].map(w => ({ what: w, default: 'x', reason: 'r', adr: 'ADR1' })),
    failure_modes: [{ id: 'F1', what: 'lost write', module: 'M2', silent: true, tested: true, handled: false, plan: 'a test' }],
  })
  const { result } = await run(fn, { architect: [design], advisor: [GATE('approve')] }, DARGS)
  assert.equal(result.status, 'design-ready')
})
await test('a design fixed in the revision goes to the gate', async () => {
  const { result, calls } = await run(fn, { architect: [DESIGN({ modules: [] }), DESIGN()], advisor: [GATE('approve')] }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.equal(result.designRounds, 2)
  assert.equal(types(calls), 'architect,architect,advisor')
})

console.log('== blueprint-design: design gate')
await test('gate revise -> the architect gets the issues -> gate approve in round 2', async () => {
  const { result, calls } = await run(fn, {
    architect: [DESIGN(), p => { assert.match(p, /1\. M1 leaks the row format \(fix: parse at the boundary\)/); assert.match(p, /Your previous design/); return DESIGN() }],
    advisor: [GATE('revise', { issues: [ISSUE] }), GATE('approve')],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.equal(result.designRounds, 2)
  assert.equal(types(calls), 'architect,advisor,architect,advisor')
})
await test('gate revise in the last round -> escalate with the open issues, no fourth architect call', async () => {
  const still = { ...ISSUE, issue: '#1: M1 still leaks the row format' }
  const { result, calls } = await run(fn, {
    architect: [DESIGN(), DESIGN(), DESIGN()],
    advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise', { issues: [still] }), GATE('revise', { issues: [still] })],
  }, DARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /design not approved after 3 architect round\(s\)/)
  assert.deepEqual(result.issues, [still])
  assert.equal(types(calls), 'architect,advisor,architect,advisor,architect,advisor')
})
await test('gate blocked -> needs-human; each question names the id it challenges, so the answer replaces that id', async () => {
  const { result } = await run(fn, {
    architect: [p => { assert.match(p, /put its id and why in conflicts/); return DESIGN() }],
    advisor: [p => { assert.match(p, /starting with the decision or assumption id it challenges/); return GATE('blocked', { questions: ['Q1: Is a magic link acceptable?', 'A1 : Keep the default stack?', 'new: Is a shared family list allowed?'] }) }],
  }, DARGS)
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.questions, [
    { about: 'Q1', question: 'Is a magic link acceptable?' },
    { about: 'A1', question: 'Keep the default stack?' },
    { about: null, question: 'Is a shared family list allowed?' },
  ])
  assert.deepEqual(result.design, DESIGN())
})
await test('a gate question without an id, or naming an unknown id -> escalate, never an answer with nowhere to go', async () => {
  for (const [q, why] of [['Is a shared list allowed?', /does not start with the id it challenges/], ['Q9: why?', /challenges Q9, which is not a decision or assumption/]]) {
    const { result } = await run(fn, { architect: [DESIGN()], advisor: [GATE('blocked', { questions: [q] })] }, DARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, why)
  }
})
await test('a decision the architect says cannot hold goes to the gate in conflicts instead of honors', async () => {
  const design = DESIGN({ honors: DESIGN().honors.filter(h => h.id !== 'Q1'), conflicts: [{ id: 'Q1', why: 'no email provider' }] })
  const { result } = await run(fn, { architect: [design], advisor: [p => { assert.match(p, /"conflicts"/); return GATE('blocked', { questions: ['Q1: Allow username login?'] }) }] }, DARGS)
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.questions, [{ about: 'Q1', question: 'Allow username login?' }])
})
await test('an approval that still carries a blocking issue is a revision', async () => {
  const { result, calls } = await run(fn, {
    architect: [DESIGN(), p => { assert.match(p, /M1 leaks the row format/); return DESIGN() }],
    advisor: [GATE('approve', { issues: [ISSUE, { ...ISSUE, n: 2, issue: 'wording', blocking: false }] }), GATE('approve')],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.equal(result.designRounds, 2)
  assert.equal(types(calls), 'architect,advisor,architect,advisor')
})
await test('an approval that leaves a conflict unresolved is a revision, never design-ready', async () => {
  const conflicted = DESIGN({ honors: DESIGN().honors.filter(h => h.id !== 'Q1'), conflicts: [{ id: 'Q1', why: 'no email provider' }] })
  const { result, calls } = await run(fn, {
    architect: [conflicted, p => { assert.match(p, /conflicts Q1 are unresolved/); return DESIGN() }],
    advisor: [GATE('approve'), GATE('approve')],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.deepEqual(result.design.conflicts, [])
  assert.equal(types(calls), 'architect,advisor,architect,advisor')
  const stuck = await run(fn, { architect: [conflicted, conflicted, conflicted], advisor: [GATE('approve'), GATE('approve'), GATE('approve')] }, DARGS)
  assert.equal(stuck.result.status, 'escalate')
  assert.match(stuck.result.reason, /not approved after 3 architect round/)
})
console.log('== blueprint-design: re-gate')
const WORDING = { n: 2, issue: 'M2: rename the helper', fix: 'call it bookRows', blocking: false }
await test('only the first gate reviews the whole design; the re-gate gets the issues it sent back and checks just those', async () => {
  const { result, calls } = await run(fn, {
    architect: [DESIGN(), DESIGN()],
    advisor: [
      p => { assert.doesNotMatch(p, /Re-gate it/); return GATE('revise', { issues: [ISSUE, WORDING] }) },
      p => { assert.match(p, /Re-gate it: check only/); assert.match(p, /#1: M1 leaks the row format \(fix: parse at the boundary\)/); assert.doesNotMatch(p, /rename the helper/); return GATE('approve') },
    ],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.deepEqual(result.history.filter(h => h.node === 'gate').map(h => h.scope), ['full', 're-gate'])
  assert.equal(calls[3].label, 're-gate: design #2')
})
await test('a re-gate blocking issue on a checked issue (#n) or a binding id (Q1) goes back to the architect', async () => {
  for (const issue of ['#1: the fix moved the leak into M2', 'Q1: the revision drops email login']) {
    const back = { ...ISSUE, issue }
    const { result, calls } = await run(fn, {
      architect: [DESIGN(), DESIGN(), p => { assert.match(p, new RegExp(issue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); return DESIGN() }],
      advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise', { issues: [back] }), GATE('approve')],
    }, DARGS)
    assert.equal(result.status, 'design-ready')
    assert.equal(result.designRounds, 3)
    assert.deepEqual(result.notes, [])
    assert.equal(types(calls), 'architect,advisor,architect,advisor,architect,advisor')
  }
})
await test('a re-gate blocking issue outside its scope is a note, so a revise with nothing in scope is design-ready', async () => {
  const fresh = [{ ...ISSUE, n: 1, issue: 'M3: a new finding nobody asked about' }, { ...ISSUE, n: 2, issue: '#9: an issue that was never sent' }, { ...ISSUE, n: 3, issue: 'no prefix at all' }, WORDING]
  const { result, calls } = await run(fn, {
    architect: [DESIGN(), DESIGN()],
    advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise', { issues: fresh })],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.deepEqual(result.notes.map(n => [n.round, n.issue]), fresh.map(i => [2, i.issue]))
  assert.equal(types(calls), 'architect,advisor,architect,advisor')
})
await test('a re-gate still escalates on a revise with no issue, and still blocks to the human with a question', async () => {
  const quiet = await run(fn, { architect: [DESIGN(), DESIGN()], advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise')] }, DARGS)
  assert.equal(quiet.result.status, 'escalate')
  assert.match(quiet.result.reason, /revision without naming an issue/)
  const asked = await run(fn, { architect: [DESIGN(), DESIGN()], advisor: [GATE('revise', { issues: [ISSUE] }), GATE('blocked', { questions: ['Q1: Allow username login?'] })] }, DARGS)
  assert.equal(asked.result.status, 'needs-human')
})
await test('a re-gate revise with nothing in scope is still a revision while conflicts stay open', async () => {
  const conflicted = DESIGN({ honors: DESIGN().honors.filter(h => h.id !== 'Q1'), conflicts: [{ id: 'Q1', why: 'no email provider' }] })
  const { result, calls } = await run(fn, {
    architect: [DESIGN(), conflicted, p => { assert.match(p, /conflicts Q1 are unresolved/); return DESIGN() }],
    advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise', { issues: [WORDING] }), GATE('approve')],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.equal(types(calls), 'architect,advisor,architect,advisor,architect,advisor')
})
await test('re-gate scope: the words before the colon must all be references, and one must be checked or binding', async () => {
  const cases = [
    ['**q1:** the revision drops email login', true], ['Q1, Q2: both answers lost', true], ['Issue #1: still leaks', true],
    ['A1: the assumption is broken', true], ['Q13: a question past the cap is an assumption id too', true], ['#1, #2: still leaks', true], ['`#1`: still leaks', true],
    ['Q9: an id nobody decided', false], ['#2: never sent back', false], ['the fix for Q1 is incomplete: see M2', false],
    ['M3: a module, not a reference', false], ['Q1 no colon at all', false],
  ]
  for (const [issue, back] of cases) {
    const { result } = await run(fn, {
      architect: back ? [DESIGN(), DESIGN(), DESIGN()] : [DESIGN(), DESIGN()],
      advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise', { issues: [{ ...ISSUE, issue }] }), ...(back ? [GATE('approve')] : [])],
    }, DARGS)
    assert.equal(result.status, 'design-ready', issue)
    assert.equal(result.designRounds, back ? 3 : 2, issue)
    assert.equal(result.notes.length, back ? 0 : 1, issue)
  }
})
await test('a full-review approval turned into a revision keeps its non-blocking findings as notes', async () => {
  const { result } = await run(fn, {
    architect: [DESIGN(), DESIGN()],
    advisor: [GATE('approve', { issues: [ISSUE, WORDING] }), GATE('approve')],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.deepEqual(result.notes, [{ round: 1, n: 2, issue: 'M2: rename the helper', fix: 'call it bookRows' }])
})
await test('a blocked gate keeps its findings as notes, so the human sees them with the questions', async () => {
  const { result } = await run(fn, {
    architect: [DESIGN(), DESIGN()],
    advisor: [GATE('revise', { issues: [ISSUE] }), GATE('blocked', { issues: [{ ...ISSUE, issue: '#1: still leaks' }, WORDING], questions: ['Q1: Allow username login?'] })],
  }, DARGS)
  assert.equal(result.status, 'needs-human')
  assert.deepEqual(result.notes.map(n => n.issue), ['M2: rename the helper', '#1: still leaks'])
})
await test('the unresolved-conflicts issue never reuses a number the advisor gave', async () => {
  const conflicted = DESIGN({ honors: DESIGN().honors.filter(h => h.id !== 'Q1'), conflicts: [{ id: 'Q1', why: 'no email provider' }] })
  const { result } = await run(fn, {
    architect: [DESIGN(), conflicted, conflicted],
    advisor: [
      GATE('revise', { issues: [ISSUE, { ...ISSUE, n: 2 }, { ...ISSUE, n: 3 }] }),
      GATE('revise', { issues: [{ ...ISSUE, n: 2, issue: '#2: still leaks' }] }),
      p => { assert.equal(p.match(/^#2: /gm).length, 1); assert.match(p, /^#3: conflicts Q1 are unresolved/m); return GATE('approve') },
    ],
  }, DARGS)
  assert.equal(result.status, 'escalate')
})
await test('a re-gate after a full review with only non-blocking issues checks nothing but the binding ids', async () => {
  const { result } = await run(fn, {
    architect: [DESIGN(), DESIGN()],
    advisor: [GATE('revise', { issues: [WORDING] }), p => { assert.match(p, /\(none: every issue was non-blocking\)/); return GATE('approve') }],
  }, DARGS)
  assert.equal(result.status, 'design-ready')
})
await test('an approval with only non-blocking issues is design-ready, and they reach the human as notes', async () => {
  const { result } = await run(fn, { architect: [DESIGN()], advisor: [GATE('approve', { issues: [{ ...ISSUE, blocking: false }] })] }, DARGS)
  assert.equal(result.status, 'design-ready')
  assert.deepEqual(result.notes, [{ round: 1, n: 1, issue: 'M1 leaks the row format', fix: 'parse at the boundary' }])
})
await test('gate blocked without a question, or revise without an issue -> escalate, never a silent loop', async () => {
  for (const [gate, why] of [[GATE('blocked'), /blocked the design without a question/], [GATE('revise'), /revision without naming an issue/]]) {
    const { result, calls } = await run(fn, { architect: [DESIGN()], advisor: [gate] }, DARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, why)
    assert.equal(types(calls), 'architect,advisor')
  }
})
await test('an architect or advisor that returns nothing or throws -> escalate naming it', async () => {
  for (const [script, who] of [
    [{ architect: [null] }, /architect returned no result in round 1/],
    [{ architect: [DESIGN()], advisor: [{ throws: "agent type 'advisor' not found" }] }, /advisor failed on the design: agent type 'advisor' not found/],
  ]) {
    const { result } = await run(fn, script, DARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, who)
  }
})

console.log('== blueprint-design: drift')
await test('GATE_SCHEMA is identical to dev-build.js: one advisor verdict contract', () => {
  const dev = readFileSync(join(here, '..', '..', 'dev', 'workflows', 'dev-build.js'), 'utf8')
  const block = text => {
    const m = text.match(/^\/\/ shared\nconst GATE_SCHEMA = /m)
    assert.ok(m, 'GATE_SCHEMA not marked shared')
    return text.slice(m.index, text.indexOf('\n}\n', m.index) + 3)
  }
  assert.equal(block(src), block(dev))
})
await test('KINDS and FIRST_CALLER_KINDS match the knowledge-map skill', () => {
  const skill = readFileSync(join(here, '..', '..', '..', 'core', 'skills', 'knowledge-map', 'SKILL.md'), 'utf8')
  const ticks = s => [...s.matchAll(/`([a-z-]+)`/g)].map(m => m[1])
  const arr = name => JSON.parse(src.match(new RegExp(`^const ${name} = (\\[.*\\])$`, 'm'))[1].replace(/'/g, '"'))
  assert.deepEqual(arr('KINDS'), ticks(skill.match(/^Kinds: ([^.]+)\./m)[1]))
  assert.deepEqual(arr('FIRST_CALLER_KINDS'), ticks(skill.match(/^\| (`authn`.*) \| its first caller \|$/m)[1]))
})

// ---------- stage backlog (run 3) ----------
const BARGS = { ...DARGS, stage: 'backlog', designPath: '/tmp/fixture/.git/harness-blueprint/run2.json', knowledge: ['K1'] }
const ac = (sid, k = 1) => ({ id: `${sid}-AC${k}`, criterion: `${sid} criterion ${k}`, fails_when: `${sid} fails ${k}` })
const slice = (n, over = {}) => ({ id: `S${n}`, title: `slice ${n}`, goal: `build slice ${n}`, requirements: [`R${n}`], acceptance: [ac(`S${n}`)], depends_on: n > 1 ? [`S${n - 1}`] : [], ...over })
const SLICED = (over = {}) => ({ app: 'reading-list', slices: [slice(1), slice(2)], knowledge: [{ id: 'K1', built_in: 'S1', used_by: ['S1', 'S2'] }], ...over })

console.log('== blueprint-design: stage backlog')
await test('backlog path pins slicer and advisor with schemas, matching the agent files; the code fills in the format', async () => {
  const { result, calls } = await run(fn, {
    slicer: [p => {
      assert.ok(p.includes(BARGS.statePath) && p.includes(BARGS.designPath), 'the slicer reads the state and the design run itself')
      assert.match(p, /Decisions are binding/)
      assert.match(p, /"Email and password"/)
      assert.match(p, /\(R1, R2\)/)
      assert.match(p, /\(K1\) is in knowledge once/)
      return SLICED()
    }],
    advisor: [p => {
      assert.match(p, /"Gating a backlog"/)
      assert.ok(p.includes(BARGS.statePath) && p.includes(BARGS.designPath))
      assert.match(p, /"integrationBranch": "integration\/reading-list"/)
      assert.match(p, /"built_in": "S1"/)
      return GATE('approve')
    }],
  }, BARGS)
  assert.equal(result.status, 'backlog-ready')
  assert.equal(result.reason, 'backlog approved in round 1')
  assert.equal(types(calls), 'slicer,advisor')
  for (const c of calls) {
    assert.ok(c.schema && c.schema.type === 'object', `call without schema: ${c.label}`)
    assert.equal(c.model, agentField(c.agentType, 'model'), `${c.agentType}: model drift`)
    assert.equal(c.effort, agentField(c.agentType, 'effort'), `${c.agentType}: effort drift`)
  }
  assert.equal(calls[0].phase, 'Backlog')
  assert.deepEqual(result.backlog, { version: 1, app: 'reading-list', integrationBranch: 'integration/reading-list', requirements: ['R1', 'R2'], slices: SLICED().slices })
  assert.deepEqual(result.owners, SLICED().knowledge)
  assert.equal(result.backlogRounds, 1)
  assert.equal(result.designRounds, 0)
})
await test('bad backlog args -> escalate before any agent runs', async () => {
  const cases = [
    [{ ...BARGS, designPath: 'run2.json' }, /args\.designPath is required/],
    [{ ...BARGS, designPath: undefined }, /args\.designPath is required/],
    [{ ...BARGS, knowledge: undefined }, /args\.knowledge must be a list/],
    [{ ...BARGS, knowledge: ['K1', 'K1'] }, /args\.knowledge/],
    [{ ...BARGS, knowledge: ['X1'] }, /args\.knowledge/],
    [{ ...BARGS, knowledge: 'K1' }, /args\.knowledge/],
    [{ ...BARGS, statePath: undefined }, /args\.statePath is required/],
    [{ ...BARGS, requirements: [] }, /args\.requirements/],
  ]
  for (const [a, why] of cases) {
    const { result, calls } = await run(fn, {}, a)
    assert.equal(result.status, 'escalate', JSON.stringify(a))
    assert.match(result.reason, why, JSON.stringify(a))
    assert.equal(calls.length, 0)
  }
  const none = await run(fn, { slicer: [SLICED({ knowledge: [] })], advisor: [GATE('approve')] }, { ...BARGS, knowledge: [] })
  assert.equal(none.result.status, 'backlog-ready', 'a design with no knowledge items slices too')
})

console.log('== blueprint-design: backlog structure checks')
// Each rule: a backlog that breaks only it goes back to the slicer with the
// problem; the fixed one then goes to the gate. The advisor never sees a bad one.
const twoUsers = { id: 'K1', built_in: 'S1', used_by: ['S1', 'S2'] }
const BACKLOG_RULES = [
  ['a bad app slug', { app: 'Reading List' }, /app must be a lowercase slug/],
  ['a requirement missing', { slices: [slice(1), slice(2, { requirements: [] })] }, /requirement R2 is in no slice/],
  ['a later dependency', { slices: [slice(1, { depends_on: ['S2'] }), slice(2)] }, /S1 depends on "S2": a slice may depend only on earlier slices/],
  ['stop and ask in a criterion', { slices: [slice(1, { acceptance: [{ ...ac('S1'), criterion: 'stop and ask the user' }] }), slice(2)] }, /S1: AC1 criterion says "stop and ask"/],
  ['an unknown knowledge id', { knowledge: [twoUsers, { id: 'K9', built_in: 'S1', used_by: ['S1'] }] }, /knowledge names "K9", which is not a knowledge id of the design/],
  ['a knowledge id twice', { knowledge: [twoUsers, twoUsers] }, /knowledge K1 is listed twice/],
  ['a design knowledge id missing', { knowledge: [] }, /knowledge K1 of the design is in no slice/],
  ['no users', { knowledge: [{ id: 'K1', built_in: 'S1', used_by: [] }] }, /K1: used_by is empty/],
  ['an unknown user', { knowledge: [{ id: 'K1', built_in: 'S1', used_by: ['S1', 'S7'] }] }, /K1 is used by "S7", which is not a slice/],
  ['a user twice', { knowledge: [{ id: 'K1', built_in: 'S1', used_by: ['S1', 'S1'] }] }, /K1 names a slice twice in used_by/],
  ['an owner built after its first user', { knowledge: [{ id: 'K1', built_in: 'S2', used_by: ['S2', 'S1'] }] }, /K1: built_in "S2" must be S1, the first slice that uses it/],
  ['an owner built ahead of its users', { slices: [slice(1), slice(2), slice(3, { requirements: [] })], knowledge: [{ id: 'K1', built_in: 'S1', used_by: ['S2', 'S3'] }] }, /K1: built_in "S1" must be S2/],
]
for (const [name, over, why] of BACKLOG_RULES) {
  await test(`backlog rule: ${name} goes back to the slicer, never to the gate`, async () => {
    const { result, calls } = await run(fn, {
      slicer: [SLICED(over), p => { assert.match(p, why); assert.match(p, /Your previous backlog/); return SLICED() }],
      advisor: [GATE('approve')],
    }, BARGS)
    assert.equal(result.status, 'backlog-ready')
    assert.equal(types(calls), 'slicer,slicer,advisor')
    assert.match(result.history[0].problems.join('\n'), why)
  })
}
await test('a backlog still malformed after 3 slicer rounds escalates with the problems and the last backlog', async () => {
  const bad = SLICED({ knowledge: [] })
  const { result, calls } = await run(fn, { slicer: [bad, bad, bad] }, BARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /backlog not approved after 3 slicer round\(s\)/)
  assert.match(result.issues[0].issue, /knowledge K1 of the design is in no slice/)
  assert.equal(result.backlog.app, 'reading-list')
  assert.equal(types(calls), 'slicer,slicer,slicer')
})

console.log('== blueprint-design: backlog gate')
await test('only the first backlog gate reviews it all; the re-gate checks what it sent back, and the rest are notes', async () => {
  const fresh = { ...ISSUE, n: 1, issue: 'S2: a new finding nobody asked about' }
  const { result, calls } = await run(fn, {
    slicer: [SLICED(), p => { assert.match(p, /1\. M1 leaks the row format/); return SLICED() }],
    advisor: [
      p => { assert.doesNotMatch(p, /Re-gate it/); return GATE('revise', { issues: [ISSUE, WORDING] }) },
      p => {
        assert.match(p, /You sent the backlog back/)
        assert.match(p, /The slicer's revised backlog/)
        assert.match(p, /#1: M1 leaks the row format/)
        assert.doesNotMatch(p, /rename the helper/)
        return GATE('revise', { issues: [fresh] })
      },
    ],
  }, BARGS)
  assert.equal(result.status, 'backlog-ready')
  assert.deepEqual(result.history.filter(h => h.node === 'gate').map(h => h.scope), ['full', 're-gate'])
  assert.deepEqual(result.notes.map(n => n.issue), [fresh.issue])
  assert.equal(calls[3].label, 're-gate: backlog #2')
})
await test('a backlog re-gate issue on a checked #n goes back to the slicer', async () => {
  const { result, calls } = await run(fn, {
    slicer: [SLICED(), SLICED(), p => { assert.match(p, /#1: still too big/); return SLICED() }],
    advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise', { issues: [{ ...ISSUE, issue: '#1: still too big' }] }), GATE('approve')],
  }, BARGS)
  assert.equal(result.status, 'backlog-ready')
  assert.equal(result.backlogRounds, 3)
  assert.equal(types(calls), 'slicer,advisor,slicer,advisor,slicer,advisor')
})
await test('a backlog gate that never approves escalates after 3 rounds', async () => {
  const { result } = await run(fn, {
    slicer: [SLICED(), SLICED(), SLICED()],
    advisor: [GATE('revise', { issues: [ISSUE] }), GATE('revise', { issues: [{ ...ISSUE, issue: '#1: still' }] }), GATE('revise', { issues: [{ ...ISSUE, issue: '#1: still' }] })],
  }, BARGS)
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /backlog not approved after 3 slicer round/)
})
await test('a blocked backlog gate asks the human, naming the id; without a question, or a revise without an issue, it escalates', async () => {
  const asked = await run(fn, { slicer: [SLICED()], advisor: [GATE('blocked', { questions: ['Q1: Is username login in scope for S1?'] })] }, BARGS)
  assert.equal(asked.result.status, 'needs-human')
  assert.match(asked.result.reason, /before this can be sliced/)
  assert.deepEqual(asked.result.questions, [{ about: 'Q1', question: 'Is username login in scope for S1?' }])
  assert.equal(asked.result.backlog.app, 'reading-list')
  for (const [gate, why] of [[GATE('blocked'), /blocked the backlog without a question/], [GATE('revise'), /revision without naming an issue/], [GATE('blocked', { questions: ['no id here'] }), /does not start with the id/]]) {
    const { result } = await run(fn, { slicer: [SLICED()], advisor: [gate] }, BARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, why)
  }
})
await test('a slicer or advisor that returns nothing or throws -> escalate naming it', async () => {
  for (const [script, who] of [
    [{ slicer: [null] }, /slicer returned no result in round 1/],
    [{ slicer: [{ throws: "agent type 'slicer' not found" }] }, /slicer failed in round 1: agent type 'slicer' not found \(run install\.sh/],
    [{ slicer: [SLICED()], advisor: [null] }, /advisor returned no result on the backlog/],
  ]) {
    const { result } = await run(fn, script, BARGS)
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, who)
  }
})
await test('validateBacklog is identical to core/skills/backlog/backlog.mjs, its owner', () => {
  const owner = readFileSync(join(here, '..', '..', '..', 'core', 'skills', 'backlog', 'backlog.mjs'), 'utf8')
  const block = text => {
    const m = text.match(/^function validateBacklog\(/m)
    assert.ok(m, 'validateBacklog not found')
    return text.slice(m.index, text.indexOf('\n}\n', m.index) + 3)
  }
  assert.equal(block(src), block(owner))
  assert.match(src, /^\/\/ shared \(the owner is core\/skills\/backlog\/backlog\.mjs[^\n]*\nfunction validateBacklog\(/m)
})
