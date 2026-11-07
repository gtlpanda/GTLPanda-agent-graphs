// findings.test.mjs — the /bughunt finding record: the candidate bar, stable
// ids across runs, status moves, the disposition, metrics, the report, and the
// CLI (core/skills/findings/findings.mjs).
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import {
  candidateProblems, mergeFindings, transition, sameFinding, disposition, metrics, renderReport, ledgerProblems,
  emptyLedger, readLedger, writeLedger, saveRun, missingEvidence, readEvidence, reconcile, reconcileFix, UNREPRODUCED_CAP,
} from '../core/skills/findings/findings.mjs'

const SCRIPT = join(REPO, 'core', 'skills', 'findings', 'findings.mjs')
const CAND = (extra = {}) => ({
  file_path: 'src/cart.js', line_range: [10, 12], bug_category: 'logic', severity: 'HIGH', confidence: 85,
  title: 'Discount applied twice when the cart has one item', description: 'd',
  failure_scenario: { trigger: 'a cart with one item', path: 'src/cart.js:10 total() loops twice', observable: 'total is negative' },
  expected_behavior: 'one discount', actual_behavior: 'two discounts',
  evidence: [{ file: 'src/cart.js', line: 11, quote: 'total -= discount' }], source_agent: 'hunter:logic', ...extra,
})
const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const tmp = () => mkdtempSync(join(tmpdir(), 'findings-test-'))
const cli = (...a) => spawnSync('node', [SCRIPT, ...a], { encoding: 'utf8' })

console.log('== findings: the candidate bar')
await test('a complete candidate passes', () => assert.deepEqual(candidateProblems(CAND()), []))
await test('a candidate without its trigger, path, or observable result is rejected, naming the missing part', () => {
  for (const k of ['trigger', 'path', 'observable']) {
    const c = CAND({ failure_scenario: { ...CAND().failure_scenario, [k]: ' ' } })
    assert.ok(candidateProblems(c).some(p => p.includes(`failure_scenario.${k}`)), k)
  }
})
await test('evidence must be a quote at file:line; an empty list or a line 0 is rejected', () => {
  assert.ok(candidateProblems(CAND({ evidence: [] })).length)
  assert.ok(candidateProblems(CAND({ evidence: [{ file: 'a', line: 0, quote: 'x' }] })).length)
  assert.ok(candidateProblems(CAND({ evidence: [{ file: 'a', line: 3, quote: '' }] })).length)
})
await test('paths must be repo-relative, ranges ordered, categories and severities from the lists', () => {
  assert.ok(candidateProblems(CAND({ file_path: '/etc/passwd' })).length)
  assert.ok(candidateProblems(CAND({ file_path: 'src/../../x' })).length)
  assert.ok(candidateProblems(CAND({ line_range: [12, 10] })).length)
  assert.ok(candidateProblems(CAND({ line_range: [10] })).length)
  assert.ok(candidateProblems(CAND({ bug_category: 'style' })).length)
  assert.ok(candidateProblems(CAND({ severity: 'BLOCKER' })).length)
  assert.ok(candidateProblems(CAND({ confidence: 85.5 })).length)
  assert.ok(candidateProblems(CAND({ confidence: '90' })).length)
})
await test('non-objects are rejected without throwing', () => {
  for (const v of [null, undefined, 0, 'x', []]) assert.deepEqual(candidateProblems(v), ['the candidate is not an object'])
})

