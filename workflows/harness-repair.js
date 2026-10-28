export const meta = {
  name: 'harness-repair',
  description: 'Check, fix, review graph for one repo: routes on structured verify and review results, stops on pass, a fix-round cap, or no progress',
  whenToUse: 'Run by /loop (loop.md step 3) once per iteration. args: {repo (required, absolute), base?, maxFixRounds?, knownStuckSigs?}',
  phases: [
    { title: 'Check', detail: 'checker runs verify.sh; the gate reads its VERIFY line', model: 'haiku' },
    { title: 'Fix', detail: 'fixer makes the smallest change for failures or confirmed findings', model: 'sonnet' },
    { title: 'Review', detail: 'reviewer reviews the branch, then only what each fix touched', model: 'sonnet' },
    { title: 'Advise', detail: 'advisor confirms blocking findings and unsticks a repeated failure', model: 'fable' },
  ],
}

// Graph. Code routes; agents are leaves and never call each other.
//
//   check --FAIL--> fix --> check                 the fixer's own verify run is never the gate
//   check --PASS--> review --nothing blocking--> done
//   review --HIGH/CRITICAL--> advise(confirm) --real--> fix --> check --> review(touched files only)
//   same failure signature twice in a row --> advise(unstick) once --> fix with its strategy, else escalate
//
// Stops with status 'done' or 'escalate' (fix-round cap, no progress, a node
// returned nothing, bad args). Returns a ledger; this script has no filesystem
// access, so the outer /loop turn persists it.

// One place for every node's agent, model, and effort. The agent files carry
// the same models for standalone use; scripts/test-workflow.mjs fails if they drift.
const NODES = {
  check:  { agentType: 'checker',  model: 'haiku',  effort: 'low',    phase: 'Check' },
  fix:    { agentType: 'fixer',    model: 'sonnet', effort: 'medium', phase: 'Fix' },
  review: { agentType: 'reviewer', model: 'sonnet', effort: 'medium', phase: 'Review' },
  advise: { agentType: 'advisor',  model: 'fable',  effort: 'high',   phase: 'Advise' },
}
const BLOCKING = ['CRITICAL', 'HIGH']
const DEFAULT_MAX_FIX_ROUNDS = 3

// ---------- schemas ----------
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
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
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: STRS,
    unfixed: {
      type: 'array',
      items: { type: 'object', properties: { item: STR, reason: STR }, required: ['item', 'reason'] },
    },
    touched: STRS,
    verify_verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_RUN'] },
    summary: STR,
  },
  required: ['fixed', 'unfixed', 'touched', 'verify_verdict', 'summary'],
}
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    title: STR, file: STR, line: { type: 'integer' }, why: STR, fix: STR,
  },
  required: ['severity', 'title', 'file', 'line', 'why', 'fix'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: { files_reviewed: { type: 'integer' }, findings: { type: 'array', items: FINDING_SCHEMA } },
  required: ['files_reviewed', 'findings'],
}
const CONFIRM_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, real: { type: 'boolean' }, reason: STR },
        required: ['index', 'real', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}
const UNSTICK_SCHEMA = {
  type: 'object',
  properties: { action: { type: 'string', enum: ['retry', 'escalate'] }, diagnosis: STR, strategy: STR },
  required: ['action', 'diagnosis', 'strategy'],
}

// ---------- args ----------
const A = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
const REPO = typeof A.repo === 'string' && A.repo.startsWith('/') ? A.repo : null
const BASE = typeof A.base === 'string' && A.base !== '' ? A.base : null
const MAX_FIX_ROUNDS = Number.isInteger(A.maxFixRounds) && A.maxFixRounds > 0 ? A.maxFixRounds : DEFAULT_MAX_FIX_ROUNDS
const KNOWN_STUCK = new Set(Array.isArray(A.knownStuckSigs) ? A.knownStuckSigs.filter(s => typeof s === 'string') : [])

