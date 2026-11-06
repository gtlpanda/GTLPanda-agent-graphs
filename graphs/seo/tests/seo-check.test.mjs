// seo-check.test.mjs - the SEO checker (graphs/seo/skills/seo-check/seo-check.mjs).
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { CHECKS, checkPage, checkSite, decidingRule, findPages, googlebotRules, pageUrl, parseRobots, parseSitemap, parseSite, scanTags } from '../skills/seo-check/seo-check.mjs'

const SKILL = join(REPO, 'graphs', 'seo', 'skills', 'seo-check')
const SCRIPT = join(SKILL, 'seo-check.mjs')
const SITE = parseSite('https://shelf.example')

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Shelf - a reading list that remembers every book</title>
<meta name="description" content="Shelf keeps the books friends recommend in one list, split into read and to-read, so a title is never lost.">
<link rel="canonical" href="https://shelf.example/">
<meta property="og:title" content="Shelf">
<meta property="og:description" content="A reading list that remembers every book.">
<meta property="og:image" content="https://shelf.example/og.png">
<meta property="og:url" content="https://shelf.example/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Shelf"}</script>
</head>
<body><h1>Shelf</h1></body>
</html>
`
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shelf.example/</loc></url>
</urlset>
`
const ROBOTS = 'User-agent: *\nAllow: /\nSitemap: https://shelf.example/sitemap.xml\n'
const findings = (html, url = 'https://shelf.example/') => checkPage(html, url, SITE).findings
const said = (html, url) => findings(html, url).map(f => `${f.level} ${f.check}: ${f.message}`)
const swap = (from, to) => { assert.ok(PAGE.includes(from), from); return PAGE.replace(from, to) }
const line = pattern => PAGE.split('\n').findIndex(l => l.includes(pattern)) + 1

console.log('== seo-check: the scanner')
const HEAD = '<html><head><title>T</title>'
const placed = (html, name = 'meta') => scanTags(html).filter(t => t.name === name).map(t => t.inHead)
await test('tags in comments, raw-text elements, noscript, and template are not tags', async () => {
  for (const hide of [
    '<!-- <meta name="description" content="hidden"> -->',
    '<script>document.write(\'<meta name="description" content="hidden">\')</script>',
    '<style>/* <meta name="description" content="hidden"> */</style>',
    '<textarea><meta name="description" content="hidden"></textarea>',
    '<noscript><meta name="description" content="hidden"></noscript>',
    '<template><meta name="description" content="hidden"></template>',
  ]) assert.deepEqual(placed(`${HEAD}${hide}</head>`), [], hide)
  assert.deepEqual(scanTags('<!-- never closed <title>x</title>'), [], 'an unclosed comment hides the rest')
  assert.equal(scanTags('<SCRIPT>a</script ><meta name=x>').length, 2, 'a raw-text element closes case-insensitively')
})
await test('attributes: any order, quotes, case, entities, repeats, and prototype names', async () => {
  const meta = html => scanTags(html)[0].attrs
  for (const html of [
    '<meta content="Books &amp; more" name="description">',
    "<meta name='description' content='Books &amp; more'>",
    '<META NAME=description CONTENT="Books &#38; more">',
    '<meta\n  name="description"\n  content="Books &#x26; more"\n/>',
    '<meta name="description" content="Books &amp; more" name="other">',
  ]) {
    assert.equal(meta(html).get('name'), 'description', html)
    assert.equal(meta(html).get('content'), 'Books & more', html)
  }
  assert.equal(meta('<meta constructor="x" name="description" content="y">').get('constructor'), 'x')
  assert.equal(meta('<meta toString name="description">').get('name'), 'description')
  assert.equal(meta('<meta name="a > b" content=c>').get('name'), 'a > b', 'a quoted > does not end the tag')
  assert.equal(meta('<meta content="&bogus; &#0; &lt;b&gt;">').get('content'), '&bogus; &#0; <b>', 'unknown entities stay as written')
  assert.equal(meta('<meta content="a &constructor; &toString; &__proto__; b">').get('content'), 'a &constructor; &toString; &__proto__; b', 'prototype names are not entities')
  assert.equal(meta('<meta content=a/b>').get('content'), 'a/b')
  assert.equal(scanTags('<title>A &amp; B</title>')[0].text, 'A & B')
  assert.equal(scanTags('<script>a &amp; b</script>')[0].text, 'a &amp; b', 'script text is not decoded')
})
await test('lines are counted with LF, CRLF, and bare CR endings', async () => {
  const tags = scanTags('<html>\n<head>\n<title>x</title>\n</head>\n<body>\n<meta name=a>\n</body>')
  assert.deepEqual(tags.map(t => [t.name, t.line, t.inHead]), [['html', 1, true], ['head', 2, true], ['title', 3, true], ['body', 5, false], ['meta', 6, false]])
  for (const eol of ['\r\n', '\r']) {
    assert.deepEqual(scanTags(`<html>${eol}<head>${eol}<meta name=a>${eol}<meta${eol}name=b>`).map(t => t.line), [1, 2, 3, 4], JSON.stringify(eol))
  }
})
await test('the head ends where the HTML parser ends it', async () => {
  for (const [name, ends] of [
    ['an <img>', '<img src="x.gif">'], ['text', 'Welcome'], ['a stray "<"', '< 3'], ['a <noscript> after </head>', '</head><noscript></noscript>'], ['</body>', '</body>'],
    ['text before a comment', 'Welcome<!-- c -->'], ['text before <?x?>', 'Welcome<?x?>'], ['a non-breaking space', '\u00a0'],
  ]) assert.deepEqual(placed(`${HEAD}${ends}<meta name=x></head><body>`), [false], `${name} ends the head`)
  for (const [name, keeps] of [
    ['whitespace', '  \n\t'], ['a comment', '<!-- x -->'], ['a comment with ">" in it', '<!-- a > b -->'], ['a <style>', '<style>p{}</style>'],
    ['a tracking pixel in <noscript>', '<noscript><img height="1" src="https://www.facebook.com/tr?id=1&ev=PageView"/></noscript>'],
    ['a tag manager <iframe> in <noscript>', '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe></noscript>'],
    ['a <template>', '<template><div></div></template>'], ['a second <head> after </head>', '</head><head>'],
  ]) assert.deepEqual(placed(`${HEAD}${keeps}<meta name=x></head><body>`), [true], `${name} keeps the head open`)
  assert.deepEqual(placed(`${HEAD}</head>\n<link rel=canonical href=x><body>`, 'link'), [true], 'a head tag between </head> and <body> goes into the head')
  assert.deepEqual(placed('<title>T</title><h1>Hi</h1><meta name=x>'), [false], 'minified HTML without <head> or <body> tags still ends the head at content')
  assert.deepEqual(placed('<title>x</title><meta name=x>'), [true], 'a page without <head> or <body> tags is all head')
  assert.deepEqual(placed('<!DOCTYPE html>\n<?xml version="1.0"?><html><head><meta name=x>'), [true], 'a doctype is not text')
  assert.deepEqual(placed('<head><title>A</title></head><body><svg><title>I</title></svg>', 'title'), [true, false], 'an <svg><title> is in <body>')
  assert.equal(scanTags(`${HEAD}<body>`).at(-1).inHead, false, '<body> itself is not in the head')
})

