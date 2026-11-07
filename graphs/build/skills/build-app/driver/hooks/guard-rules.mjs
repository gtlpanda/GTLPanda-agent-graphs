// The /build-app guard's rules, pure so they are tested without a session.
// rules: { repo: real absolute repo path, frozen: [repo-relative test files],
//          writable: [absolute files a session may write even inside .git],
//          writableDirs: [absolute directories it may write anywhere under] }.
// writableDirs is the bug hunt's own state dir: its reproductions, its result,
// and the fix worktree the repairer edits.
// Denied: git push, remote changes, commands that rewrite or discard history or
// work, touching the integration branch, recursive rm of / ~ $HOME, edits inside
// .git, and edits to test files frozen by slices that already landed. It covers
// the common spellings, not every one: the driver's checks after the session are
// the backstop (a frozen test changed any way at all, or a commit it did not
// expect, keeps the slice from landing).
import { existsSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path'

// A git subcommand (with its arguments) a slice session never needs, with why.
const GIT_DENY = [
  [a => a[0] === 'push', 'git push: nothing leaves this machine until the whole app is built'],
  [a => a[0] === 'send-pack', 'git push: nothing leaves this machine until the whole app is built'],
  [a => a[0] === 'remote' && ['add', 'set-url', 'remove', 'rm', 'rename'].includes(a[1]), 'git remote changes'],
  [a => a[0] === 'reset' && a.includes('--hard'), 'git reset --hard discards work'],
  [a => ['rebase', 'filter-branch', 'filter-repo', 'update-ref', 'replace'].includes(a[0]), 'rewriting history'],
  [a => a[0] === 'branch' && a.slice(1).some(x => /^-[a-zA-Z]*[DfM]/.test(x) || x === '--force'), 'force-deleting, forcing, or moving a branch'],
  [a => a[0] === 'clean' && a.slice(1).some(x => /^-[a-zA-Z]*f/.test(x) || x === '--force') && !a.slice(1).some(x => /^-[a-zA-Z]*n/.test(x) || x === '--dry-run'), 'git clean deletes untracked work'],
  [a => ['checkout', 'switch', 'branch', 'merge', 'reset'].includes(a[0]) && a.slice(1).some(x => /(^|[/:])integration\//.test(x)), 'the driver lands slices on the integration branch; a session never touches it'],
]
// git options before the subcommand that take a value.
const GIT_VALUE_OPTS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace']
// Words that run the command after them.
const PREFIXES = ['env', 'sudo', 'nohup', 'time', 'command', 'exec', 'xargs', 'nice', 'timeout', 'stdbuf']
const SHELLS = ['bash', 'sh', 'zsh', 'dash']

// Heredoc bodies are data (a commit message, a file), never commands.
function dropHeredocs(text) {
  const lines = String(text).split('\n')
  const out = []
  let end = null
  for (const line of lines) {
    if (end !== null) { if (line.trim() === end) end = null; continue }
    out.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (m) end = m[2]
  }
  return out.join('\n')
}

// Splits into simple commands at unquoted ; & | newlines, and lifts out every
// command substitution ($(...) and backticks outside single quotes) as its own
// script. Returns { segments: [[token]], subs: [script] }; quotes are removed
// from tokens, so a quoted commit message is one token, never a command.
function parse(text) {
  const segments = []
  const subs = []
  let tokens = []
  let tok = ''
  let inTok = false
  let q = null
  const endTok = () => { if (inTok) tokens.push(tok); tok = ''; inTok = false }
  const endSeg = () => { endTok(); if (tokens.length) segments.push(tokens); tokens = [] }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (q === "'") { if (ch === "'") q = null; else tok += ch; continue }
    if (ch === '\\' && i + 1 < text.length) { tok += text[i + 1]; inTok = true; i += 1; continue }
    if (ch === '$' && text[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth; j += 1) { if (text[j] === '(') depth += 1; else if (text[j] === ')') depth -= 1 }
      subs.push(text.slice(i + 2, j - 1))
      tok += 'SUBST'
      inTok = true
      i = j - 1
      continue
    }
    if (ch === '`') {
      const j = text.indexOf('`', i + 1)
      subs.push(text.slice(i + 1, j < 0 ? text.length : j))
      tok += 'SUBST'
      inTok = true
      i = j < 0 ? text.length : j
      continue
    }
    if (q === '"') { if (ch === '"') q = null; else tok += ch; continue }
    if (ch === "'" || ch === '"') { q = ch; inTok = true; continue }
    if (/[;&|\n()]/.test(ch)) { endSeg(); continue }
    if (/\s/.test(ch)) { endTok(); continue }
    tok += ch
    inTok = true
  }
  endSeg()
  return { segments, subs }
}

// The command word of a simple command and its arguments, after variable
// assignments and prefix commands (env, sudo, xargs, ...).
function commandOf(tokens) {
  let i = 0
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1
    if (i < tokens.length && PREFIXES.includes(basename(tokens[i]))) {
      i += 1
      while (i < tokens.length && tokens[i].startsWith('-')) i += 1
      continue
    }
    return { word: i < tokens.length ? basename(tokens[i]) : '', args: tokens.slice(i + 1) }
  }
}

export function decideBash(command, depth = 0) {
  if (depth > 5) return 'a command nested too deeply to check'
  const { segments, subs } = parse(dropHeredocs(command))
  for (const sub of subs) { const why = decideBash(sub, depth + 1); if (why) return why }
  for (const tokens of segments) {
    const { word, args } = commandOf(tokens)
    if (word === 'eval') { const why = decideBash(args.join(' '), depth + 1); if (why) return why }
    if (SHELLS.includes(word)) {
      const c = args.indexOf('-c')
      if (c >= 0 && args[c + 1] !== undefined) { const why = decideBash(args[c + 1], depth + 1); if (why) return why }
    }
    if (word === 'git') {
      let i = 0
      while (i < args.length && args[i].startsWith('-')) { if (GIT_VALUE_OPTS.includes(args[i])) i += 1; i += 1 }
      const sub = args.slice(i)
      for (const [match, why] of GIT_DENY) if (match(sub)) return why
    }
    if (word === 'rm' && args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive') && args.some(a => ['/', '/*', '~', '~/', '$HOME', '$HOME/', '${HOME}', '${HOME}/'].includes(a))) {
      return 'recursive rm of /, ~, or $HOME'
    }
  }
  return null
}

// The real path of a file that may not exist yet: its nearest existing parent,
// resolved, plus the rest. So a symlinked repo or ../ cannot dodge the rules.
function realish(p) {
  let head = p
  const rest = []
  while (!existsSync(head) && dirname(head) !== head) { rest.unshift(basename(head)); head = dirname(head) }
  try { head = realpathSync(head) } catch { /* keep it as given */ }
  return join(head, ...rest)
}

// The reason to deny one tool call, or null to let it run.
export function decide(tool, params, rules) {
  if (tool === 'Bash') return decideBash(params.command || '')
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return null
  const file = params.file_path || params.notebook_path
  if (typeof file !== 'string' || !file) return null
  const repo = realish(rules.repo)
  const abs = realish(isAbsolute(file) ? file : resolve(repo, file))
  const rel = relative(repo, abs).split('\\').join('/')
  if ((rules.writable || []).some(w => realish(w) === abs)) return null
  if ((rules.writableDirs || []).some(d => { const dir = realish(d); return abs === dir || abs.startsWith(`${dir}/`) })) return null
  if (rel === '.git' || rel.startsWith('.git/')) return 'editing inside .git'
  if ((rules.frozen || []).includes(rel)) return `${rel} is a frozen test from a slice that already landed; add a new test instead of changing it`
  return null
}
