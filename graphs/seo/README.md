# SEO graph (marketing family)

Audits a site's SEO against a scripted check, proposes fixes behind the advisor
gate, and ships them as a `/dev` task, with the check re-run as the pass gate.
It works from the product's GTM brief ([`gtm-brief`](../../core/skills/gtm-brief/SKILL.md)).

Status: **only the check is built.** [`seo-check`](skills/seo-check/SKILL.md)
covers the page tags (title, description, canonical, Open Graph, JSON-LD),
tested offline (`tests/seo-check.test.mjs`). Next: robots.txt, the sitemap,
and duplicates across pages (G2b), then the audit workflow and the `/seo`
skill (G3).
