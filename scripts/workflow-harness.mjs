// workflow-harness.mjs — shared test runtime for workflow scripts. The Workflow
// runtime supplies agent/phase/log/args as globals and allows a top-level
// `return`; we reproduce that by wrapping the script body in an AsyncFunction.
// Graph tests import test/load/run/agentField from here; scripts/test-workflow.mjs
// runs them and prints the totals.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

let pass = 0
let fail = 0
export async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass += 1 }
  catch (e) { console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`); fail += 1 }
}

// ---------- loading ----------
// The runtime rejects Date.now()/Math.random()/argless new Date() (they break
// resume); shadow them so an accidental use fails here too.
const SafeMath = Object.create(Math)
SafeMath.random = () => { throw new Error('Math.random() is not allowed in workflow scripts') }
class SafeDate extends Date {
  constructor(...a) { if (!a.length) throw new Error('argless new Date() is not allowed in workflow scripts'); super(...a) }
  static now() { throw new Error('Date.now() is not allowed in workflow scripts') }
}

export function extractMeta(src, file) {
  assert.ok(src.startsWith('export const meta = {'), `${file}: must begin with "export const meta = {"`)
  const end = src.indexOf('\n}\n')
  assert.ok(end > 0, `${file}: meta must close with a "}" on its own line`)
  const text = src.slice('export const meta = '.length, end + 2)
  assert.ok(!text.includes('${'), `${file}: meta must not use template interpolation`)
  // No identifiers in scope: any variable or call reference throws, so this
  // only succeeds for a pure literal.
  return new Function(`"use strict"; return (${text})`)()
}

export function load(file) {
  const src = readFileSync(file, 'utf8')
  const meta = extractMeta(src, file)
  const body = src.replace(/^export const meta/, 'const meta')
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'Math', 'Date', body)
  return { src, meta, fn }
}

// script: { [agentType]: [response | (prompt, opts) => response | { throws: message }, ...] }
//
// The workflow catches anything agent() throws and escalates, so an assert
// inside a scripted response (or an unexpected call) would otherwise be
// swallowed and the test would pass. Mock-side errors are recorded and
// rethrown here; only an explicit { throws } entry reaches the workflow as a
// node failure. Unconsumed responses fail the test unless allowLeftover.
export async function run(fn, script, args, { allowLeftover = false } = {}) {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]))
  const calls = []
  const logs = []
  const mockErrors = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ agentType: opts.agentType, model: opts.model, effort: opts.effort, phase: opts.phase, label: opts.label, prompt, schema: opts.schema })
    const q = queues[opts.agentType]
    if (!q || !q.length) {
      const e = new Error(`unexpected agent call: ${opts.agentType} (${opts.label})`)
      mockErrors.push(e)
      throw e
    }
    const next = q.shift()
    if (next && typeof next === 'object' && 'throws' in next) throw new Error(next.throws)
    if (typeof next !== 'function') return next
    try { return next(prompt, opts) } catch (e) { mockErrors.push(e); throw e }
  }
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const pipeline = async () => { throw new Error('pipeline not used by this graph') }
  const result = await fn(agent, parallel, pipeline, () => {}, m => logs.push(m), args, { total: null, spent: () => 0, remaining: () => Infinity }, SafeMath, SafeDate)
  if (mockErrors.length) throw mockErrors[0]
  const leftover = Object.entries(queues).filter(([, q]) => q.length).map(([k, q]) => `${k}:${q.length}`)
  if (!allowLeftover) assert.deepEqual(leftover, [], `scripted responses never consumed: ${leftover.join(', ')}`)
  return { result, calls, logs, leftover }
}

export function summary() { return { pass, fail } }

// Directories that can hold installable entries of `kind` (agents, skills,
// workflows): the flat top level, core/, and every graphs/<name>/.
export function entryDirs(kind) {
  const graphs = existsSync(join(REPO, 'graphs')) ? readdirSync(join(REPO, 'graphs')).map(g => join('graphs', g)) : []
  return ['', 'core', ...graphs].map(d => join(REPO, d, kind)).filter(d => existsSync(d))
}

// Frontmatter `<key>:` of the one agent file named <name>.md, wherever it lives.
export function agentField(name, key) {
  const files = entryDirs('agents').map(d => join(d, `${name}.md`)).filter(f => existsSync(f))
  assert.equal(files.length, 1, `agent ${name}: expected exactly one ${name}.md, found ${files.length}`)
  const m = readFileSync(files[0], 'utf8').match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'))
  return m ? m[1] : null
}
