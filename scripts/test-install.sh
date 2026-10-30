#!/usr/bin/env bash
# test-install.sh — exercise install.sh against a throwaway HOME.
# Asserts: dry-run changes nothing; install links everything and backs up what
# was in the way; a second install is a no-op; uninstall restores the originals
# byte-for-byte and leaves no link into the repo.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claude-harness-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
unset CLAUDE_CONFIG_DIR
export HARNESS_NO_GIT_CONFIG=1
CD="$HOME/.claude"

pass=0; fail=0
check() { if eval "$2"; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1" >&2; fail=$((fail+1)); fi; }
snapshot() { (cd "$HOME" && find . -print | sort; find . -type l -exec sh -c 'printf "%s -> %s\n" "$1" "$(readlink "$1")"' _ {} \; | sort); }

echo "== seed a pre-existing ~/.claude with things in the way"
mkdir -p "$CD/skills/legacy" "$CD/skills/verify" "$CD/skills/review" "$CD/agents"
echo '{"model":"old","hooks":{}}' > "$CD/settings.json"
echo '# old rules' > "$CD/CLAUDE.md"
echo 'name: legacy' > "$CD/skills/legacy/SKILL.md"
echo 'name: verify-old' > "$CD/skills/verify/SKILL.md"
echo 'name: review' > "$CD/skills/review/SKILL.md"   # another tool's skill named review (gstack ships one)
echo 'old reviewer' > "$CD/agents/reviewer.md"
ln -s /nonexistent "$CD/agents/checker.md"        # broken foreign symlink in the way
before="$(snapshot)"

echo "== 1. dry-run changes nothing"
"$REPO/install.sh" --dry-run >"$TMP/dry.log"
check "dry-run printed actions"        'grep -q "\[dry-run\] ln -s" "$TMP/dry.log"'
check "dry-run left tree untouched"    '[ "$(snapshot)" = "$before" ]'
check "dry-run created no backup dir"  '[ ! -d "$CD/backups" ]'

echo "== 2. install links everything, backs up conflicts"
"$REPO/install.sh" >"$TMP/install1.log"
# dest (under ~/.claude) = src (in the repo)
for pair in settings.json=settings.json CLAUDE.md=CLAUDE.md loop.md=loop.md \
            skills/verify=core/skills/verify skills/harness-review=core/skills/harness-review \
            agents/checker.md=core/agents/checker.md agents/advisor.md=core/agents/advisor.md \
            agents/reviewer.md=graphs/qa/agents/reviewer.md agents/fixer.md=graphs/qa/agents/fixer.md \
            agents/qa-auditor.md=graphs/qa/agents/qa-auditor.md \
            workflows/harness-repair.js=graphs/qa/workflows/harness-repair.js; do
  rel="${pair%%=*}"; src="${pair#*=}"
  check "linked $rel -> $src" '[ -L "$CD/'"$rel"'" ] && [ "$(readlink "$CD/'"$rel"'")" = "$REPO/'"$src"'" ]'
done
check "untouched foreign skill kept"   '[ -f "$CD/skills/legacy/SKILL.md" ] && [ ! -L "$CD/skills/legacy" ]'
check "foreign skills/review untouched" '[ ! -L "$CD/skills/review" ] && [ "$(cat "$CD/skills/review/SKILL.md")" = "name: review" ]'
bk="$(ls -1d "$CD"/backups/*/ | head -1)"; bk="${bk%/}"
check "exactly one backup dir"         '[ "$(ls -1d "$CD"/backups/*/ | wc -l | tr -d " ")" = "1" ]'
check "manifest lists 5 moved items"   '[ "$(wc -l < "$bk/.harness-manifest" | tr -d " ")" = "5" ]'
check "old settings.json in backup"    '[ "$(cat "$bk/settings.json")" = "{\"model\":\"old\",\"hooks\":{}}" ]'
check "old skills/verify in backup"    '[ "$(cat "$bk/skills/verify/SKILL.md")" = "name: verify-old" ]'
check "broken symlink moved to backup" '[ -L "$bk/agents/checker.md" ]'
after1="$(snapshot)"

echo "== 3. second install is a no-op"
"$REPO/install.sh" >"$TMP/install2.log"
check "no new backup dir"              '[ "$(ls -1d "$CD"/backups/*/ | wc -l | tr -d " ")" = "1" ]'
check "tree identical after re-run"    '[ "$(snapshot)" = "$after1" ]'
check "reports 0 linked"               'grep -q "done: 0 linked" "$TMP/install2.log"'

echo "== 4. uninstall restores original state"
"$REPO/install.sh" --uninstall >"$TMP/uninstall.log"
check "settings.json restored"         '[ ! -L "$CD/settings.json" ] && [ "$(cat "$CD/settings.json")" = "{\"model\":\"old\",\"hooks\":{}}" ]'
check "CLAUDE.md restored"             '[ "$(cat "$CD/CLAUDE.md")" = "# old rules" ]'
check "skills/verify restored"         '[ ! -L "$CD/skills/verify" ] && [ "$(cat "$CD/skills/verify/SKILL.md")" = "name: verify-old" ]'
check "agents/reviewer.md restored"    '[ "$(cat "$CD/agents/reviewer.md")" = "old reviewer" ]'
check "broken symlink restored as-is"  '[ -L "$CD/agents/checker.md" ] && [ "$(readlink "$CD/agents/checker.md")" = "/nonexistent" ]'
check "loop.md removed (was ours)"     '[ ! -e "$CD/loop.md" ] && [ ! -L "$CD/loop.md" ]'
check "skills/harness-review removed"  '[ ! -e "$CD/skills/harness-review" ] && [ ! -L "$CD/skills/harness-review" ]'
check "workflows link removed"         '[ ! -e "$CD/workflows/harness-repair.js" ] && [ ! -L "$CD/workflows/harness-repair.js" ]'
check "foreign skills/review survives" '[ "$(cat "$CD/skills/review/SKILL.md")" = "name: review" ]'
check "legacy skill still present"     '[ -f "$CD/skills/legacy/SKILL.md" ]'
check "no link into repo remains"      '! find "$CD" -type l -exec readlink {} \; | grep -q "^$REPO/"'
check "backup dir cleaned up"          '[ -z "$(ls -A "$CD/backups" 2>/dev/null)" ]'

echo "== 5. uninstall with nothing installed is safe"
"$REPO/install.sh" --uninstall >"$TMP/uninstall2.log"
check "second uninstall exits 0"       'true'
check "settings.json untouched"        '[ "$(cat "$CD/settings.json")" = "{\"model\":\"old\",\"hooks\":{}}" ]'

echo "== 6. regression: target that resolves into the repo is refused (audit C1/H4)"
RCOPY="$TMP/repocopy"; cp -R "$REPO" "$RCOPY"; rm -rf "$RCOPY/.git"
H2="$TMP/home2"; mkdir -p "$H2"; ln -s "$RCOPY" "$H2/.claude"
check "refuses ~/.claude -> repo"      '! HOME="$H2" "$RCOPY/install.sh" >/dev/null 2>&1'
check "repo skills untouched"          '[ -f "$RCOPY/core/skills/verify/SKILL.md" ] && [ ! -L "$RCOPY/core/skills/verify" ]'
H3="$TMP/home3"; mkdir -p "$H3/.claude" "$TMP/dotfiles/skills"; ln -s "$TMP/dotfiles/skills" "$H3/.claude/skills"
check "refuses symlinked skills dir"   '! HOME="$H3" "$REPO/install.sh" >/dev/null 2>&1'
check "nothing written through link"   '[ -z "$(ls -A "$TMP/dotfiles/skills")" ]'

echo "== 7. regression: same-second reinstall never overwrites a backup (audit H1)"
H4="$TMP/home4"; mkdir -p "$H4/.claude"; echo ORIGINAL > "$H4/.claude/settings.json"
HOME="$H4" "$REPO/install.sh" >/dev/null
rm "$H4/.claude/settings.json"; echo SECOND > "$H4/.claude/settings.json"
HOME="$H4" "$REPO/install.sh" >/dev/null
check "two backup dirs exist"          '[ "$(ls -1d "$H4"/.claude/backups/*/ | wc -l | tr -d " ")" = "2" ]'
check "ORIGINAL still in a backup"     'grep -rqs ORIGINAL "$H4/.claude/backups"'
check "SECOND still in a backup"       'grep -rqs SECOND "$H4/.claude/backups"'

echo "== 8. regression: spaces in the config path (audit H2)"
export CLAUDE_CONFIG_DIR="$TMP/My Claude Dir"; mkdir -p "$CLAUDE_CONFIG_DIR"; echo '{"keep":1}' > "$CLAUDE_CONFIG_DIR/settings.json"
"$REPO/install.sh" >/dev/null && "$REPO/install.sh" --uninstall >/dev/null
check "settings.json restored w/ spaces" '[ "$(cat "$CLAUDE_CONFIG_DIR/settings.json")" = "{\"keep\":1}" ]'
unset CLAUDE_CONFIG_DIR

echo "== 9. regression: stale harness link from a moved repo is replaced, not backed up (audit H3)"
H5="$TMP/home5"; mkdir -p "$H5/.claude/agents"
ln -s "/old/checkout/settings.json" "$H5/.claude/settings.json"
ln -s "/old/checkout/agents/fixer.md" "$H5/.claude/agents/fixer.md"
ln -s "/somewhere/else/thing.md" "$H5/.claude/agents/checker.md"   # foreign dangling link: real user data
HOME="$H5" "$REPO/install.sh" >"$TMP/install5.log"
check "stale link replaced"            '[ "$(readlink "$H5/.claude/settings.json")" = "$REPO/settings.json" ]'
check "stale links not in a backup"    '! grep -rqs "settings.json\|fixer.md" "$H5"/.claude/backups/*/.harness-manifest 2>/dev/null'
check "foreign dangling link backed up" 'grep -qs "agents/checker.md" "$H5"/.claude/backups/*/.harness-manifest'

echo "== 10. regression: partial restore keeps the manifest for the leftovers (audit M1)"
H6="$TMP/home6"; mkdir -p "$H6/.claude"; echo A > "$H6/.claude/CLAUDE.md"; echo B > "$H6/.claude/settings.json"
HOME="$H6" "$REPO/install.sh" >/dev/null
rm "$H6/.claude/CLAUDE.md"; echo NEW > "$H6/.claude/CLAUDE.md"      # user put a real file where our link was
HOME="$H6" "$REPO/install.sh" --uninstall >/dev/null 2>&1
bk6="$(ls -1d "$H6"/.claude/backups/*/ | head -1)"
check "settings.json restored"         '[ "$(cat "$H6/.claude/settings.json")" = "B" ]'
check "conflicting file left alone"    '[ "$(cat "$H6/.claude/CLAUDE.md")" = "NEW" ]'
check "manifest kept with leftover"    '[ "$(cat "$bk6.harness-manifest")" = "CLAUDE.md" ]'
rm "$H6/.claude/CLAUDE.md"; HOME="$H6" "$REPO/install.sh" --uninstall >/dev/null 2>&1
check "second uninstall restores it"   '[ "$(cat "$H6/.claude/CLAUDE.md")" = "A" ]'
check "backup dir now gone"            '[ ! -d "$bk6" ]'

echo "== 11. regression: dry-run uninstall reports what a real one would do (audit M2)"
H7="$TMP/home7"; mkdir -p "$H7/.claude"; echo X > "$H7/.claude/loop.md"
HOME="$H7" "$REPO/install.sh" >/dev/null
HOME="$H7" "$REPO/install.sh" --uninstall --dry-run >"$TMP/dry7.log" 2>&1
check "dry-run says it would restore"  'grep -q "\[dry-run\] mv .*loop.md" "$TMP/dry7.log"'
check "dry-run did not restore"        '[ -L "$H7/.claude/loop.md" ]'

echo "== 12. --skip leaves named targets alone and links the rest"
H8="$TMP/home8"; mkdir -p "$H8/.claude"; echo MINE > "$H8/.claude/settings.json"; echo RULES > "$H8/.claude/CLAUDE.md"
HOME="$H8" "$REPO/install.sh" --skip=settings.json,CLAUDE.md >"$TMP/install8.log"
check "skipped settings.json untouched" '[ ! -L "$H8/.claude/settings.json" ] && [ "$(cat "$H8/.claude/settings.json")" = "MINE" ]'
check "skipped CLAUDE.md untouched"    '[ ! -L "$H8/.claude/CLAUDE.md" ] && [ "$(cat "$H8/.claude/CLAUDE.md")" = "RULES" ]'
check "skips logged"                   '[ "$(grep -c "skip (--skip)" "$TMP/install8.log")" = "2" ]'
check "no backup made for skipped"     '[ ! -d "$H8/.claude/backups" ]'
check "rest linked (loop.md, workflow)" '[ -L "$H8/.claude/loop.md" ] && [ -L "$H8/.claude/workflows/harness-repair.js" ]'
H9="$TMP/home9"; mkdir -p "$H9/.claude"
HOME="$H9" "$REPO/install.sh" --skip=agents >/dev/null
check "--skip=<dir> skips every entry" '[ ! -e "$H9/.claude/agents" ] && [ -L "$H9/.claude/skills/verify" ]'
check "unknown --skip name refused"    '! HOME="$H9" "$REPO/install.sh" --skip=CLAUDE.mdd >/dev/null 2>&1'
check "--skip with --uninstall refused" '! HOME="$H9" "$REPO/install.sh" --uninstall --skip=CLAUDE.md >/dev/null 2>&1'
check "empty --skip= refused"          '! HOME="$H9" "$REPO/install.sh" --skip= >/dev/null 2>&1'
check "empty --skip= w/ uninstall refused" '! HOME="$H9" "$REPO/install.sh" --uninstall --skip= >/dev/null 2>&1'
check "refusals changed nothing"       '[ -L "$H9/.claude/CLAUDE.md" ] && [ ! -e "$H9/.claude/agents" ]'
H10="$TMP/home10"; mkdir -p "$H10/.claude"; echo MINE > "$H10/.claude/settings.json"
HOME="$H10" "$REPO/install.sh" --skip= >/dev/null 2>&1 || true
check "empty --skip= left settings alone" '[ ! -L "$H10/.claude/settings.json" ] && [ "$(cat "$H10/.claude/settings.json")" = "MINE" ] && [ ! -e "$H10/.claude/loop.md" ]'
HOME="$H10" "$REPO/install.sh" --skip=settings.json --dry-run >"$TMP/dry10.log"
check "--skip + --dry-run changes nothing" '[ "$(cat "$H10/.claude/settings.json")" = "MINE" ] && [ ! -e "$H10/.claude/loop.md" ] && grep -q "skip (--skip): settings.json" "$TMP/dry10.log"'

echo "== 13. every graph is installed; a name shipped by two sources is refused"
GCOPY="$TMP/graphcopy"; cp -R "$REPO" "$GCOPY"; rm -rf "$GCOPY/.git"
GCOPY="$(cd "$GCOPY" && pwd -P)"   # install.sh records physical paths (/var -> /private/var on macOS)
mkdir -p "$GCOPY/graphs/fake/agents"; printf -- '---\nname: extra\n---\n' > "$GCOPY/graphs/fake/agents/extra.md"
H11="$TMP/home11"; mkdir -p "$H11/.claude"
HOME="$H11" "$GCOPY/install.sh" >/dev/null
check "second graph's agent linked"    '[ "$(readlink "$H11/.claude/agents/extra.md")" = "$GCOPY/graphs/fake/agents/extra.md" ]'
check "first graph still linked"       '[ "$(readlink "$H11/.claude/agents/reviewer.md")" = "$GCOPY/graphs/qa/agents/reviewer.md" ]'
check "core agent linked"              '[ "$(readlink "$H11/.claude/agents/checker.md")" = "$GCOPY/core/agents/checker.md" ]'
cp "$GCOPY/core/agents/checker.md" "$GCOPY/graphs/fake/agents/checker.md"   # a graph shadowing a core agent
H12="$TMP/home12"; mkdir -p "$H12/.claude"; echo MINE > "$H12/.claude/settings.json"
check "duplicate name refused"         '! HOME="$H12" "$GCOPY/install.sh" >"$TMP/install12.log" 2>&1'
check "refusal names both sources"     'grep -q "agents/checker.md is provided by more than one source: core/agents/checker.md graphs/fake/agents/checker.md" "$TMP/install12.log"'
check "refusal wrote nothing"          '[ "$(cat "$H12/.claude/settings.json")" = "MINE" ] && [ ! -e "$H12/.claude/agents" ] && [ ! -d "$H12/.claude/backups" ]'

echo
echo "TEST-INSTALL: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
