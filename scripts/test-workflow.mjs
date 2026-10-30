// test-workflow.mjs — run every graph's workflow tests against scripted agents,
// then check every workflow file loads. Test files: tests/*.test.mjs and
// graphs/<name>/tests/*.test.mjs. Ends with TEST-WORKFLOW: N passed, M failed.
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO, test, load, summary, entryDirs } from './workflow-harness.mjs'

function testFiles() {
  const graphs = existsSync(join(REPO, 'graphs')) ? readdirSync(join(REPO, 'graphs')).map(g => join('graphs', g)) : []
  return ['', ...graphs]
    .map(d => join(REPO, d, 'tests'))
    .filter(d => existsSync(d))
    .flatMap(d => readdirSync(d).filter(f => f.endsWith('.test.mjs')).map(f => join(d, f)))
}

const files = testFiles()
await test('at least one workflow test file exists', () => {
  if (!files.length) throw new Error('no tests/*.test.mjs or graphs/*/tests/*.test.mjs found')
})
for (const f of files) {
  // A file that throws outside test() (bad import, load failure) counts as one failure.
  try { await import(pathToFileURL(f).href) }
  catch (e) { await test(`${f.slice(REPO.length + 1)} loads`, () => { throw e }) }
}

console.log('== every workflow file parses')
for (const d of entryDirs('workflows')) {
  for (const f of readdirSync(d).filter(f => f.endsWith('.js'))) {
    await test(`${join(d, f).slice(REPO.length + 1)} parses with a pure-literal meta`, () => { load(join(d, f)) })
  }
}

const { pass, fail } = summary()
console.log(`\nTEST-WORKFLOW: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
