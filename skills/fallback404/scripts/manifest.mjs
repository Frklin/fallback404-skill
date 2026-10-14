#!/usr/bin/env node
// Fallback404 manifest: what this run owns (with hashes), which flow uses which component and route file, the picks
// (titles only) and the user files it changed, in <componentsDir>/manifest.json. The picker session id is never written
// here: it is a capability, and the manifest gets committed. Usage: node manifest.mjs [--root <dir>]
import { resolve } from 'node:path'
import { CliError, SKILL_VERSION, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { componentFile, wrapperTarget } from './lib/flows.mjs'
import { readJsonIfExists, readText, walk, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { hashText } from './lib/owned.mjs'

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
  const userFiles = new Set(plan.userFiles ?? [])
  const findings = new Map((scan.findings ?? []).map((finding) => [finding.id, finding]))
  // component null: the person kept the site's own page for that flow.
  const flows = (plan.flows ?? []).map((flow) => {
    const finding = findings.get(flow.rowId)
    const component = componentFile(scan, flow.slug, flow.state)
    const entry = { route: flow.route, state: flow.state, slug: flow.slug, component: has(component) ? component : null }
    const target = wrapperTarget(finding)
    if (target && has(target.file)) entry.file = target.file
    if (finding?.proposal?.type === 'proxy' && finding.proposal.files?.some(has)) entry.via = 'proxy'
    if (finding?.kind === 'weak-suspense-fallback' && userFiles.has(finding.file)) Object.assign(entry, { file: finding.file, via: 'suspense' })
    return entry
  })
  return {
    schema: 2,
    generator: `fallback404-skill@${SKILL_VERSION}`,
    updatedAt: now().toISOString(),
    picks: Object.fromEntries(Object.entries(state.picks ?? {}).map(([kind, pick]) => [kind, pick.title])),
    flows,
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
  return { written: file, owned: Object.keys(manifest.owned).length, flows: manifest.flows.length }
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
