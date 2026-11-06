// write-docs.test.mjs — the approved design and backlog become exactly these
// files, the same every time, and nothing is ever overwritten.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { planDocs, renderDesign, knowledgeMap, designDoc, BACKLOG, KNOWLEDGE_MAP } from '../skills/blueprint/write-docs.mjs'
const DESIGN_DOC = designDoc('reading-list')

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', 'skills', 'blueprint', 'write-docs.mjs')

const DESIGN = (over = {}) => ({
  summary: 'A reading list.',
  modules: [
    { id: 'M1', name: 'books', responsibility: 'store books', requirements: ['R1'], boundary: true, shapes: [{ name: 'Repo', sketch: 'x' }, { name: 'Query', sketch: 'y' }], pick: 'Repo', depth_reason: 'hides SQL' },
    { id: 'M2', name: 'reading', responsibility: 'read state', requirements: ['R2'], boundary: false, shapes: [], pick: '', depth_reason: '' },
  ],
  failure_modes: [{ id: 'F1', what: 'db down', module: 'M1', silent: false, tested: true, handled: true, plan: '503' }],
  adrs: [{ id: 'ADR1', title: 'db', options: ['SQLite', 'Postgres'], decision: 'SQLite', reason: 'one user' }],
  departures: [],
  knowledge: [{ id: 'K1', knowledge: 'book shape', kind: 'type', owner: 'src/books/book.ts', used_by: ['M1', 'M2'], changes_together_because: 'one row shape' },
    { id: 'K2', knowledge: 'who may read', kind: 'authz', owner: '', used_by: ['M2'], changes_together_because: 'one rule' }],
  premises: [{ claim: 'SQLite has JSON', evidence: 'docs', status: 'VERIFIED' }],
  ...over,
})
const ac = sid => [{ id: `${sid}-AC1`, criterion: 'c', fails_when: 'f' }]
const SLICES = [
  { id: 'S1', title: 'scaffold', goal: 'g1', requirements: [], acceptance: ac('S1'), depends_on: [] },
  { id: 'S2', title: 'books', goal: 'g2', requirements: ['R1'], acceptance: ac('S2'), depends_on: ['S1'] },
  { id: 'S3', title: 'reading', goal: 'g3', requirements: ['R2'], acceptance: ac('S3'), depends_on: ['S2'] },
]
const RUN2 = (over = {}) => ({ status: 'design-ready', design: DESIGN(), ...over })
const RUN3 = (over = {}) => ({
  status: 'backlog-ready',
  backlog: { version: 1, app: 'reading-list', integrationBranch: 'integration/reading-list', requirements: ['R1', 'R2'], slices: SLICES },
  owners: [{ id: 'K1', built_in: 'S2', used_by: ['S3', 'S2'] }, { id: 'K2', built_in: 'S3', used_by: ['S3'] }],
  ...over,
})

