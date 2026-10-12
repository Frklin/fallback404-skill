#!/usr/bin/env node
// Fallback404 writer: the deterministic files (thin route wrappers, global-error, the static 404 route the proxy checks
// rewrite to, and the dev-only preview page), written only where approved and never over files it does not own.
// Usage: node write.mjs wrappers | preview [--root <dir>]
import { lstat, readdir, writeFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { exists, prepareWrite, readJsonIfExists, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { readOwned } from './lib/owned.mjs'
import { atLeast } from './lib/project.mjs'

const USAGE = 'Usage: node write.mjs wrappers | preview [--root <dir>]'
const STATE_WRAPPERS = { 'not-found': 'not-found', loading: 'loading', error: 'error', 'global-error': 'global-error' }

/** Import specifier for a file in the components folder, seen from `fromFile`: the alias when there is one, else relative. */
export function importSpecifier(scan, fromFile, rel) {
  const target = `${scan.componentsDir}/${rel}`
  if (scan.alias) return `${scan.alias}${scan.componentsDir.startsWith('src/') ? target.slice('src/'.length) : target}`
  const spec = posix.relative(posix.dirname(fromFile), target)
  return spec.startsWith('.') ? spec : `./${spec}`
}

/** The error prop Next.js passes to error.js and global-error.js: `retry` from 16.3, `reset` before. */
export const errorProp = (scan) => (atLeast(scan.next, 16, 3) ? 'retry' : 'reset')

function errorSignature(scan) {
  const prop = errorProp(scan)
  return scan.typescript ? `{ error, ${prop} }: { error: Error & { digest?: string }; ${prop}: () => void }` : `{ error, ${prop} }`
}

/** Source of one deterministic file: not-found | loading | error | global-error | missing. */
export function renderWrapper(kind, file, scan, identity = null) {
  const spec = (rel) => importSpecifier(scan, file, rel)
  const prop = errorProp(scan)
  switch (kind) {
    case 'not-found':
      return [`import { NotFound } from '${spec('states/NotFound')}'`, '', 'export default NotFound', ''].join('\n')
    case 'loading':
      return [`import { Loader } from '${spec('states/Loader')}'`, '', 'export default function Loading() {', '  return <Loader />', '}', ''].join('\n')
    case 'error':
      return [
        `'use client'`,
        '',
        `import { ErrorState } from '${spec('states/ErrorState')}'`,
        '',
        `export default function Error(${errorSignature(scan)}) {`,
        `  return <ErrorState error={error} retry={${prop}} />`,
        '}',
        '',
      ].join('\n')
    case 'global-error': {
      const css = (identity?.css ?? []).map((cssFile) => {
        const rel = posix.relative(posix.dirname(file), cssFile)
        return `import '${rel.startsWith('.') ? rel : `./${rel}`}'`
      })
      const lang = typeof identity?.lang === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(identity.lang) ? identity.lang : 'en'
      return [
        `'use client'`,
        '',
        ...css,
        `import { GlobalErrorState } from '${spec('states/GlobalErrorState')}'`,
        '',
        `export default function GlobalError(${errorSignature(scan)}) {`,
        '  return (',
        `    <html lang="${lang}">`,
        '      <body>',
        `        <GlobalErrorState error={error} retry={${prop}} />`,
        '      </body>',
        '    </html>',
        '  )',
        '}',
        '',
      ].join('\n')
    }
    case 'missing': {
      const instant = scan.config.cacheComponents === true && atLeast(scan.next, 16, 3)
      return [
        `import { notFound } from 'next/navigation'`,
        '',
        '// Rewrite target of the Fallback404 proxy checks. notFound() runs at build time, so Next.js serves',
        `// this route as a static HTTP 404 (see ${scan.componentsDir}/manifest.json).`,
        ...(instant ? ['export const instant = false', ''] : []),
        'export default function Fallback404Missing() {',
        '  notFound()',
        '}',
        '',
      ].join('\n')
    }
    default:
      throw new CliError('internal', `Unknown file kind ${kind}.`)
  }
}

/** The deterministic files the approved findings ask for, one entry per file, sorted. */
export function plannedWrites(scan, plan) {
  const approved = new Set(plan.approved ?? [])
  const replace = new Set(plan.replace ?? [])
  const writes = []
  for (const finding of scan.findings) {
    if (!approved.has(finding.id)) continue
    const target = finding.proposal.files?.[0]
    if (finding.kind === 'missing-root-not-found') writes.push({ file: target, kind: 'not-found' })
    if (finding.kind === 'missing-error') writes.push({ file: target, kind: 'error' })
    if (finding.kind === 'missing-global-error') writes.push({ file: target, kind: 'global-error' })
    if (finding.kind === 'missing-loading' && finding.proposal.type === 'write') writes.push({ file: target, kind: 'loading' })
    if (finding.proposal.type === 'proxy') {
      const missing = finding.proposal.files.find((file) => file.startsWith(`${scan.appDir}/fallback404-missing/`))
      if (missing) writes.push({ file: missing, kind: 'missing' })
    }
    if (finding.kind === 'existing-state' && replace.has(finding.file)) writes.push({ file: finding.file, kind: STATE_WRAPPERS[finding.state], replace: true })
  }
  return [...new Map(writes.map((write) => [write.file, write])).values()].sort((a, b) => (a.file < b.file ? -1 : 1))
}

async function existsAny(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Which states and not-found variants exist in the components folder. */
export async function previewEntries(root, scan) {
  const ext = scan.typescript ? 'tsx' : 'jsx'
  const states = join(root, scan.componentsDir, 'states')
  const has = (name) => existsAny(join(states, `${name}.${ext}`))
  const variant = new RegExp(`^NotFound\\.v(\\d+)\\.${ext}$`)
  const variants = (await readdir(join(states, 'variants')).catch(() => []))
    .map((name) => variant.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
  const motif = new RegExp(`^Motif\\.v(\\d+)\\.${ext}$`)
  const motifs = (await readdir(join(root, scan.componentsDir, 'illustrations', 'variants')).catch(() => []))
    .map((name) => motif.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
  return { notFound: await has('NotFound'), variants, motifs, error: await has('ErrorState'), globalError: await has('GlobalErrorState'), loader: await has('Loader') }
}

/** The dev-only preview page: every state, or one with ?state=…&variant=…&solo=1. A static 404 in production. */
export function renderPreview(scan, file, entries) {
  const ts = scan.typescript
  const spec = (rel) => importSpecifier(scan, file, rel)
  const imports = [`import { notFound } from 'next/navigation'`, `import { Suspense } from 'react'`, ...(ts ? [`import type { ReactNode } from 'react'`] : [])]
  const items = []
  if (entries.notFound) {
    imports.push(`import { NotFound } from '${spec('states/NotFound')}'`)
    items.push(`  { state: 'not-found', variant: null, render: () => <NotFound /> },`)
  }
  for (const k of entries.variants) {
    imports.push(`import { NotFound as NotFoundV${k} } from '${spec(`states/variants/NotFound.v${k}`)}'`)
    items.push(`  { state: 'not-found', variant: '${k}', render: () => <NotFoundV${k} /> },`)
  }
  for (const k of entries.motifs ?? []) {
    imports.push(`import { Motif as MotifV${k} } from '${spec(`illustrations/variants/Motif.v${k}`)}'`)
    items.push(`  { state: 'motif', variant: '${k}', render: () => <MotifV${k} /> },`)
  }
  const clients = [entries.error && 'ErrorPreview', entries.globalError && 'GlobalErrorPreview'].filter(Boolean)
  if (clients.length > 0) imports.push(`import { ${clients.join(', ')} } from './client'`)
  if (entries.error) items.push(`  { state: 'error', variant: null, render: () => <ErrorPreview /> },`)
  if (entries.globalError) items.push(`  { state: 'global-error', variant: null, render: () => <GlobalErrorPreview /> },`)
  if (entries.loader) {
    imports.push(`import { Loader } from '${spec('states/Loader')}'`)
    items.push(`  { state: 'loading', variant: null, render: () => <Loader /> },`, `  { state: 'loading-inline', variant: null, render: () => <Loader inline /> },`)
  }
  const props = ts ? ': { searchParams: SearchParams }' : ''
  return [
    ...imports,
    '',
    '// Dev-only gallery of every Fallback404 state, screenshotted by the Skill. Generated by write.mjs; do not edit.',
    '// In production notFound() runs at build time, so this route is a static HTTP 404.',
    ...(ts ? ['type SearchParams = Promise<Record<string, string | string[] | undefined>>', 'type Entry = { state: string; variant: string | null; render: () => ReactNode }'] : []),
    '',
    `const ENTRIES${ts ? ': Entry[]' : ''} = [`,
    ...items,
    ']',
    '',
    `export default function Fallback404Preview({ searchParams }${props}) {`,
    "  if (process.env.NODE_ENV === 'production') notFound()",
    '  return (',
    '    <Suspense fallback={null}>',
    '      <Gallery searchParams={searchParams} />',
    '    </Suspense>',
    '  )',
    '}',
    '',
    `async function Gallery({ searchParams }${props}) {`,
    '  const query = await searchParams',
    "  const state = typeof query.state === 'string' ? query.state : null",
    "  const variant = typeof query.variant === 'string' ? query.variant : null",
    '  const shown = ENTRIES.filter((entry) => state === null || (entry.state === state && entry.variant === variant))',
    "  if (query.solo === '1' && shown[0]) return <div data-fallback404-state={shown[0].state}>{shown[0].render()}</div>",
    '  return (',
    "    <div style={{ display: 'grid', gap: '3rem', padding: '2rem 0' }}>",
    '      {shown.map((entry) => (',
    "        <section key={`${entry.state}-${entry.variant ?? 'main'}`} data-fallback404-state={entry.state} data-fallback404-variant={entry.variant ?? undefined}>",
    "          <p style={{ margin: '0 1.5rem', font: '600 0.75rem/1.5 system-ui, sans-serif', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.6 }}>",
    '            {entry.variant ? `${entry.state} · variant ${entry.variant}` : entry.state}',
    '          </p>',
    '          {entry.render()}',
    '        </section>',
    '      ))}',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

/** Client wrappers so the preview page can render the error states with a sample error. */
export function renderPreviewClient(scan, file, entries) {
  const spec = (rel) => importSpecifier(scan, file, rel)
  const lines = [`'use client'`, '']
  if (entries.error) lines.push(`import { ErrorState } from '${spec('states/ErrorState')}'`)
  if (entries.globalError) lines.push(`import { GlobalErrorState } from '${spec('states/GlobalErrorState')}'`)
  lines.push(
    '',
    '// Client wrappers so the preview page can render the error states with a sample error. Generated by write.mjs.',
    "const previewError = Object.assign(new Error('Fallback404 preview'), { digest: 'fallback404-preview' })",
  )
  if (entries.error) lines.push('', 'export function ErrorPreview() {', '  return <ErrorState error={previewError} retry={() => {}} />', '}')
  if (entries.globalError) lines.push('', 'export function GlobalErrorPreview() {', '  return <GlobalErrorState error={previewError} retry={() => {}} />', '}')
  return `${lines.join('\n')}\n`
}

/** config.basePath when it is a literal path; scan.json says "unknown" when next.config computes it. */
const literalBasePath = (scan) => (typeof scan.config?.basePath === 'string' && scan.config.basePath.startsWith('/') ? scan.config.basePath : '')

/** The client component that shows a section's own 404 text once the browser knows the URL (spec section 4.2). */
export function renderNotFoundText(scan) {
  const ts = scan.typescript
  const t = (type) => (ts ? type : '')
  return [
    `'use client'`,
    '',
    `import { useSyncExternalStore } from 'react'`,
    '',
    '// Generated by write.mjs; do not edit. The root not-found page is the same HTML for every URL, so the server',
    "// renders the general text and the browser swaps in the section's own text once it knows the URL.",
    ...(ts ? ['type Text = { title: string; body: string }', 'type Section = Text & { route: string }', 'type Props = { text: Text; sections?: readonly Section[]; titleClassName?: string; bodyClassName?: string }', ''] : []),
    `const BASE_PATH = ${JSON.stringify(literalBasePath(scan)).replace(/"/g, "'")}`,
    'const subscribe = () => () => {}',
    `const browserPath = ()${t(': string | null')} => window.location.pathname`,
    `const serverPath = ()${t(': string | null')} => null`,
    '',
    '/** True when a route such as /match/[id] or /docs/[...slug] matches the path; a trailing slash does not matter. */',
    `export function routeMatches(route${t(': string')}, path${t(': string')})${t(': boolean')} {`,
    "  const pattern = route.split('/').filter(Boolean)",
    "  const parts = path.split('/').filter(Boolean)",
    '  for (let i = 0; i < pattern.length; i++) {',
    "    if (pattern[i].startsWith('[[...')) return true",
    "    if (pattern[i].startsWith('[...')) return parts.length > i",
    "    if (i >= parts.length || (!pattern[i].startsWith('[') && pattern[i] !== parts[i])) return false",
    '  }',
    '  return pattern.length === parts.length',
    '}',
    '',
    '/** The first section whose route matches the path (basePath removed), else the general text. */',
    `export function sectionText(text${t(': Text')}, sections${t(': readonly Section[]')}, path${t(': string | null')}, basePath${t(': string')})${t(': Text')} {`,
    '  if (path === null) return text',
    "  const local = basePath !== '' && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path",
    '  const match = sections.find((section) => routeMatches(section.route, local))',
    '  return match ? { title: match.title, body: match.body } : text',
    '}',
    '',
    `export function NotFoundText({ text, sections = [], titleClassName, bodyClassName }${t(': Props')}) {`,
    '  const path = useSyncExternalStore(subscribe, browserPath, serverPath)',
    '  const shown = sectionText(text, sections, path, BASE_PATH)',
    '  return (',
    '    <>',
    '      <h1 className={titleClassName}>{shown.title}</h1>',
    '      <p className={bodyClassName}>{shown.body}</p>',
    '    </>',
    '  )',
    '}',
    '',
  ].join('\n')
}

/** NotFoundText goes next to Fallback404's NotFound (or its variants) so they can import it. */
async function notFoundTextWrite(root, scan, needed) {
  if (!needed) return []
  const ext = scan.typescript ? 'tsx' : 'jsx'
  return [{ file: `${scan.componentsDir}/states/NotFoundText.${ext}`, content: renderNotFoundText(scan) }]
}

async function ownedFiles(root, scan) {
  const listed = (await readJsonIfExists(workspacePath(root, 'owned.json')))?.files ?? []
  const fromManifest = [...(await readOwned(root, scan.componentsDir))].filter(([, status]) => status === 'unchanged').map(([file]) => file)
  return new Set([...listed, ...fromManifest])
}

/** Writes new files, Fallback404's own earlier files and approved replacements; never through symlinks. Records owned.json. */
export async function writeOwned(root, scan, writes) {
  const ownedFile = workspacePath(root, 'owned.json')
  await prepareWrite(root, ownedFile)
  const owned = await ownedFiles(root, scan)
  const written = []
  const skipped = []
  for (const { file, content, replace = false } of writes) {
    const info = await lstat(join(root, file)).catch(() => null)
    if (info && !info.isSymbolicLink() && !owned.has(file) && !replace) {
      skipped.push({ file, reason: 'exists and is not a Fallback404 file; list it in "replace" in .fallback404/plan.json once the user approves replacing it' })
      continue
    }
    let target
    try {
      target = await prepareWrite(root, file)
    } catch (error) {
      if (error.code !== 'unsafe_path') throw error
      skipped.push({ file, reason: error.message })
      continue
    }
    await writeFile(target, content)
    written.push(file)
  }
  const listed = (await readJsonIfExists(ownedFile))?.files ?? []
  await writeJsonInside(root, ownedFile, { files: [...new Set([...listed, ...written])].sort() })
  return { written, skipped }
}

export async function main({ command, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  const scan = await readJsonIfExists(workspacePath(root, 'scan.json'))
  if (!scan) throw new CliError('no_scan', 'Run scan.mjs first: .fallback404/scan.json is missing.')
  if (command === 'wrappers') {
    const plan = await readJsonIfExists(workspacePath(root, 'plan.json'))
    if (!plan) throw new CliError('no_plan', 'Write .fallback404/plan.json with the approved finding ids first.')
    const identity = await readJsonIfExists(workspacePath(root, 'identity.json'))
    const writes = plannedWrites(scan, plan).map((write) => ({ ...write, content: renderWrapper(write.kind, write.file, scan, identity) }))
    const ext = scan.typescript ? 'tsx' : 'jsx'
    writes.push(...(await notFoundTextWrite(root, scan, await exists(root, `${scan.componentsDir}/states/NotFound.${ext}`))))
    return writeOwned(root, scan, writes)
  }
  if (command === 'preview') {
    const ext = scan.typescript ? 'tsx' : 'jsx'
    const page = `${scan.appDir}/fallback404-preview/page.${ext}`
    const client = `${scan.appDir}/fallback404-preview/client.${ext}`
    const entries = await previewEntries(root, scan)
    const writes = [{ file: page, content: renderPreview(scan, page, entries) }]
    if (entries.error || entries.globalError) writes.push({ file: client, content: renderPreviewClient(scan, client, entries) })
    writes.push(...(await notFoundTextWrite(root, scan, entries.notFound || entries.variants.length > 0)))
    return writeOwned(root, scan, writes)
  }
  throw new CliError('bad_args', USAGE)
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
