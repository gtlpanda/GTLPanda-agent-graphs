export const meta = {
  name: 'blueprint-design',
  description: 'Plan an app or feature before any code: extract a brief and build the ranked interview (stage interview), design it against the human\'s answers behind an advisor gate (stage design), then cut the design into /dev-sized slices behind the same gate (stage backlog)',
  whenToUse: 'Run by the /blueprint skill. args: {repo (required, absolute), stage? (interview, the default, design, or backlog), request?, docs? (interview: paths; at least one of request or docs), statePath, mode, requirements, decisions, assumptions (design and backlog), designPath, knowledge (backlog)}',
  phases: [
    { title: 'Extract', detail: 'extractor reads the documents, the repo, and the request into a brief', model: 'sonnet' },
    { title: 'Interview', detail: 'questioner ranks the open decisions by cost to change and lists preflight and assumptions', model: 'sonnet' },
    { title: 'Design', detail: 'architect designs against the binding decisions and assumptions', model: 'sonnet' },
    { title: 'Backlog', detail: 'slicer cuts the approved design into ordered /dev-sized slices', model: 'sonnet' },
    { title: 'Gate', detail: 'advisor gates the design, then the backlog', model: 'fable' },
  ],
}

// Graph (/blueprint). Code routes; agents are leaves and never call each other.
//
// stage interview (run 1):
//   extractor --malformed brief--> extractor (once, with the problems) --still--> escalate
//             --brief--> questioner --malformed--> questioner (once) --still--> escalate
//                                   --questions--> cap at MAX_QUESTIONS (contradictions always kept)
//                                                  --> needs-human (the skill asks; nothing is designed yet)
//
// stage design (run 2; the skill passes the saved answers):
//   architect --structure problems--> architect (next round)
//             --well formed--> advisor(gate) --approve--> design-ready (the skill reports it; nothing is written)
//                                            --revise--> architect (next round); every later gate re-gates:
//                                                        it checks only the blocking issues it sent back, and
//                                                        anything else it finds becomes a note for the human
//                                            --blocked--> needs-human (each question names the id it challenges;
//                                                         the skill asks, replaces that decision or assumption, reruns)
//   at most MAX_DESIGN_ROUNDS architect calls, then escalate
//
// stage backlog (run 3; the skill passes the saved answers and the design run's path):
//   slicer --structure problems (backlog format, knowledge owners)--> slicer (next round)
//          --well formed--> advisor(gate) --approve--> backlog-ready (the skill asks the human's one approval)
//                                         --revise--> slicer (next round); re-gates as in stage design
//                                         --blocked--> needs-human (the skill asks, then designs again)
//   at most MAX_BACKLOG_ROUNDS slicer calls, then escalate
//
// Helpers marked "shared" are copied verbatim from harness-repair.js (scripts
// cannot import each other) and a test fails if the copies drift. Returns a
// ledger; /blueprint persists it.

// One place for every node's agent, model, and effort. The agent files carry
// the same models and efforts; the routing tests fail if they drift.
const NODES = {
  extract: { agentType: 'extractor',  model: 'sonnet', effort: 'high', phase: 'Extract' },
  ask:     { agentType: 'questioner', model: 'sonnet', effort: 'high', phase: 'Interview' },
  design:  { agentType: 'architect',  model: 'sonnet', effort: 'high', phase: 'Design' },
  slice:   { agentType: 'slicer',     model: 'sonnet', effort: 'high', phase: 'Backlog' },
  gate:    { agentType: 'advisor',    model: 'fable',  effort: 'high', phase: 'Gate' },
}
// Three AskUserQuestion calls of four. Lower-ranked questions become assumptions.
const MAX_QUESTIONS = 12
// The design, the revision after the full review, and one more for what the
// re-gate still blocks; a design the gate still rejects needs a human.
const MAX_DESIGN_ROUNDS = 3
// The same three rounds for the backlog: the cut, the revision, one more.
const MAX_BACKLOG_ROUNDS = 3
// Innovation tokens: departures from the default stack. A fourth is a blocking problem.
const MAX_DEPARTURES = 3
// The knowledge-map skill defines the kinds, which ones get an owner from their
// first caller, and the id format (dev-build.js checks the same id pattern).
const KINDS = ['authn', 'authz', 'input-validation', 'money', 'limit', 'retry', 'type', 'constant', 'error-shape', 'client', 'fixture']
const FIRST_CALLER_KINDS = ['authn', 'authz', 'input-validation', 'money']
const OWNER_ID = /^K\d+$/

// ---------- schemas ----------
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })
const BRIEF_SCHEMA = obj({
  goal: STR,
  mode: { type: 'string', enum: ['app', 'feature'] },
  users: STRS,
  requirements: { type: 'array', items: obj({ id: STR, text: STR, source: STR }) },
  decided: { type: 'array', items: obj({ decision: STR, source: STR }) },
  gaps: STRS,
  contradictions: { type: 'array', items: obj({ id: STR, a: STR, b: STR, sources: STRS }) },
  constraints: STRS,
  existing_stack: STR,
})
const QUESTIONS_SCHEMA = obj({
  questions: {
    type: 'array',
    items: obj({
      id: STR,
      question: STR,
      stakes: STR,
      options: { type: 'array', items: obj({ label: STR, description: STR }) },
      recommended: STR,
      default_if_unasked: STR,
      resolves: STRS,
    }),
  },
  preflight: { type: 'array', items: obj({ what: STR, why: STR, needed_by: STR }) },
  assumptions: { type: 'array', items: obj({ assumption: STR, why: STR }) },
})
const BOOL = { type: 'boolean' }
const DESIGN_SCHEMA = obj({
  summary: STR,
  modules: {
    type: 'array',
    items: obj({ id: STR, name: STR, responsibility: STR, requirements: STRS, boundary: BOOL, shapes: { type: 'array', items: obj({ name: STR, sketch: STR }) }, pick: STR, depth_reason: STR }),
  },
  failure_modes: { type: 'array', items: obj({ id: STR, what: STR, module: STR, silent: BOOL, tested: BOOL, handled: BOOL, plan: STR }) },
  adrs: { type: 'array', items: obj({ id: STR, title: STR, options: STRS, decision: STR, reason: STR }) },
  departures: { type: 'array', items: obj({ what: STR, default: STR, reason: STR, adr: STR }) },
  honors: { type: 'array', items: obj({ id: STR, how: STR }) },
  conflicts: { type: 'array', items: obj({ id: STR, why: STR }) },
  knowledge: { type: 'array', items: obj({ id: STR, knowledge: STR, kind: STR, owner: STR, used_by: STRS, changes_together_because: STR }) },
  premises: { type: 'array', items: obj({ claim: STR, evidence: STR, status: { type: 'string', enum: ['VERIFIED', 'UNVERIFIED'] } }) },
})
const SLICES_SCHEMA = obj({
  app: STR,
  slices: {
    type: 'array',
    items: obj({ id: STR, title: STR, goal: STR, requirements: STRS, acceptance: { type: 'array', items: obj({ id: STR, criterion: STR, fails_when: STR }) }, depends_on: STRS }),
  },
  knowledge: { type: 'array', items: obj({ id: STR, built_in: STR, used_by: STRS }) },
})
// shared
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise', 'blocked'] },
    issues: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, issue: STR, fix: STR, blocking: { type: 'boolean' } }, required: ['n', 'issue', 'fix', 'blocking'] } },
    questions: STRS,
  },
  required: ['verdict', 'issues', 'questions'],
}

