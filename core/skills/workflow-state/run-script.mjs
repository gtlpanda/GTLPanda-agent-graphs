#!/usr/bin/env node
// run-script.mjs — write saved JSON state into a runnable copy of a workflow script.
//
//   node run-script.mjs <SEAM> <state.json> <workflow.js> <out.js>
//
// Workflow scripts cannot read files, and saved state (an approved plan, an
// interview's answers) is too big to retype as a Workflow argument, so the
// orchestrator runs this copy with `scriptPath` instead. The workflow carries
// the line `const <SEAM> = null` exactly once; the copy differs from it on
// that one line. Prints "run-script: wrote <absolute out path> ..." and exits 0,
// or prints "run-script: FAIL <why>" and exits 1 without writing anything.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

function fail(why) {
  console.log(`run-script: FAIL ${why}`)
  process.exit(1)
}

const [seamName, statePath, srcPath, outPath] = process.argv.slice(2)
if (!seamName || !statePath || !srcPath || !outPath) fail('usage: node run-script.mjs <SEAM> <state.json> <workflow.js> <out.js>')
if (!/^INJECTED_[A-Z][A-Z_]*$/.test(seamName)) fail(`seam name "${seamName}" must look like INJECTED_PLAN`)
const SEAM = `const ${seamName} = null`

let stateText
try { stateText = readFileSync(statePath, 'utf8') } catch (e) { fail(`cannot read state ${statePath}: ${e.message}`) }
let state
try { state = JSON.parse(stateText) } catch (e) { fail(`state ${statePath} is not valid JSON: ${e.message}`) }
if (!state || typeof state !== 'object' || Array.isArray(state)) fail(`state ${statePath} must be a JSON object`)

let src
try { src = readFileSync(srcPath, 'utf8') } catch (e) { fail(`cannot read workflow ${srcPath}: ${e.message}`) }
const lines = src.split('\n')
const at = lines.map((l, i) => (l === SEAM ? i : -1)).filter(i => i >= 0)
if (at.length !== 1) fail(`${srcPath} must contain the line "${SEAM}" exactly once; found ${at.length}`)

// Embedded as JSON.parse of a string literal, not as an object literal: an
// object literal treats a "__proto__" key as the prototype and drops it, while
// JSON.parse keeps it as a plain key, exactly as reading the state file does.
const PREFIX = `const ${seamName} = JSON.parse(`
const injected = `${PREFIX}${JSON.stringify(JSON.stringify(state))})`
lines[at[0]] = injected
const out = lines.join('\n')

// Prove the copy carries the state unchanged and nothing else moved. The string
// literal JSON.stringify writes is itself valid JSON, so it parses the same way here.
const back = JSON.parse(JSON.parse(injected.slice(PREFIX.length, -1)))
if (!isDeepStrictEqual(back, state)) fail(`the embedded state does not round-trip to ${statePath}`)
const changed = out.split('\n').filter((l, i) => l !== src.split('\n')[i]).length
if (changed !== 1) fail(`expected exactly 1 changed line, got ${changed}`)

const abs = resolve(outPath)
try { writeFileSync(abs, out) } catch (e) { fail(`cannot write ${abs}: ${e.message}`) }
console.log(`run-script: wrote ${abs} (${seamName} ${Buffer.byteLength(stateText)} bytes, 1 line changed from ${srcPath})`)
