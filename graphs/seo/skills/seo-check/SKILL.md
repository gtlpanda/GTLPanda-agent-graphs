---
name: seo-check
description: Check a built site's HTML for the tags search engines and link previews read - title, meta description, canonical, Open Graph, JSON-LD - and the sitemaps that list its pages, and print each problem with its file and line, ending in SEO-CHECK PASS or FAIL. Reads the build output only and fetches nothing. Use after building a site, before and after an SEO fix, or as the pass gate of the SEO graph.
---

# seo-check

The scripted evidence gate of the SEO graph: an agent's word that a page's
tags are right counts for nothing; this check's last line does.

```bash
node ~/.claude/skills/seo-check/seo-check.mjs check <built dir> --site https://example.com [--json]
```

- `<built dir>` is the build output (`dist/`, `out/`, `build/`), never the
  source: it checks the HTML exactly as a host serves it.
- `--site` is where the site is served. Each file's URL comes from it:
  `a/index.html` is `/a/`, `a.html` is `/a.html`. A path (`--site
  https://example.com/docs`) puts every page under it.
- It prints one line per finding, `seo-check: <file>[:line]: error|warn <check>:
  <message>`, then a count, then `SEO-CHECK: PASS` or `SEO-CHECK: FAIL` (exit 0
  or 1; 2 for bad usage). Errors fail; warnings never do. `--json` prints
  `{site, pages, findings}` instead of the lines, still followed by the last line.

## What it checks

Every `.html` file under the dir, skipping `node_modules`, dot directories, and
symlinks. A page with `noindex` or `none` in a `robots` or `googlebot` meta tag
in `<head>` skips every check but `json-ld`. Each rule names its source;
"our rule" means PandaStack's, not a search engine's.

The sitemap decides which pages are strict. It is `sitemap.xml`,
`sitemap-index.xml`, or `sitemap_index.xml` at the top of the dir (under
`--site`'s path), with every index followed. A page it lists is strict; a page
it leaves out gets its errors as warnings, marked `(not in the sitemap)`,
except `json-ld`'s. With no sitemap, every page is strict. A sitemap URL finds
its page the way the canonical check does: `/a`, `/a/`, `/a.html`, and
`/a/index.html` are one page.

| Check | Error (fails) | Warning (never fails) |
|-------|---------------|-----------------------|
| `files` | the dir cannot be read or has no `.html` file; a page is binary or not UTF-8; every page has `noindex` (a staging build indexes nothing) | |
| `title` | no `<title>` in `<head>`, an empty one, or two (Google: every page needs one; HTML allows one) | over 60 characters (our guide: Google sets no limit and cuts to the screen width) |
| `description` | no meta description or an empty one (our rule: without one Google writes its own snippet) | outside 70-160 characters (our guide, as above) |
| `canonical` | no `<link rel="canonical">`, no href, a relative one (Google recommends absolute), or one not under `--site` | it points to another page, so search engines index that page instead |
| `og` | no `og:title`, `og:description`, `og:image`, or `og:url`, an empty one, or an `og:image` or `og:url` that is not an absolute http(s) URL (the Open Graph URL type) | |
| `sitemap` | a root that is not `<urlset>` or `<sitemapindex>`; no entries, or over 50,000 (Google); an entry without `<loc>`; a loc not absolute (Google), 2,048 characters or more (sitemaps.org), not on `--site`, served by no page, a `noindex` page, or a page whose canonical is another URL (Google: list the URLs you want in search results); a listed sitemap with no file | no sitemap; `<priority>` or `<changefreq>` (Google ignores both); a URL listed twice; a URL outside the sitemap's directory (Google: a sitemap affects only descendants of its parent directory); an off-site or gzipped sitemap, which it does not read |
| `json-ld` | a `application/ld+json` script that does not parse, has no `@context`, or has a node (top level or in `@graph`) without `@type` | `FAQPage`: Google stopped showing FAQ rich results on 2026-05-07 |

For `description`, `canonical`, and `og`: a tag only in `<body>` is an error
(only `<head>` counts), and two tags in `<head>` that disagree are an error,
except `og:image`, which Open Graph lets repeat; each `og:image` is checked.
JSON-LD counts anywhere.

## What it cannot see

- Tags set by JavaScript. It reads the HTML as served; crawlers that do not run
  scripts (most link previews) see the same thing.
- HTTP headers (`X-Robots-Tag`, a `Link: rel=canonical` header) and redirects.
- Whether a URL resolves: it fetches nothing.
- Not built yet (G2b): robots.txt, titles and descriptions shared across
  pages, and the warning for a single-page app whose tags only JavaScript sets.

It is a tag scanner, not an HTML parser. It skips comments and the content of
`<script>`, `<style>`, and `<textarea>`; reads attributes in any order, quoting,
or case; and decodes the common entities. It places tags as the HTML parser
does: the head ends at `<body>`, at the first element that does not belong in a
head (an `<img>`, an `<h1>`), or at text, and a `<meta>` or `<link>` between
`</head>` and `<body>` still counts as in the head.
