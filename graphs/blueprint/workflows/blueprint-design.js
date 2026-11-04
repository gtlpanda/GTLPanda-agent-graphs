export const meta = {
  name: 'blueprint-design',
  description: 'Plan an app or feature before any code: extract a brief from the documents and repo, then build the ranked interview for the human (questions, preflight, assumptions)',
  whenToUse: 'Run by the /blueprint skill. args: {repo (required, absolute), request?, docs? (paths; at least one of request or docs)}',
  phases: [
    { title: 'Extract', detail: 'extractor reads the documents, the repo, and the request into a brief', model: 'sonnet' },
    { title: 'Interview', detail: 'questioner ranks the open decisions by cost to change and lists preflight and assumptions', model: 'sonnet' },
  ],
}

// Graph (run 1 of /blueprint). Code routes; agents are leaves and never call each other.
//
//   extractor --malformed brief--> extractor (once, with the problems) --still--> escalate
//             --brief--> questioner --malformed--> questioner (once) --still--> escalate
//                                   --questions--> cap at MAX_QUESTIONS (contradictions always kept)
//                                                  --> needs-human (the skill asks; nothing is designed yet)
//
// Helpers marked "shared" are copied verbatim from harness-repair.js (scripts
// cannot import each other) and a test fails if the copies drift. Returns a
// ledger; /blueprint persists it.

// One place for every node's agent, model, and effort. The agent files carry
// the same models and efforts; the routing tests fail if they drift.
const NODES = {
  extract: { agentType: 'extractor',  model: 'sonnet', effort: 'high', phase: 'Extract' },
  ask:     { agentType: 'questioner', model: 'sonnet', effort: 'high', phase: 'Interview' },
}
// Three AskUserQuestion calls of four. Lower-ranked questions become assumptions.
const MAX_QUESTIONS = 12

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

// ---------- args ----------
const A = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
const REPO = typeof A.repo === 'string' && A.repo.startsWith('/') ? A.repo : null
const REQUEST = typeof A.request === 'string' && A.request.trim() !== '' ? A.request.trim() : null
const DOCS_OK = A.docs === undefined || (Array.isArray(A.docs) && A.docs.every(d => typeof d === 'string' && d.trim() !== ''))
const DOCS = Array.isArray(A.docs) && DOCS_OK ? A.docs : []

// ---------- ledger ----------
const ledger = {
  status: null,      // 'needs-human' | 'escalate'
  reason: null,
  brief: null,       // the extractor's brief
  questions: [],     // what the skill asks, in rank order, recommended option first
  preflight: [],     // what a human must supply before an unattended build
  assumptions: [],   // decided without asking, each with an id (A<n>, or Q<n> for a question past the cap)
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
const nonEmpty = s => typeof s === 'string' && s.trim() !== ''

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

// ---------- run ----------
if (!REPO) return finish('escalate', 'args.repo is required and must be an absolute path')
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
