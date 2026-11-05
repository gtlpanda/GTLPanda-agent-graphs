#!/usr/bin/env node
// backlog.mjs - the format of an app's backlog (docs/backlog.json), the
// build ledger the /build-app driver keeps, and the next-step rules over them.
// Zero dependencies; one owner for every rule here (see this skill's SKILL.md).
//   node backlog.mjs check <path>
// Prints one line per problem, then BACKLOG: PASS|FAIL. Exit 0 pass, 1 fail, 2 usage.
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The driver's stop rules (README "Three brakes").
export const MAX_REPLANS = 3            // re-plans across the whole app
export const MAX_ESCALATED_SLICES = 3   // different slices escalated with nothing landing in between
// One slice: escalations before it is re-planned from scratch, and re-plans
// before it counts as stuck (blocked) so the other slices keep building.
export const ESCALATIONS_PER_REPLAN = 2
export const REPLANS_PER_SLICE = 1

// Self-contained on purpose: the blueprint backlog stage will copy it verbatim
// (workflow scripts cannot import), and that change must add the drift test.
// Structural problems in a backlog, as plain strings; an empty list means it
// passes. `requiredIds`, when given, is the design's requirement ids: the
// backlog's own list must name exactly those.
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
    // /dev lets task text override its no-ask rule, so a slice must never ask for that.
    else if (/stop[\s-]+and[\s-]+ask/i.test(s.goal)) problems.push(`${id}: goal says "stop and ask", which would make an unattended /dev wait for a human`)
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

export { validateBacklog }

// ---------- reading and writing ----------

// Parses a JSON file; throws with a plain message when it cannot.
function readJson(path) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch (e) { throw new Error(`cannot read ${path}: ${e.code || e.message}`) }
  try { return JSON.parse(raw) } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`) }
}

export function readBacklog(path) {
  return readJson(path)
}

export function emptyLedger() {
  return { version: 1, replans: 0, escalatedSinceLanding: [], slices: {} }
}

// A missing ledger is a fresh build. An unreadable one throws: guessing would
// rebuild slices that already landed, or skip ones that did not.
export function readLedger(path) {
  let ledger
  try {
    ledger = readJson(path)
  } catch (e) {
    if (/ENOENT/.test(e.message)) return emptyLedger()
    throw e
  }
  if (!ledger || typeof ledger !== 'object' || ledger.version !== 1 || typeof ledger.slices !== 'object' || ledger.slices === null ||
      !Number.isInteger(ledger.replans) || !Array.isArray(ledger.escalatedSinceLanding)) {
    throw new Error(`${path} is not a version 1 build ledger`)
  }
  return ledger
}

// Write to a temp file, then rename: a crash mid-write never leaves half a ledger.
export function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`)
  renameSync(tmp, path)
}

// ---------- next-step rules (pure) ----------

export function sliceState(ledger, id) {
  const s = ledger.slices[id] || {}
  return {
    status: s.status || 'pending',
    escalations: s.escalations || 0,
    replans: s.replans || 0,
    replan: s.replan === true,
    reasons: Array.isArray(s.reasons) ? s.reasons : [],
    questions: Array.isArray(s.questions) ? s.questions : [],
    answers: Array.isArray(s.answers) ? s.answers : [],
    frozen: Array.isArray(s.frozen) ? s.frozen : [],
    stuck: s.stuck === true,
  }
}

// Slices that cannot be built: blocked themselves, or depending (at any depth)
// on one that is. Dependencies point only backwards, so one pass in order is enough.
export function blockedClosure(backlog, ledger) {
  const blocked = new Set()
  for (const s of backlog.slices) {
    if (sliceState(ledger, s.id).status === 'blocked' || s.depends_on.some(d => blocked.has(d))) blocked.add(s.id)
  }
  return blocked
}

// The next slice to build: not done or blocked, every dependency done. In
// build order, but a slice that escalated since the last landing goes after
// the others, so one stuck slice does not hold up independent work. Null when
// nothing is buildable.
export function nextSlice(backlog, ledger) {
  const blocked = blockedClosure(backlog, ledger)
  const done = id => sliceState(ledger, id).status === 'done'
  const ready = backlog.slices.filter(s => !done(s.id) && !blocked.has(s.id) && s.depends_on.every(done))
  const recent = new Set(ledger.escalatedSinceLanding)
  return ready.find(s => !recent.has(s.id)) || ready[0] || null
}

// Test files frozen by every landed slice: later slices may not change them.
export function frozenFiles(ledger) {
  return [...new Set(Object.values(ledger.slices).flatMap(s => (s && s.status === 'done' && Array.isArray(s.frozen) ? s.frozen : [])))].sort()
}