// ---------- ledger ----------
const ledger = {
  status: null,       // 'done' | 'escalate'
  reason: null,
  fixRounds: 0,
  stuckSig: null,     // set when escalating on a specific failure; /loop feeds it back as knownStuckSigs
  lastVerify: null,   // verbatim VERIFY block from the most recent check
  touched: [],        // every file a fixer changed this run
  fixed: [],          // every item a fixer reported fixed, for /loop's commit message
  noted: [],          // MEDIUM/LOW findings, not fixed by the graph
  refuted: [],        // blocking findings the advisor refuted, with its reason
  history: [],        // one entry per node run, in order
}
function finish(status, reason, extra) {
  ledger.status = status
  ledger.reason = reason
  Object.assign(ledger, extra || {})
  log(`${status}: ${reason}`)
  return ledger
}

// ---------- helpers ----------
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

// The gate reads the verbatim block, not the model's verdict field: the last
// non-empty line must be the verify script's own verdict.
function verdictFromBlock(block) {
  const lines = String(block || '').split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines.length ? lines[lines.length - 1] : ''
  if (last === 'VERIFY: PASS') return 'PASS'
  if (last === 'VERIFY: FAIL') return 'FAIL'
  return null
}
function failureSig(check) {
  if (check.failures.length) {
    return 'verify|' + check.failures.map(f => `${f.step}#${f.exit}#${f.error_key}`).sort().join('|')
  }
  // FAIL with no failing step (no stack detected, no test step ran): key on the
  // block itself so unrelated step-less failures do not share one signature.
  return 'verify|block|' + String(check.verify_block).split('\n').map(l => l.trim()).filter(Boolean).join('|')
}
function findingKey(f) {
  return `${f.file}#${String(f.title).toLowerCase().trim()}`
}
function reviewSig(findings) {
  return 'review|' + findings.map(findingKey).sort().join('|')
}
function addUnique(list, items, key) {
  const seen = new Set(list.map(key))
  for (const it of items) {
    const k = key(it)
    if (!seen.has(k)) { seen.add(k); list.push(it) }
  }
}
const asIs = x => x
const json = x => JSON.stringify(x, null, 2)

// ---------- prompts ----------
const where = `Repo: ${REPO}. cd there before anything else.`

function checkPrompt() {
  return `${where}
Run the verify script exactly as your instructions say and read its full output. Do not edit files.
Fill the structured output:
- verify_block: the final summary block copied verbatim: every "  [exit] command" line, then the final "VERIFY: PASS" or "VERIFY: FAIL" line, which must be the last line.
- verdict: the word on that last line.
- failures: one entry per failing step; empty when the verdict is PASS. step = the command as printed. exit = its exit code. excerpt = the 5 to 15 output lines that explain the failure, copied verbatim. error_key = a short stable identifier for the first error: the failing test's name, or file:line plus the error code. No timestamps, durations, temp paths, or counts, so the same failure yields the same key on a re-run.`
}

function fixVerifyPrompt(check, strategy) {
  return `${where}
Verification failed. Fix the cause with the smallest correct change, following your instructions (read before editing, add or update a test when behavior changes, never commit, never push).

VERIFY block:
${check.verify_block}

Failures:
${json(check.failures)}
${strategy ? `\nAn earlier attempt did not change this failure. The advisor diagnosed it; follow this strategy:\n${strategy}\n` : ''}
Fill the structured output: fixed = what you fixed, one line each. unfixed = anything you could not fix, with the reason. touched = repo-relative paths you changed. verify_verdict = the last line of your own verify run (NOT_RUN if you did not run it). summary = at most two lines.`
}

function fixFindingsPrompt(findings) {
  return `${where}
Verification passes, but review found blocking defects that the advisor confirmed. Fix each with the smallest correct change, following your instructions (read before editing, add a test that fails without the fix, never commit, never push).

Findings:
${json(findings)}

Fill the structured output: fixed = the findings you fixed (title, one line each). unfixed = findings you could not fix, with the reason. touched = repo-relative paths you changed. verify_verdict = the last line of your own verify run (NOT_RUN if you did not run it). summary = at most two lines.`
}

