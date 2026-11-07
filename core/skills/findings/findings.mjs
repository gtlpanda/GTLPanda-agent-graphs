#!/usr/bin/env node
// findings.mjs - the record /bughunt keeps for one PR: the finding schema,
// stable ids across runs, the status rules, the computed disposition, the
// metrics, and the report. Zero dependencies; one owner for every rule here
// (see this skill's SKILL.md).
//   node findings.mjs check <ledger.json>
//   node findings.mjs save <ledger.json> <intake.json> <run-result.json> [--repo <tree>] [--started <iso time>]
//   node findings.mjs report <ledger.json> [evidence dir]
//   node findings.mjs input <ledger.json> <intake.json> <out.json>
// check prints one line per problem, then FINDINGS: PASS|FAIL. Exit 0 pass, 1 fail, 2 usage.
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// ---- shared: copied verbatim into graphs/hunt/workflows/bughunt-flow.js (workflow scripts cannot import) ----
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const BLOCKING = ['CRITICAL', 'HIGH']
const LENSES = ['logic', 'contract', 'concurrency', 'security', 'errors', 'regression']
const CONFIDENCE_FLOOR = 60   // a candidate below this is dropped before anyone spends a call on it
const UNREPRODUCED_CAP = 79   // no finding claims more until a test reproduces it
const REPRODUCED_CONFIDENCE = 90   // a reproduced finding claims at least this
const NEAR_LINES = 5          // two reports this close in one file can be the same bug
// Allowed status moves. A new head sends every finding that was not refuted
// back to 'candidate' (mergeFindings), outside this table.
const MOVES = {
  verification_status: {
    candidate: ['refuted', 'confirmed', 'contested'],
    contested: ['refuted', 'confirmed'],
    confirmed: ['reproduced', 'preexisting', 'not_reproduced', 'refuted'],   // refuted: folded into its duplicate
    not_reproduced: ['reproduced', 'preexisting'],
    reproduced: [], preexisting: [], refuted: [],
  },
  fix_status: {
    none: ['proposed'],
    proposed: ['verified', 'rejected'],
    rejected: ['proposed', 'unresolved'],
    verified: [], unresolved: ['proposed'],   // a later run may try again
  },
}

// Problems with one hunter candidate, as plain strings; an empty list means usable.
// A finding names its trigger, the path that mishandles it, and the observable
// wrong result, with evidence read from the code; without all of it, it is dropped.
function candidateProblems(c) {
  const p = []
  const text = v => typeof v === 'string' && v.trim() !== ''
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['the candidate is not an object']
  if (!text(c.file_path)) p.push('file_path is empty')
  else if (c.file_path.startsWith('/') || c.file_path.split('/').includes('..')) p.push(`file_path must be repo-relative, got ${c.file_path}`)
  const r = c.line_range
  if (!Array.isArray(r) || r.length !== 2 || !r.every(n => Number.isInteger(n) && n > 0) || r[0] > r[1]) p.push(`line_range must be [start, end] with 0 < start <= end, got ${JSON.stringify(r)}`)
  if (!LENSES.includes(c.bug_category)) p.push(`bug_category must be one of ${LENSES.join(', ')}, got ${JSON.stringify(c.bug_category)}`)
  if (!SEVERITIES.includes(c.severity)) p.push(`severity must be one of ${SEVERITIES.join(', ')}, got ${JSON.stringify(c.severity)}`)
  if (!Number.isInteger(c.confidence) || c.confidence < 0 || c.confidence > 100) p.push(`confidence must be an integer 0-100, got ${JSON.stringify(c.confidence)}`)
  for (const k of ['title', 'description', 'expected_behavior', 'actual_behavior']) if (!text(c[k])) p.push(`${k} is empty`)
  const fs = c.failure_scenario
  for (const k of ['trigger', 'path', 'observable']) if (!fs || !text(fs[k])) p.push(`failure_scenario.${k} is empty`)
  const ev = c.evidence
  if (!Array.isArray(ev) || !ev.length || !ev.every(e => e && text(e.file) && Number.isInteger(e.line) && e.line > 0 && text(e.quote))) p.push('evidence must list at least one {file, line, quote} read from the code')
  return p
}

