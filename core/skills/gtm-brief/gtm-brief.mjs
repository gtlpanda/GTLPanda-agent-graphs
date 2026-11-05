#!/usr/bin/env node
// gtm-brief.mjs - checks a product's GTM brief (docs/gtm.md) against the
// format in this skill's SKILL.md. Zero dependencies.
//   node gtm-brief.mjs check <path>
// Prints one line per problem, then GTM-BRIEF: PASS|FAIL. Exit 0 pass, 1 fail, 2 usage.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SECTIONS = ['Product', 'Customer', 'Positioning', 'Voice', 'Proof', 'Never claim', 'Compliance']
// Sections whose every line must be a "- " list item.
const LIST_SECTIONS = ['Proof', 'Never claim']
// CommonMark fences: up to 3 spaces of indent, 3+ backticks or tildes. A fence
// closes only on the same character, at least as long, with nothing after it.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^##\s+(.+?)\s*$/
const ITEM = /^\s*[-*]\s+\S/
// A claim, then a dash, then the source: "- claim - source: https://...".
const PROOF_ITEM = /^\s*[-*]\s+\S.*?\s[-\u2013\u2014]\s+source:\s*(\S.*?)\s*$/i
const NOT_A_SOURCE = /^(n\/?a|none|unknown|tbd|todo|\?+|-+)$/i
const PLACEHOLDERS = [
  // A placeholder is a phrase in angle brackets: "<Product name>". Tags
  // (<sup>), comparisons (<2s, >99%), and autolinks (<https://x>, <a@b.co>)
  // have no space-separated words starting with a letter, so they pass.
  [/<[A-Za-z][^<>=\n]* [^<>=\n]*>/, 'a <...> placeholder is left in'],
  [/\bTODO\b/, 'a TODO is left in'],
  [/\bTBD\b/, 'a TBD is left in'],
]
const INLINE_CODE = /`[^`\n]*`/g
function closesFence(line, open) {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return Boolean(m) && m[1][0] === open[0] && m[1].length >= open.length
}

// Returns [{line, message}] for the brief's text; an empty list means it passes.
export function checkBrief(text) {
  const problems = []
  const add = (line, message) => problems.push({ line, message })
  const sections = new Map()   // heading -> {line, body: [{line, text}]}
  let current = null
  let fence = null   // {marker, line} while inside a fenced code block
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  lines.forEach((raw, i) => {
    const n = i + 1
    if (fence) {
      if (closesFence(raw, fence.marker)) fence = null
      if (current) current.body.push({ line: n, text: raw })
      return
    }
    const opens = FENCE_OPEN.exec(raw)
    if (opens) { fence = { marker: opens[1], line: n }; if (current) current.body.push({ line: n, text: raw }); return }
    for (const [re, message] of PLACEHOLDERS) if (re.test(raw.replace(INLINE_CODE, ''))) add(n, message)
    const heading = HEADING.exec(raw)
    if (heading) {
      const name = heading[1]
      if (sections.has(name)) add(n, `section "${name}" appears twice (first at line ${sections.get(name).line})`)
      current = { line: n, body: [] }
      if (!sections.has(name)) sections.set(name, current)
      return
    }
    if (current && raw.trim()) current.body.push({ line: n, text: raw })
  })
  if (fence) add(fence.line, 'a fenced code block is never closed')
  for (const name of SECTIONS) {
    const section = sections.get(name)
    if (!section) { add(0, `section "## ${name}" is missing`); continue }
    if (!section.body.length) { add(section.line, `section "${name}" is empty`); continue }
    if (!LIST_SECTIONS.includes(name)) continue
    for (const { line, text: t } of section.body) {
      if (!ITEM.test(t)) { add(line, `${name} lines must be "- " list items`); continue }
      if (name !== 'Proof') continue
      const proof = PROOF_ITEM.exec(t)
      if (!proof) add(line, 'a Proof item needs a claim and a source: "- <claim> - source: <url, file:line, or interview date>"')
      else if (NOT_A_SOURCE.test(proof[1])) add(line, `"${proof[1]}" is not a source`)
    }
  }
  return problems.sort((a, b) => a.line - b.line)
}

// Reads a brief as UTF-8 text; throws with a plain message when it cannot.
export function readBrief(path) {
  let bytes
  try { bytes = readFileSync(path) } catch (e) { throw new Error(`cannot read ${path}: ${e.code || e.message}`) }
  if (bytes.includes(0)) throw new Error(`${path} is not a text file`)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error(`${path} is not UTF-8 text`) }
}

function main(argv) {
  const [cmd, path, ...rest] = argv
  if (cmd !== 'check' || !path || rest.length) {
    console.error('usage: gtm-brief.mjs check <path>')
    return 2
  }
  let problems
  try {
    problems = checkBrief(readBrief(path))
  } catch (e) {
    problems = [{ line: 0, message: e.message }]
  }
  for (const p of problems) console.log(`gtm-brief: ${path}${p.line ? `:${p.line}` : ''}: ${p.message}`)
  console.log(`GTM-BRIEF: ${problems.length ? 'FAIL' : 'PASS'}`)
  return problems.length ? 1 : 0
}

// Run as a command, also through the ~/.claude/skills symlink install.sh makes.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