// ---------- args ----------
const nonEmpty = s => typeof s === 'string' && s.trim() !== ''
const A = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
const REPO = typeof A.repo === 'string' && A.repo.startsWith('/') ? A.repo : null
const REQUEST = typeof A.request === 'string' && A.request.trim() !== '' ? A.request.trim() : null
const DOCS_OK = A.docs === undefined || (Array.isArray(A.docs) && A.docs.every(d => typeof d === 'string' && d.trim() !== ''))
const DOCS = Array.isArray(A.docs) && DOCS_OK ? A.docs : []
const STAGE = A.stage === undefined ? 'interview' : (['interview', 'design', 'backlog'].includes(A.stage) ? A.stage : null)
// Stage design: the saved answers, compacted by the skill. Ids are any
// non-empty unique strings: decisions carry Q<n>, A<n> (an override), or D<n>
// (a gate question); assumptions carry A<n> or Q<n> (past the cap).
const STATE_PATH = typeof A.statePath === 'string' && A.statePath.startsWith('/') ? A.statePath : null
const MODE = ['app', 'feature'].includes(A.mode) ? A.mode : null
const uniqueStrings = x => Array.isArray(x) && x.every(nonEmpty) && new Set(x).size === x.length
const REQ_IDS = uniqueStrings(A.requirements) && A.requirements.length && A.requirements.every(r => /^R\d+$/.test(r)) ? A.requirements : null
const DECISIONS = Array.isArray(A.decisions) && A.decisions.every(d => d && nonEmpty(d.id) && nonEmpty(d.answer)) && uniqueStrings(A.decisions.map(d => d.id)) ? A.decisions : null
const ASSUMPTION_IDS = uniqueStrings(A.assumptions) ? A.assumptions : null
// Stage backlog: the design run (run2.json) the slicer and the gate read, and
// the design's knowledge ids, the only part of it the code checks.
const DESIGN_PATH = typeof A.designPath === 'string' && A.designPath.startsWith('/') ? A.designPath : null
const KNOWLEDGE_IDS = Array.isArray(A.knowledge) && (A.knowledge.length === 0 || uniqueStrings(A.knowledge)) && A.knowledge.every(k => OWNER_ID.test(k)) ? A.knowledge : null

// ---------- ledger ----------
const ledger = {
  status: null,      // 'needs-human' | 'escalate' | 'design-ready' | 'backlog-ready'
  reason: null,
  brief: null,       // the extractor's brief
  questions: [],     // what the skill asks, in rank order, recommended option first
  preflight: [],     // what a human must supply before an unattended build
  assumptions: [],   // decided without asking, each with an id (A<n>, or Q<n> for a question past the cap)
  design: null,      // stage design: the architect's latest design
  gate: null,        // stage design: the advisor's latest verdict
  designRounds: 0,   // stage design: architect calls so far
  backlog: null,     // stage backlog: the latest backlog, in the backlog skill's format
  owners: [],        // stage backlog: per design knowledge id, the slice that builds its owner and the slices that use it
  backlogRounds: 0,  // stage backlog: slicer calls so far
  issues: [],        // stages design and backlog: what the last round left open, when it escalates
  notes: [],         // stages design and backlog: gate findings not sent back to the architect, for the human ({round, n, issue, fix})
  history: [],       // one entry per node run, in order
}
// shared
function finish(status, reason, extra) {
  ledger.status = status
  ledger.reason = reason
  Object.assign(ledger, extra || {})
  log(`${status}: ${reason}`)
  return ledger
}

// ---------- helpers ----------
// shared
// Returns the node's structured result, or null. agent() itself returns null
// when the user skips the agent or it dies after retries, and throws on setup
// errors (for example an unknown agent type); both end the run with an
// escalation that says which node failed and why, never a crash.
let lastNodeError = null
async function runNode(name, label, prompt, schema) {
  const n = NODES[name]
  lastNodeError = null
  try {
    return await agent(prompt, { label, phase: n.phase, agentType: n.agentType, model: n.model, effort: n.effort, schema })
  } catch (e) {
    lastNodeError = e && e.message ? e.message : String(e)
    ledger.history.push({ node: name, label, error: lastNodeError })
    return null
  }
}
// shared
function nodeFailure(name, context) {
  const who = NODES[name].agentType
  const where = context ? ` ${context}` : ''
  if (!lastNodeError) return `${who} returned no result${where} (skipped, or failed after retries)`
  // Observed on CLI 2.1.308: agents linked by install.sh into a running
  // session were not visible to the first workflow run, and appeared later.
  const hint = /not found/.test(lastNodeError)
    ? ' (run install.sh; a session that was already running may not see new agents yet: retry next iteration, or restart Claude Code)'
    : ''
  return `${who} failed${where}: ${lastNodeError}${hint}`
}
const json = x => JSON.stringify(x, null, 2)

