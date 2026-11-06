#!/usr/bin/env bash
# smoke-build.sh — one real /build-app slice, end to end, on a throwaway repo.
#
#   scripts/smoke-build.sh [--keep]     (--keep: leave the throwaway repo for reading)
#
# Opt-in and never part of scripts/test.sh: it runs a real headless Claude
# session (a full /dev run, about 15-40 minutes) and spends real usage. It
# builds a one-slice backlog (an `add` function with a test) with the
# installed driver and --no-pr, then prints the driver's exit code, the
# outcome, the cost from the session's result line, and the models the session
# used, so the agent model pins can be checked. Ends with SMOKE-BUILD: PASS|FAIL.
set -euo pipefail

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# HARNESS_BUILD_DRIVER: a driver to smoke instead of the installed one (a branch before merge).
DRIVER="${HARNESS_BUILD_DRIVER:-$C/skills/build-app/driver/driver.mjs}"
[ -f "$DRIVER" ] || { echo "smoke-build: $DRIVER not found; run ./install.sh first" >&2; exit 2; }
command -v claude >/dev/null || { echo "smoke-build: claude not on PATH" >&2; exit 2; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/smoke-build-XXXXXX")"
cleanup() { if [ "$KEEP" -eq 0 ]; then rm -rf "$ROOT"; else echo "smoke-build: kept $ROOT"; fi; }
trap cleanup EXIT

git -C "$ROOT" init -q -b main
git -C "$ROOT" config user.email smoke@example.com
git -C "$ROOT" config user.name smoke
cat > "$ROOT/package.json" <<'JSON'
{ "name": "smoke", "version": "1.0.0", "type": "module", "private": true, "scripts": { "test": "node --test" } }
JSON
printf 'node_modules/\n' > "$ROOT/.gitignore"
mkdir -p "$ROOT/test"
cat > "$ROOT/test/smoke.test.js" <<'JS'
import { test } from 'node:test'
test('the project runs its tests', () => {})
JS
git -C "$ROOT" add -A
git -C "$ROOT" commit -q -m "init"
git -C "$ROOT" switch -q -c integration/smoke
mkdir -p "$ROOT/docs"
cat > "$ROOT/docs/backlog.json" <<'JSON'
{
  "version": 1,
  "app": "smoke",
  "integrationBranch": "integration/smoke",
  "requirements": ["R1"],
  "slices": [
    {
      "id": "S1",
      "title": "An add function",
      "goal": "Add src/add.js exporting add(a, b) that returns the sum of two numbers, with a node:test test in test/add.test.js. Plain JavaScript modules, no dependencies.",
      "requirements": ["R1"],
      "acceptance": [
        { "id": "S1-AC1", "criterion": "add(2, 3) returns 5", "fails_when": "add(2, 3) returns anything but 5" },
        { "id": "S1-AC2", "criterion": "add throws a TypeError when either argument is not a number", "fails_when": "add('2', 3) returns a value instead of throwing a TypeError" }
      ],
      "depends_on": []
    }
  ]
}
JSON
git -C "$ROOT" add -A
git -C "$ROOT" commit -q -m "blueprint: design and backlog for smoke"

echo "smoke-build: building one slice in $ROOT (a full /dev run; this takes a while)"
set +e
node "$DRIVER" run --repo "$ROOT" --app smoke --no-pr
CODE=$?
set -e

STATE="$(git -C "$ROOT" rev-parse --path-format=absolute --git-path harness-build)/smoke"
echo "smoke-build: driver exit $CODE"
node - "$STATE" <<'NODE'
const fs = require('fs'), path = require('path')
const state = process.argv[2]
const status = JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8'))
console.log(`smoke-build: ${status.state}: ${status.message}`)
const logs = fs.readdirSync(path.join(state, 'logs')).filter(f => f.endsWith('.jsonl') && f !== 'probe.jsonl')
let cost = 0
const models = {}
for (const f of logs) {
  for (const line of fs.readFileSync(path.join(state, 'logs', f), 'utf8').split('\n')) {
    if (!line.includes('"type":"result"')) continue
    try {
      const r = JSON.parse(line)
      cost += Number(r.total_cost_usd || 0)
      for (const [m, u] of Object.entries(r.modelUsage || {})) models[m] = (models[m] || 0) + Number(u.costUSD || 0)
    } catch {}
  }
}
console.log(`smoke-build: ${logs.length} session(s), $${cost.toFixed(2)}`)
for (const [m, c] of Object.entries(models)) console.log(`smoke-build:   ${m}: $${c.toFixed(2)}`)
NODE
if [ "$CODE" -eq 0 ] && git -C "$ROOT" show integration/smoke:src/add.js >/dev/null 2>&1; then
  echo "SMOKE-BUILD: PASS"
else
  KEEP=1
  echo "SMOKE-BUILD: FAIL"
  exit 1
fi
