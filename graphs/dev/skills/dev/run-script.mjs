#!/usr/bin/env node
// run-script.mjs — write an approved plan into a runnable copy of dev-build.js.
//
//   node run-script.mjs <plan.json> <out.js> [dev-build.js]
//
// Workflow scripts cannot read files, and an approved plan is too big to retype
// as a Workflow argument, so /dev runs this copy with `scriptPath` instead. The
// copy differs from dev-build.js on exactly one line, `const INJECTED_PLAN = null`.
// Prints "run-script: wrote <absolute out path> ..." and exits 0, or prints
// "run-script: FAIL <why>" and exits 1 without writing anything.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const SEAM = 'const INJECTED_PLAN = null'

function fail(why) {
  console.log(`run-script: FAIL ${why}`)
  process.exit(1)
}

const [planPath, outPath, srcArg] = process.argv.slice(2)
if (!planPath || !outPath) fail('usage: node run-script.mjs <plan.json> <out.js> [dev-build.js]')

// This file is reached through ~/.claude/skills/dev, a symlink into the repo;
// the workflow sits two directories up from the real location.
const here = dirname(realpathSync(fileURLToPath(import.meta.url)))
const srcPath = srcArg || join(here, '..', '..', 'workflows', 'dev-build.js')

let planText
try { planText = readFileSync(planPath, 'utf8') } catch (e) { fail(`cannot read plan ${planPath}: ${e.message}`) }
let plan
try { plan = JSON.parse(planText) } catch (e) { fail(`plan ${planPath} is not valid JSON: ${e.message}`) }
if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail(`plan ${planPath} must be a JSON object`)

let src
try { src = readFileSync(srcPath, 'utf8') } catch (e) { fail(`cannot read workflow ${srcPath}: ${e.message}`) }
const lines = src.split('\n')
const at = lines.map((l, i) => (l === SEAM ? i : -1)).filter(i => i >= 0)
if (at.length !== 1) fail(`${srcPath} must contain the line "${SEAM}" exactly once; found ${at.length}`)

// Embedded as JSON.parse of a string literal, not as an object literal: an
// object literal treats a "__proto__" key as the prototype and drops it, while
// JSON.parse keeps it as a plain key, exactly as reading plan.json does.
const PREFIX = 'const INJECTED_PLAN = JSON.parse('
const injected = `${PREFIX}${JSON.stringify(JSON.stringify(plan))})`
lines[at[0]] = injected
const out = lines.join('\n')

// Prove the copy carries the plan unchanged and nothing else moved. The string
// literal JSON.stringify writes is itself valid JSON, so it parses the same way here.
const back = JSON.parse(JSON.parse(injected.slice(PREFIX.length, -1)))
if (!isDeepStrictEqual(back, plan)) fail('the embedded plan does not round-trip to plan.json')
const changed = out.split('\n').filter((l, i) => l !== src.split('\n')[i]).length
if (changed !== 1) fail(`expected exactly 1 changed line, got ${changed}`)

const abs = resolve(outPath)
try { writeFileSync(abs, out) } catch (e) { fail(`cannot write ${abs}: ${e.message}`) }
console.log(`run-script: wrote ${abs} (plan ${Buffer.byteLength(planText)} bytes, 1 line changed from ${srcPath})`)