// Structural problems the code can see without judgment.
function briefProblems(brief) {
  const problems = []
  if (!['app', 'feature'].includes(brief.mode)) problems.push(`mode must be app or feature, got ${JSON.stringify(brief.mode)}`)
  const reqs = Array.isArray(brief.requirements) ? brief.requirements : []
  if (!reqs.length) problems.push('the brief has no requirements')
  const seen = new Set()
  for (const r of reqs) {
    const id = r && r.id
    if (typeof id !== 'string' || !/^R\d+$/.test(id)) { problems.push(`${JSON.stringify(id)} is not a requirement id (R1, R2, ...)`); continue }
    if (seen.has(id)) problems.push(`requirement id ${id} is used twice`)
    seen.add(id)
    if (!nonEmpty(r.text)) problems.push(`requirement ${id} has no text`)
    if (!nonEmpty(r.source)) problems.push(`requirement ${id} has no source (file:line or request)`)
  }
  const xs = Array.isArray(brief.contradictions) ? brief.contradictions : []
  const xIds = new Set()
  for (const x of xs) {
    const id = x && x.id
    if (typeof id !== 'string' || !/^X\d+$/.test(id)) problems.push(`${JSON.stringify(id)} is not a contradiction id (X1, X2, ...)`)
    else if (xIds.has(id)) problems.push(`contradiction id ${id} is used twice`)
    else xIds.add(id)
  }
  return problems
}
function questionProblems(qs, brief) {
  const problems = []
  if (!Array.isArray(qs.questions) || !qs.questions.length) problems.push('questions must be a non-empty list')
  const list = Array.isArray(qs.questions) ? qs.questions : []
  const contradictionIds = new Set((Array.isArray(brief.contradictions) ? brief.contradictions : []).map(x => x.id))
  const seen = new Set()
  for (const q of list) {
    const id = q && q.id
    if (typeof id !== 'string' || !/^Q\d+$/.test(id)) { problems.push(`${JSON.stringify(id)} is not a question id (Q1, Q2, ...)`); continue }
    if (seen.has(id)) problems.push(`question id ${id} is used twice`)
    seen.add(id)
    const options = Array.isArray(q.options) ? q.options : []
    if (options.length < 2 || options.length > 4) problems.push(`${id}: needs 2 to 4 options, has ${options.length}`)
    if (options.some(o => !o || !nonEmpty(o.label) || !nonEmpty(o.description))) problems.push(`${id}: every option needs a label and a description`)
    if (!options.some(o => o && o.label === q.recommended)) problems.push(`${id}: recommended ${JSON.stringify(q.recommended)} is not one of its options`)
    if (!nonEmpty(q.default_if_unasked)) problems.push(`${id}: default_if_unasked is empty`)
    if (!nonEmpty(q.question)) problems.push(`${id}: the question is empty`)
    // Only real contradictions make a question undroppable at the cap.
    for (const x of Array.isArray(q.resolves) ? q.resolves : []) {
      if (!contradictionIds.has(x)) problems.push(`${id} resolves ${JSON.stringify(x)}, which is not a contradiction in the brief`)
    }
  }
  const resolved = new Set(list.flatMap(q => (q && Array.isArray(q.resolves) ? q.resolves : [])))
  for (const x of Array.isArray(brief.contradictions) ? brief.contradictions : []) {
    if (!resolved.has(x.id)) problems.push(`contradiction ${x.id} is not resolved by any question`)
  }
  return problems
}

// Rank order is kept. Questions that resolve a contradiction are always asked;
// the lowest-ranked others make room for them. Returns { asked, trimmed } or
// { error } when the contradictions alone exceed the cap.
function capQuestions(list) {
  const mustAsk = list.filter(q => Array.isArray(q.resolves) && q.resolves.length)
  if (mustAsk.length > MAX_QUESTIONS) return { error: mustAsk.length }
  const others = list.filter(q => !mustAsk.includes(q))
  const keep = new Set([...mustAsk, ...others.slice(0, MAX_QUESTIONS - mustAsk.length)])
  return { asked: list.filter(q => keep.has(q)), trimmed: list.filter(q => !keep.has(q)) }
}
// The skill marks the first option as recommended, so put it first.
function recommendedFirst(q) {
  const options = [...q.options]
  const i = options.findIndex(o => o.label === q.recommended)
  if (i > 0) options.unshift(...options.splice(i, 1))
  return { ...q, options }
}

const list = x => (Array.isArray(x) ? x : [])

// Stage design: the saved answers must be complete before an architect runs.
function designArgsProblem() {
  if (!STATE_PATH) return 'args.statePath is required and must be an absolute path to state.json'
  if (!MODE) return 'args.mode must be app or feature'
  if (!REQ_IDS) return 'args.requirements must be a non-empty list of unique requirement ids (R1, R2, ...)'
  if (!DECISIONS) return 'args.decisions must be a list of {id, answer} with unique, non-empty ids and answers'
  if (!ASSUMPTION_IDS) return 'args.assumptions must be a list of unique, non-empty assumption ids'
  const both = DECISIONS.map(d => d.id).filter(id => ASSUMPTION_IDS.includes(id))
  if (both.length) return `${both.join(', ')} is both a decision and an assumption: an override replaces its assumption`
  return null
}

