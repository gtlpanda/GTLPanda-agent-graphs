---
name: harness-review
description: Bugs, security, and infrastructure-as-code misconfiguration review of the current diff. Reports only real, reproducible findings with severity and file:line. Use before opening or merging a PR, or when asked to review changes.
allowed-tools: Bash, Read, Grep, Glob
---

# harness-review

Review the current change set for defects. Report only findings you can point
at. No style nits, no "consider", no speculative hardening.

## 1. Get the diff

```bash
git status --short
git diff --merge-base "$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo main)" -- . ':!*.lock' ':!package-lock.json' ':!pnpm-lock.yaml'
git diff HEAD   # uncommitted on top
```

If there is no base branch, review `git diff HEAD` plus staged changes. Read
the full file for anything the diff touches when a hunk is not self-explanatory.

## 2. What to look for

**Bugs**
- Wrong or missing error handling on external calls, parses, file and network ops.
- Off-by-one, null/undefined paths, unhandled promise rejections, unawaited async.
- Changed function signatures where not every caller was updated (grep for callers).
- State mutations in shared objects, race conditions on concurrent paths.
- Tests that cannot fail (assert on the wrong thing, mock the unit under test).

**Duplicated rules**
- The diff copies logic that enforces a rule (authorization, validation,
  billing, limits, retries) instead of calling the existing code that does it.
  The test: if the rule changes, must both copies change? If yes, they will
  drift. Cite both locations. Severity:
  - HIGH if EITHER is true: the copies already differ, OR either copy enforces
    authentication, authorization, validation of untrusted input, or anything
    involving money. Copies that match today are still HIGH on those paths:
    the risk is the next change, not the current one.
  - MEDIUM otherwise.
- Repetition that is not a shared rule (similar-looking code with independent
  reasons to change) is not a finding.

**Security**
- Secrets, tokens, or credentials in code, config, logs, or test fixtures.
- Injection: shell, SQL, path traversal, template, SSRF on user-controlled input.
- Auth and authorization checks missing on new routes or handlers.
- Sensitive data in logs or error messages.
- Unsafe deserialization, weak crypto, disabled TLS verification.

**Infrastructure as code (Terraform, CloudFormation, Kubernetes, Docker)**
- Public exposure: `0.0.0.0/0` ingress, public S3 buckets or ACLs, public RDS.
- Missing encryption at rest or in transit; missing state locking or versioning.
- Over-broad IAM (`*` actions or resources), wildcard trust policies.
- Containers running as root, `latest` tags, secrets in env blocks.
- Destructive changes without `prevent_destroy` or lifecycle guards.

## 3. Report format

One block per finding. Order by severity. Nothing else.

```
[CRITICAL|HIGH|MEDIUM|LOW] <one-line title>
  file: path/to/file.ts:123
  why:  <the concrete failure: input -> wrong behavior>
  fix:  <the minimal change>
```

Severity: CRITICAL = exploitable or data loss now; HIGH = will break in normal
use; MEDIUM = breaks on an edge case you can name; LOW = real but contained.

If there are no findings, print exactly:

```
REVIEW: no findings in <N> files changed
```

Do not pad the report. A short honest list beats a long speculative one.