function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
const STOPWORDS = new Set(['the', 'and', 'for', 'when', 'with', 'has', 'have', 'its', 'are', 'was', 'not', 'but', 'from', 'into', 'that', 'this', 'one', 'can', 'may', 'all', 'any', 'out', 'too', 'than', 'then', 'does', 'did'])
// Half the meaningful words shared (stopwords out, plurals folded).
function similarTitles(a, b) {
  const words = t => new Set(normTitle(t).split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w)).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return false
  let shared = 0
  for (const w of A) if (B.has(w)) shared += 1
  return shared / (A.size + B.size - shared) >= 0.5
}
// One bug reported twice: the same file, and either lines within NEAR_LINES
// with the same category or a similar title, or (lines moved by a new head)
// the same title, the same category, and a quote in common. The same generic
// title far apart in one file is two bugs.
function sameFinding(a, b) {
  if (a.file_path !== b.file_path) return false
  const near = a.line_range[0] <= b.line_range[1] + NEAR_LINES && b.line_range[0] <= a.line_range[1] + NEAR_LINES
  if (near) return a.bug_category === b.bug_category || similarTitles(a.title, b.title)
  const quote = e => String(e.quote).replace(/\s+/g, ' ').trim()
  const sharedQuote = (a.evidence || []).some(e => (b.evidence || []).some(x => quote(x) === quote(e)))
  return normTitle(a.title) === normTitle(b.title) && a.bug_category === b.bug_category && sharedQuote
}
function nextFindingId(findings) {
  const n = findings.reduce((m, f) => Math.max(m, Number(String(f.finding_id).replace(/^F/, '')) || 0), 0)
  return `F${n + 1}`
}

// Merges valid candidates (each with source_agent set) into the known findings
// at `head`. A candidate that matches a known finding keeps that id, so a
// re-run never duplicates one: on the same head it only adds its source (a
// second hunter in this run counts as a duplicate); on a new head the finding
// takes the new location and evidence and goes back to 'candidate' to be
// verified again, unless it was refuted. Its reproduction, test results, and
// fix belonged to the old head, so they are cleared and its confidence drops
// back under the cap. Known findings at another head that nothing re-found are
// marked stale. Returns { findings, added, merged }.
function mergeFindings(known, candidates, head) {
  const findings = known.map(f => ({ ...f, sources: [...(f.sources || [])], history: [...(f.history || [])] }))
  const added = []
  const merged = []
  const seenThisRun = new Set()
  for (const c of candidates) {
    const match = findings.find(f => sameFinding(f, c))
    if (!match) {
      const f = {
        finding_id: nextFindingId(findings), source_agent: c.source_agent, sources: [c.source_agent],
        file_path: c.file_path, line_range: [...c.line_range], bug_category: c.bug_category, title: c.title,
        description: c.description, failure_scenario: { ...c.failure_scenario },
        expected_behavior: c.expected_behavior, actual_behavior: c.actual_behavior, evidence: c.evidence.map(e => ({ ...e })),
        severity: c.severity, confidence: Math.min(c.confidence, UNREPRODUCED_CAP),
        verification_status: 'candidate', reproduction_artifact: null, root_cause: null,
        fix_status: 'none', fix_artifact: null, test_results: [],
        head, stale: false, duplicates: 0, history: [],
      }
      findings.push(f)
      added.push(f.finding_id)
      seenThisRun.add(f.finding_id)
      continue
    }
    if (!match.sources.includes(c.source_agent)) match.sources.push(c.source_agent)
    if (seenThisRun.has(match.finding_id)) match.duplicates += 1
    seenThisRun.add(match.finding_id)
    if (match.head !== head) {
      Object.assign(match, {
        line_range: [...c.line_range], evidence: c.evidence.map(e => ({ ...e })), description: c.description,
        failure_scenario: { ...c.failure_scenario }, head, stale: false,
        reproduction_artifact: null, test_results: [], fix_status: 'none', fix_artifact: null,
        confidence: Math.min(match.confidence, UNREPRODUCED_CAP),
      })
      if (match.verification_status !== 'refuted') {
        match.history.push({ field: 'verification_status', from: match.verification_status, to: 'candidate', why: `re-found at a new head ${head}` })
        match.verification_status = 'candidate'
      }
    }
    match.confidence = Math.max(match.confidence, Math.min(c.confidence, UNREPRODUCED_CAP))
    if (SEVERITIES.indexOf(c.severity) < SEVERITIES.indexOf(match.severity)) match.severity = c.severity
    merged.push({ finding_id: match.finding_id, source_agent: c.source_agent })
  }
  for (const f of findings) if (f.head !== head) f.stale = true
  return { findings, added, merged }
}