console.log('== findings: stable ids')
await test('new findings get F1, F2 in order; confidence is capped until a test reproduces them', () => {
  const r = mergeFindings([], [CAND({ confidence: 95 }), CAND({ file_path: 'src/b.js', title: 'other' })], H1)
  assert.deepEqual(r.added, ['F1', 'F2'])
  assert.equal(r.findings[0].confidence, UNREPRODUCED_CAP)
  assert.equal(r.findings[0].verification_status, 'candidate')
  assert.equal(r.findings[0].fix_status, 'none')
  assert.equal(r.findings[0].head, H1)
})
await test('two hunters reporting one bug in one run make one finding with both sources and one duplicate', () => {
  const r = mergeFindings([], [CAND(), CAND({ source_agent: 'hunter:regression', bug_category: 'regression', title: 'Discount applied twice for single-item carts', line_range: [11, 11] })], H1)
  assert.equal(r.findings.length, 1)
  assert.deepEqual(r.findings[0].sources, ['hunter:logic', 'hunter:regression'])
  assert.equal(r.findings[0].duplicates, 1)
})
await test('a re-run on the same head keeps the id, adds no duplicate, and changes no status', () => {
  const first = mergeFindings([], [CAND()], H1).findings
  transition(first[0], 'verification_status', 'confirmed', 'skeptic')
  const again = mergeFindings(first, [CAND()], H1)
  assert.deepEqual(again.added, [])
  assert.equal(again.findings.length, 1)
  assert.equal(again.findings[0].finding_id, 'F1')
  assert.equal(again.findings[0].duplicates, 0)
  assert.equal(again.findings[0].verification_status, 'confirmed')
})
await test('a new head clears what belonged to the old one: the reproduction, test results, fix, and confidence above the cap', () => {
  const first = mergeFindings([], [CAND()], H1).findings
  Object.assign(first[0], { verification_status: 'reproduced', confidence: 95, reproduction_artifact: { written: true, test_file: 't.test.js', verdict: 'REPRODUCED' }, test_results: [{ exit: 1 }], fix_status: 'verified', fix_artifact: { commit: 'x' } })
  const f = mergeFindings(first, [CAND()], H2).findings[0]
  assert.deepEqual([f.reproduction_artifact, f.test_results, f.fix_status, f.fix_artifact, f.confidence, f.verification_status], [null, [], 'none', null, 79, 'candidate'])
})
await test('a new head moves a re-found finding to the new lines and back to candidate, keeping its id', () => {
  const first = mergeFindings([], [CAND()], H1).findings
  transition(first[0], 'verification_status', 'confirmed', 'skeptic')
  const next = mergeFindings(first, [CAND({ line_range: [14, 16] })], H2)
  assert.equal(next.findings[0].finding_id, 'F1')
  assert.deepEqual(next.findings[0].line_range, [14, 16])
  assert.equal(next.findings[0].head, H2)
  assert.equal(next.findings[0].verification_status, 'candidate')
  assert.equal(next.findings[0].stale, false)
})
await test('a refuted finding stays refuted when a new head re-finds it', () => {
  const first = mergeFindings([], [CAND()], H1).findings
  transition(first[0], 'verification_status', 'refuted', 'guarded upstream')
  assert.equal(mergeFindings(first, [CAND()], H2).findings[0].verification_status, 'refuted')
})
await test('findings a new head did not re-find are marked stale; ids are never reused', () => {
  const first = mergeFindings([], [CAND(), CAND({ file_path: 'src/b.js', title: 'other' })], H1).findings
  const next = mergeFindings(first, [CAND({ file_path: 'src/c.js', title: 'third' })], H2)
  assert.deepEqual(next.findings.map(f => [f.finding_id, f.stale]), [['F1', true], ['F2', true], ['F3', false]])
})
await test('same file but far apart and differently titled are two findings; a different file never merges', () => {
  assert.equal(sameFinding(CAND(), CAND({ line_range: [80, 81], title: 'Unrelated overflow in tax' })), false)
  assert.equal(sameFinding(CAND(), CAND({ file_path: 'src/other.js' })), false)
  assert.equal(sameFinding(CAND(), CAND({ line_range: [80, 81], evidence: [{ file: 'src/cart.js', line: 80, quote: 'other line' }] })), false, 'the same title far apart, different code: two bugs')
  assert.equal(sameFinding(CAND(), CAND({ line_range: [80, 81] })), true, 'the same title, category, and quoted code moved by a new head: one bug')
  assert.equal(sameFinding(CAND(), CAND({ line_range: [80, 81], bug_category: 'errors' })), false, 'far apart and another category')
  assert.equal(sameFinding(CAND(), CAND({ line_range: [16, 18], title: 'Unrelated overflow in tax' })), true, 'near and the same category')
  assert.equal(sameFinding(CAND(), CAND({ line_range: [16, 18], bug_category: 'errors', title: 'Unrelated overflow in tax' })), false)
})
await test('merging keeps the higher severity and confidence', () => {
  const first = mergeFindings([], [CAND({ severity: 'MEDIUM', confidence: 65 })], H1).findings
  const next = mergeFindings(first, [CAND({ severity: 'CRITICAL', confidence: 70, source_agent: 'hunter:security' })], H1)
  assert.equal(next.findings[0].severity, 'CRITICAL')
  assert.equal(next.findings[0].confidence, 70)
})