// Applies one slice outcome and returns a new ledger (the input is not changed).
//   {kind: 'landed', frozen: [test files]}   the slice merged; its tests freeze
//   {kind: 'escalated', reason}              /dev or the driver's own checks failed
//   {kind: 'needs-human', questions: [...]}  only a human can unblock it
export function recordOutcome(ledger, id, outcome) {
  const next = JSON.parse(JSON.stringify(ledger))
  const s = sliceState(next, id)
  if (s.status !== 'pending') throw new Error(`${id} is ${s.status}; only a pending slice takes an outcome`)
  const kind = outcome && outcome.kind
  if (kind === 'landed') {
    if (!Array.isArray(outcome.frozen)) throw new Error('a landed outcome needs frozen: [test files]')
    next.slices[id] = { ...s, status: 'done', replan: false, frozen: [...outcome.frozen].sort() }
    next.escalatedSinceLanding = []
  } else if (kind === 'escalated') {
    if (typeof outcome.reason !== 'string' || !outcome.reason.trim()) throw new Error('an escalated outcome needs a reason')
    const reasons = [...s.reasons, outcome.reason]
    const escalations = s.escalations + 1
    if (escalations < ESCALATIONS_PER_REPLAN) {
      // `replan` means "the next attempt starts from a fresh plan"; it lasts one attempt.
      next.slices[id] = { ...s, escalations, replan: false, reasons }
    } else if (s.replans < REPLANS_PER_SLICE) {
      // A fresh plan, with every reason so far, instead of a third try at the same one.
      next.slices[id] = { ...s, escalations: 0, replans: s.replans + 1, replan: true, reasons }
      next.replans += 1
    } else {
      next.slices[id] = { ...s, escalations, status: 'blocked', replan: false, reasons, stuck: true }
    }
    if (!next.escalatedSinceLanding.includes(id)) next.escalatedSinceLanding.push(id)
  } else if (kind === 'needs-human') {
    if (!Array.isArray(outcome.questions) || !outcome.questions.length) throw new Error('a needs-human outcome needs questions')
    next.slices[id] = { ...s, status: 'blocked', replan: false, questions: outcome.questions }
  } else {
    throw new Error(`unknown outcome kind ${JSON.stringify(kind)}`)
  }
  return next
}

// The human's way back in. Unblocks one slice: it gets their answers and
// starts over with a fresh count. Throws unless the slice is blocked.
export function unblock(ledger, id, answers) {
  const s = sliceState(ledger, id)
  if (s.status !== 'blocked') throw new Error(`${id} is ${s.status}; only a blocked slice can be unblocked`)
  if (!Array.isArray(answers) || !answers.length || !answers.every(a => typeof a === 'string' && a.trim())) {
    throw new Error('unblocking needs the human\'s answers: a non-empty list of text')
  }
  const next = JSON.parse(JSON.stringify(ledger))
  next.slices[id] = { ...s, status: 'pending', escalations: 0, replans: 0, replan: true, stuck: false, questions: [], answers }
  return next
}

// After a brake, the human has looked: the counters behind the first two
// brakes start over. Blocked slices stay blocked until unblocked one by one.
export function resume(ledger) {
  return { ...JSON.parse(JSON.stringify(ledger)), replans: 0, escalatedSinceLanding: [] }
}

// The first brake that applies, as a sentence for the human; null to keep going.
export function brake(backlog, ledger) {
  if (ledger.replans >= MAX_REPLANS) return `${ledger.replans} re-plans in this app (the limit is ${MAX_REPLANS}): the design or the backlog needs a human`
  const escalated = ledger.escalatedSinceLanding
  if (escalated.length >= MAX_ESCALATED_SLICES) return `${escalated.length} different slices escalated with none landing in between (${escalated.join(', ')}): something shared is broken`
  const remaining = backlog.slices.filter(s => sliceState(ledger, s.id).status !== 'done')
  if (remaining.length && !nextSlice(backlog, ledger)) {
    return `every remaining slice is blocked: ${remaining.map(s => s.id).join(', ')}`
  }
  return null
}

// ---------- command line ----------

function main(argv) {
  const [cmd, path, ...rest] = argv
  if (cmd !== 'check' || !path || rest.length) {
    console.error('usage: backlog.mjs check <path>')
    return 2
  }
  let problems
  try {
    problems = validateBacklog(readBacklog(path))
  } catch (e) {
    problems = [e.message]
  }
  for (const p of problems) console.log(`backlog: ${path}: ${p}`)
  console.log(`BACKLOG: ${problems.length ? 'FAIL' : 'PASS'}`)
  return problems.length ? 1 : 0
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
