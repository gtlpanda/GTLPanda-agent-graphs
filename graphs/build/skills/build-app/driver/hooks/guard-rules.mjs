// The /build-app guard's rules, pure so they are tested without a session.
// rules: { repo: absolute repo path, frozen: [repo-relative test files] }.
// Denied: git push, remote changes, commands that rewrite or discard history or
// work, touching the integration branch, recursive rm of / ~ $HOME, edits inside
// .git, and edits to test files frozen by slices that already landed.
import { resolve, relative, isAbsolute } from 'node:path'

// Each git subcommand a slice session never needs, with why.
const GIT_DENY = [
  [/^push\b/, 'git push: nothing leaves this machine until the whole app is built'],
  [/^remote\s+(add|set-url|remove|rm|rename)\b/, 'git remote changes'],
  [/^reset\b.*--hard\b/, 'git reset --hard discards work'],
  [/^(rebase|filter-branch|filter-repo|update-ref|replace)\b/, 'rewriting history'],
  [/^branch\b.*\s(-[a-zA-Z]*[dDfM][a-zA-Z]*|--delete|--force|--move)(\s|$)/, 'deleting, forcing, or moving a branch'],
  [/^clean\b.*\s-[a-zA-Z]*f/, 'git clean deletes untracked work'],
  [/^(checkout|switch)\b.*\bintegration\//, 'the driver lands slices on the integration branch; a session never touches it'],
]
// git options before the subcommand that take a value.
const GIT_VALUE_OPTS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace']

// Splits a shell command into simple commands at ; && || | and newlines.
function segments(command) {
  return String(command).split(/;|&&|\|\||\||\n/).map(s => s.trim()).filter(Boolean)
}

// Every git subcommand (with its arguments) in one simple command. Quotes and
// $( ` are stripped from each word first, so `bash -c "git push"`, `$(git push)`,
// and `xargs git push` are seen too. Fails closed: a quoted "git push" inside a
// commit message is denied as well.
function gitSubcommands(seg) {
  const words = seg.split(/\s+/).map(w => w.replace(/^[$("'`]+|[)"'`;]+$/g, ''))
  const subs = []
  words.forEach((w, at) => {
    if (!/(^|\/)git$/.test(w)) return
    let i = at + 1
    while (i < words.length && words[i].startsWith('-')) {
      if (GIT_VALUE_OPTS.includes(words[i])) i += 1
      i += 1
    }
    subs.push(words.slice(i).join(' '))
  })
  return subs
}

export function decideBash(command) {
  for (const seg of segments(command)) {
    for (const sub of gitSubcommands(seg)) {
      for (const [re, why] of GIT_DENY) if (re.test(sub)) return why
    }
    if (/^(sudo\s+)?rm\s/.test(seg) && /\s-[a-zA-Z]*[rR]/.test(seg) && /\s(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?)(\s|$)/.test(`${seg} `)) {
      return 'recursive rm of /, ~, or $HOME'
    }
  }
  return null
}

// The reason to deny one tool call, or null to let it run.
export function decide(tool, params, rules) {
  if (tool === 'Bash') return decideBash(params.command || '')
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return null
  const file = params.file_path || params.notebook_path
  if (typeof file !== 'string' || !file) return null
  const abs = isAbsolute(file) ? file : resolve(rules.repo, file)
  const rel = relative(rules.repo, abs).split('\\').join('/')
  if (rel === '.git' || rel.startsWith('.git/')) return 'editing inside .git'
  if ((rules.frozen || []).includes(rel)) return `${rel} is a frozen test from a slice that already landed; add a new test instead of changing it`
  return null
}
