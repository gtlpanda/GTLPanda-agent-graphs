// seo-check.mjs - checks the HTML of a built site for the tags search engines
// and link previews read: title, meta description, canonical, Open Graph, and
// JSON-LD. Zero dependencies. So far: the tag scanner and the checks for one
// page; the command that checks a build follows (G2a, 2 of 3).

// Every check a finding can name.
export const CHECKS = ['title', 'description', 'canonical', 'og', 'json-ld']
const OG_REQUIRED = ['og:title', 'og:description', 'og:image', 'og:url']
const OG_URLS = ['og:image', 'og:url']
// Open Graph arrays: a page may list several images, so two values do not disagree.
const OG_ARRAYS = ['og:image']
// Our guide, not Google's: Google sets no length limit and cuts to the screen width.
const TITLE_MAX = 60
const DESCRIPTION_RANGE = [70, 160]

// ---- The tag scanner ----
// Elements whose content is text, not markup: a "<meta" inside them is not a tag.
// noscript is text for a parser with scripting on, as crawlers run; template
// content is inert. Neither can end the head (a tracking pixel's <img> often sits in one).
const RAW_TEXT = ['script', 'style', 'title', 'textarea', 'noscript', 'template', 'noframes']
// Where a tag lands, following the HTML parser: the head ends at <body>, at
// </body> or </html>, at any start tag not listed here, or at text that is not
// HTML whitespace. After </head>, these tags still go into the head (noscript does not).
const HEAD_TAGS = ['base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'noscript', 'script', 'style', 'template', 'title']
const AFTER_HEAD_TAGS = ['head', ...HEAD_TAGS.filter(t => t !== 'noscript')]
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y
const ATTR_NAME = /[^\s"'>/=]+/y
const ATTR_VALUE = /\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/y
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

function decode(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (all, ref) => {
    if (ref[0] !== '#') return Object.hasOwn(ENTITIES, ref.toLowerCase()) ? ENTITIES[ref.toLowerCase()] : all
    const code = /^#[xX]/.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
  })
}

// Reads a tag's attributes from `from` up to its ">". Attribute names are
// lowercased; the first of a repeated attribute wins, as in browsers.
function readAttrs(html, from) {
  const attrs = new Map()
  let i = from
  while (i < html.length) {
    const c = html[i]
    if (c === '>') return { attrs, end: i + 1 }
    ATTR_NAME.lastIndex = i
    const name = /[\s/]/.test(c) ? null : ATTR_NAME.exec(html)
    if (!name) { i++; continue }
    i = ATTR_NAME.lastIndex
    ATTR_VALUE.lastIndex = i
    const value = ATTR_VALUE.exec(html)
    if (value) i = ATTR_VALUE.lastIndex
    const key = name[0].toLowerCase()
    if (!attrs.has(key)) attrs.set(key, value ? decode(value[1] ?? value[2] ?? value[3]) : '')
  }
  return { attrs, end: html.length }
}

function closeTagAt(html, name, from) {
  const re = new RegExp(`</${name}[\\s/>]`, 'gi')
  re.lastIndex = from
  const m = re.exec(html)
  return m ? m.index : html.length
}

// Returns the start tags in document order: [{name, attrs, line, inHead, text}].
// `text` is the content of a script, style, title, or textarea. `inHead` follows
// the HTML parser's head rules (HEAD_TAGS). A scanner, not an HTML parser: it
// builds no tree. Line endings may be LF, CRLF, or CR.
export function scanTags(source) {
  const html = String(source).replace(/\r\n?/g, '\n')
  const tags = []
  let i = 0
  let line = 1
  let mode = 'head'   // 'head', then 'after-head' at </head>, then 'body'
  let textFrom = 0    // where the text since the last tag, comment, or doctype starts
  const advance = to => { for (let k = i; k < to; k++) if (html.charCodeAt(k) === 10) line++; i = to }
  const skipTo = (marker, from) => { const end = html.indexOf(marker, from); advance(end < 0 ? html.length : end + marker.length); textFrom = i }
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    advance(lt)
    if (mode !== 'body' && /[^\t\n\f\r ]/.test(html.slice(textFrom, lt))) mode = 'body'
    if (html.startsWith('<!--', i)) { skipTo('-->', i + 4); continue }
    if (html[i + 1] === '!' || html[i + 1] === '?') { skipTo('>', i); continue }   // <!doctype>, <?xml>
    const closing = html[i + 1] === '/'
    TAG_NAME.lastIndex = i + (closing ? 2 : 1)
    const m = TAG_NAME.exec(html)
    if (!m) { advance(i + 1); continue }   // a "<" that starts no tag is text: textFrom stays before it
    const name = m[0].toLowerCase()
    const tag = { name, attrs: null, line, inHead: false }
    const { attrs, end } = readAttrs(html, TAG_NAME.lastIndex)
    advance(end)
    textFrom = i
    if (closing) {
      if (name === 'head' && mode === 'head') mode = 'after-head'
      else if (['body', 'html'].includes(name)) mode = 'body'
      continue
    }
    const headTags = mode === 'head' ? ['html', 'head', ...HEAD_TAGS] : mode === 'after-head' ? ['html', ...AFTER_HEAD_TAGS] : []
    tag.inHead = headTags.includes(name)
    if (!tag.inHead) mode = 'body'
    tag.attrs = attrs
    if (RAW_TEXT.includes(name)) {
      const close = closeTagAt(html, name, i)
      const raw = html.slice(i, close)
      tag.text = name === 'title' || name === 'textarea' ? decode(raw) : raw
      advance(close)
      textFrom = i
    }
    tags.push(tag)
  }
  return tags
}