// Whether the change touched the finding's lines: its file is new, or one of
// the file's head-side hunks (intake's `files`) is within NEAR_LINES of the
// finding's range. A reproduction that also fails at the merge-base is a
// pre-existing bug only when the change left these lines alone; when it wrote
// them, the behavior the test asserts is the change's own (a feature the base
// never had), so the change introduced the bug. The first live benchmark run
// called a brand-new discount threshold "pre-existing" this way.
function touchedByChange(f, files) {
  const file = (Array.isArray(files) ? files : []).find(x => x && x.path === f.file_path)
  if (!file) return false
  if (file.status === 'A') return true
  return (file.hunks || []).some(([s, e]) => s <= f.line_range[1] + NEAR_LINES && f.line_range[0] <= e + NEAR_LINES)
}

// Moves one status field, or throws on a move the table does not allow.
function transition(f, field, to, why) {
  const from = f[field]
  if (!MOVES[field] || !MOVES[field][from] || !MOVES[field][from].includes(to)) {
    throw new Error(`${f.finding_id}: ${field} cannot move from ${from} to ${to}`)
  }
  f[field] = to
  f.history.push({ field, from, to, why })
  return f
}
// ---- end shared ----

export {
  SEVERITIES, BLOCKING, LENSES, CONFIDENCE_FLOOR, UNREPRODUCED_CAP, REPRODUCED_CONFIDENCE, MOVES,
  candidateProblems, sameFinding, mergeFindings, transition, touchedByChange,
}

// ---------- the ledger ----------

const VERIFICATION = Object.keys(MOVES.verification_status)
const FIX = Object.keys(MOVES.fix_status)
const MAX_RUNS = 20

export function emptyLedger(key) {
  return { version: 1, key, target: null, findings: [], coverage: [], routing: null, status: null, reason: null, runs: [] }
}

// Problems with a ledger, as plain strings; empty means it is sound.
export function ledgerProblems(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return ['the ledger is not a JSON object']
  const p = []
  if (l.version !== 1) p.push(`version must be 1, got ${JSON.stringify(l.version)}`)
  if (typeof l.key !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(l.key)) p.push(`key must be a slug, got ${JSON.stringify(l.key)}`)
  if (!Array.isArray(l.findings)) return [...p, 'findings must be a list']
  if (!Array.isArray(l.runs)) p.push('runs must be a list')
  if (!Array.isArray(l.coverage)) p.push('coverage must be a list')
  const ids = new Set()
  for (const f of l.findings) {
    const id = f && f.finding_id
    if (typeof id !== 'string' || !/^F[1-9][0-9]*$/.test(id)) { p.push(`finding id must look like F1, got ${JSON.stringify(id)}`); continue }
    if (ids.has(id)) p.push(`${id} appears twice`)
    ids.add(id)
    for (const c of candidateProblems(f)) p.push(`${id}: ${c}`)
    if (!VERIFICATION.includes(f.verification_status)) p.push(`${id}: verification_status ${JSON.stringify(f.verification_status)} is not one of ${VERIFICATION.join(', ')}`)
    if (!FIX.includes(f.fix_status)) p.push(`${id}: fix_status ${JSON.stringify(f.fix_status)} is not one of ${FIX.join(', ')}`)
    if (typeof f.head !== 'string' || !f.head) p.push(`${id}: head is empty`)
    if (!Array.isArray(f.history)) p.push(`${id}: history must be a list`)
    if (!Array.isArray(f.test_results)) p.push(`${id}: test_results must be a list`)
  }
  return p
}

