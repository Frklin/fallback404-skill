// Color roles for the generated pages: eight roles mapped to the site's own tokens where it has them, with readable
// literal fallbacks where it has none, and the shared fallback404.css. Written by identity.mjs --write; never by hand.
import { BARE_HSL, contrastRatio, mix, opaque, readableOn } from './color.mjs'

export const ROLE_NAMES = ['bg', 'surface', 'ink', 'muted', 'line', 'accent', 'accent-2', 'on-accent']
const MIN_CONTRAST = 4.5

// Candidate token names per role, most specific first. Tailwind v4 themes expose --color-<name>; shadcn uses bare names.
const CANDIDATES = {
  bg: ['--background', '--color-background', '--bg', '--color-bg', '--page', '--color-page', '--surface-0'],
  surface: ['--card', '--color-card', '--surface', '--color-surface', '--surface-card', '--color-surface-card', '--muted', '--color-muted', '--secondary', '--color-secondary'],
  ink: ['--foreground', '--color-foreground', '--text', '--color-text', '--ink', '--color-ink', '--on-background'],
  muted: ['--muted-foreground', '--color-muted-foreground', '--foreground-secondary', '--color-foreground-secondary', '--text-muted', '--color-text-muted', '--secondary-foreground', '--color-secondary-foreground'],
  line: ['--border', '--color-border', '--line', '--color-line', '--divider', '--color-divider', '--border-subtle', '--color-border-subtle'],
  accent: ['--primary', '--color-primary', '--brand', '--color-brand', '--accent', '--color-accent'],
  'accent-2': ['--accent', '--color-accent', '--secondary', '--color-secondary', '--brand-2', '--color-brand-2', '--primary', '--color-primary'],
  'on-accent': ['--primary-foreground', '--color-primary-foreground', '--on-primary', '--color-on-primary', '--accent-foreground', '--color-accent-foreground'],
}
const DEFAULTS = {
  bg: ['#ffffff', '#0a0a0a'],
  ink: ['#0a0a0a', '#fafafa'],
  accent: ['#2563eb', '#60a5fa'],
}

/** The first candidate token that resolves to a hex color in both schemes. */
function findToken(tokens, role, taken) {
  for (const name of CANDIDATES[role]) {
    if (taken.has(name)) continue
    const light = opaque(tokens.light?.[name]?.hex)
    const dark = opaque(tokens.dark?.[name]?.hex ?? tokens.light?.[name]?.hex)
    if (!light || !dark) continue
    // A bare "h s% l%" token is not a color by itself: the site uses it as hsl(var(--x)), and so must the roles.
    const bare = BARE_HSL.test(String(tokens.light?.[name]?.value ?? '').trim())
    return { token: name, ...(bare ? { wrap: 'hsl' } : {}), light, dark }
  }
  return null
}

/** Pushes `hex` away from `bg` toward black or white, in steps, until the ratio holds. */
function enforce(hex, bg) {
  if (contrastRatio(hex, bg) >= MIN_CONTRAST) return hex
  const target = readableOn(bg)
  for (let t = 0.1; t <= 1; t += 0.1) {
    const candidate = mix(hex, target, t)
    if (contrastRatio(candidate, bg) >= MIN_CONTRAST) return candidate
  }
  return target
}

