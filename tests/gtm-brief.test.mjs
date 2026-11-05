// gtm-brief.test.mjs — the GTM brief checker (core/skills/gtm-brief/gtm-brief.mjs).
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { checkBrief, readBrief, SECTIONS } from '../core/skills/gtm-brief/gtm-brief.mjs'

const SKILL = join(REPO, 'core', 'skills', 'gtm-brief')
const SCRIPT = join(SKILL, 'gtm-brief.mjs')

const BRIEF = `# Shelf GTM brief

## Product
Shelf keeps a reading list per person.

## Customer
Readers who lose track of books friends recommend: "I always forget the title."

## Positioning
A notes app today. We win because a book is one tap and the list splits read and to-read.

## Voice
Do: plain and warm. Don't: hype.

## Proof
- Adding a book takes one tap - source: https://example.com/demo
- 9 of 10 testers kept using it a week later - source: interview 2026-10-02

## Never claim
- That we sync with Goodreads: we do not.

## Compliance
none
`
const messages = text => checkBrief(text).map(p => p.message)
const without = (text, heading) => text.replace(new RegExp(`## ${heading}\\n[^#]*`), '')

console.log('== gtm-brief: the format')
await test('a complete brief passes', async () => {
  assert.deepEqual(checkBrief(BRIEF), [])
})
await test('the template in SKILL.md passes once its placeholders are filled, so the doc and the code cannot drift', async () => {
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8')
  const template = /```markdown\n([\s\S]*?)\n```/.exec(skill)[1]
  assert.ok(messages(template).some(m => /placeholder/.test(m)), 'the unfilled template must fail')
  assert.deepEqual(checkBrief(template.replace(/<[^<>\n]+>/g, 'filled')), [])
  for (const name of SECTIONS) assert.match(template, new RegExp(`^## ${name}$`, 'm'))
})
await test('each missing section is named', async () => {
  for (const name of SECTIONS) {
    assert.ok(messages(without(BRIEF, name)).includes(`section "## ${name}" is missing`), name)
  }
})
await test('an empty or duplicated section fails with its line', async () => {
  assert.deepEqual(checkBrief(BRIEF.replace('none\n', '')), [{ line: 22, message: 'section "Compliance" is empty' }])
  const twice = BRIEF + '\n## Voice\nLoud.\n'
  assert.deepEqual(checkBrief(twice), [{ line: 25, message: 'section "Voice" appears twice (first at line 12)' }])
})
await test('a proof without a source, or a prose line in a list section, fails', async () => {
  assert.deepEqual(messages(BRIEF.replace(' - source: https://example.com/demo', '')), [
    'a Proof item needs a claim and a source: "- <claim> - source: <url, file:line, or interview date>"',
  ])
  assert.deepEqual(messages(BRIEF.replace('- That we sync', 'That we sync')), ['Never claim lines must be "- " list items'])
  for (const empty of ['  - source', '- - source', '* - source', '-   - source']) {
    assert.deepEqual(messages(BRIEF.replace('- Adding a book takes one tap - source', empty)), ['a Proof item needs a claim and a source: "- <claim> - source: <url, file:line, or interview date>"'], empty)
  }
  for (const non of ['n/a', 'N/A', 'none', 'unknown', '?', 'TBD']) {
    const got = messages(BRIEF.replace('interview 2026-10-02', non))
    assert.ok(got.includes(`"${non}" is not a source`), `${non}: ${got}`)
  }
  assert.deepEqual(checkBrief(BRIEF.replace('- Adding', '* Adding')), [], 'a * bullet is a list item')
  assert.deepEqual(messages(BRIEF.replace('- source: interview 2026-10-02', '- source:   ')), [
    'a Proof item needs a claim and a source: "- <claim> - source: <url, file:line, or interview date>"',
  ])
})
await test('placeholders left in fail; autolinks, tags, comparisons, inline code, and fenced code do not', async () => {
  assert.deepEqual(messages(BRIEF.replace('plain and warm', '<your name@here>')), ['a <...> placeholder is left in'])
  assert.deepEqual(messages(BRIEF + '\n## Roadmap TBD\nsoon\n'), ['a TBD is left in'])
  assert.deepEqual(messages(BRIEF.replace('Shelf GTM', '<Product name> GTM')), ['a <...> placeholder is left in'])
  for (const fine of ['loads in <2s, >99.9% uptime', 'never say `<form here>`', 'H<sub>2</sub>O and A<b', '<a href="https://x">site</a>']) {
    assert.deepEqual(checkBrief(BRIEF.replace('plain and warm', fine)), [], fine)
  }
  assert.deepEqual(messages(BRIEF.replace('plain and warm', '<how we sound>')), ['a <...> placeholder is left in'])
  assert.deepEqual(messages(BRIEF.replace('none', 'TODO')), ['a TODO is left in'])
  assert.deepEqual(messages(BRIEF.replace('none', 'TBD')), ['a TBD is left in'])
  const autolinks = BRIEF.replace('https://example.com/demo', '<https://example.com/demo>').replace('none', 'Write to <legal@example.com> first.')
  assert.deepEqual(checkBrief(autolinks), [])
  assert.deepEqual(checkBrief(BRIEF.replace('none', 'none\n```\n<example> TODO\n```')), [])
})

