export const meta = {
  name: 'dev-build',
  description: 'Plan, build, and accept a development task, then hand the branch to the QA graph: routes on structured plan, verify, and acceptance results',
  whenToUse: 'Run by the /dev skill. args: {repo (required, absolute), task, base?, approval?: human|advisor, plan?, planApproved?, completed?, maxFixRounds?, knownStuckSigs?}',
  phases: [
    { title: 'Plan', detail: 'planner writes acceptance criteria and components in build order', model: 'sonnet' },
    { title: 'Gate', detail: 'advisor approves, revises, or blocks the plan', model: 'fable' },
    { title: 'Scout', detail: 'one read-only scout per component, in parallel', model: 'sonnet' },
    { title: 'Build', detail: 'implementer builds each component tests-first; one retry on a failed check', model: 'sonnet' },
    { title: 'Check', detail: 'checker runs verify.sh; the gate reads its VERIFY line', model: 'haiku' },
    { title: 'Accept', detail: 'acceptance-auditor maps every criterion to a passing test', model: 'sonnet' },
    { title: 'QA', detail: 'the harness-repair graph, as a child workflow' },
  ],
}

// Graph. Code routes; agents are leaves and never call each other.
//
//   planner --> advisor(gate) --revise--> planner (at most MAX_PLAN_ROUNDS planner calls)
//                             --blocked--> needs-human
//                             --approve--> plan-ready (approval: human) | build (approval: advisor)
//   args.plan + planApproved --> build (no planner, no gate)
//   build: scouts in parallel; per component in order: implementer --> check --FAIL--> implementer(retry) --> check --FAIL--> escalate
//   accept: acceptance-auditor --UNMET or unplanned change--> implementer(rework) --> check --> acceptance-auditor --still--> escalate
//   handoff: workflow('harness-repair') --> its status becomes ours
//
// Fix rounds, stuck signatures, and advisor-unstick live only in the QA graph;
// this script does not copy that loop. Helpers marked "shared" are copied
// verbatim from harness-repair.js (scripts cannot import each other) and a
// test fails if the copies drift. Returns a ledger; /dev persists it.

// One place for every node's agent, model, and effort. The agent files carry
// the same models and efforts; the routing tests fail if they drift.
const NODES = {
  plan:   { agentType: 'planner',            model: 'sonnet', effort: 'high', phase: 'Plan' },
  gate:   { agentType: 'advisor',            model: 'fable',  effort: 'high', phase: 'Gate' },
  scout:  { agentType: 'scout',              model: 'sonnet', effort: 'high', phase: 'Scout' },
  build:  { agentType: 'implementer',        model: 'sonnet', effort: 'high', phase: 'Build' },
  check:  { agentType: 'checker',            model: 'haiku',  effort: 'high', phase: 'Check' },
  accept: { agentType: 'acceptance-auditor', model: 'sonnet', effort: 'high', phase: 'Accept' },
}
const MAX_PLAN_ROUNDS = 3
const MAX_PLAN_FILES = 8
const QA_WORKFLOW = 'harness-repair'

// ---------- schemas ----------
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
// shared
const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    verify_block: STR,
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { step: STR, exit: { type: 'integer' }, error_key: STR, excerpt: STR },
        required: ['step', 'exit', 'error_key', 'excerpt'],
      },
    },
  },
  required: ['verdict', 'verify_block', 'failures'],
}
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    goal: STR,
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, criterion: STR, protects: STR, fails_when: STR, no_claim: STR },
        required: ['id', 'criterion', 'protects', 'fails_when', 'no_claim'],
      },
    },
    components: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, title: STR, files: STRS, depends_on: STRS, tests: STRS },
        required: ['id', 'title', 'files', 'depends_on', 'tests'],
      },
    },
    behavior_changes: STRS,
    out_of_scope: STRS,
    risks: { type: 'array', items: { type: 'object', properties: { risk: STR, mitigation: STR }, required: ['risk', 'mitigation'] } },
    questions: STRS,
  },
  required: ['goal', 'acceptance', 'components', 'behavior_changes', 'out_of_scope', 'risks', 'questions'],
}
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise', 'blocked'] },
    issues: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, issue: STR, fix: STR }, required: ['n', 'issue', 'fix'] } },
    questions: STRS,
  },
  required: ['verdict', 'issues', 'questions'],
}
const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    reuse: { type: 'array', items: { type: 'object', properties: { file: STR, line: { type: 'integer' }, what: STR }, required: ['file', 'line', 'what'] } },
    must_preserve: STRS,
    interfaces: STRS,
    edge_cases: STRS,
    test_patterns: STR,
  },
  required: ['reuse', 'must_preserve', 'interfaces', 'edge_cases', 'test_patterns'],
}
const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    touched: STRS,
    tests_added: { type: 'array', items: { type: 'object', properties: { file: STR, name: STR, protects: STR, fails_when: STR, bite: STR }, required: ['file', 'name', 'protects', 'fails_when', 'bite'] } },
    test_changes: { type: 'array', items: { type: 'object', properties: { change: STR, reason: STR }, required: ['change', 'reason'] } },
    verify_verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_RUN'] },
    unchecked: STRS,
    summary: STR,
  },
  required: ['done', 'touched', 'tests_added', 'test_changes', 'verify_verdict', 'unchecked', 'summary'],
}
const ACCEPT_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: { type: 'object', properties: { id: STR, status: { type: 'string', enum: ['MET', 'UNMET'] }, evidence: STR }, required: ['id', 'status', 'evidence'] },
    },
    behavior_changes_missing: {
      type: 'array',
      items: { type: 'object', properties: { change: STR, file: STR, line: { type: 'integer' } }, required: ['change', 'file', 'line'] },
    },
  },
  required: ['criteria', 'behavior_changes_missing'],
}

