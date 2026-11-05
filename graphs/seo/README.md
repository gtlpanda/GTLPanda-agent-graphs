# SEO graph (marketing family)

Audits a site's SEO against a scripted check, proposes fixes behind the advisor
gate, and ships them as a `/dev` task, with the check re-run as the pass gate.
It works from the product's GTM brief ([`gtm-brief`](../../core/skills/gtm-brief/SKILL.md)).

Status: **only part of the check is built.** `skills/seo-check/seo-check.mjs`
has the tag scanner (tested in `tests/seo-check.test.mjs`). Next: the checks
for one page, then the `seo-check` command (G2a), then robots.txt, the sitemap,
and duplicates across pages (G2b), then the audit workflow and `/seo` (G3).
