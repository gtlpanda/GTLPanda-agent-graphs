export const meta = {
  name: 'release-flow',
  description: 'Release one green pull request: docs in the PR, readiness on the exact head, a merge you approved for that head, then deploy evidence for the merge commit; instant stages, the caller waits between them',
  whenToUse: 'Run by the /release-pr skill, one stage per call. args: {repo (required, absolute), pr (required), stage: docs|ready|land|verify, approval?: {pr, head, base}, mergeSha?, targets?, prior?, verifyRound?}',
  phases: [
    { title: 'Check', detail: 'release-checker reads the PR, its checks on the head commit, and the deploy configuration', model: 'haiku' },
    { title: 'Docs', detail: 'scribe updates the repo\'s existing docs and drafts release notes', model: 'sonnet' },
    { title: 'Merge', detail: 'merger merges the approved head once and reads the state back', model: 'sonnet' },
    { title: 'Watch', detail: 'deploy-watcher snapshots deploy evidence for the merge commit and health', model: 'sonnet' },
    { title: 'Advise', detail: 'advisor decides whether a failed deploy was caused by this change', model: 'fable' },
  ],
}

// Graph. Code routes; agents are leaves and never call each other. Every stage
// is an instant snapshot: /release-pr waits between stages (CI, deploys) and
// re-invokes with the stage and what the previous one returned.
//
//   docs:   check --blocker--> blocked | --no deploy config--> needs-config | --> scribe --> docs-ready
//   ready:  check --CI pending--> waiting | --blocker--> blocked | --> ready-to-merge {pr, head, base}
//   land:   check --already MERGED--> merged (no merger) | --head/base moved--> stale | --blocker--> blocked
//           --> merger (one call) --MERGED--> merged | --else--> escalate
//   verify: watch --pending--> waiting | --failed or broken twice--> advise --> rollback-recommended | done-with-concerns
//           --unverifiable--> done-with-concerns | --all deployed--> done
//
// Helpers marked "shared" are copied verbatim from the QA graph's script and a
// test fails if they drift. Returns a ledger; /release-pr persists it.

const NODES = {
  check:  { agentType: 'release-checker', model: 'haiku',  effort: 'high', phase: 'Check' },
  docs:   { agentType: 'scribe',          model: 'sonnet', effort: 'high', phase: 'Docs' },
  merge:  { agentType: 'merger',          model: 'sonnet', effort: 'high', phase: 'Merge' },
  watch:  { agentType: 'deploy-watcher',  model: 'sonnet', effort: 'high', phase: 'Watch' },
  advise: { agentType: 'advisor',         model: 'fable',  effort: 'high', phase: 'Advise' },
}
const STAGES = ['docs', 'ready', 'land', 'verify']
const MERGEABLE = ['CLEAN', 'HAS_HOOKS']
const MAX_VERIFY_ROUNDS = 12   // backstop; the caller's time budget normally ends the waiting first

