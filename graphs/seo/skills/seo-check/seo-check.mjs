// seo-check.mjs - checks the HTML of a built site for the tags search engines
// and link previews read. Zero dependencies. So far it is the tag scanner; the
// checks for one page and the command that checks a build follow (G2a, 1 of 3).

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
