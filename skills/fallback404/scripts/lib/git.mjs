// Git helpers for the skill: find the repo, keep .fallback404/ out of git, list changes, create the work branch.
// Nothing here commits, stashes, resets or touches .gitignore.
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { WORKSPACE, toPosix } from './fs.mjs'

const run = promisify(execFile)
export const EXCLUDE_ENTRY = `${WORKSPACE}/`

export async function git(root, args) {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

export async function isGitRepo(root) {
  try {
    return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

/** Appends `.fallback404/` to the repo's info/exclude (never .gitignore). Idempotent; returns true when it added the line. */
export async function ensureExcluded(root) {
  const rel = (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).trim()
  const file = isAbsolute(rel) ? rel : join(root, rel)
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) return false
  await mkdir(dirname(file), { recursive: true })
  const separator = text === '' || text.endsWith('\n') ? '' : '\n'
  await writeFile(file, `${text}${separator}${EXCLUDE_ENTRY}\n`)
  return true
}

/**
 * Paths with uncommitted changes (staged, unstaged or untracked), relative to `root` with POSIX separators.
 * Porcelain paths are relative to the git top level, so they are re-based for apps inside a monorepo.
 * The .fallback404/ workspace is left out.
 */
export async function changedPaths(root) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
  const base = await realpath(root)
  const entries = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean)
  const paths = []
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2)
    const path = toPosix(relative(base, join(top, entries[i].slice(3))))
    if (/[RC]/.test(status)) i++ // -z puts the source path of a rename or copy, staged or in the work tree, in the next entry
    if (path === WORKSPACE || path.startsWith(`${WORKSPACE}/`)) continue
    paths.push(path)
  }
  return [...new Set(paths)].sort()
}

/**
 * Files git tracks in the .fallback404/ workspace: a repo should never commit it (it could plant a fake session).
 * Git compares path bytes, but macOS and Windows resolve other spellings (.Fallback404, a Kelvin-sign K) to the same
 * folder, so a tracked top-level entry also counts when it is the workspace on disk: same device and inode.
 */
export async function trackedWorkspace(root) {
  const workspace = await fileId(join(root, WORKSPACE))
  const isWorkspace = new Map()
  const tracked = []
  for (const path of (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean)) {
    const top = path.split('/')[0]
    if (!isWorkspace.has(top)) isWorkspace.set(top, top === WORKSPACE || (workspace !== null && workspace === (await fileId(join(root, top)))))
    if (isWorkspace.get(top)) tracked.push(path)
  }
  return tracked
}

/** "device:inode" of a path, links not followed; null when it is missing or the file system reports no inode. */
async function fileId(path) {
  try {
    const { dev, ino } = await lstat(path, { bigint: true })
    return ino === 0n ? null : `${dev}:${ino}`
  } catch {
    return null
  }
}

/** The current branch name, or null on a detached HEAD. Works before the first commit. */
export async function currentBranch(root) {
  try {
    return (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

export async function branchExists(root, name) {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

export async function createBranch(root, name) {
  await git(root, ['switch', '--quiet', '--create', name])
}
