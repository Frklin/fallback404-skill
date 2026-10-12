#!/usr/bin/env node
// Fallback404 manifest: what this run owns (with hashes), which route uses which state, the picks (titles only) and the
// user files it changed, in <componentsDir>/manifest.json. The picker session id is never written here: it is a
// capability, and the manifest gets committed. Usage: node manifest.mjs [--root <dir>]
import { resolve } from 'node:path'
import { CliError, SKILL_VERSION, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { readJsonIfExists, readText, walk, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { hashText } from './lib/owned.mjs'

const STATE_FILES = [
  ['not-found', 'NotFound'],
  ['error', 'ErrorState'],
  ['global-error', 'GlobalErrorState'],
  ['loading', 'Loader'],
]

async function readScan(root) {
  const scan = await readJsonIfExists(workspacePath(root, 'scan.json'))
  if (!scan) throw new CliError('no_scan', 'Run scan.mjs first: .fallback404/scan.json is missing.')
  return scan
}

export async function buildManifest(root, now = () => new Date()) {
  const scan = await readScan(root)
  const plan = (await readJsonIfExists(workspacePath(root, 'plan.json'))) ?? {}
  const state = (await readJsonIfExists(workspacePath(root, 'state.json'))) ?? {}
  const listed = (await readJsonIfExists(workspacePath(root, 'owned.json')))?.files ?? []
  const manifestFile = `${scan.componentsDir}/manifest.json`
  const candidates = [...new Set([...listed, ...(await walk(root, scan.componentsDir))])].filter((file) => file !== manifestFile).sort()
  const owned = {}
  for (const file of candidates) {
    const text = await readText(root, file)
    if (text !== null) owned[file] = hashText(text)
  }
  const has = (file) => typeof file === 'string' && file in owned
  const approved = new Set(plan.approved ?? [])
  const userFiles = new Set(plan.userFiles ?? [])
  const routes = []
  for (const finding of scan.findings ?? []) {
    if (!approved.has(finding.id)) continue
    const target = finding.proposal?.files?.[0]
    if (finding.kind === 'missing-root-not-found' && has(target)) routes.push({ route: '/', state: 'not-found', file: target })
    if (finding.kind === 'missing-error' && has(target)) routes.push({ route: '/', state: 'error', file: target })
    if (finding.kind === 'missing-global-error' && has(target)) routes.push({ route: '/', state: 'global-error', file: target })
    if (finding.kind === 'missing-loading' && finding.proposal.type === 'write' && has(target)) routes.push({ route: finding.route, state: 'loading', file: target })
    if (finding.proposal?.type === 'proxy' && finding.proposal.files.some(has)) routes.push({ route: finding.route, state: 'not-found', via: 'proxy' })
    if (finding.kind === 'weak-suspense-fallback' && userFiles.has(finding.file)) routes.push({ route: finding.route, state: 'loading', file: finding.file, via: 'suspense' })
    if (finding.kind === 'no-notfound-candidate' && userFiles.has(finding.file)) routes.push({ route: finding.route, state: 'not-found', file: finding.file, via: 'notFound()' })
    if (finding.kind === 'existing-state' && (plan.replace ?? []).includes(finding.file) && has(finding.file)) routes.push({ route: finding.route, state: finding.state, file: finding.file })
  }
  const ext = scan.typescript ? 'tsx' : 'jsx'
  const states = {}
  for (const [name, component] of STATE_FILES) {
    const file = `${scan.componentsDir}/states/${component}.${ext}`
    if (has(file)) states[name] = file
  }
  return {
    schema: 1,
    generator: `fallback404-skill@${SKILL_VERSION}`,
    updatedAt: now().toISOString(),
    picks: Object.fromEntries(Object.entries(state.picks ?? {}).map(([kind, pick]) => [kind, pick.title])),
    states,
    routes,
    owned,
    touched: [...userFiles].sort(),
  }
}

export async function main({ flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  const manifest = await buildManifest(root)
  const { componentsDir } = await readScan(root)
  const file = `${componentsDir}/manifest.json`
  await writeJsonInside(root, file, manifest)
  return { written: file, owned: Object.keys(manifest.owned).length, routes: manifest.routes.length }
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