// Structural problems in a design the code can see without judgment. Each one
// goes back to the architect as a blocking issue.
function designProblems(d) {
  const problems = []
  const modules = list(d.modules)
  if (!modules.length) problems.push('the design has no modules')
  const moduleIds = new Set()
  for (const m of modules) {
    const id = m && m.id
    if (typeof id !== 'string' || !/^M\d+$/.test(id)) { problems.push(`${JSON.stringify(id)} is not a module id (M1, M2, ...)`); continue }
    if (moduleIds.has(id)) problems.push(`module id ${id} is used twice`)
    moduleIds.add(id)
    for (const r of list(m.requirements)) {
      if (!REQ_IDS.includes(r)) problems.push(`${id} names ${JSON.stringify(r)}, which is not a requirement`)
    }
    if (m.boundary === true) {
      const names = [...new Set(list(m.shapes).map(x => x && x.name).filter(nonEmpty))]
      if (names.length < 2) problems.push(`${id} is a new boundary with ${names.length} distinct shape(s): sketch at least 2 structurally different shapes`)
      else if (!names.includes(m.pick)) problems.push(`${id}: pick ${JSON.stringify(m.pick)} is not one of its shapes`)
      if (!nonEmpty(m.depth_reason)) problems.push(`${id}: depth_reason is empty (why the pick hides more behind a smaller interface)`)
    }
  }
  const covered = new Set(modules.flatMap(m => list(m && m.requirements)))
  for (const r of REQ_IDS) if (!covered.has(r)) problems.push(`requirement ${r} is in no module`)

  const failureIds = new Set()
  for (const f of list(d.failure_modes)) {
    const id = f && nonEmpty(f.id) ? f.id : JSON.stringify(f && f.id)
    if (!/^F\d+$/.test(id)) problems.push(`${id} is not a failure id (F1, F2, ...)`)
    else if (failureIds.has(id)) problems.push(`failure id ${id} is used twice`)
    failureIds.add(id)
    if (!f || !moduleIds.has(f.module)) problems.push(`failure ${id} names ${JSON.stringify(f && f.module)}, which is not a module`)
    // A failure nobody sees, no test catches, and no code handles is a critical gap.
    if (f && f.silent === true && f.tested !== true && f.handled !== true) problems.push(`critical gap: failure ${id} is silent, untested, and unhandled: test it or handle it`)
  }

  const adrIds = new Set()
  for (const a of list(d.adrs)) {
    const id = a && a.id
    if (typeof id !== 'string' || !/^ADR\d+$/.test(id)) { problems.push(`${JSON.stringify(id)} is not an ADR id (ADR1, ADR2, ...)`); continue }
    if (adrIds.has(id)) problems.push(`ADR id ${id} is used twice`)
    adrIds.add(id)
    const options = list(a.options).filter(nonEmpty)
    if (options.length < 2) problems.push(`${id}: needs at least 2 options, has ${options.length}`)
    else if (!options.includes(a.decision)) problems.push(`${id}: decision ${JSON.stringify(a.decision)} is not one of its options`)
    if (!nonEmpty(a.reason)) problems.push(`${id}: the reason is empty`)
  }
  const departures = list(d.departures)
  if (departures.length > MAX_DEPARTURES) problems.push(`${departures.length} departures from the default stack: at most ${MAX_DEPARTURES} innovation tokens, so drop ${departures.length - MAX_DEPARTURES}`)
  for (const x of departures) {
    if (!x || !adrIds.has(x.adr)) problems.push(`departure ${JSON.stringify(x && x.what)} names ${JSON.stringify(x && x.adr)}, which is not an ADR`)
  }

  // Every decision and assumption is accounted for, honored or named as a
  // conflict for the gate: the only mechanical check that the design never
  // silently drops one.
  const must = [...DECISIONS.map(x => x.id), ...ASSUMPTION_IDS]
  const conflicted = new Set()
  for (const c of list(d.conflicts)) {
    const id = c && c.id
    if (!must.includes(id)) { problems.push(`conflicts names ${JSON.stringify(id)}, which is not a decision or assumption`); continue }
    conflicted.add(id)
    if (!nonEmpty(c.why)) problems.push(`conflict ${id}: say why it cannot hold`)
  }
  const honored = new Set()
  for (const h of list(d.honors)) {
    const id = h && h.id
    if (!must.includes(id)) { problems.push(`honors names ${JSON.stringify(id)}, which is not a decision or assumption`); continue }
    if (honored.has(id)) problems.push(`honors lists ${id} twice`)
    if (conflicted.has(id)) problems.push(`${id} is in both honors and conflicts`)
    honored.add(id)
    if (!nonEmpty(h.how)) problems.push(`honors ${id}: say how the design honors it`)
  }
  for (const id of must) if (!honored.has(id) && !conflicted.has(id)) problems.push(`${id} is not in honors: say how the design honors it`)

  const knowledgeIds = new Set()
  for (const k of list(d.knowledge)) {
    const id = k && k.id
    if (typeof id !== 'string' || !OWNER_ID.test(id)) { problems.push(`${JSON.stringify(id)} is not a knowledge id (K1, K2, ...)`); continue }
    if (knowledgeIds.has(id)) problems.push(`knowledge id ${id} is used twice`)
    knowledgeIds.add(id)
    if (!KINDS.includes(k.kind)) problems.push(`${id}: kind ${JSON.stringify(k.kind)} is not one of ${KINDS.join(', ')}`)
    if (!nonEmpty(k.changes_together_because)) problems.push(`${id}: changes_together_because is empty, so it is not shared knowledge`)
    if (!nonEmpty(k.owner)) problems.push(`${id}: name the owner module`)
    else if (/(^|\/)(utils|helpers|common|shared)(\/|\.[A-Za-z0-9]+$|$)/.test(k.owner)) problems.push(`${id}: owner ${k.owner} is a grab-bag module; name it for what it knows`)
    const users = new Set(list(k.used_by))
    for (const u of users) if (!moduleIds.has(u)) problems.push(`${id} is used by ${JSON.stringify(u)}, which is not a module`)
    if (!FIRST_CALLER_KINDS.includes(k.kind) && users.size < 2) problems.push(`${id}: a ${k.kind} item with one user stays local; drop it or name its second user`)
  }
  return problems
}

// Stage backlog: the design run and the knowledge ids, after the design args.
function backlogArgsProblem() {
  if (!DESIGN_PATH) return 'args.designPath is required and must be an absolute path to the design run (run2.json)'
  if (!KNOWLEDGE_IDS) return 'args.knowledge must be a list of the design\'s unique knowledge ids (K1, K2, ...), empty when it has none'
  return null
}

