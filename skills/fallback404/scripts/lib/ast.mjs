// Parsing helpers shared by scan, identity and check. Code is parsed with the vendored @babel/parser, never executed.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parse } = require('../vendor/babel-parser.cjs')

/** Marks a value that cannot be known without running the code. */
export const UNKNOWN = Symbol('unknown')

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'errors', 'tokens'])
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'])

/** Parses JS, JSX, TS or TSX, chosen by file extension. Throws on syntax it cannot recover from. */
export function parseSource(source, file) {
  const typescript = /\.(?:ts|tsx|mts|cts)$/.test(file)
  const plugins = typescript ? (file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript']) : ['jsx']
  return parse(source, { sourceType: 'module', plugins, errorRecovery: true, allowReturnOutsideFunction: true })
}

export const isCodeFile = (file) => /\.(?:[cm]?[jt]sx?)$/.test(file)

/** Calls `visit(node, ancestors)` depth first on every AST node; returning false skips that node's children. */
export function traverse(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return
  if (visit(node, ancestors) === false) return
  ancestors.push(node)
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') traverse(child, visit, ancestors)
    } else if (value && typeof value.type === 'string') {
      traverse(value, visit, ancestors)
    }
  }
  ancestors.pop()
}

/** Strips TypeScript-only wrappers: `x as T`, `x satisfies T`, `x!`, `<T>x`. */
export function unwrap(node) {
  while (node && TS_WRAPPERS.has(node.type)) node = node.expression
  return node
}

export function propertyKey(prop) {
  if (prop.computed) return prop.key.type === 'StringLiteral' ? prop.key.value : null
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'StringLiteral' || prop.key.type === 'NumericLiteral') return String(prop.key.value)
  return null
}

/** The static value of a literal expression (strings, numbers, booleans, null, arrays, plain objects), else UNKNOWN. */
export function literalValue(node) {
  node = unwrap(node)
  if (!node) return UNKNOWN
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'TemplateLiteral':
      return node.expressions.length === 0 ? node.quasis.map((quasi) => quasi.value.cooked).join('') : UNKNOWN
    case 'UnaryExpression': {
      const value = literalValue(node.argument)
      if (node.operator === '-' && typeof value === 'number') return -value
      if (node.operator === '!' && value !== UNKNOWN) return !value
      return UNKNOWN
    }
    case 'ArrayExpression': {
      const out = []
      for (const element of node.elements) {
        if (!element || element.type === 'SpreadElement') return UNKNOWN
        const value = literalValue(element)
        if (value === UNKNOWN) return UNKNOWN
        out.push(value)
      }
      return out
    }
    case 'ObjectExpression': {
      const out = {}
      for (const prop of node.properties) {
        if (prop.type !== 'ObjectProperty') return UNKNOWN
        const key = propertyKey(prop)
        const value = literalValue(prop.value)
        if (key === null || value === UNKNOWN) return UNKNOWN
        out[key] = value
      }
      return out
    }
    default:
      return UNKNOWN
  }
}

/** Entries of an object expression by key (values are AST nodes), and whether a spread or computed key could add more. */
export function objectEntries(node) {
  node = unwrap(node)
  const entries = new Map()
  if (node?.type !== 'ObjectExpression') return { entries, spread: true }
  let spread = false
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') {
      spread = true
      continue
    }
    const key = propertyKey(prop)
    if (key === null) spread = true
    else entries.set(key, prop.type === 'ObjectMethod' ? prop : prop.value)
  }
  return { entries, spread }
}

const nameOf = (node) => (node.type === 'Identifier' ? node.name : node.value)

/** Local name → { source, imported } for every value import ('default', '*' or the imported name). */
export function importBindings(ast) {
  const map = new Map()
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue
    for (const spec of node.specifiers) {
      if (spec.importKind === 'type') continue
      const imported = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(spec.imported)
      map.set(spec.local.name, { source: node.source.value, imported })
    }
  }
  return map
}

/** Every module specifier the file imports or re-exports from, in source order (type-only imports excluded). */
export function importSources(ast) {
  const sources = []
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') sources.push(node.source.value)
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source && node.exportKind !== 'type') sources.push(node.source.value)
  }
  return sources
}

/** Top-level bindings: name → function or class declaration, or the initializer of a const/let/var. */
export function topLevelBindings(ast) {
  const map = new Map()
  const add = (declaration) => {
    if (!declaration) return
    if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) map.set(declaration.id.name, declaration)
    if (declaration.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) if (item.id.type === 'Identifier' && item.init) map.set(item.id.name, item.init)
    }
  }
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') add(node.declaration)
    else add(node)
  }
  return map
}

/** Exported name → local binding name, `{ source, imported }` for a re-export, or null for an anonymous default. */
export function exportBindings(ast) {
  const map = new Map()
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
      const declaration = node.declaration
      if (declaration?.id && (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration')) map.set(declaration.id.name, declaration.id.name)
      if (declaration?.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) if (item.id.type === 'Identifier') map.set(item.id.name, item.id.name)
      }
      for (const spec of node.specifiers) {
        if (spec.type !== 'ExportSpecifier' || spec.exportKind === 'type') continue
        map.set(nameOf(spec.exported), node.source ? { source: node.source.value, imported: nameOf(spec.local) } : nameOf(spec.local))
      }
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const declaration = unwrap(node.declaration)
      if (declaration.type === 'Identifier') map.set('default', declaration.name)
      else map.set('default', declaration.id?.name ?? null)
    }
  }
  return map
}

/** The node behind the default export: a function, a class, an arrow, or an expression such as memo(Page). */
export function defaultExportNode(ast) {
  const bindings = topLevelBindings(ast)
  for (const node of ast.program.body) {
    if (node.type !== 'ExportDefaultDeclaration') continue
    const declaration = unwrap(node.declaration)
    return declaration.type === 'Identifier' ? (bindings.get(declaration.name) ?? null) : declaration
  }
  const local = exportBindings(ast).get('default')
  return typeof local === 'string' ? (bindings.get(local) ?? null) : null
}

export const hasDirective = (ast, value) => ast.program.directives.some((directive) => directive.value.value === value)

/** 'Suspense' for <Suspense>, 'React.Suspense' for <React.Suspense>, 'svg:rect' for namespaced names. */
export function jsxName(name) {
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXMemberExpression') return `${jsxName(name.object)}.${name.property.name}`
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`
  return ''
}

export function jsxAttribute(opening, name) {
  return opening.attributes.find((attr) => attr.type === 'JSXAttribute' && jsxName(attr.name) === name) ?? null
}

/** "x" and {'x'} → 'x', a bare attribute → true, {literal} → its value, other expressions → UNKNOWN, no attribute → undefined. */
export function jsxAttributeValue(attr) {
  if (!attr) return undefined
  if (attr.value == null) return true
  if (attr.value.type === 'StringLiteral') return attr.value.value
  if (attr.value.type === 'JSXExpressionContainer') return literalValue(attr.value.expression)
  return UNKNOWN
}