console.log('== seo-check: one page')
await test('a complete page has no findings', async () => {
  assert.deepEqual(findings(PAGE), [])
})
await test('each missing tag is an error with its check', async () => {
  for (const [tag, expected] of [
    ['<title>', 'error title: no <title> in <head>'],
    ['name="description"', 'error description: no meta description (our rule: without one, Google writes its own snippet)'],
    ['rel="canonical"', 'error canonical: no <link rel="canonical">'],
    ['og:title', 'error og: no og:title'],
    ['og:description', 'error og: no og:description'],
    ['og:image', 'error og: no og:image'],
    ['og:url', 'error og: no og:url'],
  ]) {
    const without = PAGE.split('\n').filter(l => !l.includes(tag)).join('\n')
    assert.deepEqual(said(without), [expected], tag)
  }
})
await test('empty, relative, and off-site values are errors with their line', async () => {
  for (const [from, to, expected] of [
    ['<title>Shelf - a reading list that remembers every book</title>', '<title>  </title>', 'title: <title> is empty'],
    ['content="Shelf keeps', 'content=" " data-x="', 'description: meta description is empty'],
    ['href="https://shelf.example/"', 'href=""', 'canonical: canonical link has no href'],
    ['href="https://shelf.example/"', 'href="/"', 'canonical: canonical "/" is relative; Google recommends an absolute URL'],
    ['href="https://shelf.example/"', 'href="https://other.example/"', 'canonical: canonical https://other.example/ is not on --site https://shelf.example/'],
    ['content="https://shelf.example/og.png"', 'content="/og.png"', 'og: og:image "/og.png" is not an absolute http(s) URL (Open Graph\'s URL type)'],
    ['content="https://shelf.example/og.png"', 'content="//shelf.example/og.png"', 'og: og:image "//shelf.example/og.png" is not an absolute http(s) URL (Open Graph\'s URL type)'],
    ['content="https://shelf.example/og.png"', 'content="ftp://shelf.example/og.png"', 'og: og:image "ftp://shelf.example/og.png" is not an absolute http(s) URL (Open Graph\'s URL type)'],
    ['og:url" content="https://shelf.example/"', 'og:url" content="shelf"', 'og: og:url "shelf" is not an absolute http(s) URL (Open Graph\'s URL type)'],
    ['content="Shelf">', 'content="">', 'og: og:title is empty'],
  ]) {
    const got = findings(swap(from, to))
    assert.deepEqual(got.map(f => `${f.check}: ${f.message}`), [expected], to)
    assert.equal(got[0].level, 'error', to)
    assert.ok(got[0].line > 0, `${to} has a line`)
  }
})
await test('a canonical under a --site path must stay under it', async () => {
  const site = parseSite('https://shelf.example/docs')
  assert.equal(site.href, 'https://shelf.example/docs/')
  const page = swap('href="https://shelf.example/"', 'href="https://shelf.example/docs/"')
  assert.deepEqual(checkPage(page, 'https://shelf.example/docs/', site).findings, [])
  const noSlash = swap('href="https://shelf.example/"', 'href="https://shelf.example/docs"')
  assert.deepEqual(checkPage(noSlash, 'https://shelf.example/docs/', site).findings, [], 'the --site root without a trailing slash is on the site')
  const sibling = swap('href="https://shelf.example/"', 'href="https://shelf.example/docsx"')
  assert.equal(checkPage(sibling, 'https://shelf.example/docs/', site).findings[0].message, 'canonical https://shelf.example/docsx is not on --site https://shelf.example/docs/')
  assert.deepEqual(checkPage(PAGE, 'https://shelf.example/docs/', site).findings.map(f => f.message), [
    'canonical https://shelf.example/ is not on --site https://shelf.example/docs/',
  ])
})
await test('a canonical to another page warns; the same page in another form does not', async () => {
  const to = href => swap('href="https://shelf.example/"', `href="${href}"`)
  assert.deepEqual(said(to('https://shelf.example/pricing')), [
    'warn canonical: canonical points to https://shelf.example/pricing, not this page (https://shelf.example/): search engines index that page instead',
  ])
  for (const [href, url] of [
    ['https://shelf.example/index.html', 'https://shelf.example/'],
    ['https://shelf.example/a', 'https://shelf.example/a/'],
    ['https://shelf.example/a.html', 'https://shelf.example/a'],
    ['https://shelf.example/a/index.html', 'https://shelf.example/a/'],
  ]) assert.deepEqual(findings(to(href), url), [], `${href} is ${url}`)
  assert.equal(findings(to('https://shelf.example/aindex.html'), 'https://shelf.example/a/').length, 1, 'aindex.html is not a/')
  assert.equal(findings(to('https://shelf.example/?ref=x'), 'https://shelf.example/').length, 1, 'a query is another page')
})
await test('two tags that disagree are an error; the same value twice, or two og:image, is not', async () => {
  assert.deepEqual(said(swap('</head>', '<title>Other</title>\n</head>')), [`error title: two <title> elements in <head> (first at line ${line('<title>')})`])
  assert.deepEqual(said(swap('</head>', '<link rel="canonical" href="https://shelf.example/b">\n</head>')), [
    `error canonical: two canonical link tags disagree (first at line ${line('canonical')})`,
  ])
  assert.deepEqual(said(swap('</head>', '<meta property="og:url" content="https://shelf.example/b">\n</head>')), [
    `error og: two og:url tags disagree (first at line ${line('og:url')})`,
  ])
  assert.deepEqual(findings(swap('</head>', '<link rel="canonical" href="https://shelf.example/">\n</head>')), [])
  assert.deepEqual(findings(swap('</head>', '<meta property="og:image" content="https://shelf.example/2.png">\n</head>')), [])
  for (const [value, expected] of [['/rel.png', 'og: og:image "/rel.png" is not an absolute http(s) URL (Open Graph\'s URL type)'], ['', 'og: og:image is empty']]) {
    assert.deepEqual(findings(swap('</head>', `<meta property="og:image" content="${value}">\n</head>`)).map(f => `${f.check}: ${f.message}`), [expected], `every og:image is checked: "${value}"`)
  }
})
await test('a tag that only appears in <body> is reported once, as in <body>', async () => {
  const move = tag => {
    const lines = PAGE.split('\n')
    const moved = lines.find(l => l.includes(tag))
    return lines.filter(l => l !== moved).join('\n').replace('<h1>', `${moved}\n<h1>`)
  }
  for (const [tag, what, check] of [
    ['name="description"', 'meta description', 'description'],
    ['rel="canonical"', 'canonical link', 'canonical'],
    ['og:image', 'og:image', 'og'],
  ]) assert.deepEqual(said(move(tag)), [`error ${check}: ${what} is in <body>; it only counts in <head>`], tag)
  assert.deepEqual(said(move('<title>')), ['error title: no <title> in <head>'], 'a <title> in <body> is not the page title')
  assert.deepEqual(findings(swap('<h1>Shelf</h1>', '<svg><title>Icon</title></svg>')), [], 'an <svg><title> is not a second title')
  assert.deepEqual(said(swap('<link rel="canonical"', '<img src="x.gif">\n<link rel="canonical"')), [
    'error canonical: canonical link is in <body>; it only counts in <head>',
    ...['og:title', 'og:description', 'og:image', 'og:url'].map(p => `error og: ${p} is in <body>; it only counts in <head>`),
  ], 'an <img> ends the head')
  const pixel = swap('<link rel="canonical"', '<noscript><img src="https://px.example/p.gif"></noscript>\n</head><link rel="canonical"')
  assert.deepEqual(findings(pixel), [], 'a pixel in <noscript>, then head tags after </head>, still count as in <head>')
})
await test('CRLF and bare CR pages pass like LF and report the same lines', async () => {
  assert.deepEqual(findings(PAGE.replace(/\n/g, '\r\n')), [])
  const twice = eol => said(PAGE.replace(/\n/g, eol).replace('<title>', '<title></title><title>'))
  assert.deepEqual(twice('\n'), [`error title: two <title> elements in <head> (first at line ${line('<title>')})`, 'error title: <title> is empty'])
  assert.deepEqual(twice('\r\n'), twice('\n'))
  assert.deepEqual(twice('\r'), twice('\n'))
})
await test('og tags set with name= are named in the error', async () => {
  assert.deepEqual(said(swap('property="og:title"', 'name="og:title"')), [
    'error og: no og:title; it is set with name=, and Open Graph reads property=',
  ])
})
await test('lengths outside our guide warn and never fail; characters, not bytes, count', async () => {
  const title = t => swap('Shelf - a reading list that remembers every book', t)
  assert.deepEqual(said(title('x'.repeat(61))), ['warn title: title is 61 characters; Google sets no limit but cuts long titles (our guide: 60)'])
  assert.deepEqual(findings(title('x'.repeat(60))), [])
  assert.deepEqual(findings(title('\u{1F4DA}'.repeat(60))), [], '60 emoji are 60 characters')
  const desc = n => swap(/content="(Shelf keeps[^"]*)"/.exec(PAGE)[1], 'd'.repeat(n))
  assert.deepEqual(findings(desc(70)), [])
  assert.deepEqual(findings(desc(160)), [])
  for (const n of [69, 161]) {
    assert.deepEqual(said(desc(n)), [`warn description: description is ${n} characters; Google sets no limit but cuts long ones (our guide: 70-160)`])
  }
})
await test('noindex in <head> skips the page checks, not JSON-LD; noindex in <body> does not count', async () => {
  const bare = '<html><head><title>x</title>\n<script type="application/ld+json">{"@type":"X"}</script>\n</head><body></body></html>'
  for (const meta of ['<meta name="robots" content="noindex">', '<META NAME="Robots" CONTENT="NoIndex, follow">', '<meta name="googlebot" content="none">', '<meta content="max-snippet:0,noindex" name="robots">']) {
    const page = checkPage(bare.replace('<title>', `${meta}<title>`), 'https://shelf.example/', SITE)
    assert.equal(page.indexable, false, meta)
    assert.deepEqual(page.findings.map(f => f.message), ['JSON-LD has no @context'], meta)
  }
  for (const not of ['<meta name="robots" content="nofollow">', '<meta name="robots" content="noindexer">', '<meta name="bingbot" content="noindex">']) {
    assert.equal(checkPage(bare.replace('<title>', `${not}<title>`), 'https://shelf.example/', SITE).indexable, true, not)
  }
  assert.equal(checkPage(bare.replace('<body>', '<body><meta name="robots" content="noindex">'), 'https://shelf.example/', SITE).indexable, true)
})
await test('JSON-LD must parse and have @context and @type; FAQPage warns', async () => {
  const ld = json => swap('{"@context":"https://schema.org","@type":"WebSite","name":"Shelf"}', json)
  for (const [json, expected] of [
    ['{"@context":"https://schema.org","@type":"WebSite",}', /^error json-ld: JSON-LD does not parse: /],
    ['', /^error json-ld: JSON-LD does not parse: /],
    ['{"@type":"WebSite"}', /^error json-ld: JSON-LD has no @context$/],
    ['{"@context":"https://schema.org"}', /^error json-ld: a JSON-LD node has no @type$/],
    ['{"@context":"https://schema.org","@type":""}', /^error json-ld: a JSON-LD node has no @type$/],
    ['{"@context":"https://schema.org","@type":[]}', /^error json-ld: a JSON-LD node has no @type$/],
    ['{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"name":"x"}]}', /^error json-ld: a JSON-LD node has no @type$/],
    ['[]', /^error json-ld: JSON-LD is an empty list$/],
    ['"WebSite"', /^error json-ld: JSON-LD must be an object or a list of objects$/],
    ['[{"@context":"https://schema.org","@type":"WebSite"},null]', /^error json-ld: JSON-LD must be an object or a list of objects$/],
    ['{"@context":"https://schema.org","@type":"FAQPage"}', /^warn json-ld: FAQPage: Google stopped showing FAQ rich results on 2026-05-07$/],
    ['{"@context":"https://schema.org","@type":["WebPage","FAQPage"]}', /^warn json-ld: FAQPage/],
  ]) {
    const got = said(ld(json))
    assert.equal(got.length, 1, `${json}: ${got}`)
    assert.match(got[0], expected, json)
  }
  for (const fine of [
    '{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Organization"}]}',
    '[{"@context":"https://schema.org","@type":"WebSite"},{"@context":"https://schema.org","@type":"Organization"}]',
    '\n  {"@context": "https://schema.org", "@type": "WebSite", "description": "<b>&amp;</b>"}\n',
  ]) assert.deepEqual(findings(ld(fine)), [], fine)
  assert.deepEqual(said(ld('{"@type":"WebSite"}').replace('type="application/ld+json"', 'type=" Application/LD+JSON "')), [
    'error json-ld: JSON-LD has no @context',
  ], 'the type matches in any case, with spaces')
  assert.deepEqual(findings(PAGE.replace('</body>', '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Book"}</script></body>')), [], 'JSON-LD in <body> counts')
})

