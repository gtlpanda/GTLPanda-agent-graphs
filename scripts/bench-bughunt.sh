#!/usr/bin/env bash
# bench-bughunt.sh — the live /bughunt benchmark. Opt-in: it runs real headless
# Claude sessions and costs real money, so it is never part of scripts/test.sh.
#   scripts/bench-bughunt.sh <out dir> [--cases a,b] [--fix a,b] [--model opus] [--timeout-min 60]
# Builds the fixture repos (graphs/hunt/bench/make-fixtures.mjs), runs
# `/bughunt pr --base main` on each, scores every ledger against its truth, and
# ends with BENCH-BUGHUNT: DONE <n> case(s) or BENCH-BUGHUNT: FAIL.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ "$#" -lt 1 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
exec node graphs/hunt/bench/run-bench.mjs "$@"