console.log('== findings: status moves')
await test('allowed moves record history; others throw and leave the finding unchanged', () => {
  const f = mergeFindings([], [CAND()], H1).findings[0]
  transition(f, 'verification_status', 'confirmed', 'why')
  transition(f, 'verification_status', 'reproduced', 'test failed at head, passed at the merge-base')
  assert.equal(f.history.length, 2)
  assert.throws(() => transition(f, 'verification_status', 'candidate', 'x'), /cannot move from reproduced to candidate/)
  assert.throws(() => transition(f, 'fix_status', 'verified', 'x'), /cannot move from none to verified/)
  assert.throws(() => transition(f, 'severity', 'LOW', 'x'), /severity cannot move/)
  assert.equal(f.verification_status, 'reproduced')
})

console.log('== findings: disposition')
const ledgerWith = (fs, coverage = []) => ({ ...emptyLedger('pr-7'), findings: fs, coverage })
const F = (status, severity = 'HIGH', extra = {}) => ({ ...mergeFindings([], [CAND({ severity })], H1).findings[0], verification_status: status, ...extra })
await test('pass with no findings; changes requested for an open reproduced or confirmed bug above LOW', () => {
  assert.equal(disposition(ledgerWith([])).disposition, 'pass')
  assert.deepEqual(disposition(ledgerWith([F('reproduced')])), { disposition: 'changes_requested', because: ['F1'] })
  assert.equal(disposition(ledgerWith([F('confirmed', 'MEDIUM')])).disposition, 'changes_requested')
  assert.equal(disposition(ledgerWith([F('reproduced', 'LOW')])).disposition, 'pass')
})
await test('a run that stopped early is manual review, whatever its findings', () => {
  assert.deepEqual(disposition({ ...ledgerWith([]), status: 'escalate', reason: 'hunter failed' }), { disposition: 'manual_review', because: ['the last run stopped: hunter failed'] })
})
await test('a partly covered lens is manual review, not pass', () => {
  assert.deepEqual(disposition(ledgerWith([], [{ lens: 'logic', status: 'partial' }])), { disposition: 'manual_review', because: ['logic partly covered'] })
})
await test('manual review for an unsettled HIGH or CRITICAL, or a lens not covered', () => {
  for (const s of ['candidate', 'contested', 'not_reproduced']) assert.equal(disposition(ledgerWith([F(s)])).disposition, 'manual_review', s)
  assert.equal(disposition(ledgerWith([F('candidate', 'MEDIUM')])).disposition, 'pass')
  assert.deepEqual(disposition(ledgerWith([], [{ lens: 'security', status: 'not_covered' }])), { disposition: 'manual_review', because: ['security not covered'] })
})
await test('refuted, pre-existing, and stale findings are never open; a verified fix does not close a finding (it is not in the PR yet)', () => {
  assert.equal(disposition(ledgerWith([F('refuted'), F('preexisting'), F('reproduced', 'HIGH', { stale: true })])).disposition, 'pass')
  assert.equal(disposition(ledgerWith([F('reproduced', 'HIGH', { fix_status: 'verified' })])).disposition, 'changes_requested')
})