console.log('== write-docs: what is written')
await test('an approved run gives the design, the backlog verbatim, and the knowledge map', () => {
  const files = planDocs(RUN2(), RUN3())
  assert.deepEqual(files.map(f => f.path), [DESIGN_DOC, BACKLOG, KNOWLEDGE_MAP])
  assert.deepEqual(files.map(f => f.path), ['docs/blueprint/reading-list.md', 'docs/backlog.json', 'docs/knowledge-map.json'])
  assert.deepEqual(JSON.parse(files[1].text), RUN3().backlog)
  assert.ok(files.every(f => f.text.endsWith('\n')))
  assert.deepEqual(planDocs(RUN2(), RUN3()), files, 'the same runs always give the same files')
})
await test('the knowledge map follows the knowledge-map format: planned, used_by in build order, an empty owner is null', () => {
  const map = knowledgeMap(DESIGN(), RUN3().owners, SLICES)
  assert.deepEqual(map, {
    version: 1,
    items: [
      { id: 'K1', knowledge: 'book shape', kind: 'type', owner: 'src/books/book.ts', status: 'planned', used_by: ['S2', 'S3'], changes_together_because: 'one row shape' },
      { id: 'K2', knowledge: 'who may read', kind: 'authz', owner: null, status: 'planned', used_by: ['S3'], changes_together_because: 'one rule' },
    ],
  })
})
await test('a design with no knowledge items writes no knowledge map', () => {
  const files = planDocs(RUN2({ design: DESIGN({ knowledge: [] }) }), RUN3({ owners: [] }))
  assert.deepEqual(files.map(f => f.path), [DESIGN_DOC, BACKLOG])
})
await test('the design doc has every section, the boundary pick, and "None." for an empty one', () => {
  const md = renderDesign('reading-list', DESIGN())
  assert.match(md, /^# Design: reading-list\n\nA reading list\.\n/)
  assert.match(md, /- \*\*M1 books\*\*: store books \(R1\)\n {2}- Boundary: picked Repo over Query\. hides SQL/)
  assert.match(md, /- \*\*M2 reading\*\*: read state \(R2\)\n/)
  assert.match(md, /- \*\*F1\*\* \(M1\): db down\. Plan: 503 \(visible, tested, handled\)/)
  assert.match(md, /- \*\*ADR1 db\*\*: SQLite \(options: SQLite, Postgres\)\. one user/)
  assert.match(md, /## Departures from the default stack\n\nNone\.\n/)
  assert.match(md, /- VERIFIED: SQLite has JSON \(docs\)/)
})
await test('only approved runs with a passing backlog and every knowledge item placed are written', () => {
  const cases = [
    [RUN2({ status: 'escalate' }), RUN3(), /run2 is not a design-ready design run/],
    [RUN2({ design: null }), RUN3(), /run2 is not a design-ready/],
    [null, RUN3(), /run2 is not/],
    [RUN2(), RUN3({ status: 'needs-human' }), /run3 is not a backlog-ready backlog run/],
    [RUN2(), RUN3({ backlog: { ...RUN3().backlog, app: 'Bad App' } }), /the backlog does not pass its check: app must be a lowercase slug/],
    [RUN2(), RUN3({ owners: [RUN3().owners[0]] }), /knowledge K2 has no slices in the backlog run/],
    [RUN2(), RUN3({ owners: [RUN3().owners[0], { id: 'K2', built_in: 'S9', used_by: ['S9'] }] }), /knowledge K2 names a slice the backlog lacks/],
    [RUN2(), RUN3({ owners: [RUN3().owners[0], { id: 'K2', built_in: 'S3', used_by: [] }] }), /knowledge K2 names a slice the backlog lacks/],
  ]
  for (const [r2, r3, why] of cases) assert.throws(() => planDocs(r2, r3), why, String(why))
})

console.log('== write-docs: the command')
const tmp = mkdtempSync(join(tmpdir(), 'write-docs-'))
const runs = (r2 = RUN2(), r3 = RUN3()) => {
  const d = mkdtempSync(join(tmp, 'runs-'))
  writeFileSync(join(d, 'run2.json'), JSON.stringify(r2))
  writeFileSync(join(d, 'run3.json'), JSON.stringify(r3))
  return [join(d, 'run2.json'), join(d, 'run3.json')]
}
const cli = (args, script = SCRIPT) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
await test('the command writes the files and names them, exit 0', () => {
  const repo = mkdtempSync(join(tmp, 'repo-'))
  const r = cli([...runs(), repo])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, 'write-docs: wrote docs/blueprint/reading-list.md docs/backlog.json docs/knowledge-map.json\n')
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'docs', 'backlog.json'), 'utf8')), RUN3().backlog)
  assert.equal(readFileSync(join(repo, DESIGN_DOC), 'utf8'), planDocs(RUN2(), RUN3())[0].text)
})
await test('what a repo already has: a design doc or a foreign file is refused and nothing is written', () => {
  const cases = [
    [DESIGN_DOC, '# mine', /docs\/blueprint\/reading-list\.md already exists: an app named reading-list was blueprinted here before/],
    [BACKLOG, '{"mine": true}', /docs\/backlog\.json exists and is not a backlog; nothing was overwritten/],
    [BACKLOG, 'not json', /docs\/backlog\.json exists and is not a backlog/],
    [KNOWLEDGE_MAP, 'mine', /docs\/knowledge-map\.json is not valid JSON/],
    [KNOWLEDGE_MAP, '{"version": 2, "items": []}', /docs\/knowledge-map\.json is not a version 1 knowledge map; nothing was overwritten/],
    [KNOWLEDGE_MAP, JSON.stringify({ version: 1, items: [{ id: 'K2' }] }), /knowledge K2 is already in docs\/knowledge-map\.json: ids are never reused/],
  ]
  for (const [path, text, why] of cases) {
    const repo = mkdtempSync(join(tmp, 'repo-'))
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
    const r = cli([...runs(), repo])
    assert.equal(r.status, 1, path)
    assert.match(r.stdout, why, path)
    assert.equal(readFileSync(join(repo, path), 'utf8'), text, 'never overwritten')
    for (const other of [DESIGN_DOC, BACKLOG, KNOWLEDGE_MAP].filter(p => p !== path)) assert.equal(existsSync(join(repo, other)), false, `${other} written after a FAIL`)
  }
})
await test('a second /blueprint in the repo: the old backlog is replaced and the map gains the new items', () => {
  const repo = mkdtempSync(join(tmp, 'repo-'))
  mkdirSync(join(repo, 'docs', 'blueprint'), { recursive: true })
  const oldBacklog = { ...RUN3().backlog, app: 'first-app', integrationBranch: 'integration/first-app' }
  writeFileSync(join(repo, BACKLOG), JSON.stringify(oldBacklog))
  writeFileSync(join(repo, designDoc('first-app')), '# first')
  const oldItem = { id: 'K1', knowledge: 'k', kind: 'type', owner: 'src/k.ts', status: 'built', used_by: ['S1', 'S2'], changes_together_because: 'c' }
  writeFileSync(join(repo, KNOWLEDGE_MAP), JSON.stringify({ version: 1, items: [oldItem] }))
  const design = DESIGN({ knowledge: DESIGN().knowledge.map((k, i) => ({ ...k, id: `K${i + 2}` })) })
  const owners = [{ id: 'K2', built_in: 'S2', used_by: ['S2', 'S3'] }, { id: 'K3', built_in: 'S3', used_by: ['S3'] }]
  const r = cli([...runs(RUN2({ design }), RUN3({ owners })), repo])
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(JSON.parse(readFileSync(join(repo, BACKLOG), 'utf8')), RUN3().backlog)
  assert.deepEqual(JSON.parse(readFileSync(join(repo, KNOWLEDGE_MAP), 'utf8')).items.map(i => [i.id, i.status]), [['K1', 'built'], ['K2', 'planned'], ['K3', 'planned']])
  assert.equal(readFileSync(join(repo, designDoc('first-app')), 'utf8'), '# first', 'another app\'s design doc is left alone')
})
await test('a failed check, a missing or broken run file is a FAIL with the reason; bad usage exits 2', () => {
  const repo = mkdtempSync(join(tmp, 'repo-'))
  const bad = cli([...runs(RUN2({ status: 'escalate' })), repo])
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^write-docs: FAIL run2 is not a design-ready design run\n$/)
  const [r2] = runs()
  const missing = cli([r2, join(tmp, 'nope.json'), repo])
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /FAIL cannot read .*nope\.json: ENOENT/)
  writeFileSync(join(tmp, 'broken.json'), '{')
  assert.match(cli([r2, join(tmp, 'broken.json'), repo]).stdout, /FAIL .*broken\.json is not valid JSON/)
  assert.equal(existsSync(join(repo, 'docs')), false, 'nothing written on any failure')
  const usage = cli([r2])
  assert.equal(usage.status, 2)
  assert.match(usage.stdout, /^usage: write-docs\.mjs <run2\.json> <run3\.json> <repo>/)
})
await test('the command runs through a symlinked skill directory, the way install.sh links it', () => {
  const link = join(tmp, 'skill-link')
  symlinkSync(dirname(SCRIPT), link)
  const repo = mkdtempSync(join(tmp, 'repo-'))
  const r = cli([...runs(), repo], join(link, 'write-docs.mjs'))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(existsSync(join(repo, 'docs', 'backlog.json')))
})
