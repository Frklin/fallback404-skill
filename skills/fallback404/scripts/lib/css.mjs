// A small, tolerant CSS reader for design tokens: custom properties per color scheme, Tailwind v4 @theme blocks and
// how the site switches to dark mode. It never throws on odd CSS; syntax it does not understand is skipped.

const DARK_MEDIA = /prefers-color-scheme\s*:\s*dark/i
const BASE_SELECTOR = /^(?::root|html|:host|\*)$/i

/** Rules, at-rules (with or without a block) and declarations, nested as in the source. */
export function parseCss(text) {
  let i = 0
  const n = text.length

  function skipComment() {
    const end = text.indexOf('*/', i + 2)
    i = end === -1 ? n : end + 2
  }

  function skipSpace() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++
      if (text.startsWith('/*', i)) skipComment()
      else return
    }
  }

  /** Reads up to the first of `stops` outside strings, comments, parentheses and brackets. */
  function readUntil(stops) {
    let out = ''
    let depth = 0
    while (i < n) {
      const char = text[i]
      if (char === '"' || char === "'") {
        let j = i + 1
        while (j < n && text[j] !== char) j += text[j] === '\\' ? 2 : 1
        out += text.slice(i, j + 1)
        i = j + 1
        continue
      }
      if (text.startsWith('/*', i)) {
        skipComment()
        continue
      }
      if (char === '(' || char === '[') depth++
      else if ((char === ')' || char === ']') && depth > 0) depth--
      else if (depth === 0 && stops.includes(char)) return { text: out.trim(), stop: char }
      out += char
      i++
    }
    return { text: out.trim(), stop: null }
  }

  function atRule(prelude, children) {
    const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude)
    return { type: 'at', name: match ? match[1].toLowerCase() : '', prelude: match ? match[2].trim() : '', children }
  }

  function block() {
    const items = []
    for (;;) {
      skipSpace()
      if (i >= n) return items
      if (text[i] === '}') {
        i++
        return items
      }
      const { text: prelude, stop } = readUntil('{;}')
      if (stop === '{') {
        i++
        const children = block()
        items.push(prelude.startsWith('@') ? atRule(prelude, children) : { type: 'rule', selector: prelude, children })
        continue
      }
      if (stop === ';') i++
      if (prelude === '') continue
      if (prelude.startsWith('@')) {
        items.push(atRule(prelude, null))
        continue
      }
      const colon = prelude.indexOf(':')
      if (colon <= 0) continue
      const value = prelude.slice(colon + 1).trim()
      const important = /!\s*important$/i.test(value)
      items.push({ type: 'decl', prop: prelude.slice(0, colon).trim(), value: important ? value.replace(/\s*!\s*important$/i, '') : value, important })
    }
  }

  return block()
}

/** Calls visit(item, context) for every item; context lists the enclosing at-rules and rules, outermost first. */
export function walkCss(items, visit, context = { atRules: [], rules: [] }) {
  for (const item of items) {
    visit(item, context)
    if (!item.children) continue
    const inner = item.type === 'at' ? { atRules: [...context.atRules, item], rules: context.rules } : { atRules: context.atRules, rules: [...context.rules, item] }
    walkCss(item.children, visit, inner)
  }
}

/** The dark-mode switch a selector stands for: `.dark` → class, `[data-theme="dark"]` → attribute; otherwise null. */
export function darkSelector(selector) {
  if (/(^|[\s,>+~(]|:root|html)\.dark\b/.test(selector)) return { strategy: 'class', value: 'dark' }
  const attribute = /\[\s*([\w-]+)\s*=\s*["']?dark["']?\s*\]/.exec(selector)
  if (attribute) return { strategy: 'attribute', attribute: attribute[1], value: 'dark' }
  return null
}

const isBase = (selector) => selector.split(',').some((part) => BASE_SELECTOR.test(part.trim()))

/** Custom properties per scheme ({ light, dark, theme }), the dark-mode switches the CSS uses, and its @import targets. */
export function extractTokens(css) {
  const out = { light: {}, dark: {}, theme: {}, darkModes: [], imports: [] }
  const addMode = (mode) => {
    if (!out.darkModes.some((known) => JSON.stringify(known) === JSON.stringify(mode))) out.darkModes.push(mode)
  }
  walkCss(parseCss(css), (item, context) => {
    if (item.type === 'at' && item.name === 'import' && !item.children) {
      const target = /^(?:url\()?\s*["']([^"']+)["']/.exec(item.prelude)
      if (target) out.imports.push(target[1])
    }
    if (item.type === 'at' && item.name === 'custom-variant' && /^dark\b/.test(item.prelude)) {
      const mode = darkSelector(item.prelude)
      if (mode) addMode(mode)
    }
    if (item.type !== 'decl' || !item.prop.startsWith('--')) return
    if (context.atRules.some((at) => at.name === 'keyframes')) return
    const rule = context.rules.at(-1)
    if (!rule) {
      if (context.atRules.some((at) => at.name === 'theme')) out.theme[item.prop] = item.value
      return
    }
    const mode = darkSelector(rule.selector)
    if (mode) {
      out.dark[item.prop] = item.value
      addMode(mode)
    } else if (context.atRules.some((at) => at.name === 'media' && DARK_MEDIA.test(at.prelude)) && isBase(rule.selector)) {
      out.dark[item.prop] = item.value
      addMode({ strategy: 'media' })
    } else if (isBase(rule.selector)) {
      out.light[item.prop] = item.value
    }
  })
  return out
}

/** Replaces var(--x) references from the maps, in order, up to 10 levels deep; unresolved references stay as written. */
export function resolveValue(value, maps, depth = 0) {
  if (typeof value !== 'string' || depth > 10) return value
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
    for (const map of maps) if (typeof map[name] === 'string') return resolveValue(map[name], maps, depth + 1)
    return fallback === undefined ? whole : resolveValue(fallback.trim(), maps, depth + 1)
  })
}
