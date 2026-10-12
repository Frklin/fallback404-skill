// What a page, layout or helper module does that matters for 404s and loading states, read from its AST, plus an
// import resolver so a page's helpers can be followed two modules deep.
import { posix } from 'node:path'
import { defaultExportNode, exportBindings, hasDirective, importBindings, isCodeFile, jsxAttribute, jsxName, parseSource, topLevelBindings, traverse, unwrap } from './ast.mjs'
import { exists, readText } from './fs.mjs'

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs']
const ROUTE_PROPS = new Set(['params', 'searchParams', 'props'])

/** An element or fragment whose children are only text, such as <p>Loading…</p>. */
function onlyText(node) {
  let text = false
  for (const child of node.children) {
    if (child.type === 'JSXText') {
      if (child.value.trim() !== '') text = true
      continue
    }
    if (child.type === 'JSXExpressionContainer') {
      const { expression } = child
      if (expression.type === 'JSXEmptyExpression') continue
      if (expression.type === 'StringLiteral' || expression.type === 'TemplateLiteral') {
        text = true
        continue
      }
    }
    return false
  }
  return text
}

/** 'none' | 'null' | 'text' | 'element' for the fallback prop of a <Suspense>. */
export function fallbackKind(opening) {
  const attr = jsxAttribute(opening, 'fallback')
  if (!attr || attr.value == null) return 'none'
  if (attr.value.type === 'StringLiteral') return 'text'
  if (attr.value.type !== 'JSXExpressionContainer') return 'element'
  const expression = unwrap(attr.value.expression)
  if (expression.type === 'JSXEmptyExpression') return 'none'
  if (expression.type === 'NullLiteral' || (expression.type === 'Identifier' && expression.name === 'undefined') || (expression.type === 'BooleanLiteral' && !expression.value)) {
    return 'null'
  }
  if (expression.type === 'StringLiteral' || expression.type === 'TemplateLiteral') return 'text'
  if (expression.type === 'JSXElement' || expression.type === 'JSXFragment') return onlyText(expression) ? 'text' : 'element'
  return 'element'
}

function isRouteProp(node) {
  node = unwrap(node)
  if (node?.type === 'Identifier') return ROUTE_PROPS.has(node.name)
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'props' &&
    (node.property.name === 'params' || node.property.name === 'searchParams')
  )
}

/** True when an async component awaits something other than its route props (params, searchParams). */
export function awaitsData(fn) {
  if (!fn?.async || !fn.body) return false
  let found = false
  traverse(fn.body, (node) => {
    if (found) return false
    if (node !== fn.body && /Function/.test(node.type)) return false
    if (node.type === 'AwaitExpression' && !isRouteProp(node.argument)) found = true
  })
  return found
}

/** Names a node calls or renders: plain names (`getPost`, `<Item>`) and namespace members (`db.find`). */
function referencedNames(node) {
  const names = new Set()
  traverse(node, (child) => {
    if (child.type === 'CallExpression') {
      const callee = unwrap(child.callee)
      if (callee.type === 'Identifier') names.add(callee.name)
      if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier') {
        names.add(`${callee.object.name}.${callee.property.name}`)
      }
    }
    if (child.type === 'JSXOpeningElement') {
      const name = jsxName(child.name)
      if (/^[A-Z]/.test(name)) names.add(name)
    }
  })
  return names
}