export function readLedger(path, key) {
  if (!existsSync(path)) return emptyLedger(key)
  let l
  try { l = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`) }
  const p = ledgerProblems(l)
  if (p.length) throw new Error(`${path} is not a sound findings ledger: ${p.slice(0, 5).join('; ')}`)
  return l
}

// Writes atomically, and only a ledger that reads back sound.
export function writeLedger(path, l) {
  const p = ledgerProblems(l)
  if (p.length) throw new Error(`refusing to write an unsound ledger: ${p.slice(0, 5).join('; ')}`)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n')
  renameSync(tmp, path)
}

// Folds one bughunt-flow result into the ledger. A finished run's findings
// already include the earlier ones (the workflow merged them), so they replace
// the list. A run that did not finish never replaces anything: the ledger keeps
// its findings, coverage, and target, and records the stop. Either way the run
// is appended to `runs`.
export function saveRun(ledger, intake, result, at, started = null) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.findings)) throw new Error('the run result has no findings list')
  const finished = result.status === 'done'
  const next = finished
    ? {
      ...ledger, target: intake.target, findings: result.findings,
      coverage: Array.isArray(result.coverage) ? result.coverage : [], routing: result.routing || null,
    }
    : { ...ledger, target: ledger.target || intake.target }
  next.status = result.status || null
  next.reason = result.reason || null
  const run = {
    at, mode: result.mode || 'discover', head: intake.target.head, status: result.status || null, reason: result.reason || null,
    added: result.added || [], merged: (result.merged || []).length, dropped: (result.dropped || []).length,
    calls: (result.history || []).length,
    duration_s: started && Number.isFinite(Date.parse(started)) && Number.isFinite(Date.parse(at)) ? Math.round((Date.parse(at) - Date.parse(started)) / 1000) : null,
    budget_stop: result.budgetStop || null,
  }
  next.runs = [...(ledger.runs || []), run].slice(-MAX_RUNS)
  return next
}

// ---------- evidence ----------

// What a reproduction verdict from evidence.mjs means for a finding. ERROR
// means the evidence is gone, so the finding falls back to confirmed (static
// evidence only).
const FROM_EVIDENCE = { REPRODUCED: 'reproduced', PREEXISTING: 'preexisting', NOT_REPRODUCED: 'not_reproduced', ERROR: 'confirmed' }
const REPRO_STATUSES = ['confirmed', 'reproduced', 'preexisting', 'not_reproduced']

// The ledger corrected to what the runs show. `evidence` is {F<n>: {verdict,
// reason, runs}} from evidence.mjs; `files` is intake's changed files, which
// decide whether a test failing at both commits means pre-existing (the change
// left the lines alone) or reproduced (the change wrote them). Execution outranks every agent here: a
// status that disagrees with the runs is moved to match them (outside the
// MOVES table, and recorded in history), test_results are replaced by the runs,
// and confidence follows (at least 90 when reproduced, at most 79 otherwise).
// Findings the skeptic or referee settled (refuted, contested) are never
// touched. Returns {ledger, corrected: [{finding_id, from, to}]}.
export function reconcile(ledger, evidence, files = null) {
  const corrected = []
  const findings = ledger.findings.map(f => {
    const e = evidence[f.finding_id]
    if (!e || !REPRO_STATUSES.includes(f.verification_status)) return f
    const g = { ...f, history: [...f.history] }
    g.test_results = (e.runs || []).map(r => ({ kind: r.kind || 'repro', arm: r.arm, sha: r.sha, exit: r.exit, timedOut: !!r.timedOut, marker: !!r.marker, error: r.error || null }))
    g.reproduction_artifact = { ...(f.reproduction_artifact || {}), verdict: e.verdict, reason: e.reason }
    const to = e.verdict === 'PREEXISTING' && touchedByChange(f, files) ? 'reproduced' : FROM_EVIDENCE[e.verdict]
    if (to && to !== f.verification_status) {
      g.history.push({ field: 'verification_status', from: f.verification_status, to, why: `evidence recheck: ${e.reason}` })
      g.verification_status = to
      corrected.push({ finding_id: f.finding_id, from: f.verification_status, to })
    }
    g.confidence = g.verification_status === 'reproduced' ? Math.max(g.confidence, REPRODUCED_CONFIDENCE) : Math.min(g.confidence, UNREPRODUCED_CAP)
    return g
  })
  return { ledger: { ...ledger, findings }, corrected }
}

// The ledger corrected to what a committed repair's re-run shows. `results` is
// {F<n>: {verdict: PASS|FAIL, reason}} from evidence.mjs recheck. A repair that
// no longer proves out (its reproduction does not pass at the commit, or does
// not fail at its parent) is taken back to rejected, outside the MOVES table
// and recorded in history. Returns {ledger, corrected}.
export function reconcileFix(ledger, results) {
  const corrected = []
  const findings = ledger.findings.map(f => {
    const r = results[f.finding_id]
    if (!r || r.verdict !== 'FAIL' || !['verified', 'proposed'].includes(f.fix_status)) return f
    corrected.push({ finding_id: f.finding_id, from: `fix ${f.fix_status}`, to: 'fix rejected' })
    return { ...f, fix_status: 'rejected', history: [...f.history, { field: 'fix_status', from: f.fix_status, to: 'rejected', why: `evidence recheck: ${r.reason}` }] }
  })
  return { ledger: { ...ledger, findings }, corrected }
}

// ---------- grounding ----------

// Checks each evidence quote against the file it cites, at the cited line
// (a few lines of slack either way). `readAt(file)` returns the file's text at
// the analysed head, or null. Returns the quotes that were not found.
export function missingEvidence(finding, readAt) {
  const norm = s => String(s).replace(/\s+/g, ' ').trim()
  const missing = []
  for (const e of finding.evidence || []) {
    const text = readAt(e.file)
    const lines = text === null ? [] : text.split('\n')
    const window = norm(lines.slice(Math.max(0, e.line - 4), e.line + 3).join('\n'))
    const quote = norm(e.quote).slice(0, 160)
    if (!quote || !window.includes(quote)) missing.push(`${e.file}:${e.line}`)
  }
  return missing
}

// ---------- the verdict ----------

// A verified fix lives on the fix branch, not in the PR's head, so it never
// closes a finding: the PR still has the bug until the fix is merged into it.
const OPEN = f => !f.stale && f.verification_status !== 'refuted' && f.verification_status !== 'preexisting'

// The PR's disposition, computed from the findings, never chosen by a model:
// manual_review when the last run did not finish; changes_requested when a
// confirmed or reproduced bug above LOW is still open; manual_review when a
// HIGH or CRITICAL one is unsettled or a lens was not fully covered; pass
// otherwise.
export function disposition(ledger) {
  if (ledger.status && ledger.status !== 'done') return { disposition: 'manual_review', because: [`the last run stopped: ${ledger.reason || ledger.status}`] }
  const open = (ledger.findings || []).filter(OPEN)
  const actionable = open.filter(f => ['confirmed', 'reproduced'].includes(f.verification_status) && f.severity !== 'LOW')
  if (actionable.length) return { disposition: 'changes_requested', because: actionable.map(f => f.finding_id) }
  const unsettled = open.filter(f => BLOCKING.includes(f.severity) && ['candidate', 'contested', 'not_reproduced'].includes(f.verification_status))
  const uncovered = (ledger.coverage || []).filter(c => c.status === 'not_covered' || c.status === 'partial')
  if (unsettled.length || uncovered.length) {
    return { disposition: 'manual_review', because: [...unsettled.map(f => f.finding_id), ...uncovered.map(c => `${c.lens} ${c.status === 'partial' ? 'partly covered' : 'not covered'}`)] }
  }
  return { disposition: 'pass', because: [] }
}

// Counts and rates over the findings. With `truth` ({bugs: [{file_path,
// line_range}]}), also precision and recall of what the graph reported as
// confirmed or reproduced; a finding matches a true bug in the same file within
// NEAR_LINES.
export function metrics(ledger, truth) {
  const fs = ledger.findings || []
  const count = pred => fs.filter(pred).length
  const by = key => Object.fromEntries([...new Set(fs.map(f => f[key]))].map(v => [v, count(f => f[key] === v)]))
  const rate = (num, den) => (den ? Math.round((num / den) * 1000) / 1000 : null)
  const reproduced = count(f => f.verification_status === 'reproduced')
  const attempted = count(f => ['reproduced', 'preexisting', 'not_reproduced'].includes(f.verification_status))
  const verified = count(f => f.fix_status === 'verified')
  const fixTried = count(f => ['verified', 'rejected', 'unresolved'].includes(f.fix_status))
  const out = {
    findings: fs.length,
    by_verification: by('verification_status'),
    by_severity: by('severity'),
    duplicates: fs.reduce((n, f) => n + (f.duplicates || 0), 0),
    stale: count(f => f.stale),
    reproduction_rate: rate(reproduced, attempted),
    fix_validation_rate: rate(verified, fixTried),
  }
  if (truth && Array.isArray(truth.bugs)) {
    const reported = fs.filter(f => !f.stale && ['confirmed', 'reproduced'].includes(f.verification_status))
    const hits = (f, b) => f.file_path === b.file_path && f.line_range[0] <= b.line_range[1] + NEAR_LINES && b.line_range[0] <= f.line_range[1] + NEAR_LINES
    const tp = reported.filter(f => truth.bugs.some(b => hits(f, b)))
    out.true_positives = tp.length
    out.false_positives = reported.length - tp.length
    out.precision = rate(tp.length, reported.length)
    out.recall = truth.bugs.length ? rate(truth.bugs.filter(b => reported.some(f => hits(f, b))).length, truth.bugs.length) : null
  }
  return out
}

// ---------- the report ----------

// Markdown for a human. Confirmed bugs, unverified findings, pre-existing ones,
// refuted ones, and coverage each get their own section, so nothing unverified
// reads as confirmed. Test results come only from the evidence files that
// evidence.mjs wrote ({finding_id: {head, test_file, runs}}), never from the
// run's own claims, and only from files written at this head for the test this
// finding's reproduction declared.
export function renderReport(ledger, evidence = {}) {
  const t = ledger.target || {}
  const short = s => (typeof s === 'string' ? s.slice(0, 7) : '?')
  const d = disposition(ledger)
  const L = []
  L.push(`# Bug hunt: ${t.label || ledger.key}`)
  L.push('')
  L.push(`Commits: ${short(t.mergeBase)}..${short(t.head)} (base ${t.base || '?'}).`)
  L.push(`Disposition: **${d.disposition.replace('_', ' ')}**${d.because.length ? ` (${d.because.join(', ')})` : ''}.`)
  if (ledger.status && ledger.status !== 'done') L.push(`The last run stopped early: ${ledger.reason || ledger.status}.`)
  if (ledger.routing) {
    const r = ledger.routing
    L.push(`Lenses run: ${(r.lenses || []).join(', ') || 'none'}${(r.skipped || []).length ? `; skipped: ${r.skipped.map(s => `${s.lens} (${s.why})`).join(', ')}` : ''}.`)
  }
  const section = (title, list, render) => {
    L.push('', `## ${title} (${list.length})`)
    if (!list.length) L.push('', 'None.')
    for (const f of list) render(f)
  }
  const full = f => {
    const ra = f.reproduction_artifact
    const ev = evidence[f.finding_id]
    const tests = ev && ra && ra.written === true && ev.head === t.head && ev.test_file === ra.test_file ? ev.runs : []
    L.push('', `### ${f.finding_id} [${f.severity}] ${f.title}`, '')
    L.push(`- **Where:** \`${f.file_path}:${f.line_range[0]}${f.line_range[1] !== f.line_range[0] ? `-${f.line_range[1]}` : ''}\` (${f.bug_category}; found by ${f.sources.join(', ')}; confidence ${f.confidence})`)
    L.push(`- **Status:** ${f.verification_status}; fix ${f.fix_status}`)
    const staticOnly = ['confirmed', 'contested', 'candidate'].includes(f.verification_status) ? ' Static evidence only.' : ''
    if (ra && ra.verdict) L.push(`- **Reproduction:** ${ra.verdict}: ${ra.reason}${ra.test_file ? ` (\`${ra.test_file}\`)` : ''}.${staticOnly}`)
    else if (ra && ra.written === false) L.push(`- **Reproduction:** no test written: ${ra.reason}.${staticOnly}`)
    else if (ra && ra.written === true) L.push(`- **Reproduction:** attempted (\`${ra.test_file}\`), no verdict: ${ra.reason || 'unknown'}.${staticOnly}`)
    else if (staticOnly) L.push(`- **Reproduction:** not attempted.${staticOnly}`)
    L.push(`- **Trigger:** ${f.failure_scenario.trigger}`)
    L.push(`- **Path:** ${f.failure_scenario.path}`)
    L.push(`- **Observable:** ${f.failure_scenario.observable}`)
    L.push(`- **Expected:** ${f.expected_behavior}`, `- **Actual:** ${f.actual_behavior}`)
    for (const e of f.evidence) L.push(`- **Evidence:** \`${e.file}:${e.line}\` \`${String(e.quote).replace(/`/g, "'").slice(0, 160)}\``)
    if (f.evidence_missing && f.evidence_missing.length) L.push(`- **Warning:** quoted evidence not found at ${f.evidence_missing.join(', ')}`)
    if (f.root_cause) L.push(`- **Root cause:** ${f.root_cause}`)
    const fa = f.fix_artifact
    if (f.fix_status === 'verified') L.push(`- **Fix:** verified and committed${fa && fa.commit ? ` in \`${fa.commit.slice(0, 12)}\`` : ''} on ${fa && fa.branch ? `\`${fa.branch}\`` : 'the fix worktree'}${fa && fa.attempts ? ` (attempt ${fa.attempts})` : ''}: the reproduction passes with it and fails without it, the suite passes, and an independent verifier accepted it. It is not in the PR until someone merges it there.`)
    else if (f.fix_status === 'proposed') L.push(`- **Fix:** proposed${fa && fa.commit ? ` in \`${fa.commit.slice(0, 12)}\`` : ''}: it passed the fix check, but no independent verifier has reviewed it.`)
    else if (f.fix_status === 'unresolved') L.push(`- **Fix:** unresolved after ${fa && fa.attempts ? fa.attempts : 'every'} attempt(s)${fa && fa.last_feedback ? `: ${fa.last_feedback}` : ''}.`)
    else if (f.fix_status === 'rejected') L.push(`- **Fix:** rejected${fa && fa.last_feedback ? `: ${fa.last_feedback}` : ''}.`)
    if (tests.length) for (const r of tests) L.push(`- **Test run:** ${r.arm || r.kind || 'run'}: exit ${r.exit}${r.verdict ? `, ${r.verdict}` : ''}`)
    else L.push('- **Test runs:** none recorded')
  }
  const fs = ledger.findings || []
  const live = fs.filter(f => !f.stale)
  section('Confirmed bugs', live.filter(f => ['confirmed', 'reproduced'].includes(f.verification_status)), full)
  section('Unverified findings: not experimentally confirmed', live.filter(f => ['candidate', 'contested', 'not_reproduced'].includes(f.verification_status)), full)
  section('Pre-existing: not introduced by this PR', live.filter(f => f.verification_status === 'preexisting'), f => L.push(`- ${f.finding_id} [${f.severity}] ${f.title} (\`${f.file_path}:${f.line_range[0]}\`)`))
  section('Refuted', live.filter(f => f.verification_status === 'refuted'), f => {
    const why = [...f.history].reverse().find(h => h.to === 'refuted')
    L.push(`- ${f.finding_id} ${f.title}: ${why ? why.why : 'refuted'}`)
  })
  section('Stale: from an earlier head, not seen again', fs.filter(f => f.stale), f => L.push(`- ${f.finding_id} [${f.severity}] ${f.title} (at ${short(f.head)})`))
  L.push('', '## Coverage', '')
  if (!(ledger.coverage || []).length) L.push('None recorded.')
  for (const c of ledger.coverage || []) L.push(`- ${c.lens}: ${c.status}${c.note ? ` (${c.note})` : ''}`)
  return L.join('\n') + '\n'
}