await test('--site must be an absolute http(s) URL; its path gains a trailing slash', async () => {
  assert.equal(parseSite('https://shelf.example/docs?x=1#y').href, 'https://shelf.example/docs/')
  for (const bad of ['shelf.example', '/docs', '//shelf.example', 'ftp://shelf.example', '', undefined]) assert.equal(parseSite(bad), null, String(bad))
})


console.log('== seo-check: the site')
const site = files => {
  const dir = mkdtempSync(join(tmpdir(), 'seo-check-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}
await test('pages are every .html file, served where a static host serves them', async () => {
  const dir = site({ 'index.html': '', 'about.html': '', 'blog/index.html': '', 'blog/a.htm': '', 'my page.html': '', 'style.css': '', 'node_modules/x/index.html': '', '.git/x.html': '', 'B.HTML': '' })
  try {
    assert.deepEqual(findPages(dir), ['B.HTML', 'about.html', 'blog/a.htm', 'blog/index.html', 'index.html', 'my page.html'])
    symlinkSync(join(dir, 'about.html'), join(dir, 'linked.html'))
    assert.ok(!findPages(dir).includes('linked.html'), 'symlinks are skipped')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  assert.deepEqual(['index.html', 'about.html', 'blog/index.html', 'blog/a.htm', 'my page.html', 'xindex.html'].map(f => pageUrl(f, SITE)), [
    'https://shelf.example/', 'https://shelf.example/about.html', 'https://shelf.example/blog/', 'https://shelf.example/blog/a.htm',
    'https://shelf.example/my%20page.html', 'https://shelf.example/xindex.html',
  ])
  assert.equal(pageUrl('a/index.html', parseSite('https://shelf.example/docs')), 'https://shelf.example/docs/a/')
})
await test('checkSite checks each page, and a missing dir, an empty dir, or an unreadable page is an error', async () => {
  const dir = site({ 'index.html': PAGE, 'bad.html': PAGE.replace('<title>', '<title></title><title>'), 'bin.html': '\u0000', 'latin1.html': '' })
  try {
    writeFileSync(join(dir, 'latin1.html'), Buffer.from([0x3c, 0xe9, 0x3e]))
    const got = checkSite(dir, SITE)
    assert.deepEqual(got.pages.map(p => [p.file, p.url, p.indexable, p.listed]), [['bad.html', 'https://shelf.example/bad.html', true, null], ['index.html', 'https://shelf.example/', true, null]])
    assert.deepEqual(got.findings.map(f => [f.file, f.check, f.message.replace(dir, '<dir>')]), [
      ['bad.html', 'title', `two <title> elements in <head> (first at line ${line('<title>')})`],
      ['bad.html', 'title', '<title> is empty'],
      ['bad.html', 'canonical', 'canonical points to https://shelf.example/, not this page (https://shelf.example/bad.html): search engines index that page instead'],
      ['bin.html', 'files', '<dir>/bin.html is not a text file'],
      ['latin1.html', 'files', '<dir>/latin1.html is not UTF-8 text'],
      ['.', 'robots', 'no robots.txt, so no Sitemap: line points crawlers to the sitemap'],
      ['.', 'sitemap', 'no sitemap (a robots.txt Sitemap: line, or sitemap.xml, sitemap-index.xml, sitemap_index.xml), so every page is checked strictly'],
    ])
    assert.match(checkSite(join(dir, 'gone'), SITE).findings[0].message, /cannot read .*gone: ENOENT/)
    assert.match(checkSite(join(dir, 'index.html'), SITE).findings[0].message, /cannot read .*index\.html: ENOTDIR/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const staging = site({ 'index.html': PAGE.replace('<head>', '<head><meta name="robots" content="noindex">'), 'a.html': '<meta name=robots content=noindex>' })
  try {
    assert.deepEqual(checkSite(staging, SITE).findings.filter(f => f.check === 'files').map(f => [f.file, f.message]), [['.', 'every page has noindex, so search engines index nothing (a staging build?)']])
  } finally { rmSync(staging, { recursive: true, force: true }) }
  const empty = site({ 'style.css': '' })
  try { assert.deepEqual(checkSite(empty, SITE).findings.filter(f => f.check === 'files').map(f => f.message), [`no .html files under ${empty}`]) } finally { rmSync(empty, { recursive: true, force: true }) }
})

console.log('== seo-check: sitemaps')
await test('parseSitemap reads <url> or <sitemap> entries with their lines, CDATA, entities, and prefixes', async () => {
  assert.deepEqual(parseSitemap(SITEMAP), { root: 'urlset', entries: [{ loc: 'https://shelf.example/', line: 3 }], hints: 0 })
  const xml = [
    '<?xml version="1.0"?>\r',
    '<!-- <url><loc>https://shelf.example/hidden</loc></url>\r',
    '-->\r',
    '<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">\r',
    '<s:url><s:loc> https://shelf.example/a?x=1&amp;y=2 </s:loc><s:priority>0.8</s:priority></s:url>\r',
    '<url>\r<loc><![CDATA[https://shelf.example/b&c]]></loc>\r<changefreq>daily</changefreq></url>\r',
    '<url><lastmod>2026-11-05</lastmod></url>\r',
    '<urls><loc>https://shelf.example/not-an-entry</loc></urls>\r',
    '</s:urlset>',
  ].join('\n')
  assert.deepEqual(parseSitemap(xml), {
    root: 'urlset',
    entries: [{ loc: 'https://shelf.example/a?x=1&y=2', line: 5 }, { loc: 'https://shelf.example/b&c', line: 6 }, { loc: null, line: 9 }],
    hints: 2,
  })
  const index = '<sitemapindex><sitemap><loc>https://shelf.example/s1.xml</loc></sitemap><url><loc>https://shelf.example/</loc></url></sitemapindex>'
  assert.deepEqual(parseSitemap(index), { root: 'sitemapindex', entries: [{ loc: 'https://shelf.example/s1.xml', line: 1 }], hints: 0 })
  assert.equal(parseSitemap('<!-- <urlset> --><html><body>404</body></html>').root, 'html')
  assert.equal(parseSitemap('').root, null)
})
const page = (title, extra = '') => PAGE.replace('Shelf - a reading list that remembers every book', title).replace('<head>', `<head>${extra}`)
const urlset = (...locs) => `<urlset>\n${locs.map(l => `<url><loc>${l}</loc></url>`).join('\n')}\n</urlset>\n`
const report = (dir, s = SITE) => checkSite(dir, s).findings.filter(f => f.check !== 'robots').map(f => [f.file, f.line, f.level, f.check, f.message])
await test('a sitemap lists pages; each URL must be absolute, on --site, served, indexable, and canonical', async () => {
  const dir = site({
    'index.html': PAGE,
    'a.html': page('A'),
    'blog/index.html': page('Blog').replace('href="https://shelf.example/"', 'href="https://shelf.example/blog/"'),
    'hidden.html': '<meta name="robots" content="noindex"><title>Hidden</title>',
    'copy.html': page('Copy'),
    'sitemap.xml': urlset(
      'https://shelf.example/', 'https://shelf.example/a', 'https://shelf.example/blog', '/relative', 'https://other.example/',
      'https://shelf.example/hidden.html', 'https://shelf.example/copy.html', 'https://shelf.example/gone', 'https://shelf.example/index.html',
      `https://shelf.example/${'x'.repeat(2048)}`,
    ).replace('<url><loc>https://shelf.example/a</loc>', '<url><loc>https://shelf.example/a</loc><priority>1</priority>'),
  })
  try {
    assert.deepEqual(report(dir), [
      ['a.html', line('rel="canonical"'), 'warn', 'canonical', 'canonical points to https://shelf.example/, not this page (https://shelf.example/a.html): search engines index that page instead'],
      ['copy.html', line('rel="canonical"'), 'warn', 'canonical', 'canonical points to https://shelf.example/, not this page (https://shelf.example/copy.html): search engines index that page instead'],
      ['sitemap.xml', 0, 'warn', 'sitemap', '1 entry sets <priority> or <changefreq>; Google ignores both'],
      ['sitemap.xml', 3, 'error', 'sitemap', 'https://shelf.example/a has the canonical https://shelf.example/; list that URL instead (Google: list the URLs you want in search results)'],
      ['sitemap.xml', 5, 'error', 'sitemap', '<loc> "/relative" is not an absolute http(s) URL (Google: use fully-qualified, absolute URLs)'],
      ['sitemap.xml', 6, 'error', 'sitemap', 'https://other.example/ is not on --site https://shelf.example/'],
      ['sitemap.xml', 7, 'error', 'sitemap', 'https://shelf.example/hidden.html has noindex, but the sitemap lists it (Google: list the URLs you want in search results)'],
      ['sitemap.xml', 8, 'error', 'sitemap', 'https://shelf.example/copy.html has the canonical https://shelf.example/; list that URL instead (Google: list the URLs you want in search results)'],
      ['sitemap.xml', 9, 'error', 'sitemap', 'no page in the build serves https://shelf.example/gone'],
      ['sitemap.xml', 10, 'warn', 'sitemap', 'https://shelf.example/index.html is listed twice (first at sitemap.xml:2)'],
      ['sitemap.xml', 11, 'error', 'sitemap', '<loc> is 2070 characters; sitemaps.org allows under 2048'],
    ])
    assert.deepEqual(checkSite(dir, SITE).pages.map(p => [p.file, p.listed]), [['a.html', true], ['blog/index.html', true], ['copy.html', true], ['hidden.html', true], ['index.html', true]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const twice = site({ 'a.html': PAGE, 'a/index.html': PAGE, 'sitemap.xml': urlset('https://shelf.example/a') })
  try {
    assert.deepEqual(checkSite(twice, SITE).pages.map(p => [p.file, p.listed]), [['a.html', true], ['a/index.html', false]], 'the first file that serves a URL is the one listed')
  } finally { rmSync(twice, { recursive: true, force: true }) }
  const big = site({ 'index.html': PAGE, 'sitemap.xml': urlset(...Array.from({ length: 50001 }, () => 'https://shelf.example/')) })
  try {
    assert.deepEqual(report(big).filter(f => f[1] === 0), [['sitemap.xml', 0, 'error', 'sitemap', '50001 entries; Google reads at most 50000 per file']])
  } finally { rmSync(big, { recursive: true, force: true }) }
})
await test('with a sitemap, a page it leaves out is not strict: its errors become warnings, except JSON-LD', async () => {
  const dir = site({
    'index.html': PAGE,
    'listed.html': page('', `<link rel="canonical" href="https://shelf.example/listed.html">`).replace('<link rel="canonical" href="https://shelf.example/">', ''),
    'drafts/x.html': page('').replace('"@type":"WebSite"', '"@type":""'),
    'sitemap.xml': urlset('https://shelf.example/', 'https://shelf.example/listed.html'),
  })
  try {
    const titleLine = line('<title>')
    assert.deepEqual(report(dir), [
      ['drafts/x.html', titleLine, 'warn', 'title', '<title> is empty (not in the sitemap)'],
      ['drafts/x.html', line('rel="canonical"'), 'warn', 'canonical', 'canonical points to https://shelf.example/, not this page (https://shelf.example/drafts/x.html): search engines index that page instead'],
      ['drafts/x.html', line('ld+json'), 'error', 'json-ld', 'a JSON-LD node has no @type'],
      ['listed.html', titleLine, 'error', 'title', '<title> is empty'],
    ])
    assert.deepEqual(checkSite(dir, SITE).pages.map(p => [p.file, p.listed]), [['drafts/x.html', false], ['index.html', true], ['listed.html', true]])
    const cli = spawnSync(process.execPath, [SCRIPT, 'check', dir, '--site', 'https://shelf.example'], { encoding: 'utf8' })
    assert.match(cli.stdout, /\nseo-check: 3 pages \(1 not in the sitemap, errors shown as warnings\), 2 errors, 3 warnings\nSEO-CHECK: FAIL\n$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await test('sitemap indexes are followed, once each; a bad or missing sitemap is an error', async () => {
  const dir = site({
    'index.html': PAGE,
    'a.html': page('A', '<link rel="canonical" href="https://shelf.example/a.html">').replace('<link rel="canonical" href="https://shelf.example/">', ''),
    'sitemap-index.xml': '<sitemapindex>\n' + [
      'https://shelf.example/maps/pages.xml', 'https://shelf.example/sitemap-index.xml',
      'https://shelf.example/maps/gone.xml', 'https://shelf.example/maps/pages.xml.gz', 'https://shelf.example/maps/%zz.xml',
      'https://shelf.example/maps/empty.xml', 'https://shelf.example/maps/page.xml', 'https://shelf.example/maps/next.xml', 'https://cdn.example/s.xml',
    ].map(l => `<sitemap><loc>${l}</loc></sitemap>`).join('\n') + '\n</sitemapindex>\n',
    'maps/pages.xml': urlset('https://shelf.example/', 'https://shelf.example/a.html'),
    'maps/empty.xml': '<urlset>\n</urlset>\n',
    'maps/page.xml': PAGE,
    'maps/next.xml': '<sitemapindex>\n<sitemap><loc>https://shelf.example/maps/pages.xml</loc></sitemap>\n<sitemap></sitemap>\n</sitemapindex>\n',
  })
  try {
    assert.deepEqual(report(dir), [
      ['maps/empty.xml', 0, 'error', 'sitemap', 'the sitemap lists no URLs'],
      ['maps/next.xml', 3, 'error', 'sitemap', '<sitemap> has no <loc>'],
      ['maps/page.xml', 0, 'error', 'sitemap', 'not a sitemap: the root element is <html>, not <urlset> or <sitemapindex>'],
      ['maps/pages.xml', 2, 'warn', 'sitemap', 'https://shelf.example/ is outside https://shelf.example/maps/ (Google: a sitemap affects only descendants of its parent directory)'],
      ['maps/pages.xml', 3, 'warn', 'sitemap', 'https://shelf.example/a.html is outside https://shelf.example/maps/ (Google: a sitemap affects only descendants of its parent directory)'],
      ['sitemap-index.xml', 4, 'error', 'sitemap', 'no file in the build serves the sitemap https://shelf.example/maps/gone.xml'],
      ['sitemap-index.xml', 5, 'warn', 'sitemap', 'https://shelf.example/maps/pages.xml.gz is gzipped; seo-check does not read it'],
      ['sitemap-index.xml', 6, 'error', 'sitemap', 'https://shelf.example/maps/%zz.xml has a malformed %-escape'],
      ['sitemap-index.xml', 10, 'warn', 'sitemap', 'https://cdn.example/s.xml is not on --site https://shelf.example/; not checked (seo-check fetches nothing)'],
    ])
    assert.ok(checkSite(dir, SITE).pages.every(p => p.listed), 'pages listed through an index count as listed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const docs = site({ 'index.html': PAGE.replaceAll('https://shelf.example/', 'https://shelf.example/docs/'), 'sitemap.xml': urlset('https://shelf.example/docs/') })
  try { assert.deepEqual(report(docs, parseSite('https://shelf.example/docs')), [], 'under a --site path, the sitemap is at <path>/sitemap.xml') } finally { rmSync(docs, { recursive: true, force: true }) }
})

console.log('== seo-check: robots.txt')
const decide = (robots, path) => {
  const rule = decidingRule(googlebotRules(parseRobots(robots).groups), `https://shelf.example${path}`)
  return rule ? `${rule.allow ? 'allow' : 'disallow'} ${rule.path}` : 'none'
}
await test('rule paths match as in Google\'s table: prefix, *, a final $, case-sensitive, percent-encoded', async () => {
  // Google's "URL matching based on path values" examples.
  for (const [path, yes, no] of [
    ['/', ['/', '/page', '/a/b?c=d'], []],
    ['/*', ['/', '/page'], []],
    ['/$', ['/'], ['/page.htm', '/?x=1']],
    ['/fish', ['/fish', '/fish.html', '/fish/salmon.html', '/fishheads', '/fishheads/yummy.html', '/fish.php?id=anything'], ['/Fish.asp', '/catfish', '/?id=fish', '/desert/fish']],
    ['/fish*', ['/fish', '/fish.html', '/fishheads/yummy.html'], ['/Fish.asp', '/catfish']],
    ['/fish/', ['/fish/', '/fish/?id=anything', '/fish/salmon.htm'], ['/fish', '/fish.html', '/animals/fish/', '/Fish/Salmon.asp']],
    ['/*.php', ['/index.php', '/filename.php', '/folder/filename.php', '/folder/filename.php?parameters', '/folder/any.php.file.html', '/filename.php/'], ['/', '/windows.PHP']],
    ['/*.php$', ['/filename.php', '/folder/filename.php'], ['/filename.php?parameters', '/filename.php/', '/filename.php5', '/windows.PHP']],
    ['/fish*.php', ['/fish.php', '/fishheads/catfish.php?parameters'], ['/Fish.PHP']],
    ['/a.b(c)+$x', ['/a.b(c)+$x', '/a.b(c)+$xy'], ['/aXb(c)+$x', '/a.b(c)$x']],
    ['/caf\u00e9', ['/caf%C3%A9'], ['/cafe']],
  ]) {
    for (const url of yes) assert.equal(decide(`User-agent: *\nDisallow: ${path}`, url), `disallow ${path}`, `${path} matches ${url}`)
    for (const url of no) assert.equal(decide(`User-agent: *\nDisallow: ${path}`, url), 'none', `${path} does not match ${url}`)
  }
})
await test('the longest matching rule wins and allow wins a tie, as in Google\'s precedence table', async () => {
  for (const [rules, path, expected] of [
    ['Allow: /p\nDisallow: /', '/page', 'allow /p'],
    ['Allow: /folder\nDisallow: /folder', '/folder/page', 'allow /folder'],
    ['Disallow: /folder\nAllow: /folder', '/folder/page', 'allow /folder'],
    ['Allow: /page\nDisallow: /*.htm', '/page.htm', 'disallow /*.htm'],
    ['Allow: /page\nDisallow: /*.ph', '/page.php5', 'allow /page'],
    ['Allow: /$\nDisallow: /', '/', 'allow /$'],
    ['Allow: /$\nDisallow: /', '/page.htm', 'disallow /'],
    ['Disallow:\nAllow: /x', '/page', 'none'],
  ]) assert.equal(decide(`User-agent: *\n${rules}`, path), expected, `${rules} for ${path}`)
})
await test('parseRobots groups User-agent runs, reads product tokens, and warns on lines Google ignores', async () => {
  const robots = [
    '\ufeffDisallow: /early',
    '# a comment',
    'USER-AGENT: Googlebot/2.1 # the web crawler',
    'user-agent: bingbot',
    'disallow: /a  ',
    'Sitemap: https://shelf.example/sitemap.xml',
    'User-agent: *',
    'Allow: /',
    'Crawl-delay: 5',
    'Dissallow: /typo',
    'this is not a field',
    'User-agent: googlebot-news',
    'Disallow: /news',
    'User-agent: googlebot',
    'Disallow: /b',
  ].join('\r\n')
  const parsed = parseRobots(robots)
  assert.deepEqual(parsed.groups.map(g => [g.agents, g.rules.map(r => `${r.allow ? 'allow' : 'disallow'} ${r.path} @${r.line}`)]), [
    [['googlebot', 'bingbot'], ['disallow /a @5']],
    [['*'], ['allow / @8']],
    [['googlebot-news'], ['disallow /news @13']],
    [['googlebot'], ['disallow /b @15']],
  ])
  assert.deepEqual(parsed.sitemaps, [{ url: 'https://shelf.example/sitemap.xml', line: 6 }])
  assert.deepEqual(parsed.problems, [
    { line: 1, message: 'Disallow comes before any User-agent line; Google ignores it' },
    { line: 10, message: '"Dissallow" is not a field Google reads; it ignores the line' },
    { line: 11, message: '"this is not a field" is not a "field: value" line; Google ignores it' },
  ])
  assert.deepEqual(googlebotRules(parsed.groups).map(r => r.path), ['/a', '/b'], 'every googlebot group, combined; not googlebot-news, not *')
  assert.deepEqual(googlebotRules(parseRobots('User-agent: googlebot-news\nDisallow: /\nUser-agent: *\nDisallow: /x').groups).map(r => r.path), ['/x'])
  assert.deepEqual(googlebotRules(parseRobots('User-agent: *x\nDisallow: /\nUser-agent: Googlebot*\nDisallow: /y').groups).map(r => r.path), ['/y'], '"Googlebot*" is googlebot')
  assert.deepEqual(googlebotRules(parseRobots('User-agent: *x\nDisallow: /').groups), [], '"*x" is not the "*" group')
  assert.deepEqual(parseRobots('User-agent: a\nDisallow:\nUser-agent: b\nDisallow: /z').groups.map(g => g.agents), [['a'], ['b']], 'an empty Disallow still ends the run')
})
await test('robots.txt must not block a listed URL or every page; its Sitemap: lines lead to sitemaps', async () => {
  const robotsSaid = dir => checkSite(dir, SITE).findings.filter(f => f.check === 'robots' || f.file === 'robots.txt').map(f => [f.line, f.level, f.check, f.message])
  const dir = site({
    'index.html': PAGE,
    'a.html': page('A', '<link rel="canonical" href="https://shelf.example/a">').replace('<link rel="canonical" href="https://shelf.example/">', ''),
    'private.html': '<meta name="robots" content="noindex"><title>Private</title>',
    'drafts/b.html': page('B'),
    'maps/main.xml': urlset('https://shelf.example/', 'https://shelf.example/a'),
    'robots.txt': [
      'User-agent: *', 'Disallow: /a$', 'Disallow: /private', 'Disallow: /drafts/', 'Allow: /a.html',
      'Sitemap: https://shelf.example/maps/main.xml', 'Sitemap: /relative.xml', 'Sitemap: https://cdn.example/s.xml', 'Sitemap: https://shelf.example/gone.xml',
      'Noindex: /private',
    ].join('\n'),
  })
  try {
    assert.deepEqual(robotsSaid(dir), [
      [2, 'error', 'robots', 'Disallow: /a$ blocks https://shelf.example/a, which the sitemap lists'],
      [3, 'warn', 'robots', 'Disallow: /private blocks https://shelf.example/private.html, so Googlebot never sees its noindex and the page can still appear in search results (Google)'],
      [7, 'error', 'robots', 'Sitemap: "/relative.xml" is not an absolute http(s) URL (Google: a fully qualified URL)'],
      [8, 'warn', 'robots', 'Sitemap: https://cdn.example/s.xml is not on --site https://shelf.example/; not checked (seo-check fetches nothing)'],
      [9, 'error', 'sitemap', 'no file in the build serves the sitemap https://shelf.example/gone.xml'],
      [10, 'warn', 'robots', '"Noindex" is not a field Google reads; it ignores the line'],
    ], 'the listed URL /a is checked, not the file a.html; an unlisted blocked page is fine')
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /\n')
    writeFileSync(join(dir, 'sitemap.xml'), urlset('https://shelf.example/'))
    assert.deepEqual(robotsSaid(dir), [
      [0, 'warn', 'robots', 'robots.txt has no Sitemap: line; Google finds a sitemap through one or through Search Console'],
      [0, 'error', 'robots', 'robots.txt blocks every indexable page from Googlebot (a staging build?)'],
    ], 'and no per-URL finding when every page is blocked')
    writeFileSync(join(dir, 'robots.txt'), `User-agent: *\n${'#'.repeat(500 * 1024)}\nDisallow: /\n`)
    assert.deepEqual(robotsSaid(dir), [
      [0, 'warn', 'robots', 'robots.txt is 501 KiB; Google ignores everything after 500 KiB'],
      [0, 'warn', 'robots', 'robots.txt has no Sitemap: line; Google finds a sitemap through one or through Search Console'],
    ], 'a rule past 500 KiB is ignored')
    writeFileSync(join(dir, 'robots.txt'), '\u0000')
    assert.deepEqual(robotsSaid(dir), [[0, 'error', 'files', `${join(dir, 'robots.txt')} is not a text file`]])
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const docs = site({ 'index.html': PAGE.replaceAll('https://shelf.example/', 'https://shelf.example/docs/'), 'robots.txt': 'User-agent: *\nDisallow: /\n' })
  try {
    assert.deepEqual(checkSite(docs, parseSite('https://shelf.example/docs')).findings.filter(f => f.check === 'robots').map(f => [f.file, f.message]), [
      ['robots.txt', 'robots.txt is served at https://shelf.example/docs/robots.txt; crawlers read only https://shelf.example/robots.txt, so it is not checked'],
    ], 'under a --site path, robots.txt is not at the root')
    rmSync(join(docs, 'robots.txt'))
    assert.deepEqual(checkSite(docs, parseSite('https://shelf.example/docs')).findings.filter(f => f.check === 'robots'), [], 'nor is a missing one: the root is out of sight')
  } finally { rmSync(docs, { recursive: true, force: true }) }
})

console.log('== seo-check: the docs and the command')
await test('SKILL.md documents every check, and the file reader matches gtm-brief\'s', async () => {
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8')
  for (const check of CHECKS) assert.match(skill, new RegExp(`\\| \`${check}\` \\|`), check)
  const body = (file, name) => new RegExp(`export function ${name}\\(path\\) \\{\\n([\\s\\S]*?)\\n\\}`).exec(readFileSync(file, 'utf8'))[1]
  assert.equal(body(SCRIPT, 'readText'), body(join(REPO, 'core', 'skills', 'gtm-brief', 'gtm-brief.mjs'), 'readBrief'))
})
const cli = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' })
await test('check prints each finding and ends with SEO-CHECK: PASS|FAIL and exit 0|1, also through a symlink', async () => {
  const dir = site({
    'good/index.html': PAGE,
    'good/sitemap.xml': SITEMAP,
    'good/robots.txt': ROBOTS,
    'bad/index.html': PAGE.replace('<title>Shelf - a reading list that remembers every book</title>', ''),
    'bad/sitemap.xml': SITEMAP,
    'bad/robots.txt': ROBOTS,
    'warned/sitemap.xml': SITEMAP,
    'warned/robots.txt': ROBOTS,
    'warned/index.html': PAGE.replace('<title>Shelf - a reading list that remembers every book</title>', `<title>${'x'.repeat(61)}</title>`),
    'warned/404.html': '<html><head><meta name="robots" content="noindex"><title>Not found</title></head></html>',
  })
  try {
    symlinkSync(SCRIPT, join(dir, 'linked.mjs'))
    const pass = cli(join(dir, 'linked.mjs'), 'check', join(dir, 'good'), '--site', 'https://shelf.example')
    assert.equal(pass.status, 0, pass.stderr)
    assert.equal(pass.stdout, 'seo-check: 1 page, 0 errors, 0 warnings\nSEO-CHECK: PASS\n')
    const warned = cli(SCRIPT, 'check', join(dir, 'warned'), '--site', 'https://shelf.example')
    assert.equal(warned.status, 0, 'warnings never fail')
    assert.equal(warned.stdout.replace(dir, '<dir>'), `seo-check: <dir>/warned/index.html:${line('<title>')}: warn title: title is 61 characters; Google sets no limit but cuts long titles (our guide: 60)\nseo-check: 2 pages (1 noindex, checked for JSON-LD only), 0 errors, 1 warning\nSEO-CHECK: PASS\n`)
    const fail = cli(SCRIPT, 'check', join(dir, 'bad'), '--site=https://shelf.example/')
    assert.equal(fail.status, 1)
    assert.equal(fail.stdout.replace(dir, '<dir>'), 'seo-check: <dir>/bad/index.html: error title: no <title> in <head>\nseo-check: 1 page, 1 error, 0 warnings\nSEO-CHECK: FAIL\n')
    const json = cli(SCRIPT, 'check', join(dir, 'bad'), '--json', '--site', 'https://shelf.example')
    assert.equal(json.status, 1)
    const lines = json.stdout.trimEnd().split('\n')
    assert.equal(lines.pop(), 'SEO-CHECK: FAIL')
    const report = JSON.parse(lines.join('\n'))
    assert.deepEqual(report.findings, [{ file: 'index.html', line: 0, level: 'error', check: 'title', message: 'no <title> in <head>' }])
    assert.deepEqual(report.pages, [{ file: 'index.html', url: 'https://shelf.example/', indexable: true, listed: true }])
    assert.equal(report.site, 'https://shelf.example/')
    const missing = cli(SCRIPT, 'check', join(dir, 'gone'), '--site', 'https://shelf.example')
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /error files: cannot read .*gone: ENOENT\n.*\nSEO-CHECK: FAIL\n$/)
    for (const args of [[], ['lint', dir, '--site', 'https://x.example'], ['check', dir], ['check', '--site', 'https://x.example'], ['check', dir, dir, '--site', 'https://x.example'], ['check', dir, '--site'], ['check', dir, '--site', 'https://x.example', '--fast'], ['check', dir, '--site', 'x.example']]) {
      const r = cli(SCRIPT, ...args)
      assert.equal(r.status, 2, args.join(' '))
      assert.equal(r.stdout, '', args.join(' '))
      assert.match(r.stderr, /usage: seo-check\.mjs check/)
    }
    const preserved = cli('--preserve-symlinks-main', join(dir, 'linked.mjs'), 'check', join(dir, 'bad'), '--site', 'https://shelf.example')
    assert.equal(preserved.status, 1, 'node --preserve-symlinks-main still runs the check')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
