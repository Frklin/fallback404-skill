#!/usr/bin/env node
// Fallback404 check: enforces the output rules on the generated files (accessibility, tokens, motion, 404 patterns,
// write scope) and prints { ok, violations, warnings }. Claude fixes every violation and runs it again.
// Usage: node check.mjs [--root <dir>]
import { posix, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  defaultExportNode,
  exportBindings,
  hasDirective,
  importBindings,
  importSources,
  isCodeFile,
  jsxAttribute,
  jsxAttributeValue,
  jsxName,
  literalValue,
  parseSource,
  topLevelBindings,
  traverse,
  unwrap,
} from './lib/ast.mjs'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { ROOT_NOT_FOUND, componentFile, isSectionFix } from './lib/flows.mjs'
import { parseCss, walkCss } from './lib/css.mjs'
import { readJsonIfExists, readText, walk, workspacePath } from './lib/fs.mjs'
import { changedPaths, git, isGitRepo } from './lib/git.mjs'
import { atLeast } from './lib/project.mjs'

/** First line of the site's own root not-found page, moved unchanged into flows/root-not-found/ so the router can show it. */
export const MOVED_MARKER = "// Fallback404: the site's own page, moved here unchanged from "

const HEX = /#[0-9a-f]{3,8}\b/i
const HEX_ONLY = /^#[0-9a-f]{3,8}$/i
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/i
const NAMED = /\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i
const KEYWORD = /^(?:none|currentcolor|transparent|inherit|initial|unset|revert)$/i
const COLOR_ATTRIBUTES = new Set(['fill', 'stroke', 'stopColor', 'floodColor', 'lightingColor', 'color'])
const COLOR_STYLE_KEYS = /^(?:color|background(?:Color)?|fill|stroke|border(?:Top|Right|Bottom|Left)?Color|outlineColor|caretColor|accentColor)$/
const COLOR_PROPERTIES = new Set([
  'color', 'background-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'caret-color', 'accent-color',
  'text-decoration-color', 'column-rule-color',
])
const COLOR_SHORTHANDS = /^(?:background|border(?:-top|-right|-bottom|-left)?|outline|box-shadow|text-shadow|column-rule|text-decoration)$/
const SIZE_PROPERTIES = new Set(['height', 'block-size', 'min-height', 'min-block-size', 'aspect-ratio'])
const TEXT_ATTRIBUTES = ['alt', 'title', 'aria-label', 'placeholder']
const LOADER_BUDGET = 15 * 1024

