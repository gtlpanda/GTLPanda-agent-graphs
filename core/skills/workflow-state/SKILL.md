---
name: workflow-state
description: Write saved JSON state (an approved plan, interview answers) into a runnable copy of a workflow script, because workflow scripts cannot read files and large state is too big to retype as an argument. Used by the /dev and /blueprint orchestrators; not for direct use.
---

# workflow-state

A workflow script cannot read files, so an orchestrator that must hand a run
saved state (more than a few lines) writes it into a copy of the script and
runs the copy with the Workflow tool's `scriptPath`.

```bash
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/workflow-state/run-script.mjs" <SEAM> <state.json> <workflow.js> <out.js>
```

- The workflow carries the line `const <SEAM> = null` exactly once (for example
  `const INJECTED_PLAN = null`). The copy differs on that line only, which now
  holds the state.
- Success prints `run-script: wrote <absolute out.js> ...` and exits 0. Anything
  else (`run-script: FAIL <why>`, exit 1) writes nothing: report it and stop.
- Pass the workflow by its installed path, `~/.claude/workflows/<name>.js`.
- Never also pass the same state in the Workflow args; the workflows escalate
  when they get it twice.