// The slicer returns the slices; the code fills in what it must not get wrong.
function assembleBacklog(out) {
  return { version: 1, app: out.app, integrationBranch: `integration/${out.app}`, requirements: REQ_IDS, slices: list(out.slices) }
}
// Every design knowledge item, once: the slices that use it, and the first of
// them building its owner (the knowledge-map skill: never ahead of its callers).
function ownerProblems(out) {
  const problems = []
  const sliceNo = new Map(list(out.slices).map((s, i) => [s && s.id, i + 1]))
  const seen = new Set()
  for (const k of list(out.knowledge)) {
    const id = k && k.id
    if (!KNOWLEDGE_IDS.includes(id)) { problems.push(`knowledge names ${JSON.stringify(id)}, which is not a knowledge id of the design`); continue }
    if (seen.has(id)) { problems.push(`knowledge ${id} is listed twice`); continue }
    seen.add(id)
    const users = list(k.used_by)
    if (!users.length) { problems.push(`${id}: used_by is empty: name the slices that use it`); continue }
    if (new Set(users).size !== users.length) problems.push(`${id} names a slice twice in used_by`)
    const bad = users.filter(u => !sliceNo.has(u))
    for (const u of bad) problems.push(`${id} is used by ${JSON.stringify(u)}, which is not a slice`)
    if (bad.length) continue
    const first = users.reduce((a, b) => (sliceNo.get(b) < sliceNo.get(a) ? b : a))
    if (k.built_in !== first) problems.push(`${id}: built_in ${JSON.stringify(k.built_in)} must be ${first}, the first slice that uses it`)
  }
  for (const id of KNOWLEDGE_IDS) if (!seen.has(id)) problems.push(`knowledge ${id} of the design is in no slice`)
  return problems
}
function backlogView(out) {
  return { ...assembleBacklog(out), knowledge: list(out.knowledge) }
}

// shared (the owner is core/skills/backlog/backlog.mjs; a test fails if this copy drifts)
function validateBacklog(backlog, requiredIds) {
  const MAX_SLICES = 40
  const MAX_CRITERIA = 8
  const problems = []
  const text = v => typeof v === 'string' && v.trim() !== ''
  const arr = v => (Array.isArray(v) ? v : [])
  const show = v => JSON.stringify(v)
  if (!backlog || typeof backlog !== 'object' || Array.isArray(backlog)) return ['the backlog is not a JSON object']
  if (backlog.version !== 1) problems.push(`version must be 1, got ${show(backlog.version)}`)
  const app = backlog.app
  if (typeof app !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(app)) problems.push(`app must be a lowercase slug like "reading-list", got ${show(app)}`)
  else if (backlog.integrationBranch !== `integration/${app}`) problems.push(`integrationBranch must be "integration/${app}", got ${show(backlog.integrationBranch)}`)

  const reqs = arr(backlog.requirements)
  if (!reqs.length) problems.push('requirements must list the design\'s requirement ids (R1, R2, ...)')
  const reqSet = new Set()
  for (const r of reqs) {
    if (typeof r !== 'string' || !/^R\d+$/.test(r)) problems.push(`${show(r)} is not a requirement id (R1, R2, ...)`)
    else if (reqSet.has(r)) problems.push(`requirement ${r} is listed twice`)
    reqSet.add(r)
  }
  if (Array.isArray(requiredIds)) {
    for (const r of requiredIds) if (!reqSet.has(r)) problems.push(`design requirement ${r} is missing from requirements`)
    for (const r of reqSet) if (!requiredIds.includes(r)) problems.push(`requirement ${show(r)} is not in the design`)
  }

  const slices = arr(backlog.slices)
  if (!slices.length) problems.push('the backlog has no slices')
  if (slices.length > MAX_SLICES) problems.push(`${slices.length} slices is more than ${MAX_SLICES}: split the app or merge slices`)
  const covered = new Set()
  slices.forEach((s, i) => {
    const id = `S${i + 1}`
    if (!s || typeof s !== 'object' || Array.isArray(s)) { problems.push(`slice ${i + 1} is not an object`); return }
    if (s.id !== id) problems.push(`slice ${i + 1} must have id ${id} (ids run S1, S2, ... in build order), got ${show(s.id)}`)
    if (!text(s.title)) problems.push(`${id}: title is empty`)
    if (!text(s.goal)) problems.push(`${id}: goal is empty`)
    // A slice's text is /dev's task text, and /dev lets task text override its
    // no-ask rule, so no part of a slice may ask for that.
    const asks = v => typeof v === 'string' && /stop[\s-]+and[\s-]+ask/i.test(v)
    const askers = [['title', s.title], ['goal', s.goal]]
      .concat(arr(s.acceptance).flatMap((c, k) => (c && typeof c === 'object' ? [[`AC${k + 1} criterion`, c.criterion], [`AC${k + 1} fails_when`, c.fails_when]] : [])))
      .filter(([, v]) => asks(v)).map(([where]) => where)
    if (askers.length) problems.push(`${id}: ${askers.join(', ')} says "stop and ask", which would make an unattended /dev wait for a human`)
    const own = arr(s.requirements)
    if (!Array.isArray(s.requirements)) problems.push(`${id}: requirements must be a list (it may be empty)`)
    for (const r of own) {
      if (!reqSet.has(r)) problems.push(`${id} names ${show(r)}, which is not in requirements`)
      covered.add(r)
    }
    if (new Set(own).size !== own.length) problems.push(`${id} names a requirement twice`)
    const acs = arr(s.acceptance)
    if (!acs.length) problems.push(`${id}: acceptance is empty (at least one pass/fail criterion)`)
    if (acs.length > MAX_CRITERIA) problems.push(`${id}: ${acs.length} criteria is more than ${MAX_CRITERIA}: split the slice`)
    acs.forEach((a, k) => {
      const acId = `${id}-AC${k + 1}`
      if (!a || typeof a !== 'object') { problems.push(`${acId} is not an object`); return }
      if (a.id !== acId) problems.push(`${id}: criterion ${k + 1} must have id ${acId}, got ${show(a.id)}`)
      if (!text(a.criterion)) problems.push(`${acId}: criterion is empty`)
      if (!text(a.fails_when)) problems.push(`${acId}: fails_when is empty (what observable result fails it)`)
    })
    const deps = arr(s.depends_on)
    if (!Array.isArray(s.depends_on)) problems.push(`${id}: depends_on must be a list (it may be empty)`)
    if (new Set(deps).size !== deps.length) problems.push(`${id} depends on a slice twice`)
    for (const d of deps) {
      const m = typeof d === 'string' ? /^S([1-9]\d*)$/.exec(d) : null
      // Earlier-only dependencies make a cycle impossible.
      if (!m || Number(m[1]) < 1 || Number(m[1]) > i) problems.push(`${id} depends on ${show(d)}: a slice may depend only on earlier slices (S1..S${i})`)
    }
  })
  for (const r of reqSet) if (!covered.has(r)) problems.push(`requirement ${r} is in no slice`)
  return problems
}

