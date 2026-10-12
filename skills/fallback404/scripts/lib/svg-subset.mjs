// A local pre-check that mirrors, and is stricter than, the picker's SVG upload rules (picker spec section 8).
// It is not a security boundary (the server is): it saves a picker step when an SVG would be rejected.

/** Same allowlist as lib/picker/validate.ts on the server. */
export const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
  'style', 'animate', 'animateMotion', 'animateTransform', 'mpath', 'set',
])

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const NAMESPACED_ATTRIBUTES = new Set(['xlink:href', 'xml:space', 'xml:lang'])
const TAG = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function refsAreLocal(svg, pattern) {
  for (const match of svg.matchAll(pattern)) if (svg[match.index + match[0].length] !== '#') return false
  return true
}

const TEXT_RULES = [
  ['it contains a control character', (svg) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(svg)],
  ['it contains <!…> (bake removes comments; DOCTYPE, ENTITY and CDATA are not allowed)', (svg) => svg.includes('<!')],
  ['it contains <script>', (svg) => /<script/i.test(svg)],
  ['it contains an event handler attribute (on…=)', (svg) => /\son[a-z]+\s*=/i.test(svg)],
  ['it contains a javascript: URL', (svg) => /javascript:/i.test(svg.replace(/\s+/g, ''))],
  ['it contains <foreignObject>, <iframe>, <embed> or <object>', (svg) => /<(?:foreignObject|iframe|embed|object)[\s>/]/i.test(svg)],
  ['it contains a numeric character reference (&#…)', (svg) => svg.includes('&#')],
  ['it contains an entity other than &amp; &lt; &gt; &quot; &apos;', (svg) => /&(?!(?:amp|lt|gt|quot|apos);)/.test(svg)],
  ['it contains a backslash (CSS escapes are not allowed)', (svg) => svg.includes('\\')],
  ['it contains @import', (svg) => /@import/i.test(svg)],
  ['it contains image-set()', (svg) => /image-set\s*\(/i.test(svg)],
  ['it animates an href', (svg) => /attributeName\s*=\s*["']\s*(?:xlink:)?href/i.test(svg)],
  ['it has an href that does not point to a local #id', (svg) => !refsAreLocal(svg, /\bhref\s*=\s*["']?/gi)],
  ['it has a url() that does not point to a local #id', (svg) => !refsAreLocal(svg, /url\(\s*["']?/gi)],
]

/** Only a leading `<?xml version="1.0" …?>` declaration, and only UTF-8. */
function prologProblem(svg) {
  const declaration = svg.match(/^\s*<\?xml\s[^>]*\?>/)
  const rest = declaration ? svg.slice(declaration[0].length) : svg
  if (rest.includes('<?')) return 'it contains a processing instruction (<?…?>)'
  if (declaration && !/version\s*=\s*["']1\.0["']/.test(declaration[0])) return 'its XML declaration must say version="1.0"'
  if (declaration && /encoding/i.test(declaration[0]) && !/encoding\s*=\s*["']utf-8["']/i.test(declaration[0])) return 'its XML declaration names an encoding other than UTF-8'
  return null
}

function attributesProblem(name, attributes, isRoot) {
  const seen = new Set()
  let namespace = null
  for (const [, attr, double, single] of attributes.matchAll(ATTRIBUTE)) {
    const value = double ?? single
    if (seen.has(attr)) return `it repeats the attribute ${attr} on <${name}>`
    seen.add(attr)
    if (attr === 'xmlns') {
      if (value !== SVG_NS) return 'its xmlns must be the SVG namespace'
      namespace = value
    } else if (attr === 'xmlns:xlink') {
      if (value !== XLINK_NS) return 'its xmlns:xlink must be the XLink namespace'
    } else if (attr.includes(':') && !NAMESPACED_ATTRIBUTES.has(attr)) {
      return `it uses the namespaced attribute ${attr.slice(0, 40)}`
    }
  }
  if (isRoot && (name !== 'svg' || namespace !== SVG_NS)) return 'the root element must be <svg xmlns="http://www.w3.org/2000/svg">'
  return null
}

/** Well-formed, one root <svg> in the SVG namespace, allowed elements only, balanced tags. */
function structureProblem(svg) {
  const body = svg.replace(/^\s*<\?xml\s[^>]*\?>/, '')
  if (/\sxlink:/.test(body) && !/\sxmlns:xlink\s*=/.test(body)) return 'it uses xlink: without declaring xmlns:xlink'
  const stack = []
  let roots = 0
  let index = 0
  for (;;) {
    const open = body.indexOf('<', index)
    const text = body.slice(index, open === -1 ? body.length : open)
    if (stack.length === 0 && text.trim() !== '') return 'it has text outside the <svg> element'
    if (open === -1) break
    TAG.lastIndex = open
    const match = TAG.exec(body)
    if (!match) return `it is not well-formed XML near "${body.slice(open, open + 30)}"`
    const [whole, closing, name, attributes, selfClosing] = match
    index = open + whole.length
    if (closing) {
      if (attributes.trim() !== '' || selfClosing) return `it has a malformed closing tag </${name}>`
      if (stack.pop() !== name) return `it closes <${name}> out of order`
      continue
    }
    if (stack.length === 0 && ++roots > 1) return 'it has more than one root element'
    if (!SVG_ELEMENTS.has(name)) return `it uses the element <${name.slice(0, 40)}>, which is not allowed`
    const problem = attributesProblem(name, attributes, stack.length === 0)
    if (problem) return problem
    if (!selfClosing) stack.push(name)
  }
  if (stack.length > 0) return `it never closes <${stack.at(-1)}>`
  if (roots === 0) return 'it has no <svg> element'
  return null
}

/** Why the picker would reject this SVG (a short reason), or null when it passes. */
export function svgProblem(svg) {
  if (Buffer.byteLength(svg, 'utf8') > 200 * 1024) return 'it is larger than 200 KB'
  const prolog = prologProblem(svg)
  if (prolog) return prolog
  for (const [reason, breaks] of TEXT_RULES) if (breaks(svg)) return reason
  return structureProblem(svg)
}
