// Finds proxy.ts (Next.js 16) or middleware.ts (15) and reads its matcher without running it.
import { UNKNOWN, exportBindings, literalValue, objectEntries, parseSource, topLevelBindings } from './ast.mjs'
import { readText } from './fs.mjs'

const NAMES = ['proxy.ts', 'proxy.js', 'proxy.mjs', 'middleware.ts', 'middleware.js', 'middleware.mjs']

/** The literal matcher list, null when there is none (the proxy then runs on every path), or 'unknown'. */
export function readMatcher(ast) {
  const local = exportBindings(ast).get('config')
  if (local === undefined) return null
  const node = typeof local === 'string' ? topLevelBindings(ast).get(local) : null
  const { entries, spread } = objectEntries(node)
  if (!entries.has('matcher')) return spread ? 'unknown' : null
  const value = literalValue(entries.get('matcher'))
  if (value === UNKNOWN) return 'unknown'
  const sources = (Array.isArray(value) ? value : [value]).map((item) => (typeof item === 'string' ? item : typeof item?.source === 'string' ? item.source : null))
  return sources.every((source) => source !== null) ? sources : 'unknown'
}

/** The project's request hook: proxy.* (Next.js 16) or middleware.* (15), at the root or in src/ for src projects. */
export async function readProxy(root, project, warnings = []) {
  const folder = project.srcDir ? 'src/' : ''
  for (const name of NAMES) {
    const file = `${folder}${name}`
    const source = await readText(root, file, { warnings })
    if (source === null) continue
    const kind = name.startsWith('proxy') ? 'proxy' : 'middleware'
    try {
      return { file, kind, matcher: readMatcher(parseSource(source, file)) }
    } catch {
      warnings.push(`${file} could not be parsed, so the routes it covers are unknown.`)
      return { file, kind, matcher: 'unknown' }
    }
  }
  return null
}

/** A Next.js matcher for a route pattern: [id] → :id, [...slug] → :slug+, [[...slug]] → :slug*. */
export function routeMatcher(route) {
  const param = (name) => name.replace(/\W/g, '_')
  return route
    .split('/')
    .map((part) => {
      const optional = /^\[\[\.\.\.(.+)\]\]$/.exec(part)
      if (optional) return `:${param(optional[1])}*`
      const catchAll = /^\[\.\.\.(.+)\]$/.exec(part)
      if (catchAll) return `:${param(catchAll[1])}+`
      const dynamic = /^\[(.+)\]$/.exec(part)
      return dynamic ? `:${param(dynamic[1])}` : part
    })
    .join('/')
}

/** A concrete URL for a route pattern, used to test matchers. */
export function sampleUrl(route) {
  return route
    .split('/')
    .map((part) => (/^\[\[?\.\.\./.test(part) ? 'f404-a/f404-b' : /^\[.+\]$/.test(part) ? 'f404-sample' : part))
    .join('/')
}

function closingParen(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '(') depth++
    if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}

/** A RegExp for a Next.js matcher (the path-to-regexp subset: :param, :param*, :param+, :param?, raw groups), or null. */
export function matcherRegExp(source) {
  let pattern = ''
  let i = 0
  while (i < source.length) {
    const param = /^\/:(\w+)(\((?:[^()\\]|\\.)*\))?([*+?])?/.exec(source.slice(i))
    if (param) {
      const [whole, , custom, modifier] = param
      const segment = custom ? `(?:${custom.slice(1, -1)})` : '[^/]+'
      pattern += modifier === '*' ? `(?:/${segment})*` : modifier === '+' ? `(?:/${segment})+` : modifier === '?' ? `(?:/${segment})?` : `/${segment}`
      i += whole.length
      continue
    }
    if (source[i] === '(') {
      const end = closingParen(source, i)
      if (end === -1) return null
      pattern += source.slice(i, end + 1)
      i = end + 1
      continue
    }
    pattern += source[i].replace(/[.+*?^${}|[\]\\]/g, '\\$&')
    i++
  }
  try {
    return new RegExp(`^${pattern}/?$`)
  } catch {
    return null
  }
}

/** True when a proxy with this matcher runs on the route; no matcher and unreadable matchers count as covering it. */
export function matcherCovers(matcher, route) {
  if (matcher === null || matcher === 'unknown') return true
  const url = sampleUrl(route)
  return matcher.some((source) => {
    const pattern = matcherRegExp(source)
    return pattern === null || pattern.test(url)
  })
}