// ---------- args ----------
const A = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
const REPO = typeof A.repo === 'string' && A.repo.startsWith('/') ? A.repo : null
const TASK = typeof A.task === 'string' && A.task.trim() !== '' ? A.task.trim() : null
const BASE = typeof A.base === 'string' && A.base !== '' ? A.base : null
const APPROVAL = A.approval === 'advisor' ? 'advisor' : 'human'
const GIVEN_PLAN = A.plan && typeof A.plan === 'object' && !Array.isArray(A.plan) ? A.plan : null
const PLAN_APPROVED = GIVEN_PLAN !== null && A.planApproved === true
const COMPLETED = Array.isArray(A.completed) ? A.completed.filter(s => typeof s === 'string') : []

// The QA child gets exactly these keys, and only the ones the caller set.
function qaArgs() {
  const out = { repo: REPO }
  if (BASE) out.base = BASE
  if (Number.isInteger(A.maxFixRounds) && A.maxFixRounds > 0) out.maxFixRounds = A.maxFixRounds
  if (Array.isArray(A.knownStuckSigs)) out.knownStuckSigs = A.knownStuckSigs.filter(s => typeof s === 'string')
  return out
}

// ---------- ledger ----------
const ledger = {
  status: null,        // 'plan-ready' | 'needs-human' | 'escalate' | 'done'
  reason: null,
  plan: null,          // the plan being built (or awaiting approval)
  planRounds: 0,       // planner calls this run
  gate: null,          // the advisor's last plan-gate result
  questions: [],       // for the human, when status is needs-human
  completed: [...COMPLETED],   // component ids built and checked; /dev passes them back to resume
  components: {},      // id -> { build, checks }
  acceptance: null,    // the acceptance-auditor's last result
  touched: [],         // every file an implementer or the QA graph changed this run
  qa: null,            // the QA child's ledger
  stuckSig: null,      // the QA child's stuckSig, for /loop's knownStuckSigs
  history: [],         // one entry per node run, in order
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

// shared
// The gate reads the verbatim block, not the model's verdict field: the last
// non-empty line must be the verify script's own verdict.
function verdictFromBlock(block) {
  const lines = String(block || '').split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines.length ? lines[lines.length - 1] : ''
  if (last === 'VERIFY: PASS') return 'PASS'
  if (last === 'VERIFY: FAIL') return 'FAIL'
  return null
}
// shared
function addUnique(list, items, key) {
  const seen = new Set(list.map(key))
  for (const it of items) {
    const k = key(it)
    if (!seen.has(k)) { seen.add(k); list.push(it) }
  }
}
const asIs = x => x
const json = x => JSON.stringify(x, null, 2)

// Structural problems the code can see without judgment. A plan with any of
// these never reaches the advisor.
function planProblems(plan) {
  const problems = []
  const acc = Array.isArray(plan.acceptance) ? plan.acceptance : []
  const comps = Array.isArray(plan.components) ? plan.components : []
  if (!acc.length) problems.push('no acceptance criteria')
  if (!comps.length) problems.push('no components')
  const accIds = acc.map(a => a && a.id)
  if (new Set(accIds).size !== accIds.length || accIds.some(id => typeof id !== 'string' || !id)) problems.push('acceptance ids must be unique, non-empty strings')
  for (const a of acc) {
    if (!a || !['criterion', 'protects', 'fails_when'].every(k => typeof a[k] === 'string' && a[k].trim())) problems.push(`acceptance ${a && a.id}: criterion, protects, and fails_when must be non-empty`)
  }
  const seen = new Set()
  for (const c of comps) {
    if (!c || typeof c.id !== 'string' || !c.id) { problems.push('every component needs a non-empty id'); continue }
    if (seen.has(c.id)) problems.push(`component id ${c.id} is used twice`)
    if (!Array.isArray(c.files) || !c.files.length) problems.push(`component ${c.id} lists no files`)
    for (const d of Array.isArray(c.depends_on) ? c.depends_on : []) {
      if (!seen.has(d)) problems.push(`component ${c.id} depends on ${d}, which is not an earlier component (components must be in build order)`)
    }
    seen.add(c.id)
  }
  return problems
}
function planFiles(plan) {
  return [...new Set(plan.components.flatMap(c => c.files))]
}

// ---------- prompts ----------
// shared
const where = `Repo: ${REPO}. cd there before anything else.`
const baseNote = BASE ? `Base branch: ${BASE}.` : 'Detect the base branch (the default branch of origin).'

function checkPrompt() {
  return `${where}
Run the verify script exactly as your instructions say and read its full output. Do not edit files.
Fill the structured output:
- verify_block: the final summary block copied verbatim: every "  [exit] command" line, then the final "VERIFY: PASS" or "VERIFY: FAIL" line, which must be the last line.
- verdict: the word on that last line.
- failures: one entry per failing step; empty when the verdict is PASS. step = the command as printed. exit = its exit code. excerpt = the 5 to 15 output lines that explain the failure, copied verbatim. error_key = a short stable identifier for the first error: the failing test's name, or file:line plus the error code. No timestamps, durations, temp paths, or counts, so the same failure yields the same key on a re-run.`
}

function planPrompt(prior, issues) {
  return `${where}
Task:
${TASK || '(no task text; revise the plan below)'}

Write the plan following your instructions.${prior ? `

Revise this plan:
${json(prior)}

Fix every one of these issues:
${json(issues)}` : ''}

Fill the structured output. Acceptance ids are AC1, AC2, ...; component ids are C1, C2, ... in build order, and depends_on lists only earlier component ids. questions is empty unless the task is ambiguous in a way the code cannot settle.`
}

function gatePrompt(plan) {
  return `${where}
Task:
${TASK || '(given as a plan)'}

Plan:
${json(plan)}

It touches ${planFiles(plan).length} distinct file(s) across ${plan.components.length} component(s).
Gate it following your "Gating a plan" instructions. verdict: approve, revise, or blocked. issues: numbered, each with the concrete fix (empty when approving). questions: only when blocked.`
}

function scoutPrompt(plan, c) {
  return `${where}
Goal: ${plan.goal}
Component to research (it is not built yet):
${json(c)}
Acceptance criteria of the whole plan, for context:
${json(plan.acceptance)}
Research it following your instructions and fill the structured output. Cite file:line for everything.`
}

function buildPrompt(plan, c, brief, failed) {
  return `${where}
Goal: ${plan.goal}
Acceptance criteria:
${json(plan.acceptance)}
Planned behavior changes: ${json(plan.behavior_changes)}
Out of scope: ${json(plan.out_of_scope)}
Already built: ${json(ledger.completed)}

Build ONLY this component, following your instructions (read first, tests first, never commit):
${json(c)}

Scout brief:
${brief ? json(brief) : '(none: the scout returned nothing; read the code yourself)'}${failed ? `

Your previous attempt failed verification. Fix the cause; do not loosen any test.
VERIFY block:
${failed.verify_block}

Failures:
${json(failed.failures)}` : ''}

Fill the structured output: done = false only if you could not finish (say why in summary). touched = repo-relative paths you changed. test_changes first: any test, timeout, threshold, or snapshot you changed, with the reason. tests_added[].bite = the break you made to the code once the test passed and the assertion that then failed ("the function did not exist" is not a bite). verify_verdict = the last line of your own verify run (NOT_RUN if you did not run it).`
}

function acceptPrompt(plan) {
  return `${where}
${baseNote}
Acceptance criteria:
${json(plan.acceptance)}
Planned behavior changes:
${json(plan.behavior_changes)}
Audit the branch (committed and uncommitted changes) following your instructions. Return one entry per criterion id, MET only with a passing assertion at file:line as evidence. behavior_changes_missing: changes the code makes that the plan does not list (empty is a valid answer).`
}

function reworkPrompt(plan, unmet, unplanned) {
  return `${where}
Goal: ${plan.goal}
Acceptance criteria:
${json(plan.acceptance)}
Planned behavior changes: ${json(plan.behavior_changes)}

The acceptance audit found gaps. Close them following your instructions (tests first, never commit):
${unmet.length ? `Unmet criteria (each needs a passing test that asserts it):
${json(unmet)}
` : ''}${unplanned.length ? `Behavior changes the plan does not list. Remove each one unless an acceptance criterion requires it; if it is required, say so in unchecked:
${json(unplanned)}
` : ''}
Fill the structured output as for a component build.`
}

// ---------- nodes with routing ----------
// Runs the checker and returns { pass: true } or { finished } or { pass: false, check }.
async function verifyGate(label) {
  phase('Check')
  const check = await runNode('check', label, checkPrompt(), CHECK_SCHEMA)
  if (!check) return { finished: finish('escalate', nodeFailure('check')) }
  const verdict = verdictFromBlock(check.verify_block)
  ledger.history.push({ node: 'check', label, verdict, reported: check.verdict, failures: check.failures.length })
  if (!verdict) return { finished: finish('escalate', 'checker output has no VERIFY: PASS/FAIL as its last line') }
  if (verdict !== check.verdict) log(`checker said ${check.verdict} but its VERIFY block says ${verdict}; using the block`)
  return verdict === 'PASS' ? { pass: true } : { pass: false, check }
}

function recordBuild(id, build) {
  ledger.history.push({ node: 'build', id, result: build })
  addUnique(ledger.touched, build.touched, asIs)
  const entry = ledger.components[id] || (ledger.components[id] = { builds: [] })
  entry.builds.push(build)
}

// ---------- graph ----------
if (!REPO) return finish('escalate', 'args.repo is required and must be an absolute path')
if (!TASK && !GIVEN_PLAN) return finish('escalate', 'args.task is required unless args.plan is given')
if (GIVEN_PLAN) {
  const problems = planProblems(GIVEN_PLAN)
  if (problems.length) return finish('escalate', `args.plan is malformed: ${problems.join('; ')}`)
}
log(`repo ${REPO}; approval ${APPROVAL}; ${GIVEN_PLAN ? `given plan${PLAN_APPROVED ? ' (approved)' : ''}` : 'planning from the task'}; ${COMPLETED.length} component(s) already built`)

// ----- plan and gate -----
let plan = GIVEN_PLAN
if (!PLAN_APPROVED) {
  let issues = null
  let approved = false
  while (!approved) {
    if (!plan || issues) {
      if (ledger.planRounds >= MAX_PLAN_ROUNDS) {
        return finish('escalate', `plan not approved after ${MAX_PLAN_ROUNDS} planner round(s)`, { plan, gate: ledger.gate })
      }
      phase('Plan')
      ledger.planRounds += 1
      const next = await runNode('plan', `plan #${ledger.planRounds}`, planPrompt(plan, issues), PLAN_SCHEMA)
      if (!next) return finish('escalate', nodeFailure('plan'), { plan })
      plan = next
      ledger.history.push({ node: 'plan', round: ledger.planRounds, components: plan.components.length, acceptance: plan.acceptance.length })
    }
    const problems = planProblems(plan)
    if (problems.length) {
      ledger.history.push({ node: 'plan-check', problems })
      issues = problems.map((issue, i) => ({ n: i + 1, issue, fix: 'restructure the plan so this holds' }))
      continue
    }
    phase('Gate')
    const gate = await runNode('gate', `gate: plan #${ledger.planRounds}`, gatePrompt(plan), GATE_SCHEMA)
    if (!gate) return finish('escalate', nodeFailure('gate', 'on the plan'), { plan })
    ledger.gate = gate
    ledger.history.push({ node: 'gate', verdict: gate.verdict, issues: gate.issues.length })
    if (gate.verdict === 'blocked') {
      return finish('needs-human', 'the advisor needs answers before this can be planned', { plan, questions: gate.questions })
    }
    if (gate.verdict === 'approve') approved = true
    else issues = gate.issues
  }
  ledger.plan = plan
  if (APPROVAL === 'human') return finish('plan-ready', 'plan approved by the advisor; waiting for human approval')
}
ledger.plan = plan
const files = planFiles(plan)
if (files.length > MAX_PLAN_FILES) log(`plan touches ${files.length} files (over ${MAX_PLAN_FILES}); it was approved with that size`)

// ----- scout (read-only, in parallel) -----
const todo = plan.components.filter(c => !COMPLETED.includes(c.id))
if (todo.length < plan.components.length) log(`skipping ${plan.components.length - todo.length} component(s) already built: ${COMPLETED.join(', ')}`)
phase('Scout')
const briefs = await parallel(todo.map(c => () => runNode('scout', `scout ${c.id}`, scoutPrompt(plan, c), SCOUT_SCHEMA)))
todo.forEach((c, i) => { if (!briefs[i]) log(`scout for ${c.id} returned nothing; the implementer reads the code itself`) })

// ----- build, one component at a time, in plan order -----
for (let i = 0; i < todo.length; i += 1) {
  const c = todo[i]
  let failed = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    phase('Build')
    const build = await runNode('build', `build ${c.id}${attempt > 1 ? ' (retry)' : ''}`, buildPrompt(plan, c, briefs[i], failed), BUILD_SCHEMA)
    if (!build) return finish('escalate', nodeFailure('build', `on ${c.id}`))
    recordBuild(c.id, build)
    if (!build.done) return finish('escalate', `implementer could not finish ${c.id}: ${build.summary}`)
    const gate = await verifyGate(`check ${c.id}${attempt > 1 ? ' (retry)' : ''}`)
    if (gate.finished) return gate.finished
    if (gate.pass) { failed = null; break }
    failed = gate.check
  }
  if (failed) return finish('escalate', `${c.id} still fails verification after one retry; resume with completed=${json(ledger.completed)}`)
  ledger.completed.push(c.id)
}

