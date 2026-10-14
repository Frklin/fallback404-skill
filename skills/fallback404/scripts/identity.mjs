#!/usr/bin/env node
// Fallback404 identity reader: logo files, color tokens in light and dark, the dark-mode switch, fonts, language, name
// and copy samples, read from the repo without running it. With --write it also turns the result into brand-kit.json
// (eight color roles, checked for contrast). --css writes the shared <componentsDir>/fallback404.css from that kit: it
// lands in the repo, so branch.mjs create runs it once the branch exists. Nobody writes either by hand.
// Usage: node identity.mjs [--write] [--out <file>] [--root <dir>] | --css [--root <dir>]
import { readFile } from 'node:fs/promises'
import { join, posix, relative, resolve } from 'node:path'
import {
  UNKNOWN,
  exportBindings,
  importBindings,
  importSources,
  jsxAttribute,
  jsxAttributeValue,
  jsxName,
  literalValue,
  objectEntries,
  parseSource,
  topLevelBindings,
  traverse,
  unwrap,
} from './lib/ast.mjs'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { toHex } from './lib/color.mjs'
import { extractTokens, resolveValue } from './lib/css.mjs'
import { exists, readJsonIfExists, readText, walk, workspacePath, writeJsonInside, writeTextInside } from './lib/fs.mjs'
import { specifierPath } from './lib/modules.mjs'
import { exportedConfigObject } from './lib/next-config.mjs'
import { loadProject } from './lib/project.mjs'
import { pickRoles, renderBrandKit, renderFallbackCss } from './lib/roles.mjs'

const CODE_EXTENSIONS = ['tsx', 'jsx', 'ts', 'js']
const IMAGE = /\.(?:svg|png|webp|jpe?g|gif|avif|ico)$/i
const LOGO_NAME = /(?:^|[-_.\s])(?:logo|logomark|logotype|wordmark|brand|mark)(?:[-_.\s]|$)/i
const MAX_CSS_FILES = 20

async function parseFile(root, file, warnings) {
  const source = await readText(root, file, { warnings })
  if (source === null) return null
  try {
    return parseSource(source, file)
  } catch {
    warnings.push(`${file} could not be parsed.`)
    return null
  }
}

async function firstExisting(root, candidates) {
  for (const file of candidates) if (await exists(root, file)) return file
  return null
}

/** The CSS the root layout imports, plus local @import chains, with tokens merged across files. */
async function readTokens(root, layoutFile, layout, paths, warnings) {
  const queue = importSources(layout)
    .filter((spec) => spec.endsWith('.css'))
    .map((spec) => specifierPath(layoutFile, spec, paths))
    .filter(Boolean)
  const css = []
  const tokens = { light: {}, dark: {}, theme: {} }
  const darkModes = []
  for (let index = 0; index < queue.length && css.length < MAX_CSS_FILES; index++) {
    const file = queue[index]
    if (css.includes(file)) continue
    const text = await readText(root, file, { warnings })
    if (text === null) continue
    css.push(file)
    const found = extractTokens(text)
    Object.assign(tokens.light, found.light)
    Object.assign(tokens.dark, found.dark)
    Object.assign(tokens.theme, found.theme)
    for (const mode of found.darkModes) if (!darkModes.some((known) => JSON.stringify(known) === JSON.stringify(mode))) darkModes.push(mode)
    for (const spec of found.imports) {
      const target = specifierPath(file, spec, paths)
      if (target?.endsWith('.css')) queue.push(target)
    }
  }
  return { css, tokens, darkModes }
}

/** Tokens with their raw value and hex color per scheme; non-color tokens are kept only for radius and fonts. */
export function resolveTokens({ light, dark, theme }) {
  const out = { light: {}, dark: {} }
  for (const name of [...new Set([...Object.keys(theme), ...Object.keys(light), ...Object.keys(dark)])].sort()) {
    const lightRaw = light[name] ?? theme[name]
    const darkRaw = dark[name] ?? lightRaw
    const lightHex = lightRaw === undefined ? null : toHex(resolveValue(lightRaw, [light, theme]))
    const darkHex = darkRaw === undefined ? null : toHex(resolveValue(darkRaw, [dark, light, theme]))
    if (lightHex === null && darkHex === null && !/radius|font/.test(name)) continue
    if (lightRaw !== undefined) out.light[name] = { value: lightRaw, hex: lightHex }
    if (darkRaw !== undefined) out.dark[name] = { value: darkRaw, hex: darkHex }
  }
  return out
}

