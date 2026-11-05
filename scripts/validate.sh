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
# Print a block-list key's items, one per line ("skills:" then "- name" lines, any indent,
# optionally quoted).
fm_list() { frontmatter "$1" | awk -v k="$2" '$0==k":"{on=1; next} on && /^ *- /{sub(/^ *- */,""); gsub(/^["\x27]|["\x27] *$/,""); print; next} on{exit}'; }

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
effort_level="$(jq -r '.effortLevel // "missing"' settings.json)"
case "$effort_level" in
  low|medium|high|xhigh|max) ok "settings.json effortLevel=$effort_level" ;;
  missing) bad "settings.json: effortLevel missing (the graph expects a high-effort orchestrator)" ;;
  *) bad "settings.json: effortLevel '$effort_level' is not low|medium|high|xhigh|max" ;;
esac
if [ "$(jq -r '.disableAllHooks // false' settings.json)" = "true" ]; then
  bad "settings.json: disableAllHooks=true breaks /goal"
else ok "hooks not disabled"; fi
if grep -nE '"/(Users|home)/' settings.json; then
  bad "settings.json contains a machine-specific absolute path; move it to settings.local.json"
else ok "settings.json has no machine-specific paths"; fi

# ---- Layout: entries live in core/ and graphs/<graph>/, never at the top level ----
shopt -s nullglob
for d in skills agents workflows; do
  [ -e "$d" ] && bad "top-level $d/ is not read by install.sh; put entries in core/$d/ or graphs/<graph>/$d/"
done
graphs=(graphs/*/)
[ "${#graphs[@]}" -gt 0 ] || bad "no graphs found under graphs/"
# install.sh links every entry flat into ~/.claude/<dir>/, so a name may appear once across all roots.
for d in skills agents workflows; do
  dups="$(for e in core/"$d"/* graphs/*/"$d"/*; do basename "$e"; done | sort | uniq -d)"
  if [ -n "$dups" ]; then bad "duplicate $d name(s) across core/ and graphs/: $(echo $dups)"; else ok "$d names unique across core/ and graphs/"; fi
done
# Claude Code lists skills and workflows together, so a skill and a workflow may not share a name.
dups="$( { for e in core/skills/* graphs/*/skills/*; do basename "$e"; done
           for e in core/workflows/*.js graphs/*/workflows/*.js; do basename "$e" .js; done; } | sort | uniq -d)"
if [ -n "$dups" ]; then bad "a skill and a workflow share a name (both appear in the skills list): $(echo $dups)"; else ok "skill and workflow names do not collide"; fi

# ---- Skills ----
skills=(core/skills/*/SKILL.md graphs/*/skills/*/SKILL.md)
[ "${#skills[@]}" -gt 0 ] || bad "no skills found under core/skills/ or graphs/*/skills/"
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
agents=(core/agents/*.md graphs/*/agents/*.md)
[ "${#agents[@]}" -gt 0 ] || bad "no agents found under core/agents/ or graphs/*/agents/"
for f in "${agents[@]}"; do
  base="$(basename "$f" .md)"
  if ! frontmatter "$f" >/dev/null; then bad "$f: no frontmatter block"; continue; fi
  name="$(fm_get "$f" name)"; desc="$(fm_get "$f" description)"; model="$(fm_get "$f" model)"; effort="$(fm_get "$f" effort)"; tools="$(fm_get "$f" tools)"
  [ -n "$name" ] || bad "$f: 'name' missing"
  [ -n "$desc" ] || bad "$f: 'description' missing"
  [ "$name" = "$base" ] || bad "$f: name '$name' does not match filename"
  case "$name" in *:*|-*) bad "$f: name may not contain ':' or start with '-'" ;; esac
  case "$model" in
    haiku|sonnet|opus|fable|inherit|claude-*) ;;
    "") bad "$f: 'model' missing" ;;
    *) bad "$f: model '$model' is not a documented alias or model id" ;;
  esac
  case "$effort" in
    low|medium|high|xhigh|max) ;;
    "") bad "$f: 'effort' missing (agents in this repo pin effort explicitly)" ;;
    *) bad "$f: effort '$effort' is not low|medium|high|xhigh|max" ;;
  esac
  [ -n "$tools" ] || bad "$f: 'tools' missing (agents in this repo declare tools explicitly)"
  [ -n "$name" ] && [ -n "$desc" ] && [ -n "$model" ] && [ -n "$effort" ] && [ -n "$tools" ] && [ "$name" = "$base" ] && ok "agent $name (model=$model, effort=$effort)"
  # A preloaded skill that does not exist leaves the agent silently without its rules.
  [ -z "$(fm_get "$f" skills)" ] || bad "$f: write 'skills:' as a block list ('  - name' lines), not inline"
  while IFS= read -r s; do
    if [ -f "core/skills/$s/SKILL.md" ] || compgen -G "graphs/*/skills/$s/SKILL.md" >/dev/null; then ok "agent $name preloads skill $s"
    else bad "$f: preloads skill '$s', which is not in core/skills/ or graphs/*/skills/"; fi
  done < <(fm_list "$f" skills)
done

