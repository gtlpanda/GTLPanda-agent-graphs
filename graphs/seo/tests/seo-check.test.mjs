// seo-check.test.mjs - the SEO checker (graphs/seo/skills/seo-check/seo-check.mjs).
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { scanTags } from '../skills/seo-check/seo-check.mjs'

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
