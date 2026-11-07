#!/usr/bin/env node
// A fake `claude` for the benchmark runner's test. In the fixture repo it runs
// in, it writes a findings ledger: a finding on the case's first true bug when
// the case has one (a true positive), and one invented finding when the case
// name contains "clean-docs" (a false positive). It prints the result line twice,
// as the real stream log does, with a cost of $0.50.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const { mergeFindings, writeLedger, emptyLedger } = await import(join(root, 'core', 'skills', 'findings', 'findings.mjs'))
const { nameKey } = await import(join(root, 'graphs', 'hunt', 'skills', 'bughunt', 'intake.mjs'))
const dir = process.cwd()
const name = basename(dir)
const truth = JSON.parse(readFileSync(join(dirname(dir), `${name}.truth.json`), 'utf8'))
const head = execFileSync('git', ['rev-parse', 'pr'], { cwd: dir, encoding: 'utf8' }).trim()
const cand = (file, range) => ({ file_path: file, line_range: range, bug_category: 'logic', severity: 'HIGH', confidence: 80, title: `bug in ${file}`, description: 'd', failure_scenario: { trigger: 't', path: 'p', observable: 'o' }, expected_behavior: 'e', actual_behavior: 'a', evidence: [{ file, line: range[0], quote: 'x' }], source_agent: 'hunter:logic' })
const cands = []
if (truth.bugs.length) cands.push(cand(truth.bugs[0].file_path, truth.bugs[0].line_range))
if (name.includes('clean-docs')) cands.push(cand('src/x.js', [1, 1]))
const findings = mergeFindings([], cands, head).findings.map(f => ({ ...f, verification_status: 'reproduced' }))
const key = nameKey('', 'pr')
const file = join(dir, '.git', 'bughunt', key, 'ledger.json')
if (!name.includes('no-ledger')) writeLedger(file, { ...emptyLedger(key), findings, status: 'done', runs: [{ at: 't', mode: 'discover', head, status: 'done' }] })
const line = JSON.stringify({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0.5 })
console.log(line)
console.log(line)