// The gate's questions name the decision or assumption each one challenges, so
// the human's answer replaces that id instead of sitting next to it. Returns
// { questions: [{ about: <id> | null, question }] } or { error }.
function gateQuestions(raw) {
  const known = [...DECISIONS.map(x => x.id), ...ASSUMPTION_IDS]
  const out = []
  for (const q of raw) {
    const m = typeof q === 'string' ? q.match(/^\s*([^:\s]+)\s*:\s*(\S[\s\S]*)$/) : null
    if (!m) return { error: `the advisor's question ${JSON.stringify(q)} does not start with the id it challenges` }
    if (m[1] === 'new') { out.push({ about: null, question: m[2] }); continue }
    if (!known.includes(m[1])) return { error: `the advisor's question challenges ${m[1]}, which is not a decision or assumption` }
    out.push({ about: m[1], question: m[2] })
  }
  return { questions: out }
}

// ---------- prompts ----------
const where = `Repo: ${REPO}. cd there before anything else.`

function extractPrompt(problems, prior) {
  return `${where}
Request:
${REQUEST || '(none: the documents are the request)'}

${DOCS.length ? `Documents to read in full (relative paths are relative to the repo):\n${DOCS.map(d => `- ${d}`).join('\n')}` : 'No documents were given: work from the request and the repo.'}

Write the brief following your instructions. Never redesign what is decided: report it under decided with its source.${problems ? `

Your previous brief:
${json(prior)}

Fix every one of these problems:
${problems.map(p => `- ${p}`).join('\n')}` : ''}

Fill the structured output. Requirement ids are R1, R2, ...; contradiction ids are X1, X2, ...`
}

function askPrompt(brief, problems, prior) {
  return `${where}
Brief:
${json(brief)}

Write the interview following your instructions. At most ${MAX_QUESTIONS} questions are asked; rank them so the ones past that are safe to assume.${problems ? `

Your previous answer:
${json(prior)}

Fix every one of these problems:
${problems.map(p => `- ${p}`).join('\n')}` : ''}

Fill the structured output. Question ids are Q1, Q2, ... in rank order.`
}

function designPrompt(prior, issues) {
  return `${where}
Design this ${MODE} following your instructions. Read the interview state first, in full: ${STATE_PATH}
(the brief, the human's decisions and assumptions, and the preflight list).

Decisions are binding: the human made them, so never contradict one or design around it:
${json(DECISIONS)}
Assumptions ${ASSUMPTION_IDS.length ? ASSUMPTION_IDS.join(', ') : '(none)'} hold too: only the human overrides one. If a decision or assumption cannot hold, put its id and why in conflicts instead of honors; the gate will ask the human.
Every requirement (${REQ_IDS.join(', ')}) belongs to at least one module, and every decision and assumption id is in honors or conflicts.${prior ? `

Your previous design:
${json(prior)}

Fix every one of these issues:
${issues.map(i => `${i.n}. ${i.issue}${i.fix ? ` (fix: ${i.fix})` : ''}`).join('\n')}` : ''}

Fill the structured output. Module ids are M1, M2, ...; failure ids F1, F2, ...; ADR ids ADR1, ADR2, ...; knowledge ids K1, K2, ...`
}

function gatePrompt(design) {
  return `${where}
Interview state: ${STATE_PATH}. The human's decisions (binding):
${json(DECISIONS)}

The architect's design:
${json(design)}

Gate it following your "Gating a design" instructions. ${GATE_ANSWER}`
}
const GATE_ANSWER = 'verdict: approve, revise, or blocked. issues: numbered, each with the concrete fix and blocking true or false (empty when approving). questions: only when blocked, each one a question only the human can answer, starting with the decision or assumption id it challenges and a colon ("Q2: ..."), or "new: " when it challenges none.'

