// Reads next.config.* without running it: Cache Components, output mode, page extensions and basePath.
import { UNKNOWN, literalValue, objectEntries, parseSource, topLevelBindings, unwrap } from './ast.mjs'
import { readText } from './fs.mjs'

export const CONFIG_FILES = ['next.config.ts', 'next.config.mts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']
export const DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js']

/** Cache Components is off by default in Next.js 15 and 16; its docs say the next major turns it on everywhere. */
const defaultCacheComponents = (next) => Number.isFinite(next?.major) && next.major >= 17

const isModuleExports = (node) =>
  node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'module' && node.property.name === 'exports'

/** The object literal a config file exports, following identifiers and wrapper calls such as withMDX(config). */
export function exportedConfigObject(ast) {
  const bindings = topLevelBindings(ast)
  let expression = null
  for (const node of ast.program.body) {
    if (node.type === 'ExportDefaultDeclaration') expression = node.declaration
    if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && isModuleExports(node.expression.left)) {
      expression = node.expression.right
    }
  }
  for (let depth = 0; depth < 6; depth++) {
    expression = unwrap(expression)
    if (!expression) return null
    if (expression.type === 'ObjectExpression') return expression
    if (expression.type === 'Identifier') expression = bindings.get(expression.name)
    else if (expression.type === 'CallExpression' && expression.arguments.length > 0) expression = expression.arguments[0]
    else return null
  }
  return null
}

function reader({ entries, spread }) {
  return {
    has: (key) => entries.has(key),
    node: (key) => entries.get(key),
    /** The literal value of `key`, the fallback when it is absent, or 'unknown' when it is computed or may come from a spread. */
    value(key, fallback) {
      if (entries.has(key)) {
        const value = literalValue(entries.get(key))
        return value === UNKNOWN ? 'unknown' : value
      }
      return spread ? 'unknown' : fallback
    },
  }
}

const asFlag = (value) => (value === true || value === false ? value : 'unknown')

/** Next.js 15 had Cache Components behind experimental flags (canary only). */
function next15CacheComponents(experimental) {
  const flags = ['dynamicIO', 'cacheComponents', 'ppr'].map((key) => experimental.value(key, false))
  if (flags.includes(true)) return true
  return flags.every((flag) => flag === false) ? false : 'unknown'
}

export async function readNextConfig(root, next, warnings = []) {
  const found = []
  for (const name of CONFIG_FILES) {
    const source = await readText(root, name, { warnings })
    if (source !== null) found.push({ name, source })
  }
  const defaults = { file: found[0]?.name ?? null, cacheComponents: defaultCacheComponents(next), output: null, pageExtensions: DEFAULT_PAGE_EXTENSIONS, basePath: '' }
  if (found.length === 0) return defaults
  if (found.length > 1) warnings.push(`Several Next.js config files exist (${found.map((item) => item.name).join(', ')}); reading ${found[0].name}.`)
  const { name, source } = found[0]
  let ast
  try {
    ast = parseSource(source, name)
  } catch (error) {
    warnings.push(`${name} could not be parsed (${String(error.message).split('\n')[0]}), so its settings are unknown.`)
    return { ...defaults, cacheComponents: 'unknown' }
  }
  const config = exportedConfigObject(ast)
  if (!config) {
    warnings.push(`${name} does not export a plain object (it may be a function or built at runtime), so its settings are unknown.`)
    return { ...defaults, cacheComponents: 'unknown' }
  }
  const topEntries = objectEntries(config)
  const top = reader(topEntries)
  const experimental = reader(top.has('experimental') ? objectEntries(top.node('experimental')) : { entries: new Map(), spread: topEntries.spread })
  const pageExtensions = top.value('pageExtensions', DEFAULT_PAGE_EXTENSIONS)
  const validExtensions = Array.isArray(pageExtensions) && pageExtensions.length > 0 && pageExtensions.every((ext) => typeof ext === 'string')
  if (!validExtensions) warnings.push(`pageExtensions in ${name} is not a literal list, so the defaults are used.`)
  const basePath = top.value('basePath', '')
  return {
    file: name,
    cacheComponents:
      Number.isFinite(next?.major) && next.major < 16 ? next15CacheComponents(experimental) : asFlag(top.value('cacheComponents', defaultCacheComponents(next))),
    output: top.value('output', null),
    pageExtensions: validExtensions ? pageExtensions : DEFAULT_PAGE_EXTENSIONS,
    basePath: typeof basePath === 'string' ? basePath : 'unknown',
  }
}
