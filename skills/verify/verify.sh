#!/usr/bin/env bash
# verify.sh — detect the stack in the current directory, run tests + lint +
# typecheck, and print an explicit final block that an evaluator can read:
#
#   VERIFY: PASS            (or VERIFY: FAIL)
#     [0] pnpm run lint
#     [1] pnpm run test
#
# Rules: never PASS when nothing ran; every command and its exit code is listed;
# the verdict is the LAST line of output. Exit code mirrors the verdict.
set -uo pipefail

ROOT="${1:-.}"
cd "$ROOT" || { echo "VERIFY: FAIL"; echo "  cannot cd to $ROOT"; exit 1; }

STEPS=()      # "exit|label"
FAILED=0
RAN=0
TESTED=0      # set when a test-class step ran (tests, validate, full repo check)
TAIL_OK="${VERIFY_TAIL_OK:-5}"
TAIL_FAIL="${VERIFY_TAIL_FAIL:-60}"

run_step() {  # run_step <label> <cmd...>   (DISPLAY=<text> overrides the summary line)
  local label="$1"; shift
  local shown="${DISPLAY_CMD:-$*}"
  local out; out="$(mktemp)"
  echo "----- $label"
  echo "\$ $shown"
  "$@" >"$out" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then tail -n "$TAIL_OK" "$out"; else tail -n "$TAIL_FAIL" "$out"; FAILED=1; fi
  rm -f "$out"
  echo "exit: $rc"
  STEPS+=("$rc|$shown")
  RAN=$((RAN + 1))
  case "$label" in *:test|*:pytest|repo:*|tf:validate) TESTED=1 ;; esac
}

fail_step() {  # record a failure that is not a command (missing tool, unreadable manifest)
  echo "----- $1"; FAILED=1; STEPS+=("$2|$1"); RAN=$((RAN + 1))
}

gofmt_check() {  # gofmt -l prints unformatted files but exits 0; turn a non-empty list (or a gofmt error) into a failure
  local unformatted
  unformatted="$(gofmt -l . 2>&1)" || { echo "$unformatted"; return 1; }
  if [ -n "$unformatted" ]; then echo "unformatted:"; echo "$unformatted"; return 1; fi
}

skip() { echo "----- skipped: $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- Node (npm / pnpm / yarn / bun) ----------
if [ -f package.json ]; then
  PM=npm
  if   [ -f pnpm-lock.yaml ]; then PM=pnpm
  elif [ -f yarn.lock ];      then PM=yarn
  elif [ -f bun.lockb ] || [ -f bun.lock ]; then PM=bun
  fi
  if ! have "$PM"; then
    fail_step "$PM (not installed)" 127
  elif ! have node; then
    fail_step "node (not installed; needed to read package.json)" 127
  elif ! node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))' 2>/dev/null; then
    fail_step "package.json is not valid JSON" 1
  else
    has_script() { node -e 'const s=require("./package.json").scripts||{};process.exit(s[process.argv[1]]?0:1)' "$1"; }
    for s in lint typecheck test; do
      if has_script "$s"; then run_step "node:$s" "$PM" run "$s"; else skip "no \"$s\" script in package.json"; fi
    done
    if ! has_script typecheck && [ -f tsconfig.json ]; then
      if [ -x node_modules/.bin/tsc ]; then run_step "node:tsc" node_modules/.bin/tsc --noEmit -p tsconfig.json
      else skip "tsconfig.json present but node_modules/.bin/tsc missing (run install)"; fi
    fi
  fi
fi

# ---------- Python ----------
if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f pytest.ini ] || [ -f setup.cfg ] || [ -f requirements.txt ]; then
  PY=python3; have python3 || PY=python
  if have uv && [ -f uv.lock ]; then RUNNER=(uv run); else RUNNER=("$PY" -m); fi
  if have ruff;  then run_step "py:ruff" ruff check .; else skip "ruff not installed"; fi
  if "${RUNNER[@]}" mypy --version >/dev/null 2>&1 && grep -qs '\[tool.mypy\]' pyproject.toml; then
    run_step "py:mypy" "${RUNNER[@]}" mypy .
  else skip "mypy not configured in pyproject.toml"; fi
  if "${RUNNER[@]}" pytest --version >/dev/null 2>&1; then run_step "py:pytest" "${RUNNER[@]}" pytest -q
  else fail_step "pytest (not installed)" 127; fi
fi

# ---------- Go ----------
if [ -f go.mod ]; then
  if have go; then
    DISPLAY_CMD="gofmt -l . (fails if any file is listed)" run_step "go:fmt" gofmt_check
    run_step "go:vet"  go vet ./...
    run_step "go:test" go test ./...
  else fail_step "go (not installed)" 127; fi
fi

# ---------- Terraform ----------
if ls ./*.tf >/dev/null 2>&1; then
  if have terraform; then
    run_step "tf:fmt" terraform fmt -check -recursive
    if [ -d .terraform ]; then run_step "tf:validate" terraform validate
    else skip "terraform validate (no .terraform dir; run 'terraform init -backend=false' first)"; fi
    if have tflint; then run_step "tf:tflint" tflint --recursive; else skip "tflint not installed"; fi
  else fail_step "terraform (not installed)" 127; fi
fi

# ---------- Shell-only repos (no language manifest) ----------
if [ "$RAN" -eq 0 ]; then
  if   [ -x scripts/test.sh ];     then run_step "repo:test"     scripts/test.sh
  elif [ -x scripts/validate.sh ]; then run_step "repo:validate" scripts/validate.sh
  fi
fi

# ---------- Verdict ----------
echo
if [ "$RAN" -eq 0 ]; then
  echo "  no stack detected in $(pwd) (looked for package.json, pyproject.toml, go.mod, *.tf, scripts/test.sh, scripts/validate.sh)"
  echo "VERIFY: FAIL"
  exit 1
fi
for s in ${STEPS[@]+"${STEPS[@]}"}; do printf '  [%s] %s\n' "${s%%|*}" "${s#*|}"; done
if [ "$TESTED" -eq 0 ] && [ "${VERIFY_ALLOW_NO_TESTS:-0}" != "1" ]; then
  echo "  no test step ran (lint/format only). Add a test script, or set VERIFY_ALLOW_NO_TESTS=1 to accept lint-only."
  FAILED=1
fi
if [ "$FAILED" -eq 0 ]; then echo "VERIFY: PASS"; exit 0; else echo "VERIFY: FAIL"; exit 1; fi
