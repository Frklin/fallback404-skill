#!/usr/bin/env node
// Fallback404 branch: reports uncommitted changes and creates the fallback404/<date> work branch.
// It never commits, stashes or resets. Usage: node branch.mjs status | create [--date YYYY-MM-DD] [--root <dir>]
import { resolve } from 'node:path'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { prepareWrite, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { branchExists, changedPaths, createBranch, currentBranch, ensureExcluded, isGitRepo } from './lib/git.mjs'

const USAGE = 'Usage: node branch.mjs status | create [--date YYYY-MM-DD] [--root <dir>]'
const today = () => new Date().toLocaleDateString('en-CA')

export async function status(root) {
  const changes = await changedPaths(root)
  return { branch: await currentBranch(root), dirty: changes.length > 0, changes }
}

/** The first free name among fallback404/<date>, fallback404/<date>-2, … */
export async function pickBranchName(root, date) {
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? `fallback404/${date}` : `fallback404/${date}-${n}`
    if (!(await branchExists(root, name))) return name
  }
  throw new CliError('branch_taken', `fallback404/${date} and 49 more names are taken. Delete old fallback404 branches first.`)
}

/** Creates the work branch (or stays on one), keeps .fallback404/ out of git and records the changes that were already there. */
export async function create(root, date) {
  await ensureExcluded(root)
  const current = await currentBranch(root)
  if (current?.startsWith('fallback404/')) return { branch: current, created: false }
  const baseline = workspacePath(root, 'baseline.json')
  await prepareWrite(root, baseline)
  const carried = await changedPaths(root)
  const name = await pickBranchName(root, date)
  await createBranch(root, name)
  await writeJsonInside(root, baseline, { from: current, branch: name, paths: carried })
  return { branch: name, created: true, from: current, carried }
}

export async function main({ command, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  if (!(await isGitRepo(root))) throw new CliError('not_git', 'This folder is not inside a git repository.')
  if (command === 'status') return status(root)
  if (command === 'create') {
    const date = stringFlag(flags, 'date', today())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CliError('bad_args', `--date must look like 2026-10-13.\n${USAGE}`)
    return create(root, date)
  }
  throw new CliError('bad_args', USAGE)
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
