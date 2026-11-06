// guard.test.mjs — the /build-app guard rules, both hooks as processes, and the
// session env and settings. Run by scripts/test-workflow.mjs.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { decide, decideBash } from '../skills/build-app/driver/hooks/guard-rules.mjs'
import { buildEnv } from '../skills/build-app/driver/proc.mjs'
import { sessionSettings, readResult } from '../skills/build-app/driver/session.mjs'
import { TEST_FILE } from '../skills/build-app/driver/checks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const HOOKS = join(here, '..', 'skills', 'build-app', 'driver', 'hooks')

console.log('== build-app guard: shell commands')
await test('denied: push in the common spellings, remote changes, history rewrites, forced branch changes, clean, the integration branch, rm -rf of home or root', () => {
  for (const cmd of [
    'git push', 'git push origin main', 'git -C . push', 'git -C /repo push --force', 'git -c core.x=y push', '/usr/bin/git push',
    'npm test && git push', 'echo x; git push', 'true || git push', 'git status | git push',
    'git remote add evil https://x', 'git remote set-url origin x', 'git reset --hard HEAD~1', 'git reset --hard',
    'git rebase -i main', 'git filter-branch', 'git update-ref refs/heads/main HEAD', 'git branch -D integration/toy', 'git branch -f main HEAD', 'git branch --force x HEAD',
    'git clean -fd', 'git clean -xdf', 'git checkout integration/toy', 'git switch integration/toy',
    'rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -fr $HOME', 'sudo rm -rf /',
    'bash -c "git push"', 'git pu\\sh', 'git send-pack origin', '(git push)', 'git branch -d integration/toy', 'git reset --soft integration/toy', 'git merge integration/toy', "sh -c 'git push origin main'", 'echo $(git push)', 'xargs git push', 'env GIT_TRACE=1 git push', 'eval git push', 'echo `git push`',
  ]) assert.ok(decideBash(cmd), `should deny: ${cmd}`)
})
await test('allowed: everything a /dev slice does', () => {
  for (const cmd of [
    'git status --porcelain', 'git diff --merge-base integration/toy', 'git log --oneline', 'git add -A', 'git commit -m "S1: C1: x"',
    'git rev-parse --path-format=absolute --git-path harness-build', 'git stash', 'git branch --show-current', 'git branch', 'git reset HEAD file',
    'npm test', 'node --test', 'rm -rf node_modules', 'rm -rf ./dist', 'rm file.txt', 'grep -r push src',
    'git checkout -- src/a.js', 'git show integration/toy:docs/backlog.json', 'echo "git push is denied"',
    // Commit messages are data, whatever words they use (review of #23).
    'git commit -m "S2: drop git rebase helper"', 'git commit -m "S2: C1: stop shelling out to git push in release script"',
    "git commit -F - <<'EOF'\nS2: C1: x\n\nrun git push manually; git reset --hard is gone\nEOF",
    'git commit -m "$(cat <<\'EOF\'\nS2: C1: x\n\nthen git push origin main\nEOF\n)"',
    'git clean -nfd', 'git clean -fd --dry-run', 'git branch -d dev/old-branch', 'git branch --delete x', 'git log --grep="git push"',
    'bash -c "git status"', 'gitk', 'legit push', 'git commit -m "S1: C1: show a push notification"',
  ]) assert.equal(decideBash(cmd), null, `should allow: ${cmd}`)
})

console.log('== build-app guard: edits')
const rules = { repo: '/r', frozen: ['tests/S1.test.js'] }
await test('an edit to a frozen test or inside .git is denied; any other edit is allowed', () => {
  assert.match(decide('Edit', { file_path: '/r/tests/S1.test.js' }, rules), /frozen test from a slice that already landed/)
  assert.match(decide('Write', { file_path: 'tests/S1.test.js' }, rules), /frozen test/, 'relative paths resolve against the repo')
  assert.match(decide('MultiEdit', { file_path: '/r/./tests/../tests/S1.test.js' }, rules), /frozen test/)
  assert.match(decide('Write', { file_path: '/r/.git/harness-build/toy/ledger.json' }, rules), /editing inside \.git/)
  assert.match(decide('NotebookEdit', { notebook_path: '/r/.git/config' }, rules), /inside \.git/)
  // The final QA session's report is the one file in .git it may write.
  const qa = { ...rules, writable: ['/r/.git/harness-build/toy/final-qa.json'] }
  assert.equal(decide('Write', { file_path: '/r/.git/harness-build/toy/final-qa.json' }, qa), null)
  assert.match(decide('Write', { file_path: '/r/.git/harness-build/toy/ledger.json' }, qa), /inside \.git/)
  for (const [tool, params] of [['Edit', { file_path: '/r/tests/S2.test.js' }], ['Write', { file_path: '/r/src/a.js' }], ['Read', { file_path: '/r/.git/config' }],
    ['Edit', {}], ['Write', { file_path: '/r/.github/workflows/ci.yml' }], ['Grep', { pattern: 'x' }]]) {
    assert.equal(decide(tool, params, rules), null, `${tool} ${JSON.stringify(params)}`)
  }
})

