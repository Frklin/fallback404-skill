// The App Router route tree, read from folder and file names alone.

export const SPECIAL_FILES = ['page', 'layout', 'loading', 'not-found', 'error', 'global-error', 'global-not-found', 'template', 'default', 'route']
const DYNAMIC = new Set(['dynamic', 'catch-all', 'optional-catch-all'])
const NOT_A_URL = new Set(['private', 'slot', 'intercept'])

/** What a folder name means to the router. */
export function segmentKind(name) {
  if (name.startsWith('_')) return 'private'
  if (name.startsWith('@')) return 'slot'
  if (/^\(\.{1,3}\)./.test(name)) return 'intercept'
  if (/^\(.+\)$/.test(name)) return 'group'
  if (/^\[\[\.\.\..+\]\]$/.test(name)) return 'optional-catch-all'
  if (/^\[\.\.\..+\]$/.test(name)) return 'catch-all'
  if (/^\[.+\]$/.test(name)) return 'dynamic'
  return 'static'
}

/** URL path of a segment folder: route groups drop out, everything else stays as written. */
export function routeForDir(appDir, dir) {
  if (dir === appDir) return '/'
  const parts = dir.slice(appDir.length + 1).split('/').filter((part) => segmentKind(part) !== 'group')
  return `/${parts.join('/')}`
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Segments and page routes from the files under appDir (repo-relative paths). Private folders, parallel-route slots
 * and intercepting routes are skipped: they are not URLs of their own.
 */
export function buildRoutes(appDir, files, pageExtensions) {
  const extension = new RegExp(`\\.(?:${pageExtensions.map(escapeRegExp).join('|')})$`)
  const segments = new Map()
  for (const file of files) {
    if (!file.startsWith(`${appDir}/`)) continue
    const parts = file.slice(appDir.length + 1).split('/')
    const base = parts.pop()
    if (parts.some((part) => NOT_A_URL.has(segmentKind(part))) || !extension.test(base)) continue
    const name = base.replace(extension, '')
    if (!SPECIAL_FILES.includes(name)) continue
    const dir = parts.length > 0 ? `${appDir}/${parts.join('/')}` : appDir
    if (!segments.has(dir)) segments.set(dir, { dir, special: {} })
    segments.get(dir).special[name] ??= file
  }
  const routes = []
  for (const segment of [...segments.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))) {
    if (!segment.special.page) continue
    const parts = segment.dir === appDir ? [] : segment.dir.slice(appDir.length + 1).split('/')
    routes.push({
      route: routeForDir(appDir, segment.dir),
      dir: segment.dir,
      page: segment.special.page,
      dynamic: parts.some((part) => DYNAMIC.has(segmentKind(part))),
      chain: [appDir, ...parts.map((_, index) => `${appDir}/${parts.slice(0, index + 1).join('/')}`)],
    })
  }
  return { segments, routes, rootLayout: segments.get(appDir)?.special.layout ?? null }
}

/** True when a route pattern, as routeForDir writes it, catches the concrete URL path. */
export function matchesPath(route, path) {
  const pattern = route.split('/').filter(Boolean)
  const parts = path.split('/').filter(Boolean)
  for (let i = 0; i < pattern.length; i++) {
    const kind = segmentKind(pattern[i])
    if (kind === 'optional-catch-all') return true
    if (kind === 'catch-all') return parts.length > i
    if (i >= parts.length || (kind !== 'dynamic' && pattern[i] !== parts[i])) return false
  }
  return pattern.length === parts.length
}

/** The closest special file called `name` along a route's folder chain, searching from the page up. */
export function nearest(segments, chain, name) {
  for (let i = chain.length - 1; i >= 0; i--) {
    const file = segments.get(chain[i])?.special[name]
    if (file) return file
  }
  return null
}