/** next-themes decides dark mode when installed: its ThemeProvider `attribute` prop, defaulting to data-theme. */
async function nextThemesMode(root, project, warnings) {
  const deps = { ...project.pkg.dependencies, ...project.pkg.devDependencies }
  if (!deps['next-themes']) return null
  for (const folder of [project.appDir, project.srcDir ? 'src/components' : 'components']) {
    const files = (await walk(root, folder, { warnings, limits: { maxFiles: 400, maxBytes: 256 * 1024 } })).filter((file) => /\.[jt]sx$/.test(file))
    for (const file of files) {
      const ast = await parseFile(root, file, [])
      if (!ast) continue
      const providers = new Set([...importBindings(ast)].filter(([, binding]) => binding.source === 'next-themes' && binding.imported === 'ThemeProvider').map(([local]) => local))
      if (providers.size === 0) continue
      let attribute
      traverse(ast.program, (node) => {
        if (attribute !== undefined || node.type !== 'JSXOpeningElement' || !providers.has(jsxName(node.name))) return
        const value = jsxAttributeValue(jsxAttribute(node, 'attribute'))
        attribute = value === undefined ? 'data-theme' : typeof value === 'string' ? value : null
      })
      if (attribute === undefined) continue
      if (attribute === 'class') return { strategy: 'class', value: 'dark', source: 'next-themes' }
      if (attribute) return { strategy: 'attribute', attribute, value: 'dark', source: 'next-themes' }
      return { strategy: 'class', value: 'dark', source: 'next-themes', note: 'The ThemeProvider attribute is not a literal; class is assumed.' }
    }
  }
  return { strategy: 'attribute', attribute: 'data-theme', value: 'dark', source: 'next-themes', note: 'No ThemeProvider found; next-themes defaults to data-theme.' }
}

function chooseDarkMode(darkModes) {
  for (const strategy of ['class', 'attribute', 'media']) {
    const mode = darkModes.find((item) => item.strategy === strategy)
    if (mode) return { ...mode, source: 'css' }
  }
  return { strategy: 'none' }
}

async function dimensions(root, file) {
  if (/\.svg$/i.test(file)) {
    const tag = (await readText(root, file))?.match(/<svg\b[^>]*>/i)?.[0] ?? ''
    const attr = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1]
    const box = attr('viewBox')?.split(/[\s,]+/).map(Number)
    const width = parseFloat(attr('width')) || box?.[2]
    const height = parseFloat(attr('height')) || box?.[3]
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {}
  }
  if (/\.png$/i.test(file)) {
    const bytes = await readFile(join(root, file)).catch(() => null)
    if (bytes && bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  return {}
}

/** App icons, image files named like a logo, and *Logo* components, icons first. */
async function findLogos(root, project, warnings) {
  const found = new Map()
  const add = async (file, kind) => {
    if (!found.has(file)) found.set(file, { file, kind, ...(await dimensions(root, file)) })
  }
  for (const folder of ['public', project.appDir, ...(project.srcDir ? ['src'] : [])]) {
    for (const file of await walk(root, folder, { warnings })) {
      const base = posix.basename(file)
      if (!IMAGE.test(base)) continue
      const stem = base.replace(IMAGE, '')
      if (posix.dirname(file) === project.appDir && /^(?:icon|apple-icon|favicon)$/i.test(stem)) await add(file, 'icon')
      else if (/^favicon$/i.test(stem)) await add(file, 'icon')
      else if (LOGO_NAME.test(stem)) await add(file, 'image')
    }
  }
  for (const folder of [project.srcDir ? 'src/components' : 'components', project.appDir]) {
    for (const file of await walk(root, folder, { warnings })) if (/logo/i.test(posix.basename(file)) && /\.[jt]sx$/.test(file)) await add(file, 'component')
  }
  const order = { icon: 0, image: 1, component: 2 }
  return [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || (a.file < b.file ? -1 : 1))
}

function fonts(ast) {
  if (!ast) return []
  const imports = importBindings(ast)
  const out = []
  for (const [binding, init] of topLevelBindings(ast)) {
    const call = unwrap(init)
    if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') continue
    const source = imports.get(call.callee.name)
    if (!source?.source.startsWith('next/font/')) continue
    const options = call.arguments[0] ? objectEntries(call.arguments[0]).entries : new Map()
    const variable = options.has('variable') ? literalValue(options.get('variable')) : null
    out.push({ binding, family: source.imported === 'default' ? call.callee.name : source.imported, source: source.source, variable: typeof variable === 'string' ? variable : null })
  }
  return out
}

function htmlLang(ast) {
  let lang = null
  if (!ast) return lang
  traverse(ast.program, (node) => {
    if (lang !== null || node.type !== 'JSXOpeningElement' || jsxName(node.name) !== 'html') return
    const value = jsxAttributeValue(jsxAttribute(node, 'lang'))
    if (typeof value === 'string') lang = value
  })
  return lang
}

function metadataTitle(ast) {
  if (!ast) return null
  const local = exportBindings(ast).get('metadata')
  const node = typeof local === 'string' ? topLevelBindings(ast).get(local) : null
  if (!node) return null
  const { entries } = objectEntries(node)
  const title = entries.has('title') ? literalValue(entries.get('title')) : UNKNOWN
  if (typeof title === 'string') return title
  if (title && title !== UNKNOWN && typeof title.default === 'string') return title.default
  return null
}

async function readmeHead(root) {
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README']) {
    const text = await readText(root, name)
    if (text !== null) return text.slice(0, 2000)
  }
  return null
}