console.log('== findings: metrics')
await test('rates and precision against ground truth count only confirmed or reproduced findings', () => {
  const l = ledgerWith([
    F('reproduced'), F('reproduced', 'HIGH', { finding_id: 'F2', file_path: 'src/x.js' }), F('refuted', 'HIGH', { finding_id: 'F3' }),
    F('not_reproduced', 'HIGH', { finding_id: 'F4' }), F('candidate', 'HIGH', { finding_id: 'F5', duplicates: 2 }),
  ])
  const m = metrics(l, { bugs: [{ file_path: 'src/cart.js', line_range: [11, 11] }, { file_path: 'src/missed.js', line_range: [1, 2] }, { file_path: 'src/also-missed.js', line_range: [3, 3] }] })
  assert.equal(m.findings, 5)
  assert.equal(m.reproduction_rate, 0.667)
  assert.equal(m.true_positives, 1)
  assert.equal(m.false_positives, 1)
  assert.equal(m.precision, 0.5)
  assert.equal(m.recall, 0.333, 'one of three true bugs found')
  assert.equal(m.duplicates, 2)
  assert.equal(m.fix_validation_rate, null)
})
await test('a clean case: no true bugs, nothing reported, precision and recall are null, not 0 or 1', () => {
  const m = metrics(ledgerWith([F('refuted')]), { bugs: [] })
  assert.equal(m.false_positives, 0)
  assert.equal(m.precision, null)
  assert.equal(m.recall, null)
})

console.log('== findings: report')
await test('confirmed and unverified findings are in separate sections; test runs only come from evidence files', () => {
  const l = { ...ledgerWith([F('reproduced', 'HIGH', { reproduction_artifact: { written: true, test_file: 't/a.test.js', verdict: 'REPRODUCED', reason: 'r' } }), F('candidate', 'HIGH', { finding_id: 'F2', file_path: 'src/y.js', title: 'Maybe a race', test_results: [{ exit: 1, verdict: 'CLAIMED' }] })]), target: { label: 'PR #7: cart', mergeBase: H1, head: H2, base: 'origin/main' } }
  const md = renderReport(l, { F1: { head: H2, test_file: 't/a.test.js', runs: [{ arm: 'head', exit: 1, verdict: 'REPRODUCED' }] }, F2: { head: H2, test_file: 'x', runs: [{ arm: 'head', exit: 1, verdict: 'NOT FOR F2' }] } })
  const confirmed = md.slice(md.indexOf('## Confirmed bugs'), md.indexOf('## Unverified'))
  const unverified = md.slice(md.indexOf('## Unverified'), md.indexOf('## Pre-existing'))
  assert.match(confirmed, /F1 \[HIGH\]/)
  assert.doesNotMatch(confirmed, /F2/)
  assert.match(unverified, /F2 \[HIGH\] Maybe a race/)
  assert.match(md, /Test run:\*\* head: exit 1, REPRODUCED/)
  assert.doesNotMatch(md, /CLAIMED/, 'a test result the run claimed never reaches the report')
  assert.match(md, /Disposition: \*\*changes requested\*\* \(F1\)/)
  assert.match(md, /Commits: aaaaaaa\.\.bbbbbbb/)
  assert.doesNotMatch(md, /NOT FOR F2/, 'evidence for a finding with no written reproduction is never shown')
})
await test('the report shows evidence only from this head and this finding\'s own test, and says when it is static only', () => {
  const ra = { written: true, test_file: 't/a.test.js', verdict: 'ERROR', reason: 'timed out' }
  const l = { ...ledgerWith([F('confirmed', 'HIGH', { reproduction_artifact: ra }), F('confirmed', 'HIGH', { finding_id: 'F2', file_path: 'b.js', reproduction_artifact: { written: true, test_file: 't/b.test.js', verdict: null, reason: 'the runner returned nothing' } })]), target: { label: 'x', mergeBase: H1, head: H2, base: 'main' } }
  const md = renderReport(l, { F1: { head: H1, test_file: 't/a.test.js', runs: [{ arm: 'head', exit: 1, verdict: 'OLD HEAD RUN' }] }, F2: { head: H2, test_file: 't/other.test.js', runs: [{ arm: 'head', exit: 1, verdict: 'OTHER TEST RUN' }] } })
  assert.doesNotMatch(md, /OLD HEAD RUN|OTHER TEST RUN/)
  assert.match(md, /Reproduction:\*\* ERROR: timed out \(`t\/a\.test\.js`\)\. Static evidence only\./)
  assert.match(md, /Reproduction:\*\* attempted \(`t\/b\.test\.js`\), no verdict: the runner returned nothing\. Static evidence only\./)
})