/** What one module does: notFound() reachability per binding, Suspense fallbacks, data awaits, route exports. */
export function analyzeModule(ast) {
  const imports = importBindings(ast)
  const localsOf = (source, imported) => new Set([...imports].filter(([, binding]) => binding.source === source && binding.imported === imported).map(([local]) => local))
  const notFoundNames = localsOf('next/navigation', 'notFound')
  const navigation = localsOf('next/navigation', '*')
  const suspenseNames = localsOf('react', 'Suspense')
  const reactNames = new Set([...localsOf('react', 'default'), ...localsOf('react', '*')])
  const isNotFoundCall = (node) => {
    if (node.type !== 'CallExpression') return false
    const callee = unwrap(node.callee)
    if (callee.type === 'Identifier') return notFoundNames.has(callee.name)
    return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && navigation.has(callee.object.name) && callee.property.name === 'notFound'
  }
  const containsNotFound = (node) => {
    let found = false
    traverse(node, (child) => {
      if (found) return false
      if (isNotFoundCall(child)) found = true
    })
    return found
  }
  const bindings = topLevelBindings(ast)
  const refs = new Map([...bindings].map(([name, node]) => [name, referencedNames(node)]))
  const reaches = new Set([...bindings].filter(([, node]) => containsNotFound(node)).map(([name]) => name))
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, names] of refs) {
      if (reaches.has(name) || ![...names].some((ref) => reaches.has(ref))) continue
      reaches.add(name)
      changed = true
    }
  }
  const suspense = []
  traverse(ast.program, (node) => {
    if (node.type !== 'JSXElement') return
    const name = jsxName(node.openingElement.name)
    const [head, member] = name.split('.')
    if (suspenseNames.has(name) || (member === 'Suspense' && reactNames.has(head))) suspense.push({ line: node.loc.start.line, fallback: fallbackKind(node.openingElement) })
  })
  const exports = exportBindings(ast)
  return {
    imports,
    exports,
    refs,
    reaches,
    allRefs: referencedNames(ast.program),
    callsNotFound: containsNotFound(ast.program),
    useClient: hasDirective(ast, 'use client'),
    generateStaticParams: exports.has('generateStaticParams'),
    suspense,
    awaitsData: awaitsData(unwrap(defaultExportNode(ast))),
  }
}

/** Repo path an import specifier points at (relative, or through a tsconfig alias), or null for packages. */
export function specifierPath(fromFile, spec, paths) {
  let base
  if (spec.startsWith('./') || spec.startsWith('../')) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), spec))
  } else {
    const alias = paths.find((entry) => spec.startsWith(entry.prefix))
    if (!alias) return null
    base = posix.normalize(posix.join(alias.target || '.', spec.slice(alias.prefix.length)))
  }
  return base.startsWith('..') || posix.isAbsolute(base) ? null : base
}

/** Loads and analyzes repo modules once each, and follows imports to find helpers that reach notFound(). */
export function createModuleGraph(root, paths, warnings = []) {
  const cache = new Map()

  async function load(file) {
    if (!isCodeFile(file)) return null
    if (cache.has(file)) return cache.get(file)
    cache.set(file, null)
    const source = await readText(root, file, { warnings })
    if (source === null) return null
    try {
      cache.set(file, analyzeModule(parseSource(source, file)))
    } catch (error) {
      warnings.push(`${file} could not be parsed (${String(error.message).split('\n')[0]}), so it is treated as unknown.`)
    }
    return cache.get(file)
  }

  async function resolve(fromFile, spec) {
    const base = specifierPath(fromFile, spec, paths)
    if (base === null) return null
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '')
    const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => `${stem}${ext}`), ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`)]
    for (const candidate of candidates) if (isCodeFile(candidate) && (await exists(root, candidate))) return candidate
    return null
  }

  /** Does export `name` of `file` reach notFound()? `depth` is how many more modules may be followed. */
  async function exportReaches(file, name, depth) {
    const mod = await load(file)
    if (!mod) return false
    const target = mod.exports.get(name)
    if (target && typeof target === 'object') {
      if (depth <= 0) return false
      const next = await resolve(file, target.source)
      return next ? exportReaches(next, target.imported, depth - 1) : false
    }
    if (typeof target !== 'string') return name === 'default' && mod.callsNotFound
    if (mod.reaches.has(target)) return true
    if (depth <= 0) return false
    for (const ref of mod.refs.get(target) ?? []) if (await importReach(file, mod, ref, depth - 1)) return true
    return false
  }

  /** `file#export` when `ref` is an imported function or component that reaches notFound(), else null. */
  async function importReach(file, mod, ref, depth) {
    const [head, member] = ref.split('.')
    const binding = mod.imports.get(head)
    if (!binding) return null
    const imported = binding.imported === '*' ? member : binding.imported
    if (!imported) return null
    const target = await resolve(file, binding.source)
    if (!target) return null
    return (await exportReaches(target, imported, depth)) ? `${target}#${imported}` : null
  }

  /** How a page reaches notFound(): directly, through an imported helper (two modules deep), not at all, or unknown. */
  async function notFoundUse(file) {
    const mod = await load(file)
    if (!mod) return { use: 'unknown' }
    if (mod.callsNotFound) return { use: 'direct' }
    for (const ref of [...mod.allRefs].sort()) {
      const via = await importReach(file, mod, ref, 1)
      if (via) return { use: 'indirect', via }
    }
    return { use: 'none' }
  }

  return { load, resolve, notFoundUse }
}