// what: 'design' or 'backlog'; who: the agent that revised it.
function regatePrompt(what, who, revised, checked) {
  return `${where}
Interview state: ${STATE_PATH}. The human's decisions (binding):
${json(DECISIONS)}

You sent the ${what} back with these blocking issues:
${checked.length ? checked.map(i => `#${i.n}: ${i.issue}${i.fix ? ` (fix: ${i.fix})` : ''}`).join('\n') : '(none: every issue was non-blocking)'}

The ${who}'s revised ${what}:
${json(revised)}

Re-gate it: check only that each issue above is fixed and that its fix broke nothing. verdict: approve, revise, or blocked. A blocking issue must start with the issue it is about ("#2: still ...", "#2: the fix broke ...") or with the decision or assumption id the ${what} now breaks ("Q2: ..."). Anything else you notice is blocking false: it goes to the human with the backlog, not back to the ${who}. questions: only when blocked, each starting with the decision or assumption id it challenges and a colon, or "new: ".`
}

function slicePrompt(prior, issues) {
  return `${where}
Cut the approved design into a backlog following your instructions. Read both in full first:
- the interview state: ${STATE_PATH} (the brief, the human's decisions and assumptions, the preflight list);
- the design run: ${DESIGN_PATH} (its "design" field is the approved design; its "notes" are the gate's open findings).

Decisions are binding: the human made them, so never contradict one or slice around it:
${json(DECISIONS)}
Every requirement (${REQ_IDS.join(', ')}) is in at least one slice. Every knowledge item of the design (${KNOWLEDGE_IDS.length ? KNOWLEDGE_IDS.join(', ') : 'none'}) is in knowledge once, with the slices that use it in used_by and the first of them in built_in.${prior ? `

Your previous backlog:
${json(prior)}

Fix every one of these issues:
${issues.map(i => `${i.n}. ${i.issue}${i.fix ? ` (fix: ${i.fix})` : ''}`).join('\n')}` : ''}

Fill the structured output. app is a lowercase slug (the integration branch is integration/<app>). Slice ids are S1, S2, ... in build order; criterion ids S<n>-AC1, S<n>-AC2, ...`
}

function backlogGatePrompt(out) {
  return `${where}
Interview state: ${STATE_PATH}. Design run: ${DESIGN_PATH} (the approved design is its "design" field). The human's decisions (binding):
${json(DECISIONS)}

The slicer's backlog:
${json(backlogView(out))}

Gate it following your "Gating a backlog" instructions. ${GATE_ANSWER}`
}

// A re-gate's blocking issue counts only when it opens with references and a
// colon, and one of them is an issue it was asked to check (#<n>) or a binding
// decision or assumption id: "Q2:", "**q2, A1:**", "Issue #2:". A sentence
// that mentions an id ("the fix for Q2 is incomplete: ...") is a note. So each
// re-gate narrows the work instead of reviewing a new design.
function inScope(issue, checked) {
  const m = /^[\s*_`]*([#\w,\/ ]+?)[\s*_`]*:/.exec(String(issue.issue || ''))
  if (!m) return false
  const tokens = m[1].split(/[,\/\s]+/).filter(Boolean)
  if (!tokens.every(t => /^(#\d+|issue|[A-Za-z]+\d+)$/i.test(t))) return false
  const ids = [...DECISIONS.map(d => d.id), ...ASSUMPTION_IDS].map(id => id.toUpperCase())
  return tokens.some(t => {
    const ref = /^#(\d+)$/.exec(t)
    if (ref) return checked.some(c => String(c.n) === ref[1])
    return ids.includes(t.toUpperCase())
  })
}
// Gate findings the architect never sees reach the human, each one once.
const noted = new Set()
function note(round, issues) {
  for (const i of issues) {
    if (noted.has(i)) continue
    noted.add(i)
    ledger.notes.push({ round, n: i.n, issue: i.issue, fix: i.fix || '' })
  }
}

// ---------- run ----------
if (!REPO) return finish('escalate', 'args.repo is required and must be an absolute path')
if (!STAGE) return finish('escalate', 'args.stage must be interview, design, or backlog')

if (STAGE === 'backlog') {
  const bad = designArgsProblem() || backlogArgsProblem()
  if (bad) return finish('escalate', bad)
  log(`repo ${REPO}; backlog (${MODE}); ${REQ_IDS.length} requirement(s), ${KNOWLEDGE_IDS.length} knowledge item(s)`)
  const keep = out => (out ? { backlog: assembleBacklog(out), owners: list(out.knowledge) } : {})
  let out = null
  let issues = null
  let checked = null   // the blocking issues the last gate sent back; null until the first gate
  for (;;) {
    if (ledger.backlogRounds >= MAX_BACKLOG_ROUNDS) {
      return finish('escalate', `backlog not approved after ${MAX_BACKLOG_ROUNDS} slicer round(s)`, { ...keep(out), issues })
    }
    ledger.backlogRounds += 1
    const round = ledger.backlogRounds
    const next = await runNode('slice', `backlog #${round}`, slicePrompt(out, issues), SLICES_SCHEMA)
    if (!next) return finish('escalate', nodeFailure('slice', `in round ${round}`), keep(out))
    out = next
    const problems = [...validateBacklog(assembleBacklog(out), REQ_IDS), ...ownerProblems(out)]
    ledger.history.push({ node: 'slice', round, slices: list(out.slices).length, problems })
    if (problems.length) {
      issues = problems.map((issue, i) => ({ n: i + 1, issue, fix: 'restructure the backlog so this holds', blocking: true }))
      continue
    }
    const regate = checked !== null
    const prompt = regate ? regatePrompt('backlog', 'slicer', backlogView(out), checked) : backlogGatePrompt(out)
    const gate = await runNode('gate', `${regate ? 're-gate' : 'gate'}: backlog #${round}`, prompt, GATE_SCHEMA)
    if (!gate) return finish('escalate', nodeFailure('gate', 'on the backlog'), keep(out))
    ledger.gate = gate
    const found = list(gate.issues).filter(i => i && typeof i === 'object')
    const blocking = found.filter(i => i.blocking === true && (!regate || inScope(i, checked)))
    if (regate || gate.verdict === 'approve') note(round, found.filter(i => !blocking.includes(i)))
    ledger.history.push({ node: 'gate', round, scope: regate ? 're-gate' : 'full', verdict: gate.verdict, issues: found.length, blocking: blocking.length })
    if (gate.verdict === 'blocked') {
      if (!list(gate.questions).length) return finish('escalate', 'the advisor blocked the backlog without a question for the human', keep(out))
      const asked = gateQuestions(gate.questions)
      if (asked.error) return finish('escalate', asked.error, keep(out))
      note(round, found)
      return finish('needs-human', 'the advisor needs answers before this can be sliced', { ...keep(out), questions: asked.questions })
    }
    if (gate.verdict === 'revise' && !found.length) return finish('escalate', 'the advisor asked for a revision without naming an issue', keep(out))
    // As in stage design: a re-gate revise with nothing in scope is an approval.
    const settled = gate.verdict === 'approve' || regate
    if (settled && !blocking.length) return finish('backlog-ready', `backlog approved in round ${round}`, keep(out))
    issues = settled ? blocking : found
    checked = issues.filter(i => i.blocking === true)
  }
}

if (STAGE === 'design') {
  const bad = designArgsProblem()
  if (bad) return finish('escalate', bad)
  log(`repo ${REPO}; design (${MODE}); ${REQ_IDS.length} requirement(s), ${DECISIONS.length} decision(s), ${ASSUMPTION_IDS.length} assumption(s)`)
  let design = null
  let issues = null
  let checked = null   // the blocking issues the last gate sent back; null until the first gate
  for (;;) {
    if (ledger.designRounds >= MAX_DESIGN_ROUNDS) {
      return finish('escalate', `design not approved after ${MAX_DESIGN_ROUNDS} architect round(s)`, { design, issues })
    }
    ledger.designRounds += 1
    const round = ledger.designRounds
    const next = await runNode('design', `design #${round}`, designPrompt(design, issues), DESIGN_SCHEMA)
    if (!next) return finish('escalate', nodeFailure('design', `in round ${round}`), { design })
    design = next
    const problems = designProblems(design)
    ledger.history.push({ node: 'design', round, modules: list(design.modules).length, problems })
    if (problems.length) {
      issues = problems.map((issue, i) => ({ n: i + 1, issue, fix: 'restructure the design so this holds', blocking: true }))
      continue
    }
    const regate = checked !== null
    const prompt = regate ? regatePrompt('design', 'architect', design, checked) : gatePrompt(design)
    const gate = await runNode('gate', `${regate ? 're-gate' : 'gate'}: design #${round}`, prompt, GATE_SCHEMA)
    if (!gate) return finish('escalate', nodeFailure('gate', 'on the design'), { design })
    ledger.gate = gate
    const found = list(gate.issues).filter(i => i && typeof i === 'object')
    // A re-gate sends back only what is in scope, and a full-review approval
    // sends back only its blocking issues; the rest becomes notes now.
    const blocking = found.filter(i => i.blocking === true && (!regate || inScope(i, checked)))
    if (regate || gate.verdict === 'approve') note(round, found.filter(i => !blocking.includes(i)))
    ledger.history.push({ node: 'gate', round, scope: regate ? 're-gate' : 'full', verdict: gate.verdict, issues: found.length, blocking: blocking.length })
    if (gate.verdict === 'blocked') {
      if (!list(gate.questions).length) return finish('escalate', 'the advisor blocked the design without a question for the human', { design })
      const asked = gateQuestions(gate.questions)
      if (asked.error) return finish('escalate', asked.error, { design })
      note(round, found)
      return finish('needs-human', 'the advisor needs answers before this can be designed', { design, questions: asked.questions })
    }
    if (gate.verdict === 'revise' && !found.length) return finish('escalate', 'the advisor asked for a revision without naming an issue', { design })
    // An approval that still carries a blocking issue, or leaves a conflict
    // unresolved, is a revision; so is a full-review revise. A re-gate revise
    // with nothing in scope is an approval: its findings are notes.
    const conflicted = list(design.conflicts).map(c => c.id)
    const settled = gate.verdict === 'approve' || regate
    if (settled && conflicted.length) {
      const n = Math.max(0, ...found.map(i => Number(i.n) || 0)) + 1
      blocking.push({ n, issue: `conflicts ${conflicted.join(', ')} are unresolved`, fix: 'design so each one holds, or the gate blocks with a question for the human', blocking: true })
    }
    if (settled && !blocking.length) {
      return finish('design-ready', `design approved in round ${round}`, { design })
    }
    issues = settled ? blocking : found
    checked = issues.filter(i => i.blocking === true)
  }
}

if (!DOCS_OK) return finish('escalate', 'args.docs must be a list of non-empty paths')
if (!REQUEST && !DOCS.length) return finish('escalate', 'give args.request, args.docs, or both')
log(`repo ${REPO}; ${DOCS.length} document(s); ${REQUEST ? 'with' : 'no'} request text`)

// ----- extract -----
let brief = await runNode('extract', 'extract', extractPrompt(), BRIEF_SCHEMA)
if (!brief) return finish('escalate', nodeFailure('extract'))
ledger.history.push({ node: 'extract', requirements: Array.isArray(brief.requirements) ? brief.requirements.length : 0 })
let problems = briefProblems(brief)
if (problems.length) {
  const prior = brief
  brief = await runNode('extract', 'extract (revise)', extractPrompt(problems, prior), BRIEF_SCHEMA)
  if (!brief) return finish('escalate', nodeFailure('extract', 'on the revision'))
  problems = briefProblems(brief)
  if (problems.length) return finish('escalate', `brief is malformed after one revision: ${problems.join('; ')}`, { brief })
}
ledger.brief = brief

// ----- interview -----
let qs = await runNode('ask', 'interview', askPrompt(brief), QUESTIONS_SCHEMA)
if (!qs) return finish('escalate', nodeFailure('ask'))
problems = questionProblems(qs, brief)
if (problems.length) {
  const prior = qs
  qs = await runNode('ask', 'interview (revise)', askPrompt(brief, problems, prior), QUESTIONS_SCHEMA)
  if (!qs) return finish('escalate', nodeFailure('ask', 'on the revision'))
  problems = questionProblems(qs, brief)
  if (problems.length) return finish('escalate', `questions are malformed after one revision: ${problems.join('; ')}`)
}
const capped = capQuestions(qs.questions)
if (capped.error) {
  return finish('escalate', `${capped.error} questions resolve contradictions, more than the ${MAX_QUESTIONS}-question interview holds: fix the documents first`)
}
// Every assumption gets a stable id the human can name to override it: A1, A2, ... for the
// questioner's own, the question's id for one past the cap.
const own = (Array.isArray(qs.assumptions) ? qs.assumptions : []).map((a, i) => ({ id: `A${i + 1}`, ...a }))
const trimmed = capped.trimmed.map(q => ({ id: q.id, from: q.id, assumption: q.default_if_unasked, why: `not asked (ranked below the ${MAX_QUESTIONS}-question cap): ${q.question}` }))
ledger.history.push({ node: 'ask', questions: qs.questions.length, asked: capped.asked.length, trimmed: trimmed.length })
return finish('needs-human', `${capped.asked.length} question(s) for the human; ${trimmed.length} more assumed`, {
  questions: capped.asked.map(recommendedFirst),
  preflight: Array.isArray(qs.preflight) ? qs.preflight : [],
  assumptions: [...own, ...trimmed],
})