const lineOf = (node) => node?.loc?.start.line ?? 1
const allowedColor = (value) => {
  const text = value.trim()
  return KEYWORD.test(text) || /^var\(--f404-[a-z0-9-]+\)$/.test(text) || /^url\(#/.test(text)
}

function hasElement(ast, name) {
  let found = false
  traverse(ast.program, (node) => {
    if (found) return false
    if (node.type === 'JSXOpeningElement' && jsxName(node.name) === name) found = true
  })
  return found
}

// A component in a flow folder, final or a variant: flows/<slug>/[variants/]<Name>[.v<k>].tsx; its text: copy[.v<k>].ts.
const FLOW_COMPONENT = /^flows\/[a-z0-9-]+\/(?:variants\/)?([A-Za-z]+)(?:\.v\d+)?\.[jt]sx$/
const FLOW_COPY = /^flows\/[a-z0-9-]+\/(?:variants\/)?copy(?:\.v\d+)?\.[jt]s$/
const STATE_NAMES = new Set(['NotFound', 'ErrorState', 'GlobalErrorState'])
const CLIENT_NAMES = new Set(['ErrorState', 'GlobalErrorState'])

function pathKind(file, scan) {
  const rel = file.startsWith(`${scan.componentsDir}/`) ? file.slice(scan.componentsDir.length + 1) : null
  const name = rel === null ? null : (FLOW_COMPONENT.exec(rel)?.[1] ?? null)
  return {
    component: rel !== null,
    visual: name !== null,
    state: STATE_NAMES.has(name),
    clientState: CLIENT_NAMES.has(name),
    loader: name === 'Loader',
    copy: rel !== null && FLOW_COPY.test(rel),
  }
}

/** error | global-error | not-found | loading | missing | preview | preview-client for Fallback404's files under the app dir. */
function wrapperKind(file, scan) {
  if (!file.startsWith(`${scan.appDir}/`)) return null
  const base = posix.basename(file).replace(/\.[jt]sx?$/, '')
  if (file.startsWith(`${scan.appDir}/fallback404-missing/`)) return base === 'page' ? 'missing' : null
  if (file.startsWith(`${scan.appDir}/fallback404-preview/`)) return base === 'page' ? 'preview' : base === 'client' ? 'preview-client' : null
  return ['error', 'global-error', 'not-found', 'loading'].includes(base) ? base : null
}

function checkSvg(file, ast, add) {
  traverse(ast.program, (node) => {
    if (node.type !== 'JSXElement' || jsxName(node.openingElement.name) !== 'svg') return
    const opening = node.openingElement
    const hidden = jsxAttributeValue(jsxAttribute(opening, 'aria-hidden'))
    const focusable = jsxAttributeValue(jsxAttribute(opening, 'focusable'))
    if (hidden !== true && hidden !== 'true') add(file, lineOf(opening), 'svg-aria-hidden', 'Illustrations are decorative: add aria-hidden="true" to the <svg>.')
    if (focusable !== false && focusable !== 'false') add(file, lineOf(opening), 'svg-aria-hidden', 'Add focusable="false" to the <svg> so it never takes keyboard focus.')
    traverse(node, (child) => {
      if (child.type !== 'JSXAttribute' || jsxName(child.name) !== 'id') return
      const value = jsxAttributeValue(child)
      if (typeof value === 'string') add(file, lineOf(child), 'svg-static-id', `id="${value}" is fixed, so two illustrations on one page collide. Build ids from useId().`)
    })
    return false
  })
}

function checkColorsInCode(file, ast, add) {
  traverse(ast.program, (node) => {
    if (node.type === 'ImportDeclaration') return false
    if (node.type === 'JSXAttribute' && COLOR_ATTRIBUTES.has(jsxName(node.name))) {
      const value = jsxAttributeValue(node)
      if (typeof value === 'string' && !allowedColor(value)) {
        add(file, lineOf(node), 'color-literal', `${jsxName(node.name)}="${value}" is a literal color. Use var(--f404-<role>) or currentColor.`)
      }
      return false
    }
    if (node.type === 'ObjectProperty' && !node.computed) {
      const key = node.key.type === 'Identifier' ? node.key.name : String(node.key.value)
      const value = literalValue(node.value)
      if (COLOR_STYLE_KEYS.test(key) && typeof value === 'string' && !allowedColor(value) && !/var\(/.test(value)) {
        add(file, lineOf(node), 'color-literal', `${key}: '${value}' is a literal color. Use a var(--f404-<role>) token.`)
        return false
      }
    }
    const text = node.type === 'StringLiteral' ? node.value : node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null
    if (text !== null && !allowedColor(text) && (HEX_ONLY.test(text.trim()) || COLOR_FN.test(text))) {
      add(file, lineOf(node), 'color-literal', `"${text.slice(0, 40)}" is a literal color. Colors come from tokens: var(--f404-<role>).`)
    }
  })
}

function checkCopy(file, ast, add) {
  traverse(ast.program, (node) => {
    if (node.type === 'JSXElement' && jsxAttribute(node.openingElement, 'data-f404-art')) return false
    if (node.type === 'JSXText' && node.value.trim() !== '') add(file, lineOf(node), 'copy-literal', `Visible text "${node.value.trim().slice(0, 40)}" belongs in the flow's copy.ts.`)
    if (node.type === 'JSXAttribute' && TEXT_ATTRIBUTES.includes(jsxName(node.name))) {
      const value = jsxAttributeValue(node)
      if (typeof value === 'string' && value.trim() !== '') add(file, lineOf(node), 'copy-literal', `${jsxName(node.name)}="${value.slice(0, 40)}" belongs in the flow's copy.ts.`)
    }
  })
}

function hasTextChild(element) {
  return element.children.some((child) => {
    if (child.type === 'JSXExpressionContainer') return child.expression.type !== 'JSXEmptyExpression'
    if (child.type === 'JSXElement' || child.type === 'JSXFragment') return hasTextChild(child)
    return child.type === 'JSXText' && child.value.trim() !== ''
  })
}

function checkLoader(file, ast, add) {
  let status = null
  traverse(ast.program, (node) => {
    if (status || node.type !== 'JSXElement') return
    const opening = node.openingElement
    if (jsxAttributeValue(jsxAttribute(opening, 'role')) === 'status' || jsxAttribute(opening, 'aria-busy')) status = node
  })
  if (!status) {
    add(file, 1, 'loader-status', 'The loader needs role="status" (or aria-busy) so screen readers hear that something is loading.')
    return
  }
  const label = jsxAttributeValue(jsxAttribute(status.openingElement, 'aria-label'))
  const labelled = (label !== undefined && label !== '' && label !== true) || hasTextChild(status)
  if (!labelled) add(file, lineOf(status), 'loader-status', 'Give the loader a text label from copy.ts: aria-label, or visually hidden text inside it.')
}

function checkLoaderBox(file, source, cssFile, cssItems, add) {
  if (!/\bf404-loader\b/.test(source)) {
    add(file, 1, 'loader-box', 'Give the loader root the f404-loader class so its box keeps a fixed size (no layout shift).')
    return
  }
  let sized = false
  walkCss(cssItems, (item, context) => {
    if (item.type === 'decl' && SIZE_PROPERTIES.has(item.prop) && context.rules.some((rule) => /\.f404-loader(?![\w-])/.test(rule.selector))) sized = true
  })
  if (!sized) add(cssFile, 1, 'loader-box', 'Give .f404-loader a height, block-size, min-block-size or aspect-ratio, so swapping it for content causes no layout shift.')
}

async function checkLoaderBudget(root, file, source, css, ast, add) {
  let total = source + css
  for (const spec of importSources(ast).filter((item) => item.startsWith('.') && !item.endsWith('.css'))) {
    const base = posix.normalize(posix.join(posix.dirname(file), spec))
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      const text = await readText(root, `${base}${ext}`)
      if (text !== null) {
        total += text
        break
      }
    }
  }
  const bytes = gzipSync(total).length
  if (bytes > LOADER_BUDGET) add(file, 1, 'loader-budget', `The loader, what it imports and the Fallback404 CSS are ${(bytes / 1024).toFixed(1)} KB gzipped; the budget is 15 KB.`)
}

/** Selectors that animate without a prefers-reduced-motion: reduce rule turning their animation off. */
export function unguardedAnimations(items) {
  const animated = new Set()
  const reduced = new Set()
  walkCss(items, (item, context) => {
    if (item.type !== 'decl' || (item.prop !== 'animation' && item.prop !== 'animation-name') || context.rules.length === 0) return
    if (context.atRules.some((at) => at.name === 'keyframes')) return
    const inReduced = context.atRules.some((at) => at.name === 'media' && /prefers-reduced-motion\s*:\s*reduce/i.test(at.prelude))
    const none = /^none\b/i.test(item.value)
    for (const selector of context.rules.at(-1).selector.split(',').map((part) => part.trim().replace(/\s+/g, ' '))) {
      if (inReduced && none) reduced.add(selector)
      else if (!inReduced && !none) animated.add(selector)
    }
  })
  if ([...reduced].some((selector) => selector.includes('*'))) return []
  return [...animated].filter((selector) => !reduced.has(selector))
}

function checkCss(file, items, add) {
  walkCss(items, (item) => {
    if (item.type !== 'decl' || item.prop.startsWith('--f404-')) return
    const value = item.value.replace(/url\([^)]*\)/gi, '')
    if (HEX.test(value) || COLOR_FN.test(value) || (item.prop.startsWith('--') && NAMED.test(value))) {
      add(file, 1, 'color-literal', `${item.prop}: ${item.value} uses a literal color. Only --f404-* role definitions may hold literal colors.`)
    } else if (COLOR_PROPERTIES.has(item.prop) && !/var\(/.test(value) && !KEYWORD.test(value.trim())) {
      add(file, 1, 'color-literal', `${item.prop}: ${item.value} must come from a token, such as var(--f404-ink).`)
    } else if (COLOR_SHORTHANDS.test(item.prop) && NAMED.test(value)) {
      add(file, 1, 'color-literal', `${item.prop}: ${item.value} names a color. Use a var(--f404-<role>) token.`)
    }
  })
  for (const selector of unguardedAnimations(items)) {
    add(file, 1, 'motion-reduced', `${selector} animates, but no @media (prefers-reduced-motion: reduce) rule sets its animation to none.`)
  }
}

function checkErrorProp(file, ast, scan, add) {
  const expected = atLeast(scan.next, 16, 3) ? 'retry' : 'reset'
  const param = unwrap(defaultExportNode(ast))?.params?.[0]
  const keys = param?.type === 'ObjectPattern' ? param.properties.map((property) => property.key?.name).filter(Boolean) : []
  if (!keys.includes(expected)) add(file, 1, 'error-prop', `Next.js ${scan.next.version} passes \`${expected}\` to error boundaries; take it from the props and pass it on as retry.`)
}

function checkMissingRoute(file, ast, scan, add) {
  const fn = unwrap(defaultExportNode(ast))
  const notFoundNames = new Set([...importBindings(ast)].filter(([, binding]) => binding.source === 'next/navigation' && binding.imported === 'notFound').map(([local]) => local))
  const body = fn?.body?.type === 'BlockStatement' ? fn.body.body : []
  const unconditional = body.some(
    (statement) => statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression' && statement.expression.callee.type === 'Identifier' && notFoundNames.has(statement.expression.callee.name),
  )
  if (!unconditional || (fn?.params?.length ?? 0) > 0) {
    add(file, 1, 'missing-route-static', 'The rewrite target must call notFound() unconditionally and take no params, so it is prerendered as a static 404.')
  }
  if (scan.config.cacheComponents === true && atLeast(scan.next, 16, 3)) {
    const local = exportBindings(ast).get('instant')
    const node = typeof local === 'string' ? topLevelBindings(ast).get(local) : null
    if (literalValue(node) !== false) add(file, 1, 'missing-route-static', 'With Cache Components on Next.js 16.3+, export const instant = false here, or dev logs an instant-validation error.')
  }
}

/** The scan leaves /fallback404-missing unrouted under a root loading file; a page there would answer 200, so flag any. */
async function checkUnroutedTarget(root, scan, add) {
  const dir = `${scan.appDir}/fallback404-missing`
  const proxies = (scan.findings ?? []).filter((finding) => finding.proposal?.type === 'proxy')
  if (proxies.length === 0 || proxies.some((finding) => finding.proposal.files?.some((file) => file.startsWith(`${dir}/`)))) return
  for (const file of await walk(root, dir)) {
    add(
      file,
      1,
      'missing-route-unrouted',
      `Delete ${dir}/: a loading file at the root of ${scan.appDir}/ streams before this page, so it can answer HTTP 200. With no route there, the proxy rewrite gets Next.js's own 404.`,
    )
  }
}

// Next.js 16.3+ `next dev` upserts these managed blocks into AGENTS.md (or a CLAUDE.md alone) unless next.config sets agentRules: false.
const NEXT_AGENT_BLOCKS = [
  ['<!-- BEGIN:nextjs-agent-rules -->', '<!-- END:nextjs-agent-rules -->'],
  ['<!-- BEGIN:nextjs-agent-feedback -->', '<!-- END:nextjs-agent-feedback -->'],
  ['<!-- NEXT-AGENTS-MD-START -->', '<!-- NEXT-AGENTS-MD-END -->'],
]

function withoutNextBlocks(text) {
  let rest = text
  for (const [start, end] of NEXT_AGENT_BLOCKS) {
    for (let from = rest.indexOf(start); from !== -1; from = rest.indexOf(start)) {
      const to = rest.indexOf(end, from)
      if (to === -1) break
      rest = rest.slice(0, from) + rest.slice(to + end.length)
    }
  }
  return rest.replace(/\s+/g, ' ').trim()
}

/** True for files the app's own tools rewrite while the skill runs them: next dev and next build, and tsc. */
async function toolchainWrote(root, path) {
  if (path === 'next-env.d.ts' || path.endsWith('.tsbuildinfo')) return true
  if (path !== 'AGENTS.md' && path !== 'CLAUDE.md') return false
  const now = await readText(root, path)
  if (now === null) return false
  const before = await git(root, ['show', `HEAD:./${path}`]).catch(() => '')
  // Next.js 16.3's next dev scaffolds CLAUDE.md as a pointer to AGENTS.md when neither file exists.
  if (path === 'CLAUDE.md' && before === '' && now === '@AGENTS.md\n') return true
  return withoutNextBlocks(now) === withoutNextBlocks(before)
}

async function checkScope(root, scan, plan, owned, add, warnings) {
  if (!(await isGitRepo(root))) {
    warnings.push('Not a git repository, so the write-scope rule was skipped.')
    return
  }
  const baseline = new Set((await readJsonIfExists(workspacePath(root, 'baseline.json')))?.paths ?? [])
  const allowed = new Set([...owned, ...(plan.userFiles ?? [])])
  const toolchain = []
  for (const path of await changedPaths(root)) {
    if (baseline.has(path) || allowed.has(path) || path.startsWith(`${scan.componentsDir}/`)) continue
    if (await toolchainWrote(root, path)) {
      toolchain.push(path)
      continue
    }
    add(path, 1, 'write-scope', `${path} changed but is neither a Fallback404 file nor an approved user file. Revert it, or add it to "userFiles" in .fallback404/plan.json once the user approves the change.`)
  }
  if (toolchain.length > 0) {
    warnings.push(
      `${toolchain.join(', ')} changed because Fallback404 ran the app's own tools (next dev writes its block in AGENTS.md or CLAUDE.md, and may create both; next and tsc write next-env.d.ts and *.tsbuildinfo). These are not Fallback404 changes: tell the user, and leave them as they are.`,
    )
  }
}

/** A scene composed from the site's components is decorative: hidden from assistive tech, the message lives in real text. */
function checkArt(file, ast, add) {
  traverse(ast.program, (node) => {
    if (node.type !== 'JSXOpeningElement' || !jsxAttribute(node, 'data-f404-art')) return
    const hidden = jsxAttributeValue(jsxAttribute(node, 'aria-hidden'))
    if (hidden !== true && hidden !== 'true') add(file, lineOf(node), 'decorative-aria-hidden', 'Add aria-hidden="true" next to data-f404-art: the scene is decorative, and the message lives in real text.')
  })
}

/** Every approved section fix needs its design; the router shows it on the root not-found page (spec section 8.2). */
async function checkSectionFlows(root, scan, plan, add, warnings) {
  const findings = new Map((scan.findings ?? []).map((finding) => [finding.id, finding]))
  const approved = new Set(plan.approved ?? [])
  const sections = (plan.flows ?? []).filter((flow) => approved.has(flow.rowId) && isSectionFix(findings.get(flow.rowId)))
  for (const flow of sections) {
    const file = componentFile(scan, flow.slug, 'not-found')
    if ((await readText(root, file)) === null) add(file, 1, 'section-flow', `The fixed section ${flow.route} needs its design in ${file}: promote the picked option there.`)
  }
  const rootDesign = componentFile(scan, ROOT_NOT_FOUND, 'not-found')
  if (sections.length > 0 && (await readText(root, rootDesign)) === null) {
    warnings.push(`Fixed sections answer a real 404 but show the site's own root 404 page: there is no ${rootDesign}, so there is no router. Tell the user.`)
  }
}

export async function runChecks(root) {
  const scan = await readJsonIfExists(workspacePath(root, 'scan.json'))
  if (!scan) throw new CliError('no_scan', 'Run scan.mjs first: .fallback404/scan.json is missing.')
  const plan = (await readJsonIfExists(workspacePath(root, 'plan.json'))) ?? {}
  const owned = (await readJsonIfExists(workspacePath(root, 'owned.json')))?.files ?? []
  const violations = []
  const warnings = []
  const add = (file, line, rule, message) => violations.push({ file, line, rule, message })
  const cssFile = `${scan.componentsDir}/fallback404.css`
  const componentFiles = await walk(root, scan.componentsDir)
  let css = ''
  const cssItems = []
  for (const file of componentFiles.filter((path) => path.endsWith('.css')).sort()) {
    const text = (await readText(root, file)) ?? ''
    const items = parseCss(text)
    checkCss(file, items, add)
    css += `${text}\n`
    cssItems.push(...items)
  }
  const files = [...new Set([...componentFiles, ...owned])].sort()
  for (const file of files) {
    if (!isCodeFile(file)) continue
    const source = await readText(root, file)
    if (source === null) continue
    let ast
    try {
      ast = parseSource(source, file)
    } catch (error) {
      add(file, 1, 'parse', `${file} does not parse: ${String(error.message).split('\n')[0]}`)
      continue
    }
    // The site's own page, kept and moved here unchanged (changes.md): the user's code, not Fallback404's output.
    if (source.startsWith(MOVED_MARKER)) continue
    const kind = pathKind(file, scan)
    if (kind.visual) {
      checkSvg(file, ast, add)
      checkCopy(file, ast, add)
      checkArt(file, ast, add)
    }
    if (kind.component && !kind.copy) checkColorsInCode(file, ast, add)
    if (kind.state && !hasElement(ast, 'h1')) add(file, 1, 'state-h1', 'Not-found and error screens need a real <h1> with the message.')
    if (kind.loader) {
      checkLoader(file, ast, add)
      checkLoaderBox(file, source, cssFile, cssItems, add)
      await checkLoaderBudget(root, file, source, css, ast, add)
    }
    const wrapper = wrapperKind(file, scan)
    if ((kind.clientState || ['error', 'global-error', 'preview-client'].includes(wrapper)) && !hasDirective(ast, 'use client')) {
      add(file, 1, 'client-directive', `${file} must start with 'use client': error boundaries and their screens are Client Components.`)
    }
    if (wrapper === 'error' || wrapper === 'global-error') checkErrorProp(file, ast, scan, add)
    if (wrapper === 'global-error' && !(hasElement(ast, 'html') && hasElement(ast, 'body'))) {
      add(file, 1, 'global-error-document', 'global-error replaces the root layout, so it must render <html> and <body>.')
    }
    if (wrapper === 'missing') checkMissingRoute(file, ast, scan, add)
    if (wrapper === 'preview' && !(/process\.env\.NODE_ENV\s*===\s*['"]production['"]/.test(source) && /notFound\(\)/.test(source))) {
      add(file, 1, 'preview-prod-404', 'The preview page must call notFound() when NODE_ENV is production, so it is a 404 in production.')
    }
  }
  await checkUnroutedTarget(root, scan, add)
  await checkSectionFlows(root, scan, plan, add, warnings)
  await checkScope(root, scan, plan, owned, add, warnings)
  return { ok: violations.length === 0, violations, warnings }
}

export async function main({ flags }) {
  return runChecks(resolve(stringFlag(flags, 'root', '.')))
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
