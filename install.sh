#!/usr/bin/env bash
# install.sh — link this repo's Claude Code config into ~/.claude/
#
# Links (never the whole ~/.claude directory — it holds credentials and state):
#   files:        settings.json, CLAUDE.md, loop.md    -> one symlink each
#   directories:  skills/, agents/, workflows/          -> one symlink PER ENTRY
#                 (so entries installed by other tools keep working)
#
# Usage:
#   ./install.sh              link; back up anything in the way
#   ./install.sh --dry-run    print what would happen, change nothing
#   ./install.sh --skip=a,b   install, but leave these targets alone (e.g.
#                             --skip=settings.json,CLAUDE.md, or skills/verify)
#   ./install.sh --uninstall  remove our links, restore the most recent backup
#
# Env: CLAUDE_CONFIG_DIR overrides the target (default: $HOME/.claude).
#      HARNESS_NO_GIT_CONFIG=1 skips enabling the repo's pre-commit hook.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CLAUDE_DIR="${CLAUDE_DIR%/}"
BACKUP_ROOT="$CLAUDE_DIR/backups"
MANIFEST=".harness-manifest"

FILE_TARGETS=(settings.json CLAUDE.md loop.md)
DIR_TARGETS=(skills agents workflows)

DRY_RUN=0
MODE=install
SKIP=()      # rel paths (or a whole DIR_TARGETS name) that install leaves alone

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) MODE=uninstall ;;
    --skip=*)
      # An empty value (e.g. --skip="$UNSET") must not fall through to a full install.
      [ -n "${arg#--skip=}" ] || { echo "--skip= needs at least one target" >&2; exit 2; }
      IFS=',' read -r -a parts <<< "${arg#--skip=}"; SKIP+=(${parts[@]+"${parts[@]}"}) ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$MODE" = install ] || [ "${#SKIP[@]}" -eq 0 ] || { echo "--skip only applies to install" >&2; exit 2; }

log()  { printf '%s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] $*"; else "$@"; fi
}
# Physical path of a directory, or empty if it does not exist.
physical() { [ -d "$1" ] && (cd "$1" && pwd -P) || true; }

# Refuse layouts where linking would write into, or move files out of, the repo
# itself, or write through a symlinked skills/agents dir into some other tree.
guard_layout() {
  local p t
  p="$(physical "$CLAUDE_DIR")"
  case "$p" in "$REPO_DIR"|"$REPO_DIR"/*)
    die "$CLAUDE_DIR resolves inside the repo ($REPO_DIR); refusing" ;;
  esac
  for t in "${DIR_TARGETS[@]}"; do
    if [ -L "$CLAUDE_DIR/$t" ]; then
      die "$CLAUDE_DIR/$t is a symlink (-> $(readlink "$CLAUDE_DIR/$t")). Replace it with a real directory first; per-entry links must land in $CLAUDE_DIR/$t itself"
    fi
    p="$(physical "$CLAUDE_DIR/$t")"
    case "$p" in "$REPO_DIR"|"$REPO_DIR"/*) die "$CLAUDE_DIR/$t resolves inside the repo; refusing" ;; esac
  done
}

# Print "rel/path" for every item we manage, one per line.
list_targets() {
  local t entry
  for t in "${FILE_TARGETS[@]}"; do printf '%s\n' "$t"; done
  for t in "${DIR_TARGETS[@]}"; do
    [ -d "$REPO_DIR/$t" ] || continue
    for entry in "$REPO_DIR/$t"/*; do
      [ -e "$entry" ] || continue
      printf '%s/%s\n' "$t" "$(basename "$entry")"
    done
  done
}

# True if rel path $1 is named by --skip, directly or by its top-level dir.
is_skipped() {
  local s
  for s in ${SKIP[@]+"${SKIP[@]}"}; do
    [ "$1" = "$s" ] && return 0
    case "$1" in "$s"/*) return 0 ;; esac
  done
  return 1
}
# Refuse --skip names that match nothing, so a typo cannot silently install the target.
check_skips() {
  local s t known targets
  # Collect first: `list_targets | grep -q` under pipefail fails when grep exits
  # early on a match and list_targets takes SIGPIPE.
  targets="$(list_targets)"
  for s in ${SKIP[@]+"${SKIP[@]}"}; do
    known=0
    for t in "${DIR_TARGETS[@]}"; do [ "$s" = "$t" ] && known=1; done
    [ "$known" -eq 1 ] || grep -qxF -- "$s" <<< "$targets" || die "--skip: '$s' is not an install target (see the table in README.md)"
  done
}

# True if $1 is a symlink whose literal target is inside this repo.
points_into_repo() {
  [ -L "$1" ] || return 1
  case "$(readlink "$1")" in "$REPO_DIR"/*) return 0 ;; *) return 1 ;; esac
}
# True if $1 is a dangling symlink that looks like a harness link from a
# previous checkout location (target path ends in /<rel>). Not user data.
is_stale_harness_link() {  # $1 = path, $2 = rel
  [ -L "$1" ] && [ ! -e "$1" ] || return 1
  case "$(readlink "$1")" in */"$2") return 0 ;; *) return 1 ;; esac
}

