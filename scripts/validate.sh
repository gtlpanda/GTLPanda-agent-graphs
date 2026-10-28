#!/usr/bin/env bash
# validate.sh — lint this repo: JSON is valid, every SKILL.md and agent has the
# required frontmatter, settings.json carries the keys the harness depends on,
# shell scripts parse, and no secrets or machine paths are committed.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail=0
ok()   { printf 'ok    %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*" >&2; fail=1; }
for tool in python3 jq git; do
  command -v "$tool" >/dev/null 2>&1 || { bad "required tool '$tool' not installed"; }
done
[ "$fail" -eq 0 ] || { echo "VALIDATE: FAIL"; exit 1; }

# Print frontmatter body (between the first two '---' lines) of a markdown file.
frontmatter() { awk 'NR==1 && $0!="---"{exit 1} NR>1 && $0=="---"{exit} NR>1{print}' "$1"; }
fm_get() { frontmatter "$1" | awk -v k="$2" -F': *' '$1==k{sub(/^[^:]*: */,""); print; exit}'; }

# ---- JSON ----
for f in settings.json; do
  if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" 2>/dev/null; then ok "$f is valid JSON"
  else bad "$f is not valid JSON"; fi
done

# ---- settings.json contract ----
mode="$(jq -r '.permissions.defaultMode // empty' settings.json)"
case "$mode" in
  default|acceptEdits|plan|auto|dontAsk|bypassPermissions) ok "permissions.defaultMode=$mode" ;;
  "") bad "settings.json: permissions.defaultMode missing" ;;
  *)  bad "settings.json: permissions.defaultMode='$mode' is not a documented value" ;;
esac
teams="$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // "missing"' settings.json)"
case "$teams" in
  0) ok "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=\"0\" (off; see README to enable)" ;;
  1) ok "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=\"1\" (ON: ~7x token cost)" ;;
  *) bad "settings.json: env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS must be \"0\" or \"1\" (got $teams)" ;;
esac
for key in model advisorModel; do
  val="$(jq -r --arg k "$key" '.[$k] // "missing"' settings.json)"
  case "$val" in
    haiku|sonnet|opus|fable|claude-*) ok "settings.json $key=$val" ;;
    missing) bad "settings.json: $key missing (the graph expects an opus orchestrator and a fable advisor)" ;;
    *) bad "settings.json: $key '$val' is not a documented alias or model id" ;;
  esac
done
if [ "$(jq -r '.disableAllHooks // false' settings.json)" = "true" ]; then
  bad "settings.json: disableAllHooks=true breaks /goal"
else ok "hooks not disabled"; fi
if grep -nE '"/(Users|home)/' settings.json; then
  bad "settings.json contains a machine-specific absolute path; move it to settings.local.json"
else ok "settings.json has no machine-specific paths"; fi

# ---- Skills ----
shopt -s nullglob
skills=(skills/*/SKILL.md)
[ "${#skills[@]}" -gt 0 ] || bad "no skills found under skills/"
for f in "${skills[@]}"; do
  dir="$(basename "$(dirname "$f")")"
  if ! frontmatter "$f" >/dev/null; then bad "$f: no frontmatter block"; continue; fi
  name="$(fm_get "$f" name)"; desc="$(fm_get "$f" description)"
  [ -n "$name" ] || bad "$f: frontmatter 'name' missing"
  [ -n "$desc" ] || bad "$f: frontmatter 'description' missing"
  [ "$name" = "$dir" ] || bad "$f: name '$name' does not match directory '$dir'"
  [ -n "$name" ] && [ -n "$desc" ] && [ "$name" = "$dir" ] && ok "skill $name"
done

# ---- Agents ----
agents=(agents/*.md)
[ "${#agents[@]}" -gt 0 ] || bad "no agents found under agents/"
for f in "${agents[@]}"; do
  base="$(basename "$f" .md)"
  if ! frontmatter "$f" >/dev/null; then bad "$f: no frontmatter block"; continue; fi
  name="$(fm_get "$f" name)"; desc="$(fm_get "$f" description)"; model="$(fm_get "$f" model)"; tools="$(fm_get "$f" tools)"
  [ -n "$name" ] || bad "$f: 'name' missing"
  [ -n "$desc" ] || bad "$f: 'description' missing"
  [ "$name" = "$base" ] || bad "$f: name '$name' does not match filename"
  case "$name" in *:*|-*) bad "$f: name may not contain ':' or start with '-'" ;; esac
  case "$model" in
    haiku|sonnet|opus|fable|inherit|claude-*) ;;
    "") bad "$f: 'model' missing" ;;
    *) bad "$f: model '$model' is not a documented alias or model id" ;;
  esac
  [ -n "$tools" ] || bad "$f: 'tools' missing (agents in this repo declare tools explicitly)"
  [ -n "$name" ] && [ -n "$desc" ] && [ -n "$model" ] && [ -n "$tools" ] && [ "$name" = "$base" ] && ok "agent $name (model=$model)"
done

# ---- Shell scripts parse ----
for f in install.sh scripts/*.sh skills/*/*.sh .githooks/*; do
  [ -f "$f" ] || continue
  if bash -n "$f"; then ok "bash -n $f"; else bad "bash -n $f"; fi
  [ -x "$f" ] || bad "$f is not executable"
done
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S warning install.sh scripts/*.sh skills/*/*.sh .githooks/*; then ok "shellcheck"; else bad "shellcheck"; fi
else echo "note  shellcheck not installed; skipped"; fi

# ---- Required files ----
for f in install.sh README.md CLAUDE.md settings.json loop.md .gitignore .githooks/pre-commit; do
  [ -f "$f" ] && ok "present $f" || bad "missing $f"
done
grep -qE '^settings\.local\.json$' .gitignore && ok ".gitignore ignores settings.local.json" || bad ".gitignore must ignore settings.local.json"
if git ls-files --error-unmatch settings.local.json >/dev/null 2>&1; then bad "settings.local.json is tracked by git"; fi

# ---- Secrets ----
if scripts/check-secrets.sh >/dev/null; then ok "no secrets detected"; else bad "possible secrets found (run scripts/check-secrets.sh)"; fi

echo
if [ "$fail" -eq 0 ]; then echo "VALIDATE: PASS"; exit 0; else echo "VALIDATE: FAIL"; exit 1; fi
