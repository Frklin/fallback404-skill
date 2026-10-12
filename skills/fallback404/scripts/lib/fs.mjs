// Repo file access for the skill scripts: never follows symlinks, never leaves the root, skips dependencies and build output.
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CliError } from './cli.mjs'

export const WORKSPACE = '.fallback404'
export const LIMITS = { maxFiles: 5000, maxBytes: 1024 * 1024 }
const ROOT_BUILD_OUTPUT = new Set(['out', 'build', 'dist', 'coverage'])

export const toPosix = (path) => path.split(sep).join('/')

/** Absolute path of a file in the project's .fallback404/ workspace. */
export const workspacePath = (root, name) => join(root, WORKSPACE, name)

/** True when absolute `path` is `root` or inside it. */
export function isInside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Regular files under `dir` (repo-relative, POSIX separators, sorted). Skips symlinks, dot-folders and node_modules
 * everywhere, and build output folders at the repo root. Stops at `limits.maxFiles` with a warning.
 */
export async function walk(root, dir, { limits = LIMITS, warnings = [] } = {}) {
  // readdir follows a link at the start folder (links below it are skipped), so a linked start folder is not read.
  const link = await firstLink(root, dir)
  if (link) {
    warnings.push(`${link} is a symlink; Fallback404 does not follow links out of the project, so ${toPosix(dir)} was not read.`)
    return []
  }
  const files = []
  let truncated = false
  async function visit(rel) {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (files.length >= limits.maxFiles) {
        truncated = true
        return
      }
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        if (rel === '.' && ROOT_BUILD_OUTPUT.has(entry.name)) continue
        await visit(child)
      } else if (entry.isFile()) {
        files.push(child)
      }
    }
  }
  await visit(dir)
  if (truncated) warnings.push(`Stopped after ${limits.maxFiles} files under ${dir}/; the rest was not scanned.`)
  return files
}

/** True when `rel` exists in any form (file, folder or symlink), without following it. */
export async function exists(root, rel) {
  try {
    await lstat(join(root, rel))
    return true
  } catch {
    return false
  }
}

/**
 * A repo file as UTF-8 text, or null when it is missing, not a regular file (symlinks included),
 * outside the root once symlinked folders are resolved, or larger than the cap (with a warning).
 */
export async function readText(root, rel, { limits = LIMITS, warnings = [] } = {}) {
  const abs = resolve(root, rel)
  let info
  try {
    info = await lstat(abs)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  try {
    if (!isInside(await realpath(root), await realpath(abs))) return null
  } catch {
    return null
  }
  if (info.size > limits.maxBytes) {
    warnings.push(`${toPosix(rel)}: skipped, larger than ${Math.round(limits.maxBytes / 1024)} KB.`)
    return null
  }
  return readFile(abs, 'utf8')
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function readJsonIfExists(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(text)
}

/**
 * The absolute path for writing `rel` (relative to `root`, or absolute inside it), after refusing any symlink on the
 * way and creating missing folders. A cloned repo can commit a symlink, such as .fallback404/scan.json pointing at
 * ~/.bashrc, so every write the scripts make goes through here and never follows one.
 */
export async function prepareWrite(root, rel) {
  const base = resolve(root)
  const target = resolve(base, rel)
  const inner = relative(base, target)
  if (inner === '' || inner.startsWith('..') || isAbsolute(inner)) throw new CliError('unsafe_path', `${toPosix(String(rel))} is outside the project.`)
  const parts = inner.split(sep)
  let current = base
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const last = index === parts.length - 1
    let info = null
    try {
      info = await lstat(current)
    } catch {
      if (!last) await mkdir(current)
      continue
    }
    const shown = toPosix(relative(base, current))
    if (info.isSymbolicLink()) throw new CliError('unsafe_path', `${shown} is a symlink; Fallback404 never writes through links.`)
    if (!last && !info.isDirectory()) throw new CliError('unsafe_path', `${shown} is not a folder.`)
    if (last && !info.isFile()) throw new CliError('unsafe_path', `${shown} exists and is not a regular file.`)
  }
  return target
}

/** The first part of `rel` below `root` that is a symlink, as a POSIX path, or null. Read-only: unlike prepareWrite it creates nothing. */
export async function firstLink(root, rel) {
  const base = resolve(root)
  let current = base
  for (const part of toPosix(rel).split('/').filter((part) => part !== '' && part !== '.')) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch {
      return null
    }
    if (info.isSymbolicLink()) return toPosix(relative(base, current))
  }
  return null
}

export async function writeTextInside(root, rel, content, options) {
  await writeFile(await prepareWrite(root, rel), content, options)
}

export async function writeJsonInside(root, rel, data) {
  await writeTextInside(root, rel, `${JSON.stringify(data, null, 2)}\n`)
}

/** Writes JSON at an absolute path; for test setup only. Scripts write through writeJsonInside. */
export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}

/** JSON that may contain comments and trailing commas, as tsconfig.json does. */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') out += text[++i] ?? ''
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
    } else {
      out += char
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}