console.log('== findings: reconcile')
await test('reconcile moves a status to what the runs show, fills test_results from the runs, and sets confidence', () => {
  const run = (arm, exit, marker) => ({ kind: 'repro', arm, sha: H1, exit, timedOut: false, marker, error: null, tail: 'long output' })
  const l = ledgerWith([
    F('not_reproduced', 'HIGH', { confidence: 60, test_results: [{ exit: 0, verdict: 'CLAIMED BY AN AGENT' }] }),
    F('reproduced', 'HIGH', { finding_id: 'F2', confidence: 95 }),
    F('refuted', 'HIGH', { finding_id: 'F3' }),
    F('confirmed', 'HIGH', { finding_id: 'F4', confidence: 70 }),
  ])
  const { ledger, corrected } = reconcile(l, {
    F1: { verdict: 'REPRODUCED', reason: 'r1', runs: [run('head', 1, true), run('merge-base', 0, false)] },
    F2: { verdict: 'ERROR', reason: 'timed out', runs: [] },
    F3: { verdict: 'REPRODUCED', reason: 'r3', runs: [] },
    F4: { verdict: 'REPRODUCED', reason: 'r4', runs: [run('head', 1, true)] },
  })
  const [a, b, c, d] = ledger.findings
  assert.deepEqual(corrected, [{ finding_id: 'F1', from: 'not_reproduced', to: 'reproduced' }, { finding_id: 'F2', from: 'reproduced', to: 'confirmed' }, { finding_id: 'F4', from: 'confirmed', to: 'reproduced' }])
  assert.equal(a.confidence, 90)
  assert.deepEqual(a.test_results, [{ kind: 'repro', arm: 'head', sha: H1, exit: 1, timedOut: false, marker: true, error: null }, { kind: 'repro', arm: 'merge-base', sha: H1, exit: 0, timedOut: false, marker: false, error: null }])
  assert.equal(b.verification_status, 'confirmed', 'evidence that is gone takes the claim back to static evidence')
  assert.equal(b.confidence, 79)
  assert.equal(c.verification_status, 'refuted', 'what the skeptic or referee settled is never touched')
  assert.equal(d.reproduction_artifact.verdict, 'REPRODUCED')
  assert.equal(a.history.at(-1).why, 'evidence recheck: r1')
  assert.equal(l.findings[0].verification_status, 'not_reproduced', 'the input ledger is not mutated')
})

await test('reconcileFix takes back a committed repair that no longer proves out, and leaves the rest alone', () => {
  const l = ledgerWith([
    F('reproduced', 'HIGH', { fix_status: 'verified', fix_artifact: { commit: 'a'.repeat(40) } }),
    F('reproduced', 'HIGH', { finding_id: 'F2', fix_status: 'proposed', fix_artifact: { commit: 'b'.repeat(40) } }),
    F('reproduced', 'HIGH', { finding_id: 'F3', fix_status: 'verified' }),
  ])
  const { ledger, corrected } = reconcileFix(l, { F1: { verdict: 'FAIL', reason: 'at the fix commit the reproduction does not pass' }, F2: { verdict: 'PASS', reason: 'ok' } })
  assert.deepEqual(corrected, [{ finding_id: 'F1', from: 'fix verified', to: 'fix rejected' }])
  assert.deepEqual(ledger.findings.map(f => f.fix_status), ['rejected', 'proposed', 'verified'])
  assert.equal(ledger.findings[0].history.at(-1).why, 'evidence recheck: at the fix commit the reproduction does not pass')
  assert.equal(l.findings[0].fix_status, 'verified', 'the input is not mutated')
})
await test('the report says what each fix status means: verified, proposed (no verifier), unresolved', () => {
  const l = { ...ledgerWith([
    F('reproduced', 'HIGH', { fix_status: 'verified', fix_artifact: { commit: 'c'.repeat(40), branch: 'bughunt/pr-7', attempts: 2 } }),
    F('reproduced', 'HIGH', { finding_id: 'F2', file_path: 'b.js', fix_status: 'proposed', fix_artifact: { commit: 'd'.repeat(40) } }),
    F('reproduced', 'HIGH', { finding_id: 'F3', file_path: 'c.js', fix_status: 'unresolved', fix_artifact: { attempts: 2, last_feedback: 'breaks the suite' } }),
  ]), target: { label: 'x', head: H2, mergeBase: H1, base: 'main' } }
  const md = renderReport(l, {})
  assert.match(md, /Fix:\*\* verified and committed in `cccccccccccc` on `bughunt\/pr-7` \(attempt 2\)/)
  assert.match(md, /Fix:\*\* proposed in `dddddddddddd`: it passed the fix check, but no independent verifier has reviewed it\./)
  assert.match(md, /Fix:\*\* unresolved after 2 attempt\(s\): breaks the suite\./)
  assert.match(md, /Disposition: \*\*changes requested\*\* \(F1, F2, F3\)/, 'a fix on a side branch closes nothing in the PR')
  assert.match(md, /It is not in the PR until someone merges it there\./)
})