async function homeText(root, project, warnings) {
  const file = await firstExisting(root, CODE_EXTENSIONS.map((ext) => `${project.appDir}/page.${ext}`))
  const ast = file ? await parseFile(root, file, warnings) : null
  const texts = []
  let total = 0
  if (ast) {
    traverse(ast.program, (node) => {
      if (node.type !== 'JSXText') return
      const text = node.value.replace(/\s+/g, ' ').trim()
      if (text.length < 2 || texts.includes(text) || total + text.length > 2000) return
      texts.push(text)
      total += text.length
    })
  }
  return texts
}

/** Literal colors from tailwind.config.* (Tailwind v3): theme.colors and theme.extend.colors, flattened. */
async function tailwindV3Colors(root, warnings) {
  const file = await firstExisting(root, ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs'])
  const ast = file ? await parseFile(root, file, warnings) : null
  const config = ast ? exportedConfigObject(ast) : null
  if (!config) return null
  const theme = objectEntries(config).entries.get('theme')
  const nodes = []
  if (theme) {
    const entries = objectEntries(theme).entries
    if (entries.has('colors')) nodes.push(entries.get('colors'))
    const extend = entries.has('extend') ? objectEntries(entries.get('extend')).entries : new Map()
    if (extend.has('colors')) nodes.push(extend.get('colors'))
  }
  const out = {}
  const visit = (node, prefix) => {
    const value = unwrap(node)
    if (value?.type === 'StringLiteral') out[prefix] = value.value
    if (value?.type !== 'ObjectExpression') return
    for (const [key, child] of objectEntries(value).entries) visit(child, key === 'DEFAULT' ? prefix : prefix ? `${prefix}-${key}` : key)
  }
  for (const node of nodes) visit(node, '')
  return Object.keys(out).length > 0 ? out : null
}

export async function collectIdentity(root) {
  const warnings = []
  const project = await loadProject(root, warnings)
  if (!project.appDir) throw new CliError('unsupported', 'There is no app/ or src/app/ directory.')
  const layoutFile = await firstExisting(root, CODE_EXTENSIONS.map((ext) => `${project.appDir}/layout.${ext}`))
  const layout = layoutFile ? await parseFile(root, layoutFile, warnings) : null
  const { css, tokens, darkModes } = layout
    ? await readTokens(root, layoutFile, layout, project.paths, warnings)
    : { css: [], tokens: { light: {}, dark: {}, theme: {} }, darkModes: [] }
  return {
    schema: 1,
    name: metadataTitle(layout) ?? project.pkg.name ?? null,
    lang: htmlLang(layout),
    layout: layoutFile,
    css,
    tokens: resolveTokens(tokens),
    darkMode: (await nextThemesMode(root, project, warnings)) ?? chooseDarkMode(darkModes),
    fonts: fonts(layout),
    radius: tokens.light['--radius'] ?? tokens.theme['--radius'] ?? null,
    logos: await findLogos(root, project, warnings),
    readme: await readmeHead(root),
    homeText: await homeText(root, project, warnings),
    tailwindV3Colors: await tailwindV3Colors(root, warnings),
    warnings,
  }
}

/** The font variable the brand kit's body font refers to, as renderFallbackCss expects it. */
const kitFonts = (kit) => {
  const variable = /^var\((--[\w-]+)\)/.exec(kit.fonts?.body ?? '')?.[1] ?? null
  return variable ? [{ variable }] : []
}

/** Writes <componentsDir>/fallback404.css from .fallback404/brand-kit.json; returns the file's repo-relative path. */
export async function writeSharedCss(root) {
  const kit = await readJsonIfExists(workspacePath(root, 'brand-kit.json'))
  if (!kit?.roles) throw new CliError('no_kit', 'Run coverage.mjs run (or identity.mjs --write) first: .fallback404/brand-kit.json is missing.')
  const project = await loadProject(root, [])
  const cssFile = `${project.componentsDir}/fallback404.css`
  await writeTextInside(root, cssFile, renderFallbackCss(kit.roles, kit.darkMode, kitFonts(kit)))
  return cssFile
}

export async function main({ flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  if (flags.css) return { ok: true, wrote: [await writeSharedCss(root)] }
  const identity = await collectIdentity(root)
  const out = resolve(root, stringFlag(flags, 'out', workspacePath(root, 'identity.json')))
  await writeJsonInside(root, out, identity)
  const result = {
    ok: true,
    out: relative(root, out),
    logos: identity.logos.length,
    colorTokens: Object.keys(identity.tokens.light).length,
    darkMode: identity.darkMode.strategy,
    warnings: identity.warnings,
  }
  if (flags.write) {
    const { roles, adjusted } = pickRoles(identity)
    const kitFile = workspacePath(root, 'brand-kit.json')
    await writeJsonInside(root, kitFile, renderBrandKit(identity, roles))
    Object.assign(result, { wrote: [relative(root, kitFile)], adjusted })
  }
  return result
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
