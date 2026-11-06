#!/usr/bin/env node
// write-docs.mjs — write an approved design and backlog into the app's repo.
//
//   node write-docs.mjs <run2.json> <run3.json> <repo>
//
// Writes docs/blueprint/design.md, docs/backlog.json, and, when the design has
// knowledge items, docs/knowledge-map.json. The same runs always give the same
// files, so what is committed is exactly what the gates approved. Prints
// "write-docs: wrote <paths>" and exits 0, or "write-docs: FAIL <why>" and
// exits 1. Every check runs before the first write, so a failed check writes
// nothing. It never overwrites a file.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// Resolved from this file's real path (install.sh links the skill directory).
import { validateBacklog } from '../../../../core/skills/backlog/backlog.mjs'

export const DESIGN_DOC = 'docs/blueprint/design.md'
export const BACKLOG = 'docs/backlog.json'
export const KNOWLEDGE_MAP = 'docs/knowledge-map.json'

const list = x => (Array.isArray(x) ? x : [])
const or = (items, line) => (items.length ? items.map(line) : ['None.'])

export function renderDesign(app, d) {
  const shapes = m => list(m.shapes).map(s => s.name).filter(n => n !== m.pick)
  return [
    `# Design: ${app}`,
    '',
    String(d.summary || '').trim(),
    '',
    'Approved with `docs/backlog.json` by `/blueprint`. The binding decisions are in the',
    'interview state; this is the design built on them.',
    '',
    '## Modules',
    '',
    ...or(list(d.modules), m => `- **${m.id} ${m.name}**: ${m.responsibility} (${list(m.requirements).join(', ') || 'no requirement'})` +
      (m.boundary ? `\n  - Boundary: picked ${m.pick} over ${shapes(m).join(', ')}. ${m.depth_reason}` : '')),
    '',
    '## Failure modes',
    '',
    ...or(list(d.failure_modes), f => `- **${f.id}** (${f.module}): ${f.what}. Plan: ${f.plan}` +
      ` (${[f.silent ? 'silent' : 'visible', f.tested ? 'tested' : 'untested', f.handled ? 'handled' : 'unhandled'].join(', ')})`),
    '',
    '## Decisions (ADRs)',
    '',
    ...or(list(d.adrs), a => `- **${a.id} ${a.title}**: ${a.decision} (options: ${list(a.options).join(', ')}). ${a.reason}`),
    '',
    '## Departures from the default stack',
    '',
    ...or(list(d.departures), x => `- ${x.what} instead of ${x.default}: ${x.reason} (${x.adr})`),
    '',
    '## Shared knowledge',
    '',
    ...or(list(d.knowledge), k => `- **${k.id}** ${k.knowledge} (${k.kind}): owner \`${k.owner}\`. ${k.changes_together_because}`),
    '',
    '## Premises',
    '',
    ...or(list(d.premises), p => `- ${p.status}: ${p.claim} (${p.evidence || 'no evidence yet'})`),
    '',
  ].join('\n')
}

// The knowledge-map skill's format. used_by is in build order, so its first
// slice is the one that builds the owner (the backlog stage checked that).
export function knowledgeMap(design, owners, slices) {
  const order = new Map(slices.map((s, i) => [s.id, i]))
  const byId = new Map(list(owners).map(o => [o.id, o]))
  return {
    version: 1,
    items: list(design.knowledge).map(k => ({
      id: k.id,
      knowledge: k.knowledge,
      kind: k.kind,
      owner: typeof k.owner === 'string' && k.owner.trim() ? k.owner : null,
      status: 'planned',
      used_by: [...byId.get(k.id).used_by].sort((a, b) => order.get(a) - order.get(b)),
      changes_together_because: k.changes_together_because,
    })),
  }
}

// Returns [{path, text}] or throws with the reason. Pure: reads nothing.
export function planDocs(run2, run3) {
  if (!run2 || run2.status !== 'design-ready' || !run2.design || typeof run2.design !== 'object') throw new Error('run2 is not a design-ready design run')
  if (!run3 || run3.status !== 'backlog-ready' || !run3.backlog || typeof run3.backlog !== 'object') throw new Error('run3 is not a backlog-ready backlog run')
  const { design } = run2
  const { backlog } = run3
  const problems = validateBacklog(backlog)
  if (problems.length) throw new Error(`the backlog does not pass its check: ${problems.join('; ')}`)
  const owned = new Set(list(run3.owners).map(o => o && o.id))
  const missing = list(design.knowledge).map(k => k.id).filter(id => !owned.has(id))
  if (missing.length) throw new Error(`knowledge ${missing.join(', ')} has no slices in the backlog run`)
  const slices = new Set(backlog.slices.map(s => s.id))
  for (const o of list(run3.owners)) {
    if (!list(o.used_by).length || !o.used_by.every(u => slices.has(u))) throw new Error(`knowledge ${o.id} names a slice the backlog lacks`)
  }
  const files = [
    { path: DESIGN_DOC, text: renderDesign(backlog.app, design) },
    { path: BACKLOG, text: `${JSON.stringify(backlog, null, 2)}\n` },
  ]
  if (list(design.knowledge).length) {
    files.push({ path: KNOWLEDGE_MAP, text: `${JSON.stringify(knowledgeMap(design, run3.owners, backlog.slices), null, 2)}\n` })
  }
  return files
}

function readJson(path) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch (e) { throw new Error(`cannot read ${path}: ${e.code || e.message}`) }
  try { return JSON.parse(raw) } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`) }
}

export function main(argv) {
  const [run2Path, run3Path, repo] = argv
  if (!run2Path || !run3Path || !repo) return { code: 2, out: 'usage: write-docs.mjs <run2.json> <run3.json> <repo>' }
  try {
    const files = planDocs(readJson(run2Path), readJson(run3Path))
    const taken = files.map(f => f.path).filter(p => existsSync(join(repo, p)))
    if (taken.length) throw new Error(`${repo} already has ${taken.join(', ')}; nothing was overwritten`)
    for (const f of files) {
      mkdirSync(dirname(join(repo, f.path)), { recursive: true })
      writeFileSync(join(repo, f.path), f.text)
    }
    return { code: 0, out: `write-docs: wrote ${files.map(f => f.path).join(' ')}` }
  } catch (e) {
    return { code: 1, out: `write-docs: FAIL ${e.message}` }
  }
}

// Run as a command, also through the install symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { code, out } = main(process.argv.slice(2))
  console.log(out)
  process.exit(code)
}
