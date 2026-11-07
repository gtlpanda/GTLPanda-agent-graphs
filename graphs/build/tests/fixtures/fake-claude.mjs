#!/usr/bin/env node
// A fake `claude` for the driver tests. Each call takes the next step from the
// JSON array in $FAKE_CLAUDE_SCRIPT, records its args and env in <script>.calls,
// and acts it out in the repo (its cwd):
//   { dev: 'done'|'escalate'|'needs-human', commits: [{ subject, files: {path: text} }],
//     dirty: {path: text}, questions: [..], reason }   a /dev session and its ledger
//     (a commit may also carry sh: a shell command run before it, e.g. a git mv)
//   { limit: 'text' } | { error: 'text' }                an API failure, exit 1
//   { hang: true }                                       runs until killed
//   { ok: true }                                         a probe that succeeds
//   { qa: 'done'|'escalate', commits: [...], reason }    the final QA session: commits, then
//                                                        its report where the prompt says
//   { hunt: 'done'|'escalate'|'none', commits: [...],    the bug hunt session: commits in the fix
//     dirty: {path: text}, findings: [{severity,           worktree the prompt names, then a real
//     status, fix}] }                                    findings ledger in its state dir ('none':
//                                                        no ledger)
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT
const steps = JSON.parse(readFileSync(scriptFile, 'utf8'))
const counter = `${scriptFile}.n`
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(n + 1))
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HARNESS_BUILD_|CLAUDE)/.test(k)))
const guard = process.env.HARNESS_BUILD_GUARD && existsSync(process.env.HARNESS_BUILD_GUARD) ? JSON.parse(readFileSync(process.env.HARNESS_BUILD_GUARD, 'utf8')) : null
appendFileSync(`${scriptFile}.calls`, `${JSON.stringify({ args: process.argv.slice(2), env, cwd: process.cwd(), guard })}\n`)
const step = steps[n]
// The real CLI's stream log repeats its result line (measured 2026-11-05), so this one does too.
const result = (fields) => { const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.01, result: 'ok', ...fields }); console.log(line); console.log(line) }
const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), stdio: 'pipe' })
if (!step) { result({ subtype: 'error_during_execution', is_error: true, result: 'fake-claude: no step left' }); process.exit(1) }
if (step.hang) setInterval(() => {}, 1000)
else if (step.limit || step.error) { result({ subtype: 'error_during_execution', is_error: true, result: step.limit || step.error }); process.exit(1) }
else if (step.ok) result({})
else if (step.qa) {
  const prompt = process.argv[process.argv.indexOf('-p') + 1]
  const report = /as JSON, to (\S+)\.\n/.exec(prompt)
  for (const c of step.commits || []) {
    for (const [p, text] of Object.entries(c.files || {})) { mkdirSync(dirname(join(process.cwd(), p)), { recursive: true }); writeFileSync(join(process.cwd(), p), text) }
    git('add', '-A'); git('commit', '-q', '-m', c.subject)
  }
  if (report) writeFileSync(report[1], JSON.stringify({ status: step.qa, reason: step.reason || 'VERIFY: PASS and no HIGH/CRITICAL findings', touched: [] }))
  result({})
}
else if (step.hunt) {
  const prompt = process.argv[process.argv.indexOf('-p') + 1]
  const state = /"stateDir": "([^"]+)"/.exec(prompt)[1]
  const fixDir = join(state, 'fix')
  const inFix = (...args) => execFileSync('git', ['-C', fixDir, ...args], { stdio: 'pipe' })
  const write = files => { for (const [p, text] of Object.entries(files || {})) { mkdirSync(dirname(join(fixDir, p)), { recursive: true }); writeFileSync(join(fixDir, p), text) } }
  for (const c of step.commits || []) { write(c.files); inFix('add', '-A'); inFix('commit', '-q', '--no-verify', '-m', c.subject) }
  write(step.dirty)
  if (step.hunt !== 'none') {
    const { mergeFindings, writeLedger, emptyLedger } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'core', 'skills', 'findings', 'findings.mjs'))
    const intake = JSON.parse(readFileSync(join(state, 'intake.json'), 'utf8'))
    const head = intake.target.head
    const cand = (f, i) => ({
      file_path: `src/f${i + 1}.js`, line_range: [1, 1], bug_category: 'logic', severity: f.severity || 'HIGH', confidence: 70, title: `bug ${i + 1}`, description: 'd',
      failure_scenario: { trigger: 't', path: 'p', observable: 'o' }, expected_behavior: 'e', actual_behavior: 'a', evidence: [{ file: `src/f${i + 1}.js`, line: 1, quote: 'x' }], source_agent: 'hunter:logic',
    })
    const found = step.findings || []
    const findings = mergeFindings([], found.map(cand), head).findings.map((f, i) => ({ ...f, verification_status: found[i].status || 'reproduced', fix_status: found[i].fix || 'none' }))
    writeLedger(join(state, 'ledger.json'), { ...emptyLedger(intake.key), target: intake.target, findings, status: step.hunt, runs: [{ at: 't', mode: 'fix', head, status: step.hunt, reason: step.reason || 'r', added: [], merged: 0, dropped: 0, calls: 1 }] })
  }
  result({})
}
else {
  const write = files => { for (const [p, text] of Object.entries(files || {})) { mkdirSync(dirname(join(process.cwd(), p)), { recursive: true }); writeFileSync(join(process.cwd(), p), text) } }
  for (const c of step.commits || []) { if (c.sh) execFileSync('bash', ['-c', c.sh], { cwd: process.cwd() }); write(c.files); git('add', '-A'); git('commit', '-q', '-m', c.subject) }
  write(step.dirty)
  const devDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'harness-dev'], { encoding: 'utf8' }).trim()
  mkdirSync(devDir, { recursive: true })
  writeFileSync(join(devDir, 'ledger.json'), JSON.stringify({ status: step.dev, reason: step.reason || `${step.dev}`, questions: step.questions || [] }))
  result({})
}
