// release-flow.test.mjs — routing tests for the release-flow graph against
// scripted agents. Run by scripts/test-workflow.mjs.
import { readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, load, run, agentField } from '../../../scripts/workflow-harness.mjs'

// ---------- fixtures ----------
const HEAD = 'abc1234'
const MERGE_SHA = 'def5678'
const T1 = { name: 'backend', workflow: 'deploy.yml', status_command: '', health: 'https://example.test/health expect 200' }
const T2 = { name: 'frontend', workflow: '', status_command: 'deployctl status', health: '' }
const snapOf = (o = {}) => ({
  pr: {
    number: 271, state: o.state || 'OPEN', headRefOid: o.head || HEAD, headRefName: 'feat/x', baseRefName: o.base || 'main',
    mergeStateStatus: o.mergeState || 'CLEAN', reviewDecision: o.review ?? 'APPROVED', isDraft: o.draft || false, mergeCommit: o.mergeCommit || '',
  },
  default_branch: 'main',
  merge_methods: o.methods || ['squash', 'merge'],
  checks: o.checks || [{ name: 'ci', bucket: 'pass' }],
  deploy: { source: o.source || 'config', merge_method: o.method || 'squash', targets: o.targets || [T1], missing_credentials: o.creds || [] },
})
const DOCS = { touched: ['changelogs/2026-10-30.md'], summary: 's', for_human: [], release_notes: 'Assessments now show a progress bar.' }
const MERGED = { outcome: 'MERGED', merge_sha: MERGE_SHA, by_this_attempt: true, detail: 'merged' }
const APPROVAL = { pr: 271, head: HEAD, base: 'main' }
const A = (stage, extra = {}) => ({ repo: '/tmp/r', pr: 271, stage, ...extra })
const watched = (...targets) => ({ targets })
const tgt = (name, evidence, health = 'OK') => ({ name, evidence, health, detail: `${name} ${evidence} ${health}` })
const types = calls => calls.map(c => c.agentType).join(',')

const here = dirname(fileURLToPath(import.meta.url))
const wfFile = join(here, '..', 'workflows', 'release-flow.js')
const { meta, fn, src } = load(wfFile)