BACKUP_DIR=""
ensure_backup_dir() {
  [ -n "$BACKUP_DIR" ] && return 0
  local ts n=0
  ts="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$BACKUP_ROOT/$ts"
  while [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; do n=$((n + 1)); BACKUP_DIR="$BACKUP_ROOT/$ts-$n"; done
  run mkdir -p "$BACKUP_DIR"
  log "backup dir: $BACKUP_DIR"
}

backup_target() {  # $1 = rel path
  local rel="$1" dest="$CLAUDE_DIR/$1"
  ensure_backup_dir
  if [ -e "$BACKUP_DIR/$rel" ] || [ -L "$BACKUP_DIR/$rel" ]; then
    die "backup collision: $BACKUP_DIR/$rel already exists; refusing to overwrite"
  fi
  run mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
  run mv "$dest" "$BACKUP_DIR/$rel"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] record '$rel' in $BACKUP_DIR/$MANIFEST"
  else
    printf '%s\n' "$rel" >> "$BACKUP_DIR/$MANIFEST"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then log "[dry-run] would back up: $rel"; else log "backed up: $rel"; fi
}

# Remove symlinks under managed dirs that point into the repo but whose source
# is gone (e.g. a skill renamed or deleted in the repo).
prune_dangling() {
  local t link
  for t in "${DIR_TARGETS[@]}"; do
    [ -d "$CLAUDE_DIR/$t" ] || continue
    for link in "$CLAUDE_DIR/$t"/*; do
      [ -L "$link" ] || continue
      points_into_repo "$link" || continue
      [ -e "$link" ] && continue
      run rm "$link"
      log "pruned dangling link: ${link#"$CLAUDE_DIR"/}"
    done
  done
}

enable_git_hooks() {
  [ "${HARNESS_NO_GIT_CONFIG:-0}" = "1" ] && return 0
  git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || return 0
  if [ "$(git -C "$REPO_DIR" config --get core.hooksPath || true)" != ".githooks" ]; then
    run git -C "$REPO_DIR" config core.hooksPath .githooks
    log "git: core.hooksPath=.githooks (pre-commit secret scan enabled)"
  fi
}

do_install() {
  local rel src dest linked=0 skipped=0
  log "repo:   $REPO_DIR"
  log "target: $CLAUDE_DIR"
  guard_layout
  check_skips
  run mkdir -p "$CLAUDE_DIR"
  while IFS= read -r rel; do
    src="$REPO_DIR/$rel"; dest="$CLAUDE_DIR/$rel"
    if is_skipped "$rel"; then
      log "skip (--skip): $rel"; continue
    fi
    if [ ! -e "$src" ]; then
      log "skip (missing in repo): $rel"; continue
    fi
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      skipped=$((skipped + 1)); continue
    fi
    if is_stale_harness_link "$dest" "$rel"; then
      run rm "$dest"; log "removed stale harness link: $rel -> $(readlink "$dest" 2>/dev/null || echo '?')"
    elif [ -L "$dest" ] || [ -e "$dest" ]; then
      backup_target "$rel"
    fi
    run mkdir -p "$(dirname "$dest")"
    run ln -s "$src" "$dest"
    log "linked: $rel -> $src"
    linked=$((linked + 1))
  done < <(list_targets)
  prune_dangling
  enable_git_hooks
  log "done: $linked linked, $skipped already linked"
}

latest_backup_with_manifest() {
  local dirs=() i
  [ -d "$BACKUP_ROOT" ] || return 0
  for i in "$BACKUP_ROOT"/*/; do [ -d "$i" ] && dirs+=("${i%/}"); done
  [ "${#dirs[@]}" -gt 0 ] || return 0
  # glob results are sorted; walk from the newest (lexicographically last)
  for (( i=${#dirs[@]}-1; i>=0; i-- )); do
    if [ -f "${dirs[$i]}/$MANIFEST" ]; then printf '%s\n' "${dirs[$i]}"; return 0; fi
  done
}

do_uninstall() {
  local rel dest removed=0 backup restored=0 remaining=()
  log "repo:   $REPO_DIR"
  log "target: $CLAUDE_DIR"
  while IFS= read -r rel; do
    dest="$CLAUDE_DIR/$rel"
    if points_into_repo "$dest"; then
      run rm "$dest"; log "unlinked: $rel"; removed=$((removed + 1))
    fi
  done < <(list_targets)
  prune_dangling

  backup="$(latest_backup_with_manifest)"
  if [ -z "$backup" ]; then
    log "no backup with a manifest under $BACKUP_ROOT; nothing to restore"
    log "done: $removed unlinked"
    return 0
  fi
  log "restoring from: $backup"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    dest="$CLAUDE_DIR/$rel"
    if [ ! -e "$backup/$rel" ] && [ ! -L "$backup/$rel" ]; then
      warn "'$rel' listed in manifest but missing from backup; skipped"; continue
    fi
    # In dry-run our link was not actually removed above; treat it as gone.
    if { [ -e "$dest" ] || [ -L "$dest" ]; } && ! { [ "$DRY_RUN" -eq 1 ] && points_into_repo "$dest"; }; then
      warn "'$rel' already exists at target; left backup copy in place"
      remaining+=("$rel"); continue
    fi
    run mkdir -p "$(dirname "$dest")"
    run mv "$backup/$rel" "$dest"
    log "restored: $rel"; restored=$((restored + 1))
  done < "$backup/$MANIFEST"
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ "${#remaining[@]}" -eq 0 ]; then
      rm -f "$backup/$MANIFEST"
      find "$backup" -type d -empty -delete 2>/dev/null || true
      [ -d "$backup" ] && warn "$backup kept (contains unlisted files)"
    else
      printf '%s\n' "${remaining[@]}" > "$backup/$MANIFEST"
      warn "$backup kept with ${#remaining[@]} unrestored item(s); run --uninstall again after clearing the conflicts"
    fi
  fi
  log "done: $removed unlinked, $restored restored"
}

case "$MODE" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac
