// bench.test.mjs — the /bughunt benchmark, offline: every fixture builds and
// its suite passes at the base, every truth points at real changed lines, and
// the runner's orchestration and scoring work against a fake claude.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { CASES, build } from '../bench/make-fixtures.mjs'
import { parseArgs, totals } from '../bench/run-bench.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(here, '..', 'bench', 'run-bench.mjs')
const FAKE = join(here, 'fixtures', 'fake-bench-claude.mjs')
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim()

console.log('== bench: the fixtures')
const out = mkdtempSync(join(tmpdir(), 'bench-fixtures-'))
await test('there are 10 cases: 6 planted bugs, 1 misleading change, 3 clean changes', () => {
  const names = Object.keys(CASES)
  assert.equal(names.length, 10)
  assert.equal(names.filter(n => CASES[n].bugs.length).length, 6)
  assert.deepEqual(names.filter(n => !CASES[n].bugs.length).sort(), ['clean-docs', 'clean-refactor', 'clean-test-only', 'misleading-correct'])
})
for (const name of Object.keys(CASES)) {
  await test(`${name}: builds, its suite passes at the base, and its truth points at lines the change touched`, () => {
    const dir = build(out, name)
    git(dir, 'checkout', '-q', 'main')
    const base = spawnSync('npm', ['--prefix', dir, 'test'], { encoding: 'utf8' })
    git(dir, 'checkout', '-q', 'pr')
    assert.equal(base.status, 0, `the suite fails at the base: ${base.stdout.slice(-400)}`)
    const truth = JSON.parse(readFileSync(join(out, `${name}.truth.json`), 'utf8'))
    assert.deepEqual(truth.bugs, CASES[name].bugs)
    for (const b of truth.bugs) {
      const lines = readFileSync(join(dir, b.file_path), 'utf8').split('\n').length - 1
      assert.ok(b.line_range[0] >= 1 && b.line_range[1] <= lines, `${b.file_path}:${b.line_range} is outside the file (${lines} lines)`)
      // contract-return-shape's bug is in an unchanged caller (greet.js) of the changed callee (users.js).
      if (name === 'contract-return-shape') {
        assert.equal(b.file_path, 'src/greet.js')
        assert.match(git(dir, 'diff', '--name-only', 'main', 'pr'), /^src\/users\.js$/m)
        continue
      }
      const hunks = [...git(dir, 'diff', '-U0', 'main', 'pr', '--', b.file_path).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(m => { const s = Number(m[1]); const n = m[2] === undefined ? 1 : Number(m[2]); return [s, n > 0 ? s + n - 1 : s] })   // a deletion touches the line it follows, as intake records it
      assert.ok(hunks.some(([s, e]) => s <= b.line_range[1] && b.line_range[0] <= e), `${b.file_path}:${b.line_range} is not on a line the change wrote (hunks ${JSON.stringify(hunks)})`)
    }
  })
}

console.log('== bench: the runner, against a fake claude')
await test('parseArgs takes cases, fix cases, a model, and a timeout, and refuses unknown cases', () => {
  assert.deepEqual(parseArgs(['/o', '--cases', 'clean-docs', '--fix', 'boundary-discount', '--timeout-min', '5']), { out: '/o', cases: ['clean-docs'], fix: ['boundary-discount'], model: 'opus', timeoutMin: 5 })
  for (const bad of [[], ['/o', '--cases'], ['/o', '--cases', 'nope'], ['/o', '--timeout-min', '0'], ['/o', '--what', 'x']]) assert.throws(() => parseArgs(bad), JSON.stringify(bad))
})
await test('the runner scores each ledger against its truth: precision, recall, clean-case false positives, cost per true bug', () => {
  const o = mkdtempSync(join(tmpdir(), 'bench-run-'))
  const r = spawnSync('node', [RUNNER, o, '--cases', 'boundary-discount,clean-docs,clean-refactor'], { encoding: 'utf8', env: { ...process.env, BENCH_CLAUDE_BIN: FAKE } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^boundary-discount: exit 0, 1 finding\(s\), TP 1, FP 0, missed 0, reproduced 1/m)
  assert.match(r.stdout, /^clean-docs: exit 0, 1 finding\(s\), TP 0, FP 1/m)
  assert.match(r.stdout, /BENCH-BUGHUNT: DONE 3 case\(s\)$/m)
  const t = JSON.parse(readFileSync(join(o, 'results.json'), 'utf8')).totals
  assert.deepEqual({ tp: t.true_positives, fp: t.false_positives, p: t.precision, r: t.recall, cleanFp: t.clean_cases_with_false_positives, cost: t.cost_usd, perBug: t.cost_per_true_bug }, { tp: 1, fp: 1, p: 0.5, r: 1, cleanFp: 1, cost: 1.5, perBug: 1.5 })
})
await test('totals: a fix-mode run hunts a case a second time, so discovery counts only discover runs; cost and time cover every run', () => {
  const d = { truth_bugs: 1, found: 1, true_positives: 1, false_positives: 0, missed: 0, cost_usd: 1, seconds: 10 }
  const t = totals([d, { ...d, fix_mode: true, fixes_verified: 1, fix_commits: 1, cost_usd: 2, seconds: 20 }])
  assert.deepEqual({ bugs: t.truth_bugs, found: t.bugs_found, perBug: t.cost_per_true_bug, dcost: t.discover_cost_usd, cost: t.cost_usd, secs: t.seconds, fixes: t.fixes_verified, runs: t.runs }, { bugs: 1, found: 1, perBug: 1, dcost: 1, cost: 3, secs: 30, fixes: 1, runs: 2 })
})
await test('totals: recall counts true bugs found, and a second report of one bug is a duplicate, not a second find', () => {
  const t = totals([{ truth_bugs: 1, found: 1, true_positives: 3, false_positives: 1, missed: 0, cost_usd: 2, seconds: 1 }, { truth_bugs: 1, found: 0, true_positives: 0, false_positives: 0, missed: 1, cost_usd: 1, seconds: 1 }])
  assert.deepEqual({ r: t.recall, p: t.precision, dup: t.duplicate_reports, found: t.bugs_found }, { r: 0.5, p: 0.75, dup: 2, found: 1 })
})
await test('totals: no reported findings gives precision null, not 1; no true bugs gives recall null', () => {
  const t = totals([{ truth_bugs: 0, true_positives: 0, false_positives: 0, missed: 0, cost_usd: 1, seconds: 3 }])
  assert.equal(t.precision, null)
  assert.equal(t.recall, null)
  assert.equal(t.cost_per_true_bug, null)
})