console.log('== release-flow: shape')
await test('meta is a pure literal with name matching the filename', () => {
  assert.equal(meta.name, basename(wfFile, '.js'))
  assert.ok(meta.description.length > 10)
})
await test('every phase() title used in the script is declared in meta.phases', () => {
  const declared = new Set(meta.phases.map(p => p.title))
  const used = [...src.matchAll(/phase\('([^']+)'\)|phase: '([^']+)'/g)].map(m => m[1] || m[2])
  for (const t of used) assert.ok(declared.has(t), `phase '${t}' not in meta.phases`)
})
await test('helpers marked shared are identical to harness-repair.js', () => {
  const qa = readFileSync(join(here, '..', '..', 'qa', 'workflows', 'harness-repair.js'), 'utf8')
  const blockOf = (text, start) => {
    const m = text.match(start)
    assert.ok(m, `not found: ${start}`)
    return text.slice(m.index, text.indexOf('\n}\n', m.index) + 3)
  }
  for (const start of [/^function finish\(/m, /^\/\/ Returns the node's structured result/m, /^function nodeFailure\(/m, /^function addUnique\(/m]) {
    assert.equal(blockOf(src, start), blockOf(qa, start), `shared block drifted: ${start}`)
  }
})
await test('every node pins agentType + model + effort at high, matching the agent files and meta.phases', async () => {
  const declared = Object.fromEntries(meta.phases.map(p => [p.title, p.model]))
  const runs = [
    await run(fn, { 'release-checker': [snapOf()], scribe: [DOCS] }, A('docs')),
    await run(fn, { 'release-checker': [snapOf()], merger: [MERGED] }, A('land', { approval: APPROVAL })),
    await run(fn, { 'deploy-watcher': [watched(tgt('backend', 'FAILED'))], advisor: [{ action: 'rollback', diagnosis: 'd', evidence: 'e' }] }, A('verify', { mergeSha: MERGE_SHA, targets: [T1] })),
  ]
  const seen = new Set()
  for (const c of runs.flatMap(r => r.calls)) {
    assert.equal(c.model, agentField(c.agentType, 'model'), `${c.agentType}: model drift`)
    assert.equal(c.effort, agentField(c.agentType, 'effort'), `${c.agentType}: effort drift`)
    assert.equal(c.effort, 'high')
    assert.equal(c.model, declared[c.phase], `phase ${c.phase}: meta says ${declared[c.phase]}, node runs ${c.model}`)
    assert.ok(c.schema && c.schema.type === 'object')
    seen.add(c.agentType)
  }
  assert.deepEqual([...seen].sort(), ['advisor', 'deploy-watcher', 'merger', 'release-checker', 'scribe'])
})

console.log('== release-flow: land (the irreversible stage)')
await test('an already-merged PR never calls the merger; the run continues from its merge commit', async () => {
  const { result, calls } = await run(fn, { 'release-checker': [snapOf({ state: 'MERGED', mergeCommit: MERGE_SHA })] }, A('land', { approval: APPROVAL }))
  assert.equal(result.status, 'merged')
  assert.equal(types(calls), 'release-checker')
  assert.deepEqual(result.merge, { outcome: 'MERGED', merge_sha: MERGE_SHA, by_this_attempt: false, detail: 'already merged before this run; merger not called' })
  assert.deepEqual(result.targets, [T1], 'targets for verify come back with it')
})
await test('approved head merges once, with the approved head and the configured method', async () => {
  const { result, calls } = await run(fn, {
    'release-checker': [snapOf()],
    merger: [p => { assert.match(p, /#271 at head abc1234 into main with --squash/); assert.match(p, /Never a second attempt/); return MERGED }],
  }, A('land', { approval: APPROVAL }))
  assert.equal(result.status, 'merged')
  assert.equal(result.merge.merge_sha, MERGE_SHA)
  assert.equal(types(calls), 'release-checker,merger')
})
await test('head or base moved since approval -> stale, approval void, no merger', async () => {
  for (const moved of [snapOf({ head: 'fff0000' }), snapOf({ base: 'release' })]) {
    const { result, calls } = await run(fn, { 'release-checker': [moved] }, A('land', { approval: APPROVAL }))
    assert.equal(result.status, 'stale')
    assert.match(result.reason, /the approval was for abc1234 into main/)
    assert.equal(types(calls), 'release-checker')
  }
})
await test('anything short of mergeable at the approved head -> blocked, no merger', async () => {
  for (const [snap, why] of [
    [snapOf({ checks: [{ name: 'ci', bucket: 'pending' }] }), /checks still running on the approved head: ci/],
    [snapOf({ checks: [{ name: 'ci', bucket: 'fail' }] }), /checks failing on the head commit: ci/],
    [snapOf({ mergeState: 'BLOCKED', review: 'REVIEW_REQUIRED' }), /mergeStateStatus BLOCKED \(reviewDecision REVIEW_REQUIRED\)/],
    [snapOf({ method: 'rebase' }), /no usable merge method: config says "rebase"/],
    [snapOf({ state: 'CLOSED' }), /the pull request is CLOSED/],
  ]) {
    const { result, calls } = await run(fn, { 'release-checker': [snap] }, A('land', { approval: APPROVAL }))
    assert.equal(result.status, 'blocked')
    assert.match(result.reason, why)
    assert.equal(calls.filter(c => c.agentType === 'merger').length, 0)
  }
})
await test('merger NOT_MERGED or UNKNOWN -> escalate with its detail; never a second merge', async () => {
  for (const outcome of ['NOT_MERGED', 'UNKNOWN']) {
    const { result, calls } = await run(fn, { 'release-checker': [snapOf()], merger: [{ outcome, merge_sha: '', by_this_attempt: false, detail: 'Head branch was modified' }] }, A('land', { approval: APPROVAL }))
    assert.equal(result.status, 'escalate')
    assert.match(result.reason, new RegExp(`merge ${outcome}: Head branch was modified`))
    assert.equal(calls.filter(c => c.agentType === 'merger').length, 1)
  }
})
await test('merger dying -> escalate that warns the merge may have happened', async () => {
  const { result } = await run(fn, { 'release-checker': [snapOf()], merger: [null] }, A('land', { approval: APPROVAL }))
  assert.equal(result.status, 'escalate')
  assert.match(result.reason, /may or may not have happened: read the pull request/)
})
await test('land without a valid approval for this PR -> escalate before any agent runs', async () => {
  for (const approval of [undefined, { pr: 272, head: HEAD, base: 'main' }, { pr: 271, head: '', base: 'main' }, { pr: 271, head: HEAD }]) {
    const { result, calls } = await run(fn, {}, A('land', { approval }))
    assert.equal(result.status, 'escalate')
    assert.equal(calls.length, 0)
  }
})
await test('MERGED with no merge commit reported -> escalate, not a guess', async () => {
  const { result } = await run(fn, { 'release-checker': [snapOf({ state: 'MERGED', mergeCommit: '' })] }, A('land', { approval: APPROVAL }))
  assert.equal(result.status, 'escalate')
})

console.log('== release-flow: docs and ready')
await test('docs: blockers stop the stage before the scribe runs', async () => {
  for (const [snap, why] of [
    [snapOf({ base: 'feat/parent' }), /stacked on feat\/parent; merge that first/],
    [snapOf({ draft: true }), /is a draft/],
    [snapOf({ checks: [{ name: 'lint', bucket: 'cancel' }] }), /checks failing on the head commit: lint/],
  ]) {
    const { result, calls } = await run(fn, { 'release-checker': [snap] }, A('docs'))
    assert.equal(result.status, 'blocked')
    assert.match(result.reason, why)
    assert.equal(types(calls), 'release-checker')
  }
})
await test('docs: no deploy configuration -> needs-config with the proposal, no scribe', async () => {
  const proposal = snapOf({ source: 'proposal', targets: [T2] })
  const { result, calls } = await run(fn, { 'release-checker': [proposal] }, A('docs'))
  assert.equal(result.status, 'needs-config')
  assert.deepEqual(result.proposal.targets, [T2])
  assert.equal(types(calls), 'release-checker')
  const none = await run(fn, { 'release-checker': [snapOf({ source: 'none', targets: [] })] }, A('docs'))
  assert.match(none.result.reason, /an empty targets list if this repo never deploys/)
})
await test('docs: pending checks do not block; the scribe runs and its report comes back', async () => {
  const { result, calls } = await run(fn, {
    'release-checker': [snapOf({ checks: [{ name: 'ci', bucket: 'pending' }] })],
    scribe: [p => { assert.match(p, /#271 \(feat\/x into main\)/); assert.match(p, /Never commit/); return DOCS }],
  }, A('docs'))
  assert.equal(result.status, 'docs-ready')
  assert.deepEqual(result.docs.touched, ['changelogs/2026-10-30.md'])
  assert.equal(types(calls), 'release-checker,scribe')
})
await test('ready: checks still running -> waiting on ci for the exact head', async () => {
  const { result } = await run(fn, { 'release-checker': [snapOf({ checks: [{ name: 'ci', bucket: 'pass' }, { name: 'e2e', bucket: 'pending' }] })] }, A('ready'))
  assert.equal(result.status, 'waiting')
  assert.deepEqual(result.wait_for, [{ kind: 'ci', pr: 271, head: HEAD, checks: ['e2e'] }])
})
await test("ready: GitHub's merge gate closed -> blocked with the review reason", async () => {
  const { result } = await run(fn, { 'release-checker': [snapOf({ mergeState: 'BLOCKED', review: 'CHANGES_REQUESTED' })] }, A('ready'))
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /reviewDecision CHANGES_REQUESTED/)
})
await test('ready: green and mergeable -> ready-to-merge for the exact head, with warnings', async () => {
  const { result } = await run(fn, { 'release-checker': [snapOf({ checks: [], creds: ['RENDER_API_KEY'] })] }, A('ready'))
  assert.equal(result.status, 'ready-to-merge')
  assert.equal(result.head, HEAD)
  assert.equal(result.base, 'main')
  assert.deepEqual(result.warnings, ['no checks ran on the head commit', 'deploy verification needs RENDER_API_KEY, which is not set; those targets will be reported UNVERIFIED'])
})

console.log('== release-flow: verify')
const V = (extra = {}) => A('verify', { mergeSha: MERGE_SHA, targets: [T1], ...extra })
await test('deployed with a passing health check -> done', async () => {
  const { result } = await run(fn, { 'deploy-watcher': [p => { assert.match(p, /merged as def5678/); return watched(tgt('backend', 'MATCHED')) }] }, V())
  assert.equal(result.status, 'done')
  assert.equal(result.deploy[0].verdict, 'DEPLOYED')
})
await test('deployed but no health check configured -> done, with a warning', async () => {
  const { result } = await run(fn, { 'deploy-watcher': [watched(tgt('backend', 'MATCHED', 'NOT_CONFIGURED'))] }, V())
  assert.equal(result.status, 'done')
  assert.deepEqual(result.warnings, ['backend: deployed, but no health check is configured'])
})
await test('still deploying -> waiting on the deploy for the merge commit', async () => {
  const { result } = await run(fn, { 'deploy-watcher': [watched(tgt('backend', 'PENDING', 'NOT_CONFIGURED'))] }, V())
  assert.equal(result.status, 'waiting')
  assert.deepEqual(result.wait_for, [{ kind: 'deploy', target: 'backend', sha: MERGE_SHA }])
})
await test('one failing health check is a recheck, never a verdict', async () => {
  const { result, calls } = await run(fn, { 'deploy-watcher': [watched(tgt('backend', 'MATCHED', 'FAIL'))] }, V())
  assert.equal(result.status, 'waiting')
  assert.equal(calls.filter(c => c.agentType === 'advisor').length, 0)
})
await test('two consecutive failing health checks -> BROKEN -> advisor -> rollback-recommended', async () => {
  const { result } = await run(fn, {
    'deploy-watcher': [watched(tgt('backend', 'MATCHED', 'FAIL'))],
    advisor: [p => { assert.match(p, /Diagnosing a failed release/); assert.match(p, /"verdict": "BROKEN"/); return { action: 'rollback', diagnosis: 'the new route 500s', evidence: 'src/a.js:3' } }],
  }, V({ prior: [{ name: 'backend', health: 'FAIL' }], verifyRound: 2 }))
  assert.equal(result.status, 'rollback-recommended')
  assert.match(result.reason, /the new route 500s/)
})
await test('a failed deploy the advisor does not pin on the change -> done-with-concerns', async () => {
  const { result } = await run(fn, {
    'deploy-watcher': [watched(tgt('backend', 'FAILED', 'NOT_CONFIGURED'))],
    advisor: [{ action: 'investigate', diagnosis: 'ECR login expired', evidence: 'run 42 step 3' }],
  }, V())
  assert.equal(result.status, 'done-with-concerns')
  assert.match(result.reason, /backend DEPLOY-FAILED; advisor: ECR login expired/)
})
await test('no way to tie a target to the commit, or not reported -> UNVERIFIED, never a pass', async () => {
  const { result } = await run(fn, { 'deploy-watcher': [watched(tgt('backend', 'NO_EVIDENCE', 'OK'))] }, V({ targets: [T1, T2] }))
  assert.equal(result.status, 'done-with-concerns')
  assert.deepEqual(result.deploy.map(d => [d.name, d.verdict]), [['backend', 'UNVERIFIED'], ['frontend', 'UNVERIFIED']])
  assert.match(result.deploy[1].detail, /not reported by the deploy watcher/)
})
await test('still pending at the round cap -> UNVERIFIED, so waiting always ends', async () => {
  const { result } = await run(fn, { 'deploy-watcher': [watched(tgt('backend', 'PENDING', 'NOT_CONFIGURED'))] }, V({ verifyRound: 12 }))
  assert.equal(result.status, 'done-with-concerns')
})
await test('no deploy targets configured -> done without a watcher call', async () => {
  const { result, calls } = await run(fn, {}, V({ targets: [] }))
  assert.equal(result.status, 'done')
  assert.equal(calls.length, 0)
})
await test('verify without mergeSha or targets -> escalate before any agent runs', async () => {
  for (const extra of [{ mergeSha: undefined }, { mergeSha: 'not-a-sha' }, { targets: undefined }]) {
    const { result, calls } = await run(fn, {}, V(extra))
    assert.equal(result.status, 'escalate')
    assert.equal(calls.length, 0)
  }
})

console.log('== release-flow: node failures and args')
await test('a node returning null -> escalate naming it, never a crash', async () => {
  for (const [script, a, who] of [
    [{ 'release-checker': [null] }, A('docs'), 'release-checker'],
    [{ 'release-checker': [snapOf()], scribe: [null] }, A('docs'), 'scribe'],
    [{ 'release-checker': [null] }, A('land', { approval: APPROVAL }), 'release-checker'],
    [{ 'deploy-watcher': [null] }, V(), 'deploy-watcher'],
    [{ 'deploy-watcher': [watched(tgt('backend', 'FAILED'))], advisor: [null] }, V(), 'advisor'],
  ]) {
    const { result } = await run(fn, script, a)
    assert.equal(result.status, 'escalate', who)
    assert.match(result.reason, new RegExp(who), who)
  }
})
await test('missing or bad repo, pr, or stage -> escalate before any agent runs', async () => {
  for (const a of [undefined, {}, { pr: 271, stage: 'docs' }, { repo: '/r', stage: 'docs' }, { repo: '/r', pr: '271', stage: 'docs' }, { repo: '/r', pr: 271 }, { repo: '/r', pr: 271, stage: 'ship' }]) {
    const { result, calls } = await run(fn, {}, a)
    assert.equal(result.status, 'escalate')
    assert.equal(calls.length, 0)
  }
})
