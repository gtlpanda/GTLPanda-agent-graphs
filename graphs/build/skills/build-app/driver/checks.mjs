// The driver's own checks after a slice session. None trusts what the session
// reports: they read git and run verification themselves.
import { existsSync, readFileSync } from 'node:fs'
import { git, run, tail } from './proc.mjs'

// Test files, by the rule /dev's test ratio uses (graphs/dev/skills/dev/SKILL.md,
// section 6); a test fails if the two drift.
export const TEST_FILE = /(^|\/)(tests?|__tests__)\/|[._](test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^\/]*\.py$/

// Returns { problems: [text], testFiles: [this slice's test files] }. Landing
// needs no problems.
// allowEmpty: no commits is fine (the final QA pass may find nothing to fix).
export function sliceChecks({ repo, integration, branch, sliceId, frozen, verifyCommand, allowEmpty = false, verifyTimeoutMs = 40 * 60_000 }) {
  const problems = []
  const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.stdout.trim() !== branch) problems.push(`the session left the repo on ${JSON.stringify(head.stdout.trim())}, not ${branch}`)
  const dirty = git(repo, ['status', '--porcelain']).stdout.trim()
  if (dirty) problems.push(`uncommitted changes were left:\n${tail(dirty, 15)}`)
  if (!git(repo, ['merge-base', '--is-ancestor', integration, branch]).ok) problems.push(`${branch} does not build on ${integration}, so it cannot be fast-forwarded`)
  const subjects = git(repo, ['log', '--format=%s', `${integration}..${branch}`]).stdout.split('\n').filter(Boolean)
  if (!subjects.length && !allowEmpty) problems.push(`no commits on ${branch}`)
  const foreign = subjects.filter(s => !s.startsWith(`${sliceId}: `))
  if (foreign.length) problems.push(`commits that do not start with "${sliceId}: ": ${foreign.map(s => JSON.stringify(s)).join(', ')}`)
  // --no-renames: a renamed frozen test shows up under its old name too.
  const changed = git(repo, ['diff', '--name-only', '--no-renames', `${integration}...${branch}`]).stdout.split('\n').filter(Boolean)
  const touchedFrozen = changed.filter(f => frozen.includes(f))
  if (touchedFrozen.length) problems.push(`frozen tests from earlier slices changed: ${touchedFrozen.join(', ')}`)
  if (!problems.length) {
    const v = run('bash', ['-c', verifyCommand], { cwd: repo, timeoutMs: verifyTimeoutMs })
    const last = v.out.trimEnd().split('\n').pop() || ''
    if (last !== 'VERIFY: PASS') problems.push(`the driver's own verify did not pass (last line ${JSON.stringify(last)}):\n${tail(v.out, 30)}`)
    // The next session starts from a clean tree, and /dev --unattended stops on a dirty one.
    const left = git(repo, ['status', '--porcelain']).stdout.trim()
    if (left) problems.push(`the driver's own verify left files git does not ignore: ${left.split('\n').map(l => l.slice(3)).join(', ')} (ignore them in .gitignore)`)
  }
  const testFiles = changed.filter(f => TEST_FILE.test(f) && existsSync(`${repo}/${f}`))
  return { problems, testFiles }
}

// The driver's own checks on the bug hunt's fix branch before it lands: every
// commit is one evidence.mjs fix commit that the ledger still calls verified,
// no frozen test changed, the worktree is clean, and its own verify passes on
// the branch, run in the repo itself (where the dependencies are installed),
// with the branch checked out detached and integration checked out again after.
// Returns {problems, commits}.
export function bughuntChecks({ repo, integration, branch, worktree, frozen, verifyCommand, verified = [], verifyTimeoutMs = 40 * 60_000 }) {
  const problems = []
  const safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
  if (!git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok) return { problems: [`no branch ${branch}`], commits: 0 }
  if (!git(repo, ['merge-base', '--is-ancestor', integration, branch]).ok) problems.push(`${branch} does not build on ${integration}, so it cannot be fast-forwarded`)
  const subjects = git(repo, ['log', '--format=%s', `${integration}..${branch}`]).stdout.split('\n').filter(Boolean)
  const foreign = subjects.filter(s => !/^bughunt: fix F[1-9][0-9]*$/.test(s))
  if (foreign.length) problems.push(`commits that are not "bughunt: fix F<n>": ${foreign.map(s => JSON.stringify(s)).join(', ')}`)
  const shas = git(repo, ['rev-list', `${integration}..${branch}`]).stdout.split('\n').filter(Boolean)
  const unverified = shas.filter(sha => !verified.includes(sha))
  if (!foreign.length && unverified.length) problems.push(`fix commits the hunt's ledger does not call verified: ${unverified.map(s => s.slice(0, 7)).join(', ')}`)
  const changed = git(repo, ['diff', '--name-only', '--no-renames', `${integration}...${branch}`]).stdout.split('\n').filter(Boolean)
  const touchedFrozen = changed.filter(f => frozen.includes(f))
  if (touchedFrozen.length) problems.push(`frozen tests from earlier slices changed: ${touchedFrozen.join(', ')}`)
  if (existsSync(worktree)) {
    const dirty = git(worktree, [...safe, 'status', '--porcelain']).stdout.trim()
    if (dirty) problems.push(`the fix worktree has uncommitted changes:\n${tail(dirty, 15)}`)
  }
  if (!problems.length && subjects.length) {
    if (!git(repo, [...safe, 'checkout', '-q', '--detach', branch]).ok) return { problems: [`could not check out ${branch} to verify it`], commits: subjects.length }
    try {
      const v = run('bash', ['-c', verifyCommand], { cwd: repo, timeoutMs: verifyTimeoutMs })
      const last = v.out.trimEnd().split('\n').pop() || ''
      if (last !== 'VERIFY: PASS') problems.push(`the driver's own verify did not pass on ${branch} (last line ${JSON.stringify(last)}):\n${tail(v.out, 30)}`)
      const left = git(repo, ['status', '--porcelain']).stdout.trim()
      if (left) problems.push(`the driver's own verify left files git does not ignore: ${left.split('\n').map(l => l.slice(3)).join(', ')}`)
    } finally {
      git(repo, [...safe, 'checkout', '-q', '-f', integration])
    }
  }
  return { problems, commits: subjects.length }
}

// What /dev reported in its own ledger ($(git rev-parse --git-path harness-dev)/ledger.json),
// or null when it wrote none. A report, never proof: landing still needs sliceChecks.
export function devReport(file) {
  if (!existsSync(file)) return null
  try {
    const l = JSON.parse(readFileSync(file, 'utf8'))
    const questions = Array.isArray(l.questions) ? l.questions.map(q => (typeof q === 'string' ? q : JSON.stringify(q))).filter(q => q.trim()) : []
    return { status: typeof l.status === 'string' ? l.status : null, reason: typeof l.reason === 'string' ? l.reason : '', questions }
  } catch {
    return null
  }
}

// The ledger outcome for a session that ended normally (no usage limit):
// landed only when /dev says done and every check passes.
export function outcomeOf(report, checks) {
  if (report && report.status === 'needs-human' && report.questions.length) return { kind: 'needs-human', questions: report.questions }
  if (report && report.status === 'done' && !checks.problems.length) return { kind: 'landed', frozen: checks.testFiles }
  const said = report ? `/dev ${report.status || 'reported no status'}${report.reason ? `: ${report.reason}` : ''}` : '/dev wrote no ledger (the session ended before it finished)'
  const found = checks.problems.length ? `; the driver's checks: ${checks.problems.join('; ')}` : ''
  return { kind: 'escalated', reason: `${said}${found}` }
}
