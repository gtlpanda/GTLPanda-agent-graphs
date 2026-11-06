// The end of a build, once every slice has landed: one QA pass over the whole
// integration branch (the QA graph, in a headless session), then the branch is
// pushed and one pull request opened for the human. The driver, never a
// session, pushes; production deploys are never part of it.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, run } from './proc.mjs'
import { sliceState } from '../../../../../core/skills/backlog/backlog.mjs'

// The branch the PR goes to: origin's default branch, else main, else master.
export function defaultBase(repo) {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '')
  if (git(repo, ['rev-parse', '--verify', '-q', 'refs/heads/main']).ok) return 'main'
  return 'master'
}

// What the final QA session is told. It reports through reportFile, and its
// only commit subject is "final: QA fixes".
export function finalQaPrompt({ repo, base, reportFile, configDir }) {
  return [
    'Final QA pass of an unattended /build-app build. These instructions are your opt-in to the Workflow tool for this one run.',
    `1. Run the QA graph once: the Workflow tool with name "harness-repair" (if that name is not found, scriptPath ${join(configDir, 'workflows', 'harness-repair.js')}), args {"repo": ${JSON.stringify(repo)}, "base": ${JSON.stringify(base)}, "maxFixRounds": 3, "knownStuckSigs": []}.`,
    `2. Write the ledger it returns, as JSON, to ${reportFile}.`,
    `3. On status done with a non-empty touched list: run bash ${join(configDir, 'skills', 'verify', 'verify.sh')}; only when its last line is VERIFY: PASS, commit exactly the touched files with the subject "final: QA fixes" and the fixed list in the body.`,
    '4. On any other status, commit nothing. Never push, never switch branches, never ask a question. Then stop.',
  ].join('\n')
}

// /dev-style report from the QA ledger the session wrote, or null.
export function qaReport(file) {
  if (!existsSync(file)) return null
  try {
    const l = JSON.parse(readFileSync(file, 'utf8'))
    return { status: typeof l.status === 'string' ? l.status : null, reason: typeof l.reason === 'string' ? l.reason : '', questions: [] }
  } catch {
    return null
  }
}

export function prBody(backlog, ledger, qaLine) {
  const rows = backlog.slices.map(s => {
    const st = sliceState(ledger, s.id)
    return `- **${s.id}** ${s.title}: ${s.acceptance.length} criteria${st.reasons.length ? `, ${st.reasons.length} earlier attempt(s)` : ''}`
  })
  return [
    `Built unattended by \`/build-app\` from \`docs/backlog.json\` (${backlog.slices.length} slices), one fresh \`/dev --slice\` session per slice.`,
    'Each slice landed only after the driver\'s own checks: every commit `S<n>: `-prefixed, a clean tree, no frozen test changed, and its own verify passing.',
    '',
    '## Slices',
    ...rows,
    '',
    '## Final QA',
    qaLine,
    '',
    'Review it before merging: nothing here is merged or deployed automatically.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n')
}

// Pushes the integration branch and returns the open PR's URL, creating the PR
// when there is none. Throws with the reason.
export function pushAndOpenPr({ repo, integration, base, gh, title, body }) {
  if (!git(repo, ['remote', 'get-url', 'origin']).ok) throw new Error('the repo has no origin remote')
  const push = git(repo, ['push', '-q', '-u', 'origin', integration], { timeoutMs: 10 * 60_000 })
  if (!push.ok) throw new Error(`git push failed: ${push.out.trim().slice(0, 500)}`)
  const open = run(gh, ['pr', 'list', '--head', integration, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], { cwd: repo, timeoutMs: 120_000 })
  if (open.ok && open.stdout.trim()) return open.stdout.trim()
  const made = run(gh, ['pr', 'create', '--base', base, '--head', integration, '--title', title, '--body', body], { cwd: repo, timeoutMs: 120_000 })
  const url = made.stdout.trim().split('\n').pop() || ''
  if (!made.ok || !/^https?:\/\//.test(url)) throw new Error(`gh pr create failed: ${made.out.trim().slice(0, 500)}`)
  return url
}