function reviewPrompt(scope) {
  if (scope.kind === 'branch') {
    return `${where}
Review this branch's changes, committed and uncommitted, following your harness-review skill.${BASE ? ` Base branch: ${BASE}.` : ' Let the skill detect the base branch.'}
Put every finding in the structured output with its severity, file, line, why, and fix. files_reviewed = how many changed files you read. An empty findings list is a valid answer.`
  }
  return `${where}
A fix just changed these files: ${json(scope.files)}
Review ONLY the uncommitted changes to those files, following your harness-review skill. Ignore the rest of the branch.
These blocking findings were the reason for the fix:
${json(scope.prior)}
Report a prior finding again only if it is still present. Report any new defect the fix introduced. files_reviewed = how many of those files you read. An empty findings list is a valid answer.`
}

function confirmPrompt(findings) {
  const indexed = findings.map((f, index) => ({ index, ...f }))
  return `${where}
A reviewer reported these blocking findings. Before anyone spends a fix round on them, confirm or refute each by reading the code at file:line.
${json(indexed)}
Return one verdict per index. real=false only when you can show the finding is wrong (unreachable path, already handled, or a misreading of the code). If you cannot decide, real=true. reason = one sentence with file:line evidence.`
}

function unstickPrompt(check, attempts) {
  return `${where}
A fix attempt left this verification failure unchanged.

VERIFY block:
${check.verify_block}

Failures:
${json(check.failures)}

What the fixer reported on the attempts for this failure:
${json(attempts)}

Read the failing output and the code it points at, and find why the attempt did not move it. action=retry only with a concretely different strategy (which files, which change, why it addresses the cause the attempt missed). action=escalate when a human is needed (missing credential or service, ambiguous requirement, failure outside the change's scope, flaky environment); then strategy is an empty string and diagnosis says exactly what the human must decide.`
}

// ---------- graph ----------
if (!REPO) {
  return finish('escalate', 'args.repo is required and must be an absolute path')
}
log(`repo ${REPO}; fix-round cap ${MAX_FIX_ROUNDS}; ${KNOWN_STUCK.size} known-stuck signature(s)`)

let lastSig = null                 // signature that triggered the previous fix round
const advisedSigs = new Set()      // signatures the advisor already tried to unstick
let strategy = null                // advisor strategy for the next verify fix
let reviewScope = { kind: 'branch' }
let touchedSinceReview = []
let checks = 0