// ---------- schemas ----------
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const TARGET = {
  type: 'object',
  properties: { name: STR, workflow: STR, status_command: STR, health: STR },
  required: ['name', 'workflow', 'status_command', 'health'],
}
const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    pr: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        state: { type: 'string', enum: ['OPEN', 'MERGED', 'CLOSED'] },
        headRefOid: STR, headRefName: STR, baseRefName: STR,
        mergeStateStatus: STR, reviewDecision: STR,
        isDraft: { type: 'boolean' },
        mergeCommit: STR,
      },
      required: ['number', 'state', 'headRefOid', 'headRefName', 'baseRefName', 'mergeStateStatus', 'reviewDecision', 'isDraft', 'mergeCommit'],
    },
    default_branch: STR,
    merge_methods: STRS,
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: STR, bucket: { type: 'string', enum: ['pass', 'fail', 'pending', 'skipping', 'cancel'] } },
        required: ['name', 'bucket'],
      },
    },
    deploy: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['config', 'proposal', 'none'] },
        merge_method: STR,
        targets: { type: 'array', items: TARGET },
        missing_credentials: STRS,
      },
      required: ['source', 'merge_method', 'targets', 'missing_credentials'],
    },
  },
  required: ['pr', 'default_branch', 'merge_methods', 'checks', 'deploy'],
}
const DOCS_SCHEMA = {
  type: 'object',
  properties: { touched: STRS, summary: STR, for_human: STRS, release_notes: STR },
  required: ['touched', 'summary', 'for_human', 'release_notes'],
}
const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['MERGED', 'NOT_MERGED', 'UNKNOWN'] },
    merge_sha: STR,
    by_this_attempt: { type: 'boolean' },
    detail: STR,
  },
  required: ['outcome', 'merge_sha', 'by_this_attempt', 'detail'],
}
const WATCH_SCHEMA = {
  type: 'object',
  properties: {
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: STR,
          evidence: { type: 'string', enum: ['MATCHED', 'PENDING', 'FAILED', 'NO_EVIDENCE'] },
          health: { type: 'string', enum: ['OK', 'FAIL', 'NOT_CONFIGURED'] },
          detail: STR,
        },
        required: ['name', 'evidence', 'health', 'detail'],
      },
    },
  },
  required: ['targets'],
}
const ADVISE_SCHEMA = {
  type: 'object',
  properties: { action: { type: 'string', enum: ['rollback', 'investigate'] }, diagnosis: STR, evidence: STR },
  required: ['action', 'diagnosis', 'evidence'],
}

// ---------- args ----------
const A = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
const REPO = typeof A.repo === 'string' && A.repo.startsWith('/') ? A.repo : null
const PR = Number.isInteger(A.pr) && A.pr > 0 ? A.pr : null
const STAGE = STAGES.includes(A.stage) ? A.stage : null
const AP = A.approval && typeof A.approval === 'object' ? A.approval : null
const APPROVAL = AP && AP.pr === PR && typeof AP.head === 'string' && AP.head && typeof AP.base === 'string' && AP.base ? AP : null
const MERGE_SHA = typeof A.mergeSha === 'string' && /^[0-9a-f]{7,40}$/.test(A.mergeSha) ? A.mergeSha : null
const TARGETS = Array.isArray(A.targets) ? A.targets.filter(t => t && typeof t.name === 'string' && t.name) : null
const PRIOR = Array.isArray(A.prior) ? A.prior.filter(t => t && typeof t.name === 'string') : []
const VERIFY_ROUND = Number.isInteger(A.verifyRound) && A.verifyRound > 0 ? A.verifyRound : 1

