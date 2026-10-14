#!/usr/bin/env node
// Fallback404 branch: reports uncommitted changes and creates the fallback404/<date> work branch.
// It never commits, stashes or resets; on a dirty tree `create` asks first, and `--carry` takes the changes along. Once the
// branch exists it writes the shared fallback404.css from the brand kit: the first Fallback404 file to land in the repo.
// Usage: node branch.mjs status | create [--carry] [--date YYYY-MM-DD] [--root <dir>]
import { resolve } from 'node:path'
import { CliError, isMain, runCli, stringFlag } from './lib/cli.mjs'
import { prepareWrite, workspacePath, writeJsonInside } from './lib/fs.mjs'
import { writeSharedCss } from './identity.mjs'
import { branchExists, changedPaths, createBranch, currentBranch, ensureExcluded, isGitRepo } from './lib/git.mjs'
import { exists } from './lib/fs.mjs'
import { toolchainWrote } from './lib/toolchain.mjs'
import { setPhase } from './state.mjs'

const USAGE = 'Usage: node branch.mjs status | create [--carry] [--date YYYY-MM-DD] [--root <dir>]'
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

/**
 * Creates the work branch (or stays on one), keeps .fallback404/ out of git and records the changes that were already
 * there. A dirty tree creates nothing without `carry`: the answer says what to ask the user.
 */
export async function create(root, date, { carry = false } = {}) {
  await ensureExcluded(root)
  const current = await currentBranch(root)
  if (current?.startsWith('fallback404/')) return { branch: current, created: false }
  const carried = await changedPaths(root)
  // What the app's own tools wrote while the scripts ran (next dev's AGENTS.md block, next-env.d.ts) is not the user's work.
  const yours = []
  for (const path of carried) if (!(await toolchainWrote(root, path))) yours.push(path)
  if (yours.length > 0 && !carry) {
    return {
      created: false,
      dirty: true,
      changes: yours,
      question: 'Your tree has uncommitted changes. Stop here to commit or stash them yourself, or continue with them carried onto the new branch (run branch.mjs create --carry)? Fallback404 never stashes.',
    }
  }
  const baseline = workspacePath(root, 'baseline.json')
  await prepareWrite(root, baseline)
  const name = await pickBranchName(root, date)
  await createBranch(root, name)
  await writeJsonInside(root, baseline, { from: current, branch: name, paths: carried })
  await setPhase(root, 'branch')
  const result = { branch: name, created: true, from: current, carried }
  if (await exists(root, '.fallback404/brand-kit.json')) result.wrote = [await writeSharedCss(root)]
  return result
}

export async function main({ command, flags }) {
  const root = resolve(stringFlag(flags, 'root', '.'))
  if (!(await isGitRepo(root))) throw new CliError('not_git', 'This folder is not inside a git repository.')
  if (command === 'status') return status(root)
  if (command === 'create') {
    const date = stringFlag(flags, 'date', today())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CliError('bad_args', `--date must look like 2026-10-13.\n${USAGE}`)
    return create(root, date, { carry: flags.carry === true })
  }
  throw new CliError('bad_args', USAGE)
}

if (isMain(import.meta.url)) process.exitCode = await runCli(main, process.argv.slice(2))
