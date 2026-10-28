#!/usr/bin/env bash
# test.sh — run every repo check. Ends with TEST: PASS|FAIL.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
rc=0
for t in scripts/validate.sh scripts/test-install.sh scripts/test-secrets.sh scripts/test-workflow.sh; do
  echo "######## $t"; "$t" || rc=1; echo
done
if [ "$rc" -eq 0 ]; then echo "TEST: PASS"; else echo "TEST: FAIL"; fi
exit "$rc"