/** The eight roles from identity.json tokens, with literal fallbacks and the contrast rules applied. */
export function pickRoles(identity) {
  const tokens = identity.tokens ?? { light: {}, dark: {} }
  const roles = {}
  const taken = new Set()
  for (const role of ROLE_NAMES) {
    const found = findToken(tokens, role, taken)
    if (!found) continue
    // accent-2 may share the accent token; everything else is distinct.
    if (role !== 'accent-2') taken.add(found.token)
    roles[role] = found
  }
  const bg = roles.bg ?? { token: null, light: DEFAULTS.bg[0], dark: DEFAULTS.bg[1] }
  const ink = roles.ink ?? { token: null, light: DEFAULTS.ink[0], dark: DEFAULTS.ink[1] }
  const accent = roles.accent ?? { token: null, light: DEFAULTS.accent[0], dark: DEFAULTS.accent[1] }
  const derived = {
    bg,
    ink,
    accent,
    surface: roles.surface ?? { token: null, light: mix(bg.light, ink.light, 0.04), dark: mix(bg.dark, ink.dark, 0.06) },
    muted: roles.muted ?? { token: null, light: mix(ink.light, bg.light, 0.4), dark: mix(ink.dark, bg.dark, 0.35) },
    line: roles.line ?? { token: null, light: mix(bg.light, ink.light, 0.12), dark: mix(bg.dark, ink.dark, 0.16) },
    'accent-2': roles['accent-2'] ?? { token: null, light: mix(accent.light, ink.light, 0.3), dark: mix(accent.dark, bg.dark, 0.3) },
    'on-accent': roles['on-accent'] ?? { token: null, light: readableOn(accent.light), dark: readableOn(accent.dark) },
  }
  const adjusted = []
  // Text on the action snaps to white or black: a gray mixed toward contrast reads wrong on a button. Page text keeps its hue.
  const fix = (role, against, label, { snap = false } = {}) => {
    const settle = (hex, bg) => (snap && contrastRatio(hex, bg) < MIN_CONTRAST ? readableOn(bg) : enforce(hex, bg))
    const light = settle(derived[role].light, derived[against].light)
    const dark = settle(derived[role].dark, derived[against].dark)
    if (light === derived[role].light && dark === derived[role].dark) return
    adjusted.push(`${role} (${label}): ${derived[role].token ?? 'the default'} gave ${derived[role].light} / ${derived[role].dark}, now ${light} / ${dark} for 4.5:1 on ${against}.`)
    derived[role] = { token: null, light, dark }
  }
  fix('ink', 'bg', 'text on the page')
  fix('muted', 'bg', 'secondary text on the page')
  fix('on-accent', 'accent', 'text on the action', { snap: true })
  return { roles: Object.fromEntries(ROLE_NAMES.map((name) => [name, derived[name]])), adjusted }
}

/** brand-kit.json, schema 2: what reference/writing.md documents, written by the script. */
export function renderBrandKit(identity, roles) {
  const font = identity.fonts?.find((item) => item.variable)?.variable ?? null
  const fontValue = font ? `var(${font})` : 'system-ui, sans-serif'
  const purpose = identity.readme ? (identity.readme.split('\n').map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('#')) ?? null) : null
  return {
    schema: 2,
    name: identity.name ?? null,
    purpose,
    lang: identity.lang ?? 'en',
    logo: identity.logos?.[0] ? { file: identity.logos[0].file } : null,
    fonts: { heading: fontValue, body: fontValue },
    radius: identity.radius ? 'var(--radius)' : null,
    darkMode: identity.darkMode ?? { strategy: 'none' },
    roles,
  }
}

function darkBlock(darkMode, declarations) {
  if (declarations.length === 0) return []
  const inner = declarations.map((line) => `  ${line}`)
  if (darkMode?.strategy === 'media') return ['@media (prefers-color-scheme: dark) {', '  :root {', ...inner.map((line) => `  ${line}`), '  }', '}', '']
  if (darkMode?.strategy === 'class') return [`.${darkMode.value ?? 'dark'} {`, ...inner, '}', '']
  if (darkMode?.strategy === 'attribute') return [`[${darkMode.attribute ?? 'data-theme'}="${darkMode.value ?? 'dark'}"] {`, ...inner, '}', '']
  return []
}

