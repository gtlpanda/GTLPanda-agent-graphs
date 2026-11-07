#!/usr/bin/env node
// make-fixtures.mjs - builds the /bughunt benchmark: small Node repos, each
// with a base commit on main and a change on the branch `pr`, an `npm test`
// suite (node --test) that passes at the base, and truth.json naming every bug
// the change introduced ({bugs: [{file_path, line_range, kind}]}; empty for a
// clean or misleading change). Deterministic: the same files every time.
//   node make-fixtures.mjs <out dir> [case ...]
// Prints one line per case, then BENCH-FIXTURES: <n> built.
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = JSON.stringify({ name: 'bench', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n'
const T = (imp, name, body) => `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${imp}\n\ntest(${JSON.stringify(name)}, () => {\n${body}\n})\n`

// Each case: base files, the change (files to write; null deletes), the truth.
export const CASES = {
  'logic-off-by-one': {
    about: 'paging returns one item too few on every page',
    base: {
      'src/page.js': 'export function page(items, n, size) {\n  const start = n * size\n  return items.slice(start, start + size)\n}\n',
      'tests/page.test.js': T("import { page } from '../src/page.js'", 'first page', '  assert.deepEqual(page([1, 2, 3], 0, 2), [1, 2])'),
    },
    change: {
      'src/page.js': 'export function page(items, n, size) {\n  // pages are numbered from 1 now, matching the API\n  const start = (n - 1) * size\n  return items.slice(start, start + size - 1)\n}\n',
      'tests/page.test.js': T("import { page } from '../src/page.js'", 'first page', '  assert.deepEqual(page([1, 2, 3], 1, 1), [])'),
    },
    bugs: [{ file_path: 'src/page.js', line_range: [4, 4], kind: 'logic' }],
  },
  'boundary-discount': {
    about: 'the discount threshold excludes exactly 100',
    base: {
      'src/discount.js': 'export function total(amount) {\n  return amount\n}\n',
      'tests/discount.test.js': T("import { total } from '../src/discount.js'", 'no discount', '  assert.equal(total(50), 50)'),
    },
    change: {
      'src/discount.js': '// Orders of 100 or more get 10% off.\nexport function total(amount) {\n  if (amount > 100) return amount * 0.9\n  return amount\n}\n',
    },
    bugs: [{ file_path: 'src/discount.js', line_range: [3, 3], kind: 'boundary' }],
  },
  'contract-return-shape': {
    about: 'findUser now returns {user} but a caller still reads .name directly',
    base: {
      'src/users.js': "const USERS = [{ id: 1, name: 'Ada' }]\nexport function findUser(id) {\n  return USERS.find(u => u.id === id) || null\n}\n",
      'src/greet.js': "import { findUser } from './users.js'\nexport function greet(id) {\n  const u = findUser(id)\n  return u ? `Hello, ${u.name}` : 'Hello, stranger'\n}\n",
      'tests/greet.test.js': T("import { greet } from '../src/greet.js'", 'stranger', "  assert.equal(greet(9), 'Hello, stranger')"),
    },
    change: {
      'src/users.js': "const USERS = [{ id: 1, name: 'Ada' }]\n// Returns {user, found} so callers can tell a miss from an error.\nexport function findUser(id) {\n  const user = USERS.find(u => u.id === id) || null\n  return { user, found: user !== null }\n}\n",
    },
    bugs: [{ file_path: 'src/greet.js', line_range: [3, 4], kind: 'contract' }],
  },
  'async-missing-await': {
    about: 'save resolves before the write finishes, so a read right after misses it',
    base: {
      'src/store.js': 'const data = new Map()\nexport function save(key, value) {\n  data.set(key, value)\n}\nexport function load(key) {\n  return data.get(key)\n}\n',
      'tests/store.test.js': T("import { save, load } from '../src/store.js'", 'round trip', "  save('a', 1)\n  assert.equal(load('a'), 1)"),
    },
    change: {
      'src/store.js': "const data = new Map()\nconst slowWrite = (key, value) => new Promise(r => setTimeout(() => { data.set(key, value); r() }, 5))\n// save is async now; it resolves once the value is stored.\nexport async function save(key, value) {\n  slowWrite(key, value)\n}\nexport function load(key) {\n  return data.get(key)\n}\n",
      'tests/store.test.js': T("import { save, load } from '../src/store.js'", 'round trip', "  return save('a', 1).then(() => assert.ok(true))"),
    },
    bugs: [{ file_path: 'src/store.js', line_range: [4, 6], kind: 'concurrency' }],
  },
  'errors-swallowed': {
    about: 'a parse failure now returns an empty config instead of failing',
    base: {
      'src/config.js': 'export function parseConfig(text) {\n  return JSON.parse(text)\n}\n',
      'tests/config.test.js': T("import { parseConfig } from '../src/config.js'", 'parses', "  assert.deepEqual(parseConfig('{\"port\":1}'), { port: 1 })"),
    },
    change: {
      'src/config.js': "export function parseConfig(text) {\n  try {\n    return JSON.parse(text)\n  } catch {\n    return {}\n  }\n}\n\nexport function portOf(text) {\n  const cfg = parseConfig(text)\n  return cfg.port ?? 8080\n}\n",
    },
    bugs: [{ file_path: 'src/config.js', line_range: [4, 6], kind: 'errors' }],
  },
  'security-path-traversal': {
    about: 'a file name from the request reaches the file system unchecked',
    base: {
      'src/files.js': "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst ALLOWED = ['a.txt', 'b.txt']\nexport function readPublic(root, name) {\n  if (!ALLOWED.includes(name)) throw new Error('not allowed')\n  return readFileSync(join(root, name), 'utf8')\n}\n",
      'tests/files.test.js': T("import { readPublic } from '../src/files.js'", 'refuses others', "  assert.throws(() => readPublic('/tmp', 'x'))"),
    },
    change: {
      'src/files.js': "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n// Any file in the public root may be read now, not only the listed ones.\nexport function readPublic(root, name) {\n  return readFileSync(join(root, name), 'utf8')\n}\n",
      'tests/files.test.js': T("import { readPublic } from '../src/files.js'", 'reads', "  assert.ok(typeof readPublic === 'function')"),
    },
    bugs: [{ file_path: 'src/files.js', line_range: [4, 5], kind: 'security' }],
  },
  'misleading-correct': {
    about: 'a loop bound that looks off by one but is right',
    base: {
      'src/sum.js': 'export function sumTo(n) {\n  let s = 0\n  for (let i = 1; i <= n; i += 1) s += i\n  return s\n}\n',
      'tests/sum.test.js': T("import { sumTo } from '../src/sum.js'", 'sums', '  assert.equal(sumTo(3), 6)'),
    },
    change: {
      'src/sum.js': 'export function sumTo(n) {\n  let s = 0\n  // i < n + 1 is i <= n: kept as written for the reviewers who asked\n  for (let i = 1; i < n + 1; i += 1) s += i\n  return s\n}\n\nexport function sumRange(a, b) {\n  return sumTo(b) - sumTo(a - 1)\n}\n',
      'tests/range.test.js': T("import { sumRange } from '../src/sum.js'", 'range', '  assert.equal(sumRange(2, 4), 9)'),
    },
    bugs: [],
  },
  'clean-refactor': {
    about: 'renames a local variable and extracts a helper, same behavior',
    base: {
      'src/fmt.js': "export function money(cents) {\n  const d = Math.floor(cents / 100)\n  const c = String(cents % 100).padStart(2, '0')\n  return `$${d}.${c}`\n}\n",
      'tests/fmt.test.js': T("import { money } from '../src/fmt.js'", 'formats', "  assert.equal(money(1234), '$12.34')"),
    },
    change: {
      'src/fmt.js': "const pad2 = n => String(n).padStart(2, '0')\nexport function money(cents) {\n  const dollars = Math.floor(cents / 100)\n  return `$${dollars}.${pad2(cents % 100)}`\n}\n",
    },
    bugs: [],
  },
  'clean-docs': {
    about: 'a README change only',
    base: {
      'src/x.js': 'export const x = 1\n',
      'tests/x.test.js': T("import { x } from '../src/x.js'", 'x', '  assert.equal(x, 1)'),
      'README.md': '# bench\n',
    },
    change: { 'README.md': '# bench\n\nA small library. Run `npm test`.\n' },
    bugs: [],
  },
  'clean-test-only': {
    about: 'adds a test, no code change',
    base: {
      'src/max.js': 'export function max(a, b) {\n  return a > b ? a : b\n}\n',
      'tests/max.test.js': T("import { max } from '../src/max.js'", 'max', '  assert.equal(max(1, 2), 2)'),
    },
    change: { 'tests/max-equal.test.js': T("import { max } from '../src/max.js'", 'equal', '  assert.equal(max(2, 2), 2)') },
    bugs: [],
  },
}

function put(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    const f = join(dir, p)
    if (text === null) { rmSync(f, { force: true }); continue }
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, text)
  }
}

export function build(out, name) {
  const c = CASES[name]
  if (!c) throw new Error(`no case ${name}`)
  const dir = join(out, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@localhost', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@localhost', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' }
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  put(dir, { 'package.json': PKG, ...c.base })
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'pr')
  put(dir, c.change)
  git('add', '-A')
  git('commit', '-q', '-m', c.about)
  writeFileSync(join(out, `${name}.truth.json`), JSON.stringify({ case: name, about: c.about, bugs: c.bugs }, null, 2) + '\n')
  return dir
}

function main(argv) {
  const [out, ...names] = argv
  if (!out) { console.error('usage: make-fixtures.mjs <out dir> [case ...]'); return 2 }
  const list = names.length ? names : Object.keys(CASES)
  for (const n of list) console.log(`${n}: ${build(out, n)} (${CASES[n].bugs.length} bug(s))`)
  console.log(`BENCH-FIXTURES: ${list.length} built`)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