// ---------- command line ----------

const USAGE = 'usage: findings.mjs check <ledger.json> | save <ledger.json> <intake.json> <result.json> [--repo <tree>] | report <ledger.json> [evidence dir] | input <ledger.json> <intake.json> <out.json>'

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`${path}: ${e.message}`) }
}

// Reads every <id>.json in the evidence directory evidence.mjs writes, as
// {F<n>: {head, test_file, runs}}. An unreadable file has no runs.
export function readEvidence(dir) {
  const out = {}
  if (!dir || !existsSync(dir)) return out
  for (const f of readdirSync(dir).filter(n => /^F[0-9]+\.json$/.test(n))) {
    const id = f.replace(/\.json$/, '')
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      out[id] = { head: e.head || null, test_file: e.test_file || null, runs: Array.isArray(e.runs) ? e.runs : [] }
    } catch { out[id] = { head: null, test_file: null, runs: [] } }
  }
  return out
}

function main(argv) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'check' && rest.length === 1) {
      let p
      try { p = ledgerProblems(readJson(rest[0])) } catch (e) { p = [e.message] }
      for (const x of p) console.log(`findings: ${rest[0]}: ${x}`)
      console.log(`FINDINGS: ${p.length ? 'FAIL' : 'PASS'}`)
      return p.length ? 1 : 0
    }
    const flags = {}
    const positional = []
    for (let i = 0; i < rest.length; i += 1) {
      if (['--repo', '--started'].includes(rest[i]) && rest[i + 1] !== undefined) { flags[rest[i].slice(2)] = rest[i + 1]; i += 1 } else positional.push(rest[i])
    }
    if (cmd === 'save' && positional.length === 3) {
      const [ledgerFile, intakeFile, resultFile] = positional
      const intake = readJson(intakeFile)
      const ledger = readLedger(ledgerFile, intake.key)
      const next = saveRun(ledger, intake, readJson(resultFile), new Date().toISOString(), flags.started || null)
      if (flags.repo) {
        const readAt = file => {
          const r = spawnSync('git', ['-C', flags.repo, 'show', `${intake.target.head}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
          return r.status === 0 ? r.stdout : null
        }
        for (const f of next.findings) if (f.head === intake.target.head) f.evidence_missing = missingEvidence(f, readAt)
      }
      writeLedger(ledgerFile, next)
      const d = disposition(next)
      console.log(`FINDINGS: SAVED ${next.findings.length} finding(s), disposition ${d.disposition}`)
      return 0
    }
    // The run's input, {intake, prior}, for run-script.mjs to write into the workflow.
    if (cmd === 'input' && rest.length === 3) {
      const intake = readJson(rest[1])
      const ledger = readLedger(rest[0], intake.key)
      writeFileSync(rest[2], JSON.stringify({ intake, prior: ledger.findings }, null, 2) + '\n')
      console.log(`FINDINGS: INPUT ${ledger.findings.length} earlier finding(s) -> ${rest[2]}`)
      return 0
    }
    if (cmd === 'report' && (rest.length === 1 || rest.length === 2)) {
      if (!existsSync(rest[0])) throw new Error(`no ledger at ${rest[0]}: nothing has been saved for this target yet`)
      const l = readLedger(rest[0], 'unknown')
      process.stdout.write(renderReport(l, readEvidence(rest[1])))
      return 0
    }
  } catch (e) {
    console.error(`findings: ${e.message}`)
    return 1
  }
  console.error(USAGE)
  return 2
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
