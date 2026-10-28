#!/usr/bin/env bash
# test-workflow.sh — routing tests for workflows/*.js against scripted agents.
# Ends with TEST-WORKFLOW: N passed, M failed. A missing node is a failure.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  echo "TEST-WORKFLOW: 0 passed, 1 failed (node not installed)"
  exit 1
fi
exec node scripts/test-workflow.mjs
