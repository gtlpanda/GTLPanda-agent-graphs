// The end of a build, once every slice has landed: one QA pass over the whole
// integration branch (the QA graph, in a headless session), then the branch is
// pushed and one pull request opened for the human. The driver, never a
// session, pushes; production deploys are never part of it.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, run } from './proc.mjs'
import { sliceState } from '../../../../../core/skills/backlog/backlog.mjs'
import { disposition } from '../../../../../core/skills/findings/findings.mjs'

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
    `2. Write the ledger it returns, as JSON, to ${reportFile}.\n   (That one file inside .git is open to the Write tool; nothing else in .git is.)`,
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

// What the bug hunt session is told: the driver already ran intake and made the
// fix worktree, so the session only runs the hunt graph in fix mode and writes
// its results into the state dir (the one place in .git the guard opens).
export function bughuntPrompt({ repo, stateDir, configDir, branch }) {
  // Shell lines get single-quoted paths ($ and backticks stay literal); the
  // Workflow args are JSON.
  const q = p => `'${String(p).replace(/'/g, `'\\''`)}'`
  const j = p => JSON.stringify(p)
  const findings = join(configDir, 'skills', 'findings', 'findings.mjs')
  const evidence = join(configDir, 'skills', 'bughunt', 'evidence.mjs')
  return [
    'Bug hunt of an unattended /build-app build, in fix mode, over the whole integration branch. These instructions are your opt-in to the Workflow tool for this one run.',
    `The driver already ran intake and made the fix worktree ${j(join(stateDir, 'fix'))} on ${branch}. Do not run intake.mjs, and never create, remove, or switch a worktree or branch.`,
    `1. node ${q(findings)} input ${q(join(stateDir, 'ledger.json'))} ${q(join(stateDir, 'intake.json'))} ${q(join(stateDir, 'input.json'))}`,
    `2. node ${q(join(configDir, 'skills', 'workflow-state', 'run-script.mjs'))} INJECTED_INPUT ${q(join(stateDir, 'input.json'))} ${q(join(configDir, 'workflows', 'bughunt-flow.js'))} ${q(join(stateDir, 'run.js'))}; its output must start with "run-script: wrote".`,
    `3. Run the Workflow tool with scriptPath set to the path it printed, and args {"repo": ${j(repo)}, "tree": ${j(join(stateDir, 'tree'))}, "configDir": ${j(configDir)}, "stateDir": ${j(stateDir)}, "mode": "fix", "fixBranch": ${j(branch)}}.`,
    '   It runs in the background and notifies you when it completes: wait for that notification, never a ScheduleWakeup or a sleep.',
    `4. Write the ledger it returns, as JSON, to ${join(stateDir, 'result.json')}.`,
    `5. node ${q(findings)} save ${q(join(stateDir, 'ledger.json'))} ${q(join(stateDir, 'intake.json'))} ${q(join(stateDir, 'result.json'))} --repo ${q(join(stateDir, 'tree'))}`,
    `6. node ${q(evidence)} recheck ${q(stateDir)} (with the Bash tool's timeout set to 600000 ms)`,
    `7. node ${q(findings)} report ${q(join(stateDir, 'ledger.json'))} ${q(join(stateDir, 'evidence'))} > ${q(join(stateDir, 'report.md'))}`,
    'Never push, never commit yourself, never switch branches, never ask a question. Then stop.',
  ].join('\n')
}

// One paragraph for the PR body from the hunt's ledger: what was found, what
// was fixed (now in this branch), and what is left for the reviewer.
export function bughuntLine(ledger, landed) {
  const live = ledger.findings.filter(f => !f.stale)
  const real = live.filter(f => ['reproduced', 'confirmed'].includes(f.verification_status))
  const fixed = real.filter(f => f.fix_status === 'verified')
  const open = real.filter(f => f.fix_status !== 'verified')
  const unverified = live.filter(f => ['candidate', 'contested', 'not_reproduced'].includes(f.verification_status))
  const lines = [`The bug hunt (\`/bughunt --fix\`) ran over the whole branch: ${real.length} confirmed bug(s), ${live.filter(f => f.verification_status === 'reproduced').length} of them reproduced by a failing test; ${fixed.length} fixed and independently verified${landed ? ' (in this branch, one `bughunt: fix F<n>` commit each, with its regression test)' : ''}.`]
  for (const f of open) lines.push(`- **Still open:** ${f.finding_id} [${f.severity}] ${f.title} (\`${f.file_path}:${f.line_range[0]}\`; ${f.verification_status}, fix ${f.fix_status}${f.fix_artifact && f.fix_artifact.last_feedback ? `: ${f.fix_artifact.last_feedback}` : ''})`)
  if (unverified.length) lines.push(`- ${unverified.length} more finding(s) were not confirmed; see the hunt's report.`)
  // A hunt that did not cover everything is never reported as clean.
  const fixedIds = new Set(fixed.map(f => f.finding_id))
  const d = disposition({ ...ledger, findings: ledger.findings.filter(f => !fixedIds.has(f.finding_id)) })
  if (d.disposition !== 'pass') lines.push(`- **Disposition: ${d.disposition.replace('_', ' ')}** (${d.because.join(', ')}).`)
  const run = ledger.runs && ledger.runs.length ? ledger.runs[ledger.runs.length - 1] : null
  if (run && run.budget_stop) lines.push(`- The hunt stopped before ${run.budget_stop}: its token budget was nearly spent.`)
  return lines.join('\n')
}

export function prBody(backlog, ledger, qaLine, huntLine = null) {
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
    ...(huntLine ? ['## Bug hunt', huntLine, ''] : []),
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
