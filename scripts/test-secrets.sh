#!/usr/bin/env bash
# test-secrets.sh — prove the secret scanner and pre-commit hook actually block.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claude-harness-secrets.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check() { if eval "$2"; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1" >&2; fail=$((fail+1)); fi; }
scan() { "$REPO/scripts/check-secrets.sh" "$@" >/dev/null 2>&1; }

echo "== file mode: known key formats are flagged"
printf 'const k = "AKIAABCDEFGHIJKLMNOP";\n'                       > "$TMP/aws.txt"  # allow-secret
printf 'key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n'   > "$TMP/anthropic.txt"  # allow-secret
printf 'ghp_%s\n' "$(printf 'a%.0s' $(seq 1 36))"                   > "$TMP/github.txt"  # allow-secret
printf 'SLACK=xoxb-123456789012-abcdefghij\n'                       > "$TMP/slack.txt"  # allow-secret
printf -- '-----BEGIN RSA PRIVATE KEY-----\n'                       > "$TMP/pem.txt"  # allow-secret
printf 'api_key = "supersecretvalue123"\n'                          > "$TMP/generic.txt"  # allow-secret
for f in aws anthropic github slack pem generic; do check "flags $f" "! scan '$TMP/$f.txt'"; done

printf 'OPENAI=sk-proj-%s\n' "$(printf 'b%.0s' $(seq 1 40))"           > "$TMP/openai.txt"      # allow-secret
printf 'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCY"\n'   > "$TMP/awssecret.txt"   # allow-secret
printf 'JWT_SECRET_KEY = "0123456789abcdef0123"\n'                   > "$TMP/jwtkey.txt"      # allow-secret
printf 'DATABASE_URL=postgres://app:hunter22hunter22@db/x\n'         > "$TMP/url.txt"         # allow-secret
printf 'API_KEY=abcdefghijklmnop1234\n'                               > "$TMP/dotenv.txt"      # allow-secret
printf 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig\n' > "$TMP/jwt.txt"     # allow-secret
for f in openai awssecret jwtkey url dotenv jwt; do check "flags $f" "! scan '$TMP/$f.txt'"; done

echo "== file mode: ordinary code is not flagged"
printf 'const token = "abc";\nconst tokenName = x;\nfoo(password);\nsecret = os.environ["SECRET"]\npassword: ${DB_PASSWORD}\n' > "$TMP/clean.txt"
check "clean code passes" "scan '$TMP/clean.txt'"
printf 'example: api_key = "not-a-real-key-0000"  # allow-secret\n' > "$TMP/allow.txt"
check "allow-secret marker whitelists a line" "scan '$TMP/allow.txt'"
printf 'token: "${{ secrets.GITHUB_TOKEN }}"\npassword = "{{ .Values.db.password }}"\npassword="<your-password-here>"\nsecret: "REPLACE_ME_WITH_REAL"\nconst token = "abcdefghij";\n' > "$TMP/templates.txt"
check "CI/Helm/placeholder templates pass" "scan '$TMP/templates.txt'"
printf 'hello\0world\n' > "$TMP/bin.dat"
check "binary file does not false-positive" "scan '$TMP/bin.dat'"

echo "== staged mode + pre-commit hook in a scratch repo"
mkdir -p "$TMP/repo/scripts" && cd "$TMP/repo" && git init -q
cp "$REPO/scripts/check-secrets.sh" scripts/ && cp -r "$REPO/.githooks" . && git config core.hooksPath .githooks
G="git -c user.email=t@example.com -c user.name=t"
echo 'token = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"' > leak.txt  # allow-secret
git add .
check "staged scan flags leak"        "! scripts/check-secrets.sh --staged >/dev/null 2>&1"
check "pre-commit blocks the commit"  "! $G commit -qm leak >/dev/null 2>&1"
git rm -q --cached leak.txt && rm leak.txt
echo 'hello' > ok.txt && git add ok.txt
check "pre-commit allows clean commit" "$G commit -qm ok >/dev/null 2>&1"
echo '{}' > settings.local.json && git add -f settings.local.json
check "pre-commit blocks settings.local.json" "! $G commit -qm local >/dev/null 2>&1"
git rm -q --cached settings.local.json
echo 'x' > gone.txt && git add gone.txt && $G commit -qm add >/dev/null && git rm -q gone.txt
check "staged scan tolerates a staged deletion" "scripts/check-secrets.sh --staged >/dev/null 2>&1"
$G commit -qm rm >/dev/null
printf 'api_key = "supersecretvalue123"\n' > "café.txt" && git add "café.txt"   # allow-secret
check "staged scan catches non-ASCII filename" "! scripts/check-secrets.sh --staged >/dev/null 2>&1"

echo
echo "TEST-SECRETS: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