# ---- Workflows (routing is tested by scripts/test-workflow.sh) ----
for f in core/workflows/*.js graphs/*/workflows/*.js; do
  base="$(basename "$f" .js)"
  if [ "$(head -n 1 "$f")" != "export const meta = {" ]; then bad "$f: first line must be 'export const meta = {'"; continue; fi
  name="$(awk '/^  name: /{gsub(/^  name: \x27|\x27,$/,""); print; exit}' "$f")"
  if [ "$name" = "$base" ]; then ok "workflow $name"; else bad "$f: meta name '$name' does not match filename"; fi
done

# ---- Shell scripts parse ----
for f in install.sh scripts/*.sh core/skills/*/*.sh graphs/*/skills/*/*.sh .githooks/*; do
  [ -f "$f" ] || continue
  if bash -n "$f"; then ok "bash -n $f"; else bad "bash -n $f"; fi
  [ -x "$f" ] || bad "$f is not executable"
done
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S warning install.sh scripts/*.sh core/skills/*/*.sh graphs/*/skills/*/*.sh .githooks/*; then ok "shellcheck"; else bad "shellcheck"; fi
else echo "note  shellcheck not installed; skipped"; fi

# ---- Orchestrator rules (prose the routing tests cannot reach) ----
# Each rule came from a real run; dropping one silently would bring back the failure it fixed.
rule() { # rule <file> <fixed string> <what it guards>
  if grep -qF -- "$2" "$1"; then ok "rule in $1: $3"; else bad "$1 lost a rule: $3 (expected text: $2)"; fi
}
rule loop.md 'blockedOn' 'notify once per human block, tracked in the ledger'
rule loop.md 'being blocked is not idle' 'a block never ends the loop'
rule loop.md 'idleRuns' 'idle iterations are counted in the ledger'
rule loop.md 'When it reaches 2' 'a truly idle loop ends itself'
rule loop.md 'Stopping an iteration never skips steps 5 to 7' 'an escalation still notifies'
rule loop.md 'ScheduleWakeup with `stop: true`' 'how an idle loop ends'
rule graphs/dev/skills/dev/SKILL.md 'run-script.mjs' 'an approved plan runs via a generated script, never retyped'
rule graphs/dev/skills/dev/SKILL.md 'keptChanges' 'advisor-kept changes are reported and in the commit'
rule graphs/dev/skills/dev/SKILL.md 'blockedChanges' 'blocked unplanned changes are put to the human'
rule graphs/release/skills/release-pr/SKILL.md '## Notifications' 'release stops reach a user who walked away'
rule graphs/dev/agents/implementer.md 'one table-driven test per function' 'lean tests: data variations share one test'
rule graphs/dev/agents/implementer.md 'assert the rule the text must keep' 'copy tests assert rules, not whole sentences'
rule graphs/dev/skills/dev/SKILL.md 'Test ratio:' '/dev reports the test-to-code ratio every build'
rule core/agents/advisor.md 'State left stale for the next one is a defect' 'triage follows leftover state into the next run'
rule graphs/dev/agents/implementer.md 'Change no other entry, and add none' 'only /blueprint adds knowledge-map entries'
rule core/agents/advisor.md 'following the Advisor rules in your `knowledge-map`' 'the plan gate checks the knowledge map'
rule graphs/dev/agents/acceptance-auditor.md '`RECORDED` only when all three hold' 'owner records are checked against the map, not taken from the implementer'
# harness-review runs standalone without the knowledge-map skill, so it keeps a copy of the
# same-knowledge test; the knowledge-map skill is the source and the copy must match it exactly.
same_test="$(grep -m1 '^\*\*Same-knowledge test:\*\*' core/skills/knowledge-map/SKILL.md)"
if [ -z "$same_test" ]; then bad "core/skills/knowledge-map/SKILL.md lost its '**Same-knowledge test:**' line"
elif grep -qxF -- "$same_test" core/skills/harness-review/SKILL.md; then ok "harness-review's same-knowledge test matches knowledge-map"
else bad "core/skills/harness-review/SKILL.md: the same-knowledge test differs from knowledge-map's; copy the line exactly"; fi
rule graphs/blueprint/skills/blueprint/SKILL.md 'Never ask for a secret value.' 'preflight records credentials by name only'
rule graphs/blueprint/skills/blueprint/SKILL.md '`decisions` are binding.' 'interview answers bind every later stage'
rule graphs/blueprint/agents/architect.md '`decisions` are binding: the human made them.' 'the architect never designs around an answer'
rule graphs/blueprint/agents/architect.md 'only the human overrides one' 'the architect never overrides an assumption'
rule core/agents/advisor.md '## Gating a design' 'designs are gated before a backlog is cut from them'
rule core/agents/advisor.md 'Hand-synced list' 'the design gate screens for the eight red flags'
rule core/agents/advisor.md 'Re-gating a revision: check only the blocking issues you sent back' 'a re-gate narrows the work instead of reviewing a new design'
rule graphs/blueprint/skills/blueprint/SKILL.md 'entry in `notes`' 'the design report shows the findings the advisor did not send back'
rule core/skills/gtm-brief/SKILL.md 'Read the brief and never edit it.' 'agents never rewrite a product brief'
rule core/skills/gtm-brief/SKILL.md 'Never invent the' 'without a passing brief, marketing and sales agents stop'
rule graphs/seo/skills/seo-check/SKILL.md 'Errors fail; warnings never do.' 'a length guide or a Google-ignored tag never fails the SEO gate'
rule graphs/seo/skills/seo-check/SKILL.md '"our rule" means PandaStack' 'every SEO rule names its source; house rules say so'
rule graphs/blueprint/skills/blueprint/SKILL.md 'decisions:s.decisions.map(d=>({id:d.id,answer:d.answer}))' 'design args come from one exact command, never paraphrased'
rule graphs/blueprint/skills/blueprint/SKILL.md '"none" keeps every assumption' 'the optional last interview step says so (L0 finding)'
rule graphs/blueprint/skills/blueprint/SKILL.md 'Each answer replaces what it challenges' 'a gate answer never sits next to the decision it overrides'
rule graphs/blueprint/skills/blueprint/SKILL.md '`gateRounds`' 'the design gate cannot ask forever'

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
