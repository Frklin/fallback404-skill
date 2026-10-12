#!/usr/bin/env node
// Fallback404 bake: turns a role SVG (colors written as var(--f404-<role>)) into light and dark SVGs with the brand's
// hex colors, optionally with a house-style motion preset, and checks them against the picker's upload rules first.
// Usage: node bake.mjs <role.svg> --kit <brand-kit.json> --out <dir> [--motion <preset>] [--name <base>] [--root <dir>]
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { CliError, isMain, requireString, runCli, stringFlag } from './lib/cli.mjs'
import { readJson, writeTextInside } from './lib/fs.mjs'
import { svgProblem } from './lib/svg-subset.mjs'

export const ROLES = ['bg', 'surface', 'ink', 'muted', 'line', 'accent', 'accent-2', 'on-accent']
const HOUSE_STYLE = new URL('../house-style/', import.meta.url)
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i
const USAGE = 'Usage: node bake.mjs <role.svg> --kit <brand-kit.json> --out <dir> [--motion <preset>] [--name <base>] [--root <dir>]'

/** The CSS of a house-style motion preset, by id. */
export async function motionCss(id) {
  const index = JSON.parse(await readFile(new URL('index.json', HOUSE_STYLE), 'utf8'))
  const preset = index.motion.find((entry) => entry.id === id)
  if (!preset) throw new CliError('bad_args', `Unknown motion preset "${id}". Presets: ${index.motion.map((entry) => entry.id).join(', ')}.`)
  return readFile(new URL(preset.file, HOUSE_STYLE), 'utf8')
}

/** One theme of a role SVG: motion CSS added, roles replaced by hex, then checked against the picker's upload rules. */
export function bakeSvg(svg, kit, theme, motion = null) {
  let out = svg.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (motion) {
    out = out.replace(/<svg\b([^>]*?)(\/?)>/, (whole, attributes, selfClosing) => {
      if (selfClosing) return whole
      const withClass = /\sclass\s*=\s*"/.test(attributes)
        ? attributes.replace(/\sclass\s*=\s*"([^"]*)"/, (match, classes) => ` class="${classes} f404-anim-${motion.id}"`)
        : `${attributes} class="f404-anim-${motion.id}"`
      return `<svg${withClass}><style>${motion.css.trim()}</style>`
    })
  }
  out = out.replace(/var\(\s*--f404-([a-z0-9-]+)\s*(?:,[^)]*)?\)/g, (whole, role) => {
    if (!ROLES.includes(role)) throw new CliError('bad_svg', `var(--f404-${role}) is not a role. Roles: ${ROLES.join(', ')}.`)
    const color = kit?.roles?.[role]?.[theme]
    if (typeof color !== 'string' || !HEX.test(color)) throw new CliError('bad_kit', `brand-kit.json has no ${theme} hex color for the role "${role}".`)
    return color
  })
  if (/var\(/.test(out)) throw new CliError('bad_svg', 'Role SVGs may only use var(--f404-<role>) colors; bake found another var().')
  const problem = svgProblem(out)
  if (problem) throw new CliError('bad_svg', `The baked ${theme} SVG would be rejected by the picker: ${problem}.`)
  return out
}

export async function main({ command, positionals, flags }) {
  const input = command ?? positionals[0]
  if (!input) throw new CliError('bad_args', `Missing the role SVG.\n${USAGE}`)
  const name = stringFlag(flags, 'name', basename(input).replace(/\.svg$/i, ''))
  if (!/^[\w.-]+$/.test(name)) throw new CliError('bad_args', `--name may only use letters, digits, ".", "_" and "-".\n${USAGE}`)
  const kit = await readJson(resolve(requireString(flags, 'kit', USAGE)))
  const root = resolve(stringFlag(flags, 'root', '.'))
  const out = resolve(requireString(flags, 'out', USAGE))
  const motionId = stringFlag(flags, 'motion', null)
  const motion = motionId ? { id: motionId, css: await motionCss(motionId) } : null
  const svg = await readFile(resolve(input), 'utf8')
  const result = { light: null, dark: null, bytes: {} }
  for (const theme of ['light', 'dark']) {
    const baked = bakeSvg(svg, kit, theme, motion)
    const file = join(out, `${name}-${theme}.svg`)
    await writeTextInside(root, file, baked)
    result[theme] = file
    result.bytes[theme] = Buffer.byteLength(baked)
  }
  return result
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