console.log('== findings: grounding')
await test('missingEvidence finds a quote near its cited line, and flags a quote that is not there', () => {
  const file = ['a', 'b', 'c', 'total -= discount', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
  const f = { evidence: [{ file: 'src/cart.js', line: 5, quote: 'total  -=   discount' }, { file: 'src/cart.js', line: 9, quote: 'total -= discount' }, { file: 'gone.js', line: 1, quote: 'x' }] }
  assert.deepEqual(missingEvidence(f, p => (p === 'src/cart.js' ? file : null)), ['src/cart.js:9', 'gone.js:1'])
})

console.log('== findings: the ledger and the CLI')
await test('writeLedger refuses an unsound ledger; readLedger round-trips a sound one and returns empty when missing', () => {
  const d = tmp()
  const path = join(d, 'sub', 'ledger.json')
  assert.deepEqual(readLedger(path, 'pr-7'), emptyLedger('pr-7'))
  const l = ledgerWith(mergeFindings([], [CAND()], H1).findings)
  writeLedger(path, l)
  assert.deepEqual(readLedger(path, 'pr-7'), l)
  assert.throws(() => writeLedger(path, { ...l, findings: [{ ...l.findings[0], verification_status: 'maybe' }] }), /unsound/)
  assert.throws(() => writeLedger(path, { ...l, findings: [l.findings[0], l.findings[0]] }), /F1 appears twice/)
  writeFileSync(path, '{not json')
  assert.throws(() => readLedger(path, 'pr-7'), /not valid JSON/)
})
await test('saveRun replaces the findings, keeps the last 20 runs, and stamps the head', () => {
  let l = emptyLedger('pr-7')
  const intake = { key: 'pr-7', target: { head: H1, label: 'x' } }
  for (let i = 0; i < 22; i += 1) l = saveRun(l, intake, { status: 'done', findings: mergeFindings([], [CAND()], H1).findings, history: [1, 2] }, `t${i}`)
  assert.equal(l.runs.length, 20)
  assert.equal(l.runs[19].at, 't21')
  assert.equal(l.runs[19].head, H1)
  assert.equal(l.runs[19].calls, 2)
  assert.equal(l.findings.length, 1)
  assert.throws(() => saveRun(l, intake, { status: 'done' }, 't'), /no findings list/)
})
await test('saveRun records how long the run took (from --started) and where a token budget stopped it', () => {
  const intake = { key: 'pr-7', target: { head: H1, label: 'x' } }
  const l = saveRun(emptyLedger('pr-7'), intake, { status: 'done', findings: [], budgetStop: 'Reproduce' }, '2026-11-06T10:05:30.000Z', '2026-11-06T10:00:00Z')
  assert.equal(l.runs[0].duration_s, 330)
  assert.equal(l.runs[0].budget_stop, 'Reproduce')
  assert.equal(saveRun(emptyLedger('pr-7'), intake, { status: 'done', findings: [] }, 't', 'not a time').runs[0].duration_s, null)
})
await test('saveRun: a run that stopped early never replaces the findings, coverage, or target; it records the stop', () => {
  const intake = { key: 'pr-7', target: { head: H1, label: 'first' } }
  const kept = saveRun(emptyLedger('pr-7'), intake, { status: 'done', findings: mergeFindings([], [CAND()], H1).findings, coverage: [{ lens: 'logic', status: 'covered' }] }, 't1')
  const after = saveRun(kept, { key: 'pr-7', target: { head: H2, label: 'second' } }, { status: 'escalate', reason: 'bad args', findings: [], coverage: [] }, 't2')
  assert.equal(after.findings.length, 1)
  assert.deepEqual(after.coverage, kept.coverage)
  assert.equal(after.target.label, 'first')
  assert.equal(after.status, 'escalate')
  assert.equal(after.runs.at(-1).status, 'escalate')
  assert.equal(disposition(after).disposition, 'manual_review')
})
await test('CLI: input, save, check, and report work end to end, also through a symlink', () => {
  const d = tmp()
  const intake = join(d, 'intake.json')
  const result = join(d, 'result.json')
  const ledger = join(d, 'ledger.json')
  writeFileSync(intake, JSON.stringify({ key: 'pr-7', target: { head: H1, mergeBase: H2, label: 'PR #7', base: 'main' } }))
  writeFileSync(result, JSON.stringify({ status: 'done', mode: 'discover', findings: mergeFindings([], [CAND()], H1).findings, coverage: [{ lens: 'logic', status: 'covered' }] }))
  let r = cli('input', ledger, intake, join(d, 'input.json'))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'input.json'), 'utf8')).prior, [])
  r = cli('save', ledger, intake, result, '--started', '2026-11-06T10:00:00Z')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(typeof JSON.parse(readFileSync(ledger, 'utf8')).runs[0].duration_s, 'number')
  assert.match(r.stdout, /FINDINGS: SAVED 1 finding\(s\), disposition manual_review/)
  const link = join(d, 'linked.mjs')
  symlinkSync(SCRIPT, link)
  r = spawnSync('node', [link, 'check', ledger], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /FINDINGS: PASS$/m)
  r = cli('report', ledger)
  assert.match(r.stdout, /# Bug hunt: PR #7/)
  assert.match(r.stdout, /- logic: covered/)
  r = cli('input', ledger, intake, join(d, 'input2.json'))
  assert.equal(JSON.parse(readFileSync(join(d, 'input2.json'), 'utf8')).prior.length, 1)
})
await test('CLI: check fails on a broken ledger and usage errors exit 2', () => {
  const d = tmp()
  writeFileSync(join(d, 'bad.json'), JSON.stringify({ version: 2, key: 'K!', findings: [] }))
  const r = cli('check', join(d, 'bad.json'))
  assert.equal(r.status, 1)
  assert.match(r.stdout, /version must be 1/)
  assert.match(r.stdout, /FINDINGS: FAIL$/m)
  assert.equal(cli().status, 2)
  assert.equal(cli('report').status, 2)
  const missing = cli('report', join(d, 'missing.json'))
  assert.equal(missing.status, 1, 'a missing ledger never reads as a clean PR')
  assert.match(missing.stderr, /no ledger at .*missing\.json/)
})
await test('readEvidence reads F<n>.json files and ignores everything else', () => {
  const d = tmp()
  mkdirSync(join(d, 'ev'))
  writeFileSync(join(d, 'ev', 'F1.json'), JSON.stringify({ runs: [{ exit: 1 }] }))
  writeFileSync(join(d, 'ev', 'F2.json'), '{broken')
  writeFileSync(join(d, 'ev', 'notes.txt'), 'x')
  assert.deepEqual(readEvidence(join(d, 'ev')), { F1: { head: null, test_file: null, runs: [{ exit: 1 }] }, F2: { head: null, test_file: null, runs: [] } })
  assert.deepEqual(readEvidence(join(d, 'missing')), {})
  assert.ok(!existsSync(join(d, 'missing')))
})
await test('ledgerProblems: findings must have F ids, a head, and lists for history and test results', () => {
  const f = mergeFindings([], [CAND()], H1).findings[0]
  assert.deepEqual(ledgerProblems(ledgerWith([f])), [])
  assert.ok(ledgerProblems(ledgerWith([{ ...f, finding_id: 'B1' }])).some(p => p.includes('F1')))
  assert.ok(ledgerProblems(ledgerWith([{ ...f, head: '' }])).some(p => p.includes('head is empty')))
  assert.ok(ledgerProblems(ledgerWith([{ ...f, test_results: null }])).some(p => p.includes('test_results')))
  assert.deepEqual(ledgerProblems(null), ['the ledger is not a JSON object'])
})