// ---- One page ----
const attr = (tag, name) => (tag.attrs.get(name) ?? '').trim()
const words = value => value.toLowerCase().split(/[\s,]+/).filter(Boolean)
const collapse = text => text.replace(/\s+/g, ' ').trim()
const chars = text => [...text].length
const isAbsolute = value => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
// /a, /a/, /a.html, and /a/index.html serve one page on most static hosts.
const pageKey = url => {
  const u = new URL(url)
  return u.origin + u.pathname.replace(/(\/index)?\.html?$/i, '').replace(/\/+$/, '') + u.search
}
const onSite = (url, site) => {
  const u = new URL(url)
  return u.origin === site.origin && `${u.pathname}/`.startsWith(site.pathname)
}

// --site as a URL object whose pathname ends in "/", or null when it is not an absolute http(s) URL.
export function parseSite(value) {
  if (!isAbsolute(value)) return null
  const site = new URL(value)
  site.search = ''
  site.hash = ''
  if (!site.pathname.endsWith('/')) site.pathname += '/'
  return site
}

// Checks one page's HTML. `url` is where the page is served; `site` is the
// --site URL (a URL object whose pathname ends in "/"). Returns
// {indexable, title, description, canonical, findings: [{line, level, check, message}]}.
export function checkPage(html, url, site) {
  const findings = []
  const add = (level, line, check, message) => {
    if (!CHECKS.includes(check)) throw new Error(`unknown check "${check}"`)
    findings.push({ line, level, check, message })
  }
  const error = (...a) => add('error', ...a)
  const warn = (...a) => add('warn', ...a)
  const tags = scanTags(html)
  const metas = key => value => tags.filter(t => t.name === 'meta' && attr(t, key).toLowerCase() === value)

  // The tags of one kind that count (inside <head>). Reports the first one in
  // <body> when <head> has none, and two in <head> that disagree, unless the
  // tag may repeat (valueOf is null).
  const fromHead = (found, check, what, valueOf) => {
    const head = found.filter(t => t.inHead)
    if (!head.length && found.length) error(found[0].line, check, `${what} is in <body>; it only counts in <head>`)
    if (!valueOf) return head
    const values = head.map(valueOf)
    const other = values.findIndex(v => v !== values[0])
    if (other > 0) error(head[other].line, check, `two ${what} tags disagree (first at line ${head[0].line})`)
    return head
  }

  const noindex = ['robots', 'googlebot'].some(name =>
    metas('name')(name).some(t => t.inHead && words(attr(t, 'content')).some(w => w === 'noindex' || w === 'none')))
  const facts = { indexable: !noindex, title: null, description: null, canonical: null }

  if (!noindex) {
    const titles = tags.filter(t => t.name === 'title' && t.inHead)
    if (!titles.length) error(0, 'title', 'no <title> in <head>')
    else {
      if (titles.length > 1) error(titles[1].line, 'title', `two <title> elements in <head> (first at line ${titles[0].line})`)
      facts.title = collapse(titles[0].text)
      if (!facts.title) error(titles[0].line, 'title', '<title> is empty')
      else if (chars(facts.title) > TITLE_MAX) {
        warn(titles[0].line, 'title', `title is ${chars(facts.title)} characters; Google sets no limit but cuts long titles (our guide: ${TITLE_MAX})`)
      }
    }

    const allDescriptions = metas('name')('description')
    const descriptions = fromHead(allDescriptions, 'description', 'meta description', t => attr(t, 'content'))
    if (!allDescriptions.length) error(0, 'description', 'no meta description (our rule: without one, Google writes its own snippet)')
    else if (descriptions.length) {
      facts.description = collapse(attr(descriptions[0], 'content'))
      const n = chars(facts.description)
      const [min, max] = DESCRIPTION_RANGE
      if (!n) error(descriptions[0].line, 'description', 'meta description is empty')
      else if (n < min || n > max) {
        warn(descriptions[0].line, 'description', `description is ${n} characters; Google sets no limit but cuts long ones (our guide: ${min}-${max})`)
      }
    }

    const isCanonical = t => t.name === 'link' && words(attr(t, 'rel')).includes('canonical')
    const allCanonicals = tags.filter(isCanonical)
    const canonicals = fromHead(allCanonicals, 'canonical', 'canonical link', t => attr(t, 'href'))
    if (!allCanonicals.length) error(0, 'canonical', 'no <link rel="canonical">')
    else if (canonicals.length) {
      const href = attr(canonicals[0], 'href')
      const line = canonicals[0].line
      if (!href) error(line, 'canonical', 'canonical link has no href')
      else if (!isAbsolute(href)) error(line, 'canonical', `canonical "${href}" is relative; Google recommends an absolute URL`)
      else if (!onSite(href, site)) error(line, 'canonical', `canonical ${href} is not on --site ${site.href}`)
      else {
        facts.canonical = href
        if (pageKey(href) !== pageKey(url)) warn(line, 'canonical', `canonical points to ${href}, not this page (${url}): search engines index that page instead`)
      }
    }

    for (const property of OG_REQUIRED) {
      const all = metas('property')(property)
      const found = fromHead(all, 'og', property, OG_ARRAYS.includes(property) ? null : t => attr(t, 'content'))
      if (!all.length) {
        const named = metas('name')(property).length ? '; it is set with name=, and Open Graph reads property=' : ''
        error(0, 'og', `no ${property}${named}`)
      }
      for (const tag of OG_ARRAYS.includes(property) ? found : found.slice(0, 1)) {
        const value = attr(tag, 'content')
        if (!value) error(tag.line, 'og', `${property} is empty`)
        else if (OG_URLS.includes(property) && !isAbsolute(value)) {
          error(tag.line, 'og', `${property} "${value}" is not an absolute http(s) URL (Open Graph's URL type)`)
        }
      }
    }
  }

  const jsonLd = tags.filter(t => t.name === 'script' && attr(t, 'type').toLowerCase() === 'application/ld+json')
  for (const script of jsonLd) checkJsonLd(script, error, warn)
  return { ...facts, findings: findings.sort((a, b) => a.line - b.line) }
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const typesOf = node => [].concat(node['@type'] ?? [])

function checkJsonLd(script, error, warn) {
  let data
  try { data = JSON.parse(script.text) } catch (e) {
    error(script.line, 'json-ld', `JSON-LD does not parse: ${e.message}`)
    return
  }
  const roots = Array.isArray(data) ? data : [data]
  if (!roots.length) error(script.line, 'json-ld', 'JSON-LD is an empty list')
  for (const root of roots) {
    if (!isObject(root)) { error(script.line, 'json-ld', 'JSON-LD must be an object or a list of objects'); continue }
    if (!Object.hasOwn(root, '@context')) error(script.line, 'json-ld', 'JSON-LD has no @context')
    const nodes = Object.hasOwn(root, '@graph') ? [].concat(root['@graph']) : [root]
    for (const node of nodes) {
      const types = isObject(node) ? typesOf(node) : []
      if (!types.length || !types.every(t => typeof t === 'string' && t.trim())) {
        error(script.line, 'json-ld', 'a JSON-LD node has no @type')
      } else if (types.includes('FAQPage')) {
        warn(script.line, 'json-ld', 'FAQPage: Google stopped showing FAQ rich results on 2026-05-07')
      }
    }
  }
}