while (true) {
  // ----- check -----
  phase('Check')
  checks += 1
  const check = await runNode('check', `check #${checks}`, checkPrompt(), CHECK_SCHEMA)
  if (!check) return finish('escalate', nodeFailure('check'))
  ledger.lastVerify = check.verify_block
  const verdict = verdictFromBlock(check.verify_block)
  ledger.history.push({ node: 'check', verdict, reported: check.verdict, failures: check.failures.length })
  if (!verdict) return finish('escalate', 'checker output has no VERIFY: PASS/FAIL as its last line')
  if (verdict !== check.verdict) log(`checker said ${check.verdict} but its VERIFY block says ${verdict}; using the block`)

  if (verdict === 'FAIL') {
    const sig = failureSig(check)
    if (KNOWN_STUCK.has(sig)) {
      return finish('escalate', 'same failure an earlier iteration already escalated; needs a human', { stuckSig: sig })
    }
    if (ledger.fixRounds >= MAX_FIX_ROUNDS) {
      return finish('escalate', `fix-round cap (${MAX_FIX_ROUNDS}) reached with verification still failing`, { stuckSig: sig })
    }
    if (sig === lastSig) {
      if (advisedSigs.has(sig)) {
        return finish('escalate', 'failure unchanged even after the advisor strategy', { stuckSig: sig })
      }
      advisedSigs.add(sig)
      phase('Advise')
      const attempts = ledger.history.filter(h => h.node === 'fix' && h.sig === sig).map(h => h.result)
      const advice = await runNode('advise', 'advise: unstick', unstickPrompt(check, attempts), UNSTICK_SCHEMA)
      if (!advice) return finish('escalate', nodeFailure('advise', 'while unsticking'), { stuckSig: sig })
      ledger.history.push({ node: 'advise', kind: 'unstick', sig, result: advice })
      if (advice.action === 'escalate' || !advice.strategy.trim()) {
        return finish('escalate', `advisor: ${advice.diagnosis}`, { stuckSig: sig })
      }
      strategy = advice.strategy
    }

    phase('Fix')
    lastSig = sig
    ledger.fixRounds += 1
    const fix = await runNode('fix', `fix #${ledger.fixRounds} (verify)`, fixVerifyPrompt(check, strategy), FIX_SCHEMA)
    strategy = null
    if (!fix) return finish('escalate', nodeFailure('fix'))
    ledger.history.push({ node: 'fix', trigger: 'verify', sig, result: fix })
    addUnique(ledger.touched, fix.touched, asIs)
    addUnique(ledger.fixed, fix.fixed, asIs)
    addUnique(touchedSinceReview, fix.touched, asIs)
    continue
  }

  // ----- review (verification passed) -----
  phase('Review')
  const scope = reviewScope.kind === 'fix'
    ? { kind: 'fix', files: touchedSinceReview, prior: reviewScope.prior }
    : reviewScope
  const review = await runNode('review', scope.kind === 'fix' ? 'review: fix diff' : 'review: branch', reviewPrompt(scope), REVIEW_SCHEMA)
  if (!review) return finish('escalate', nodeFailure('review'))
  ledger.history.push({ node: 'review', scope: scope.kind, files: scope.files || null, findings: review.findings.length })
  touchedSinceReview = []

  const blocking = review.findings.filter(f => BLOCKING.includes(f.severity))
  addUnique(ledger.noted, review.findings.filter(f => !BLOCKING.includes(f.severity)), findingKey)
  if (!blocking.length) return finish('done', 'VERIFY: PASS and no HIGH/CRITICAL findings')

  // ----- advise: confirm blocking findings, one batched call -----
  phase('Advise')
  const confirm = await runNode('advise', `advise: confirm ${blocking.length} finding(s)`, confirmPrompt(blocking), CONFIRM_SCHEMA)
  if (!confirm) return finish('escalate', nodeFailure('advise', 'on blocking findings'), { unconfirmed: blocking })
  ledger.history.push({ node: 'advise', kind: 'confirm', result: confirm })
  const byIndex = new Map(confirm.verdicts.map(v => [v.index, v]))
  const confirmed = []
  blocking.forEach((f, i) => {
    const v = byIndex.get(i)
    if (v && v.real === false) ledger.refuted.push({ ...f, refutedBecause: v.reason })
    else confirmed.push(f)   // no verdict for this index counts as real: a missed bug costs more than a fix round
  })
  if (!confirmed.length) return finish('done', 'VERIFY: PASS; every blocking finding was refuted by the advisor')

  const sig = reviewSig(confirmed)
  if (KNOWN_STUCK.has(sig)) {
    return finish('escalate', 'same confirmed findings an earlier iteration already escalated; needs a human', { stuckSig: sig })
  }
  if (sig === lastSig) {
    return finish('escalate', 'confirmed findings survived a fix round unchanged', { stuckSig: sig })
  }
  if (ledger.fixRounds >= MAX_FIX_ROUNDS) {
    return finish('escalate', `fix-round cap (${MAX_FIX_ROUNDS}) reached with confirmed findings open`, { stuckSig: sig })
  }

  phase('Fix')
  lastSig = sig
  ledger.fixRounds += 1
  const fix = await runNode('fix', `fix #${ledger.fixRounds} (review)`, fixFindingsPrompt(confirmed), FIX_SCHEMA)
  if (!fix) return finish('escalate', nodeFailure('fix'))
  ledger.history.push({ node: 'fix', trigger: 'review', sig, result: fix })
  if (!fix.touched.length) {
    return finish('escalate', 'fixer changed no files for confirmed findings', { stuckSig: sig })
  }
  addUnique(ledger.touched, fix.touched, asIs)
  addUnique(ledger.fixed, fix.fixed, asIs)
  addUnique(touchedSinceReview, fix.touched, asIs)
  reviewScope = { kind: 'fix', prior: confirmed }
}