/** The shared stylesheet: role tokens, the layout classes every flow may use, and the motion presets with reduced-motion. */
export function renderFallbackCss(roles, darkMode, fonts = []) {
  const font = fonts.find((item) => item.variable)?.variable
  const family = font ? `var(${font}), system-ui, sans-serif` : 'system-ui, sans-serif'
  const reference = (role) => (role.wrap === 'hsl' ? `hsl(var(${role.token}))` : `var(${role.token})`)
  const light = ROLE_NAMES.map((name) => `  --f404-${name}: ${roles[name].token ? reference(roles[name]) : roles[name].light};`)
  const dark = ROLE_NAMES.filter((name) => !roles[name].token).map((name) => `--f404-${name}: ${roles[name].dark};`)
  return [
    '/* Fallback404: role tokens, shared layout and motion for the generated flows. Generated by identity.mjs; do not edit. */',
    ':root {',
    ...light,
    '}',
    '',
    ...darkBlock(darkMode, dark),
    '.f404-screen {',
    '  display: grid;',
    '  justify-items: center;',
    '  gap: 0.75rem;',
    '  padding: 4rem 1.5rem;',
    '  text-align: center;',
    '  color: var(--f404-ink);',
    '  background: var(--f404-bg);',
    `  font-family: ${family};`,
    '}',
    '',
    '.f404-art {',
    '  display: flex;',
    '  justify-content: center;',
    '  gap: 0.5rem;',
    '  max-block-size: 240px;',
    '}',
    '',
    '.f404-title {',
    '  margin: 0;',
    '  font-size: clamp(1.75rem, 4vw, 2.5rem);',
    '  line-height: 1.15;',
    '}',
    '',
    '.f404-body {',
    '  margin: 0;',
    '  max-inline-size: 36rem;',
    '  color: var(--f404-muted);',
    '}',
    '',
    '.f404-action {',
    '  margin-top: 0.5rem;',
    '  padding: 0.625rem 1.125rem;',
    '  border: 0;',
    '  border-radius: 999px;',
    '  background: var(--f404-accent);',
    '  color: var(--f404-on-accent);',
    '  font: inherit;',
    '  text-decoration: none;',
    '  cursor: pointer;',
    '}',
    '',
    '.f404-action:focus-visible {',
    '  outline: 3px solid var(--f404-accent-2);',
    '  outline-offset: 3px;',
    '}',
    '',
    '.f404-loader {',
    '  display: grid;',
    '  place-items: center;',
    '  min-block-size: 50vh;',
    '}',
    '',
    '.f404-loader-inline {',
    '  min-block-size: 6rem;',
    '}',
    '',
    '.f404-visually-hidden {',
    '  position: absolute;',
    '  inline-size: 1px;',
    '  block-size: 1px;',
    '  overflow: hidden;',
    '  clip-path: inset(50%);',
    '  white-space: nowrap;',
    '}',
    '',
    '.f404-anim-bounce [data-part="body"] {',
    '  transform-box: fill-box;',
    '  transform-origin: 50% 100%;',
    '  animation: f404-bounce 1.4s ease-in-out infinite;',
    '}',
    '',
    '.f404-anim-pulse [data-part="body"] {',
    '  transform-box: fill-box;',
    '  transform-origin: 50% 50%;',
    '  animation: f404-pulse 1.2s ease-in-out infinite;',
    '}',
    '',
    '@keyframes f404-bounce {',
    '  0%,',
    '  100% {',
    '    transform: translateY(0);',
    '  }',
    '  50% {',
    '    transform: translateY(-8%);',
    '  }',
    '}',
    '',
    '@keyframes f404-pulse {',
    '  0%,',
    '  100% {',
    '    opacity: 1;',
    '    transform: scale(1);',
    '  }',
    '  50% {',
    '    opacity: 0.7;',
    '    transform: scale(0.94);',
    '  }',
    '}',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    '  .f404-anim-bounce [data-part="body"],',
    '  .f404-anim-pulse [data-part="body"] {',
    '    animation: none;',
    '  }',
    '}',
    '',
  ].join('\n')
}
