// seo-check.test.mjs - the SEO checker (graphs/seo/skills/seo-check/seo-check.mjs).
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { CHECKS, checkPage, checkSite, findPages, pageUrl, parseSite, scanTags } from '../skills/seo-check/seo-check.mjs'

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
    assert.deepEqual(got.pages.map(p => [p.file, p.url, p.indexable]), [['bad.html', 'https://shelf.example/bad.html', true], ['index.html', 'https://shelf.example/', true]])
    assert.deepEqual(got.findings.map(f => [f.file, f.check, f.message.replace(dir, '<dir>')]), [
      ['bad.html', 'title', `two <title> elements in <head> (first at line ${line('<title>')})`],
      ['bad.html', 'title', '<title> is empty'],
      ['bad.html', 'canonical', 'canonical points to https://shelf.example/, not this page (https://shelf.example/bad.html): search engines index that page instead'],
      ['bin.html', 'files', '<dir>/bin.html is not a text file'],
      ['latin1.html', 'files', '<dir>/latin1.html is not UTF-8 text'],
    ])
    assert.match(checkSite(join(dir, 'gone'), SITE).findings[0].message, /cannot read .*gone: ENOENT/)
    assert.match(checkSite(join(dir, 'index.html'), SITE).findings[0].message, /cannot read .*index\.html: ENOTDIR/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const staging = site({ 'index.html': PAGE.replace('<head>', '<head><meta name="robots" content="noindex">'), 'a.html': '<meta name=robots content=noindex>' })
  try {
    assert.deepEqual(checkSite(staging, SITE).findings.map(f => [f.file, f.message]), [['.', 'every page has noindex, so search engines index nothing (a staging build?)']])
  } finally { rmSync(staging, { recursive: true, force: true }) }
  const empty = site({ 'style.css': '' })
  try { assert.deepEqual(checkSite(empty, SITE).findings.map(f => f.message), [`no .html files under ${empty}`]) } finally { rmSync(empty, { recursive: true, force: true }) }
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
    'bad/index.html': PAGE.replace('<title>Shelf - a reading list that remembers every book</title>', ''),
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
    assert.deepEqual(report.pages, [{ file: 'index.html', url: 'https://shelf.example/', indexable: true }])
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
