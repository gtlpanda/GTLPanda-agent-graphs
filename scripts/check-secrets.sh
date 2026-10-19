#!/usr/bin/env bash
# check-secrets.sh — grep for keys and tokens.
#   scripts/check-secrets.sh            scan all git-tracked files (or all files if not a repo)
#   scripts/check-secrets.sh --staged   scan staged content only (used by the pre-commit hook)
#   scripts/check-secrets.sh FILE...    scan the given files
# Exit 1 on any hit, and on any file it could not read (fail closed).
set -euo pipefail

PATTERNS=(
  'sk-ant-[A-Za-z0-9_-]{20,}'                      # Anthropic API key
  'sk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}'         # OpenAI-style keys (classic, project, service account)
  'AKIA[0-9A-Z]{16}'                               # AWS access key id
  'ghp_[A-Za-z0-9]{36}'                            # GitHub PAT (classic)
  'github_pat_[A-Za-z0-9_]{22,}'                   # GitHub PAT (fine-grained)
  'gh[ousr]_[A-Za-z0-9]{36}'                       # GitHub OAuth/user/server/refresh tokens
  'xox[abprs]-[A-Za-z0-9-]{10,}'                   # Slack tokens
  'AIza[0-9A-Za-z_-]{35}'                          # Google API key
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}'   # JWT
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'             # PEM private key
  '://[^/:@[:space:]]+:[^@/[:space:]]{8,}@'        # credentials embedded in a URL
  # generic: something named like a secret, assigned a quoted literal of 12+ chars
  '[A-Za-z_]*(api[_-]?key|secret|token|password|passwd)[A-Za-z_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{12,}["'"'"']'
  # generic: unquoted dotenv-style assignment (KEY=value) of 16+ chars with no spaces
  '^[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)=[^[:space:]"'"'"']{16,}$'
)
# Lines matching one of these are templates/placeholders, not secrets.
PLACEHOLDERS='\$\{|\{\{|<[^>]{3,}>|REPLACE|CHANGE_?ME|EXAMPLE|YOUR_|xxxx|\.\.\.|allow-secret'
REGEX="$(IFS='|'; echo "${PATTERNS[*]}")"
ALLOW_MARK='allow-secret'   # append this comment to a line to whitelist it (e.g. docs examples)

hits=0
scan_stream() {  # scan_stream <label>; content on stdin
  local label="$1" out
  out="$(grep -nEIi "$REGEX" | grep -vE "$PLACEHOLDERS" || true)"
  if [ -n "$out" ]; then
    printf 'SECRET? %s\n%s\n' "$label" "$out" | sed '2,$s/^/  /'
    hits=$((hits + 1))
  fi
}

if [ "${1:-}" = "--staged" ]; then
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    if ! git show ":$f" > "$tmp" 2>/dev/null; then
      echo "SECRET? $f (staged): could not read staged content; refusing"; hits=$((hits + 1)); continue
    fi
    scan_stream "$f (staged)" < "$tmp"
  done < <(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR -z)
elif [ "$#" -gt 0 ]; then
  for f in "$@"; do
    if [ -f "$f" ]; then scan_stream "$f" < "$f"
    else echo "SECRET? $f: not a readable file"; hits=$((hits + 1)); fi
  done
else
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    lister=(git -c core.quotePath=false ls-files -z)
  else
    lister=(find . -type f -not -path './.git/*' -print0)
  fi
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    scan_stream "$f" < "$f"
  done < <("${lister[@]}")
fi

if [ "$hits" -gt 0 ]; then
  echo "check-secrets: $hits file(s) with possible secrets. Remove them, or append '# $ALLOW_MARK' to a known-safe example line." >&2
  exit 1
fi
echo "check-secrets: clean"