// ---------- ledger ----------
const ledger = {
  status: null,     // blocked | needs-config | docs-ready | waiting | ready-to-merge | stale | merged | done | done-with-concerns | rollback-recommended | escalate
  reason: null,
  stage: STAGE,
  pr: PR,
  head: null,
  base: null,
  blockers: [],
  warnings: [],
  wait_for: [],     // what /release-pr should wait on before re-running this stage
  proposal: null,   // a proposed deploy configuration, when status is needs-config
  docs: null,       // the scribe's report
  merge: null,      // { outcome, merge_sha, by_this_attempt, detail }
  targets: [],      // deploy targets from the configuration, for verify
  deploy: [],       // per target: { name, evidence, health, verdict, detail }
  advice: null,
  history: [],
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
function addUnique(list, items, key) {
  const seen = new Set(list.map(key))
  for (const it of items) {
    const k = key(it)
    if (!seen.has(k)) { seen.add(k); list.push(it) }
  }
}
const json = x => JSON.stringify(x, null, 2)

// Snapshot the PR with the checker and record the facts every stage needs.
async function snapshot(label) {
  phase('Check')
  const snap = await runNode('check', label, checkPrompt(), CHECK_SCHEMA)
  if (!snap) return null
  ledger.head = snap.pr.headRefOid
  ledger.base = snap.pr.baseRefName
  ledger.targets = snap.deploy.targets
  ledger.history.push({ node: 'check', label, state: snap.pr.state, head: snap.pr.headRefOid, mergeState: snap.pr.mergeStateStatus, checks: snap.checks.length })
  return snap
}

// Blockers that hold in every pre-merge stage. Pending checks are not
// blockers; each stage decides whether to wait for them.
function baseBlockers(snap) {
  const b = []
  if (snap.pr.state !== 'OPEN') b.push(`the pull request is ${snap.pr.state}`)
  if (snap.pr.isDraft) b.push('the pull request is a draft')
  if (snap.pr.baseRefName !== snap.default_branch) b.push(`it is stacked on ${snap.pr.baseRefName}; merge that first so its base is ${snap.default_branch}`)
  const failed = snap.checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').map(c => c.name)
  if (failed.length) b.push(`checks failing on the head commit: ${failed.join(', ')}`)
  return b
}
function pendingChecks(snap) {
  return snap.checks.filter(c => c.bucket === 'pending').map(c => c.name)
}
function mergeGateBlocker(snap) {
  if (MERGEABLE.includes(snap.pr.mergeStateStatus)) return null
  const why = snap.pr.reviewDecision && snap.pr.reviewDecision !== 'APPROVED' ? ` (reviewDecision ${snap.pr.reviewDecision})` : ''
  return `GitHub will not merge it: mergeStateStatus ${snap.pr.mergeStateStatus}${why}`
}
function mergeMethod(snap) {
  const m = snap.deploy.merge_method
  return ['squash', 'merge', 'rebase'].includes(m) && snap.merge_methods.includes(m) ? m : null
}

// ---------- prompts ----------
// shared
const where = `Repo: ${REPO}. cd there before anything else.`

function checkPrompt() {
  return `${where}
Report the release readiness of pull request #${PR} following your instructions. Copy GitHub's values exactly. checks: every check on the head commit only, with gh's bucket (pass, fail, pending, skipping, cancel). deploy.source: "config" when CLAUDE.md has a ## Deploy Configuration section (targets as written), "proposal" when you built one from the repo's files, "none" when there is nothing to propose. Empty string for any field the repo does not show; never invent a URL or a command.`
}

function docsPrompt(snap) {
  return `${where}
Pull request #${PR} (${snap.pr.headRefName} into ${snap.pr.baseRefName}) is built, tested, and about to be released. Update its documentation following your instructions, in this working tree, on its branch. Never commit.
Fill the structured output: touched = repo-relative paths you changed. for_human = changes you did not make because they are narrative, removals, or new pages. release_notes = the note for people outside the repo.`
}

function mergePrompt(method) {
  return `${where}
Merge pull request #${PR} at head ${APPROVAL.head} into ${APPROVAL.base} with --${method}, following your instructions: one attempt, then read the state back. Never a second attempt.`
}

function watchPrompt(targets) {
  return `${where}
Pull request #${PR} merged as ${MERGE_SHA}. Take one snapshot of these deploy targets following your instructions:
${json(targets)}
Return one entry per target name.`
}

function advisePrompt(bad) {
  return `${where}
Pull request #${PR} merged as ${MERGE_SHA}. These deploy targets failed:
${json(bad)}
Follow your "Diagnosing a failed release" instructions. action: rollback only with evidence this change caused it; otherwise investigate.`
}

// ---------- graph ----------
if (!REPO) return finish('escalate', 'args.repo is required and must be an absolute path')
if (!PR) return finish('escalate', 'args.pr is required and must be a positive integer')
if (!STAGE) return finish('escalate', `args.stage must be one of ${STAGES.join(', ')}`)
if (STAGE === 'land' && !APPROVAL) return finish('escalate', 'stage land needs args.approval {pr, head, base} for this pull request')
if (STAGE === 'verify' && (!MERGE_SHA || !TARGETS)) return finish('escalate', 'stage verify needs args.mergeSha and args.targets from the land stage')
log(`PR #${PR}; stage ${STAGE}`)

// ----- verify: deploy evidence for the merge commit -----
if (STAGE === 'verify') {
  if (!TARGETS.length) return finish('done', 'merged; the deploy configuration lists no targets')
  phase('Watch')
  const snap = await runNode('watch', `watch #${VERIFY_ROUND}`, watchPrompt(TARGETS), WATCH_SCHEMA)
  if (!snap) return finish('escalate', nodeFailure('watch'))
  const byName = new Map(snap.targets.map(t => [t.name, t]))
  const priorFail = new Set(PRIOR.filter(t => t.health === 'FAIL').map(t => t.name))
  const timedOut = VERIFY_ROUND >= MAX_VERIFY_ROUNDS
  for (const t of TARGETS) {
    // A target the watcher did not report on has no evidence, never a pass.
    const r = byName.get(t.name) || { name: t.name, evidence: 'NO_EVIDENCE', health: 'NOT_CONFIGURED', detail: 'not reported by the deploy watcher' }
    let verdict
    if (r.evidence === 'FAILED') verdict = 'DEPLOY-FAILED'
    else if (r.health === 'FAIL') verdict = priorFail.has(t.name) ? 'BROKEN' : 'PENDING'   // two consecutive failures, never one
    else if (r.evidence === 'PENDING') verdict = 'PENDING'
    else if (r.evidence === 'MATCHED') verdict = 'DEPLOYED'
    else verdict = 'UNVERIFIED'
    if (verdict === 'PENDING' && timedOut) verdict = 'UNVERIFIED'
    ledger.deploy.push({ name: t.name, evidence: r.evidence, health: r.health, verdict, detail: r.detail })
  }
  ledger.history.push({ node: 'watch', round: VERIFY_ROUND, verdicts: ledger.deploy.map(d => `${d.name}:${d.verdict}`) })
  for (const d of ledger.deploy) {
    if (d.verdict === 'DEPLOYED' && d.health === 'NOT_CONFIGURED') ledger.warnings.push(`${d.name}: deployed, but no health check is configured`)
  }
  const pending = ledger.deploy.filter(d => d.verdict === 'PENDING')
  if (pending.length) {
    ledger.wait_for = pending.map(d => ({ kind: 'deploy', target: d.name, sha: MERGE_SHA }))
    return finish('waiting', `waiting on ${pending.map(d => d.name).join(', ')}`)
  }
  const bad = ledger.deploy.filter(d => d.verdict === 'DEPLOY-FAILED' || d.verdict === 'BROKEN')
  if (bad.length) {
    phase('Advise')
    const advice = await runNode('advise', 'advise: failed release', advisePrompt(bad), ADVISE_SCHEMA)
    if (!advice) return finish('escalate', nodeFailure('advise', 'on the failed deploy'))
    ledger.advice = advice
    ledger.history.push({ node: 'advise', action: advice.action })
    if (advice.action === 'rollback') return finish('rollback-recommended', `advisor: ${advice.diagnosis}`)
    return finish('done-with-concerns', `${bad.map(d => `${d.name} ${d.verdict}`).join(', ')}; advisor: ${advice.diagnosis}`)
  }
  const unverified = ledger.deploy.filter(d => d.verdict === 'UNVERIFIED')
  if (unverified.length) {
    return finish('done-with-concerns', `merged; could not verify that ${unverified.map(d => d.name).join(', ')} deployed this commit`)
  }
  return finish('done', `merged and deployed: ${ledger.deploy.map(d => d.name).join(', ')}`)
}

// ----- land: merge the approved head, once -----
if (STAGE === 'land') {
  const snap = await snapshot('check: before merge')
  if (!snap) return finish('escalate', nodeFailure('check'))
  if (snap.pr.state === 'MERGED') {
    // Merged by an earlier run or by a person: never merge again; continue from its merge commit.
    if (!snap.pr.mergeCommit) return finish('escalate', 'the pull request is MERGED but GitHub reported no merge commit')
    ledger.merge = { outcome: 'MERGED', merge_sha: snap.pr.mergeCommit, by_this_attempt: false, detail: 'already merged before this run; merger not called' }
    return finish('merged', `already merged as ${snap.pr.mergeCommit}`)
  }
  if (snap.pr.headRefOid !== APPROVAL.head || snap.pr.baseRefName !== APPROVAL.base) {
    return finish('stale', `the approval was for ${APPROVAL.head} into ${APPROVAL.base}; the pull request is now ${snap.pr.headRefOid} into ${snap.pr.baseRefName}`)
  }
  ledger.blockers = baseBlockers(snap)
  const pending = pendingChecks(snap)
  if (pending.length) ledger.blockers.push(`checks still running on the approved head: ${pending.join(', ')}`)
  const gate = mergeGateBlocker(snap)
  if (gate) ledger.blockers.push(gate)
  const method = mergeMethod(snap)
  if (!method) ledger.blockers.push(`no usable merge method: config says "${snap.deploy.merge_method}", the repo allows ${json(snap.merge_methods)}`)
  if (ledger.blockers.length) return finish('blocked', ledger.blockers.join('; '))

  phase('Merge')
  const merged = await runNode('merge', `merge #${PR}`, mergePrompt(method), MERGE_SCHEMA)
  if (!merged) return finish('escalate', `${nodeFailure('merge')}; the merge may or may not have happened: read the pull request before anything else`)
  ledger.merge = merged
  ledger.history.push({ node: 'merge', outcome: merged.outcome, by_this_attempt: merged.by_this_attempt })
  if (merged.outcome === 'MERGED' && merged.merge_sha) return finish('merged', `merged as ${merged.merge_sha}`)
  return finish('escalate', `merge ${merged.outcome}: ${merged.detail}`)
}

// ----- docs and ready: read the PR -----
const snap = await snapshot(`check: ${STAGE}`)
if (!snap) return finish('escalate', nodeFailure('check'))
ledger.blockers = baseBlockers(snap)
if (ledger.blockers.length) return finish('blocked', ledger.blockers.join('; '))

if (STAGE === 'docs') {
  if (snap.deploy.source !== 'config') {
    ledger.proposal = snap.deploy
    return finish('needs-config', snap.deploy.source === 'proposal'
      ? 'no ## Deploy Configuration in CLAUDE.md; a proposal is attached for you to confirm'
      : 'no ## Deploy Configuration in CLAUDE.md and nothing to propose; write one (an empty targets list if this repo never deploys)')
  }
  phase('Docs')
  const docs = await runNode('docs', `docs #${PR}`, docsPrompt(snap), DOCS_SCHEMA)
  if (!docs) return finish('escalate', nodeFailure('docs'))
  ledger.docs = docs
  ledger.history.push({ node: 'docs', touched: docs.touched.length })
  return finish('docs-ready', docs.touched.length ? `docs updated: ${docs.touched.join(', ')}` : 'no docs needed changes')
}

// ready
const pending = pendingChecks(snap)
if (pending.length) {
  ledger.wait_for = [{ kind: 'ci', pr: PR, head: snap.pr.headRefOid, checks: pending }]
  return finish('waiting', `checks still running on ${snap.pr.headRefOid}: ${pending.join(', ')}`)
}
const gate = mergeGateBlocker(snap)
if (gate) ledger.blockers.push(gate)
if (!mergeMethod(snap)) ledger.blockers.push(`no usable merge method: config says "${snap.deploy.merge_method}", the repo allows ${json(snap.merge_methods)}`)
if (ledger.blockers.length) return finish('blocked', ledger.blockers.join('; '))
if (!snap.checks.length) ledger.warnings.push('no checks ran on the head commit')
for (const c of snap.deploy.missing_credentials) ledger.warnings.push(`deploy verification needs ${c}, which is not set; those targets will be reported UNVERIFIED`)
return finish('ready-to-merge', `#${PR} at ${snap.pr.headRefOid} into ${snap.pr.baseRefName} is ready; approve this exact head to merge`)
