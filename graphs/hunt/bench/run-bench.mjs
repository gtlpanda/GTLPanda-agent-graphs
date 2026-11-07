#!/usr/bin/env node
// run-bench.mjs - the /bughunt benchmark, live. Builds the fixture repos
// (make-fixtures.mjs), runs one fresh headless `claude -p "/bughunt pr --base main"`
// per case (with --fix for the cases named by --fix), then scores each ledger
// against the case's truth.json with findings.mjs metrics. Costs real money:
// opt-in, never part of scripts/test.sh. See scripts/bench-bughunt.sh.
//   node run-bench.mjs <out dir> [--cases a,b] [--fix a,b] [--model opus] [--timeout-min 60]
// Writes <out dir>/results.json, prints one line per case, then the totals and
// BENCH-BUGHUNT: DONE <n> case(s) (or FAIL when a case produced no ledger).
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES, build } from './make-fixtures.mjs'
import { nameKey } from '../skills/bughunt/intake.mjs'
import { readLedger, metrics, disposition } from '../../../core/skills/findings/findings.mjs'
import { buildEnv, git } from '../../build/skills/build-app/driver/proc.mjs'
import { sessionSettings, runClaude, readResult, NO_BG_CEILING } from '../../build/skills/build-app/driver/session.mjs'

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
const HOOKS = join(HERE, '..', '..', 'build', 'skills', 'build-app', 'driver', 'hooks')
export const BENCH_PROMPT = 'UNATTENDED BENCHMARK RUN (PandaStack /bughunt). No human is present. Run the /bughunt command you were given exactly, and stop when it reports. Never enter plan mode, never ask a question, never push. Where user-level instructions conflict (plan mode, asking before acting, worktree isolation, retro or changelog updates), the /bughunt skill wins in this session.'

export function parseArgs(argv) {
  const [out, ...rest] = argv
  if (!out || out.startsWith('--')) throw new Error('usage')
  const o = { out, cases: Object.keys(CASES), fix: [], model: 'opus', timeoutMin: 60 }
  for (let i = 0; i < rest.length; i += 2) {
    const v = rest[i + 1]
    if (v === undefined) throw new Error('usage')
    if (rest[i] === '--cases') o.cases = v.split(',')
    else if (rest[i] === '--fix') o.fix = v.split(',')
    else if (rest[i] === '--model') o.model = v
    else if (rest[i] === '--timeout-min') o.timeoutMin = Number(v)
    else throw new Error('usage')
  }
  for (const c of [...o.cases, ...o.fix]) if (!CASES[c]) throw new Error(`no case ${c}`)
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0) throw new Error('usage')
  return o
}

