#!/usr/bin/env node
// A fake `claude` for the driver tests. Each call takes the next step from the
// JSON array in $FAKE_CLAUDE_SCRIPT, records its args and env in <script>.calls,
// and acts it out in the repo (its cwd):
//   { dev: 'done'|'escalate'|'needs-human', commits: [{ subject, files: {path: text} }],
//     dirty: {path: text}, questions: [..], reason }   a /dev session and its ledger
//   { limit: 'text' } | { error: 'text' }                an API failure, exit 1
//   { hang: true }                                       runs until killed
//   { ok: true }                                         a probe that succeeds
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT
const steps = JSON.parse(readFileSync(scriptFile, 'utf8'))
const counter = `${scriptFile}.n`
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(n + 1))
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HARNESS_BUILD_|CLAUDE)/.test(k)))
const guard = process.env.HARNESS_BUILD_GUARD && existsSync(process.env.HARNESS_BUILD_GUARD) ? JSON.parse(readFileSync(process.env.HARNESS_BUILD_GUARD, 'utf8')) : null
appendFileSync(`${scriptFile}.calls`, `${JSON.stringify({ args: process.argv.slice(2), env, cwd: process.cwd(), guard })}\n`)
const step = steps[n]
const result = (fields) => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.01, result: 'ok', ...fields }))
const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), stdio: 'pipe' })
if (!step) { result({ subtype: 'error_during_execution', is_error: true, result: 'fake-claude: no step left' }); process.exit(1) }
if (step.hang) setInterval(() => {}, 1000)
else if (step.limit || step.error) { result({ subtype: 'error_during_execution', is_error: true, result: step.limit || step.error }); process.exit(1) }
else if (step.ok) result({})
else {
  const write = files => { for (const [p, text] of Object.entries(files || {})) { mkdirSync(dirname(join(process.cwd(), p)), { recursive: true }); writeFileSync(join(process.cwd(), p), text) } }
  for (const c of step.commits || []) { write(c.files); git('add', '-A'); git('commit', '-q', '-m', c.subject) }
  write(step.dirty)
  const devDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'harness-dev'], { encoding: 'utf8' }).trim()
  mkdirSync(devDir, { recursive: true })
  writeFileSync(join(devDir, 'ledger.json'), JSON.stringify({ status: step.dev, reason: step.reason || `${step.dev}`, questions: step.questions || [] }))
  result({})
}
