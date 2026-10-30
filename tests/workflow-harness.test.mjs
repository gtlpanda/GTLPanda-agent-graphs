// workflow-harness.test.mjs — the mock runtime itself: child workflow() calls.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test, load, run } from '../scripts/workflow-harness.mjs'

const { fn } = load(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'calls-child.js'))

console.log('== workflow-harness: child workflow() mock')
await test('workflow() returns the scripted ledger and is recorded in call order with its args', async () => {
  const { result, calls } = await run(fn, { checker: ['ok'], 'workflow:child-graph': [{ status: 'done' }] }, { repo: '/r' })
  assert.deepEqual(result, { child: { status: 'done' } })
  assert.deepEqual(calls.map(c => c.agentType), ['checker', 'workflow:child-graph'])
  assert.deepEqual(calls[1].args, { repo: '/r', from: 'ok' })
})
await test('a function entry receives the child args', async () => {
  const { result } = await run(fn, { checker: ['x'], 'workflow:child-graph': [a => ({ echoed: a.from })] }, { repo: '/r' })
  assert.deepEqual(result.child, { echoed: 'x' })
})
await test('an unscripted workflow() call fails the test instead of being swallowed', async () => {
  await assert.rejects(run(fn, { checker: ['ok'] }, { repo: '/r' }), /unexpected workflow call: workflow:child-graph/)
})
await test('{ throws } reaches the script as a thrown error', async () => {
  await assert.rejects(run(fn, { checker: ['ok'], 'workflow:child-graph': [{ throws: 'unknown workflow' }] }, { repo: '/r' }), /unknown workflow/)
})