await test('a symlinked repo path, or ../ in a file path, does not dodge the edit rules', () => {
  const real = mkdtempSync(join(tmpdir(), 'guard-real-'))
  mkdirSync(join(real, 'tests'))
  writeFileSync(join(real, 'tests', 'S1.test.js'), 'x')
  mkdirSync(join(real, '.git'))
  const link = `${real}-link`
  symlinkSync(real, link)
  for (const [repo, file] of [[link, join(real, 'tests', 'S1.test.js')], [real, join(link, 'tests', 'S1.test.js')], [link, 'tests/../tests/S1.test.js']]) {
    assert.match(decide('Edit', { file_path: file }, { repo, frozen: ['tests/S1.test.js'] }) || '', /frozen test/, `${repo} ${file}`)
  }
  assert.match(decide('Write', { file_path: join(real, '.git', 'hooks', 'new-hook') }, { repo: link, frozen: [] }) || '', /inside \.git/)
})
await test('the frozen-test rule is the same regex /dev counts tests by', () => {
  const skill = readFileSync(join(here, '..', '..', 'dev', 'skills', 'dev', 'SKILL.md'), 'utf8')
  const awk = skill.match(/if \(\$3 ~ \/(.+?)\/\) t \+= \$1/)
  assert.ok(awk, 'the test ratio command in /dev SKILL.md')
  assert.equal(TEST_FILE.source, awk[1])
})

console.log('== build-app guard: the hooks as processes')
const hook = (file, input, env) => spawnSync(process.execPath, [join(HOOKS, file)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } })
await test('the guard prints a deny decision under the driver, and nothing outside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'))
  writeFileSync(join(dir, 'guard.json'), JSON.stringify(rules))
  const active = { HARNESS_BUILD_ACTIVE: '1', HARNESS_BUILD_GUARD: join(dir, 'guard.json') }
  const denied = hook('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'git -C . push' } }, active)
  assert.equal(denied.status, 0)
  const out = JSON.parse(denied.stdout)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^build-app guard: git push/)
  assert.equal(hook('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'npm test' } }, active).stdout, '')
  assert.equal(hook('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'git push' } }, { HARNESS_BUILD_ACTIVE: '' }).stdout, '', 'inert outside the driver')
  assert.equal(hook('guard.mjs', 'not json', active).status, 0, 'never fails the session on bad input')
})
await test('the stop-failure hook records the failure under the driver, and nothing outside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stopfail-'))
  const file = join(dir, 'stop-failure.json')
  hook('stop-failure.mjs', { error: 'rate_limit', last_assistant_message: 'resets 3pm' }, { HARNESS_BUILD_ACTIVE: '', HARNESS_BUILD_STOP_FAILURE: file })
  assert.equal(existsSync(file), false)
  const r = hook('stop-failure.mjs', { error: 'rate_limit', last_assistant_message: 'resets 3pm' }, { HARNESS_BUILD_ACTIVE: '1', HARNESS_BUILD_STOP_FAILURE: file })
  assert.equal(r.status, 0)
  const rec = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(rec.error, 'rate_limit')
  assert.ok(rec.recordedAt)
})

console.log('== build-app driver: session env and settings')
await test('buildEnv drops the parent session\'s identity and settings env and keeps the rest', () => {
  const env = buildEnv({ HARNESS_BUILD_ACTIVE: '1' }, { PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '9', CLAUDE_EFFORT: 'high', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k',
    CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1' })
  // How an unattended box authenticates stays (review of #23); session identity and model settings go.
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', HARNESS_BUILD_ACTIVE: '1' })
})
await test('settings: the model env, both hooks, and the deny rules; readResult takes the last result line', () => {
  const s = sessionSettings('/hooks')
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash|Edit|Write|MultiEdit|NotebookEdit')
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'node "/hooks/guard.mjs"')
  assert.equal(s.hooks.StopFailure[0].hooks[0].command, 'node "/hooks/stop-failure.mjs"')
  assert.equal(s.env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, '')
  const dir = mkdtempSync(join(tmpdir(), 'result-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, [JSON.stringify({ type: 'result', subtype: 'error', n: 1 }), '{"type":"assistant"}', JSON.stringify({ type: 'result', subtype: 'success', n: 2 }), '{broken "type":"result"'].join('\n'))
  assert.equal(readResult(f).n, 2)
  assert.equal(readResult(join(dir, 'none.jsonl')), null)
})