// ----- accept: every criterion proven by a passing assertion -----
for (let round = 1; round <= 2; round += 1) {
  phase('Accept')
  const acc = await runNode('accept', `accept #${round}`, acceptPrompt(plan), ACCEPT_SCHEMA)
  if (!acc) return finish('escalate', nodeFailure('accept'))
  ledger.acceptance = acc
  const byId = new Map(acc.criteria.map(r => [r.id, r]))
  // A criterion the auditor did not report on is unmet: no evidence, no pass.
  const unmet = plan.acceptance
    .filter(a => !byId.has(a.id) || byId.get(a.id).status !== 'MET')
    .map(a => ({ ...a, auditor: byId.has(a.id) ? byId.get(a.id).evidence : 'not reported by the auditor' }))
  const unplanned = acc.behavior_changes_missing
  ledger.history.push({ node: 'accept', round, unmet: unmet.map(a => a.id), unplanned: unplanned.length })
  if (!unmet.length && !unplanned.length) break
  if (round === 2) {
    const gaps = [unmet.length ? `unmet ${unmet.map(a => a.id).join(', ')}` : '', unplanned.length ? `${unplanned.length} unplanned behavior change(s)` : ''].filter(Boolean).join('; ')
    return finish('escalate', `acceptance still failing after one rework: ${gaps}`)
  }
  phase('Build')
  const rework = await runNode('build', 'rework: acceptance', reworkPrompt(plan, unmet, unplanned), BUILD_SCHEMA)
  if (!rework) return finish('escalate', nodeFailure('build', 'on the acceptance rework'))
  recordBuild('rework', rework)
  if (!rework.done) return finish('escalate', `implementer could not close the acceptance gaps: ${rework.summary}`)
  const gate = await verifyGate('check rework')
  if (gate.finished) return gate.finished
  if (!gate.pass) return finish('escalate', 'the acceptance rework broke verification')
}

// ----- hand off to the QA graph -----
phase('QA')
let qa = null
try {
  qa = await workflow(QA_WORKFLOW, qaArgs())
} catch (e) {
  return finish('escalate', `QA graph failed to run: ${e && e.message ? e.message : String(e)}`)
}
if (!qa || typeof qa !== 'object' || !qa.status) return finish('escalate', 'QA graph returned no ledger')
ledger.qa = qa
ledger.history.push({ node: 'qa', status: qa.status, reason: qa.reason })
addUnique(ledger.touched, Array.isArray(qa.touched) ? qa.touched : [], asIs)
if (qa.status !== 'done') return finish('escalate', `QA graph escalated: ${qa.reason}`, { stuckSig: qa.stuckSig || null })
return finish('done', `built ${plan.components.length} component(s), ${plan.acceptance.length} acceptance criteria met; QA: ${qa.reason}`)