console.log('== gtm-brief: adversarial input')
await test('"source:" inside the claim text is not a source; only the trailing " - source: " counts', async () => {
  assert.equal(messages(BRIEF.replace('- Adding a book takes one tap - source: https://example.com/demo', '- Our source: code is open')).length, 1)
  assert.deepEqual(checkBrief(BRIEF.replace('- Adding a book takes one tap', '- Our source: code is open')), [])
  assert.deepEqual(checkBrief(BRIEF.replace(' - source: https', ' — source: https')), [])
})
await test('a heading inside a fenced block, or at the wrong level, is not a section', async () => {
  const fenced = without(BRIEF, 'Compliance') + '```\n## Compliance\nnone\n```\n'
  assert.ok(messages(fenced).includes('section "## Compliance" is missing'))
  assert.ok(messages(BRIEF.replace('## Proof', '### Proof')).includes('section "## Proof" is missing'))
  assert.deepEqual(checkBrief(BRIEF + '```\nnever closed\n'), [{ line: 24, message: 'a fenced code block is never closed' }])
  const noCompliance = without(BRIEF, 'Compliance')
  for (const [name, block] of [
    ['a ``` fence is not closed by ~~~', '```\n~~~\n## Compliance\nnone\n```\n'],
    ['a ```` fence holds a ``` example', '````\n```\n## Compliance\nnone\n```\n````\n'],
    ['a fence with an info string still opens', '```markdown\n## Compliance\nnone\n```\n'],
  ]) assert.ok(messages(noCompliance + block).includes('section "## Compliance" is missing'), name)
  assert.ok(!messages(BRIEF.replace('## Compliance', '    ```\n## Compliance')).includes('section "## Compliance" is missing'), 'a 4-space-indented ``` is not a fence')
})
await test('CRLF line endings and trailing spaces pass like LF', async () => {
  assert.deepEqual(checkBrief(BRIEF.replace(/\n/g, '\r\n')), [])
  assert.deepEqual(checkBrief(BRIEF.replace('## Voice', '## Voice   ')), [])
})
await test('an empty brief names every section', async () => {
  assert.equal(checkBrief('').length, SECTIONS.length)
})
await test('a missing, binary, or non-UTF-8 file is a plain error, never a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtm-brief-'))
  try {
    assert.throws(() => readBrief(join(dir, 'nope.md')), /cannot read .*nope\.md: ENOENT/)
    writeFileSync(join(dir, 'bin.md'), Buffer.from([0x23, 0x00, 0x01]))
    assert.throws(() => readBrief(join(dir, 'bin.md')), /is not a text file/)
    writeFileSync(join(dir, 'latin1.md'), Buffer.from([0x23, 0x20, 0xe9, 0x0a]))
    assert.throws(() => readBrief(join(dir, 'latin1.md')), /is not UTF-8 text/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('== gtm-brief: the command')
const cli = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' })
await test('check prints each problem and ends with GTM-BRIEF: PASS|FAIL and exit 0|1, also through a symlink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtm-brief-'))
  try {
    writeFileSync(join(dir, 'gtm.md'), BRIEF)
    writeFileSync(join(dir, 'bad.md'), BRIEF.replace('none', 'TBD'))
    symlinkSync(SCRIPT, join(dir, 'linked.mjs'))
    const pass = cli(join(dir, 'linked.mjs'), 'check', join(dir, 'gtm.md'))
    assert.equal(pass.status, 0)
    assert.equal(pass.stdout.trim().split('\n').pop(), 'GTM-BRIEF: PASS')
    const fail = cli(SCRIPT, 'check', join(dir, 'bad.md'))
    assert.equal(fail.status, 1)
    assert.match(fail.stdout, /gtm-brief: .*bad\.md:23: a TBD is left in\nGTM-BRIEF: FAIL\n$/)
    const missing = cli(SCRIPT, 'check', join(dir, 'gone.md'))
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /cannot read .*gone\.md: ENOENT\nGTM-BRIEF: FAIL/)
    for (const args of [[], ['lint', 'x'], ['check'], ['check', 'a', 'b']]) assert.equal(cli(SCRIPT, ...args).status, 2, args.join(' '))
    const preserved = cli('--preserve-symlinks-main', join(dir, 'linked.mjs'), 'check', join(dir, 'bad.md'))
    assert.equal(preserved.status, 1, 'node --preserve-symlinks-main still runs the check')
    assert.match(preserved.stdout, /GTM-BRIEF: FAIL\n$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