// One case's score: the ledger against the truth, plus cost, time, and (fix
// mode) the commits on the fix branch.
export function scoreCase(name, dir, logFile, seconds, fixMode) {
  const key = nameKey('', 'pr')
  const ledgerFile = join(dir, '.git', 'bughunt', key, 'ledger.json')
  const truth = JSON.parse(readFileSync(join(dirname(dir), `${name}.truth.json`), 'utf8'))
  const result = readResult(logFile)
  const row = { case: name, truth_bugs: truth.bugs.length, cost_usd: result && Number.isFinite(Number(result.total_cost_usd)) ? Number(result.total_cost_usd) : null, seconds, fix_mode: fixMode }
  if (!existsSync(ledgerFile)) return { ...row, ledger: false }
  const l = readLedger(ledgerFile, key)
  const m = metrics(l, truth)
  const fixBranch = `bughunt/${key}`
  const fixCommits = fixMode && git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${fixBranch}`]).ok
    ? git(dir, ['log', '--format=%s', `pr..${fixBranch}`]).stdout.split('\n').filter(Boolean).length
    : 0
  return {
    ...row, ledger: true, status: l.status, disposition: disposition(l).disposition,
    findings: m.findings, true_positives: m.true_positives, false_positives: m.false_positives,
    found: Math.round((m.recall || 0) * truth.bugs.length),
    missed: truth.bugs.length - Math.round((m.recall || 0) * truth.bugs.length),
    reproduced: l.findings.filter(f => !f.stale && f.verification_status === 'reproduced').length,
    refuted: l.findings.filter(f => f.verification_status === 'refuted').length,
    fixes_verified: l.findings.filter(f => f.fix_status === 'verified').length, fix_commits: fixCommits,
  }
}

// Discovery is scored over the discover runs only: a fix-mode run hunts a case
// a second time, so counting it would count its bugs twice. Fix runs are
// reported on their own; cost and time cover every run.
export function totals(all) {
  const rows = all.filter(r => !r.fix_mode)
  const fixRows = all.filter(r => r.fix_mode)
  const sum = k => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0)
  const sumAll = k => all.reduce((n, r) => n + (Number(r[k]) || 0), 0)
  // Precision is over reported findings (a second report of one bug counts as a
  // true positive and as a duplicate); recall is over true bugs found.
  const tp = sum('true_positives')
  const fp = sum('false_positives')
  const truthBugs = sum('truth_bugs')
  const found = sum('found')
  const clean = rows.filter(r => r.truth_bugs === 0)
  const cost = rows.every(r => r.cost_usd !== null) ? Math.round(sum('cost_usd') * 100) / 100 : null
  const costAll = all.every(r => r.cost_usd !== null) ? Math.round(sumAll('cost_usd') * 100) / 100 : null
  return {
    runs: all.length, cases: rows.length, truth_bugs: truthBugs, bugs_found: found, true_positives: tp, duplicate_reports: tp - found, false_positives: fp, missed: sum('missed'),
    precision: tp + fp ? Math.round((tp / (tp + fp)) * 1000) / 1000 : null,
    recall: truthBugs ? Math.round((found / truthBugs) * 1000) / 1000 : null,
    clean_cases: clean.length, clean_cases_with_false_positives: clean.filter(r => r.false_positives > 0).length,
    reproduced: sum('reproduced'), refuted: sum('refuted'),
    discover_cost_usd: cost, cost_per_true_bug: cost !== null && found ? Math.round((cost / found) * 100) / 100 : null, discover_seconds: sum('seconds'),
    fix_runs: fixRows.length, fixes_verified: fixRows.reduce((n, r) => n + (Number(r.fixes_verified) || 0), 0), fix_commits: fixRows.reduce((n, r) => n + (Number(r.fix_commits) || 0), 0),
    cost_usd: costAll, seconds: sumAll('seconds'),
  }
}

async function main(argv) {
  let o
  try { o = parseArgs(argv) } catch (e) { console.error(e.message === 'usage' ? 'usage: run-bench.mjs <out dir> [--cases a,b] [--fix a,b] [--model opus] [--timeout-min 60]' : e.message); return 2 }
  mkdirSync(o.out, { recursive: true })
  const settingsFile = join(o.out, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(sessionSettings(HOOKS), null, 2))
  const runs = [...o.cases.map(c => [c, false]), ...o.fix.map(c => [c, true])]
  const rows = []
  for (const [name, fixMode] of runs) {
    const out = fixMode ? join(o.out, 'fix') : o.out
    mkdirSync(out, { recursive: true })
    const dir = build(out, name)
    const logFile = join(out, `${name}.jsonl`)
    const started = Date.now()
    const code = await runClaude({
      bin: process.env.BENCH_CLAUDE_BIN || 'claude', repo: dir, logFile, timeoutMs: o.timeoutMin * 60_000,
      args: ['-p', `/bughunt pr --base main${fixMode ? ' --fix' : ''}`, '--model', o.model, '--permission-mode', 'bypassPermissions', '--settings', settingsFile, '--append-system-prompt', BENCH_PROMPT, '--output-format', 'stream-json', '--verbose'],
      env: buildEnv(NO_BG_CEILING),
    })
    const row = { ...scoreCase(name, dir, logFile, Math.round((Date.now() - started) / 1000), fixMode), exit: code }
    rows.push(row)
    writeFileSync(join(o.out, 'results.json'), JSON.stringify({ rows, totals: totals(rows) }, null, 2) + '\n')
    console.log(`${name}${fixMode ? ' (fix)' : ''}: exit ${code}, ${row.ledger ? `${row.findings} finding(s), TP ${row.true_positives}, FP ${row.false_positives}, missed ${row.missed}, reproduced ${row.reproduced}, ${row.disposition}${fixMode ? `, ${row.fixes_verified} fix(es) verified, ${row.fix_commits} commit(s)` : ''}` : 'NO LEDGER'}, $${row.cost_usd ?? '?'}, ${row.seconds}s`)
  }
  const t = totals(rows)
  console.log(`TOTALS: ${JSON.stringify(t)}`)
  const missing = rows.filter(r => !r.ledger).length
  console.log(missing ? `BENCH-BUGHUNT: FAIL ${missing} case(s) produced no ledger` : `BENCH-BUGHUNT: DONE ${rows.length} case(s)`)
  return missing ? 1 : 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
