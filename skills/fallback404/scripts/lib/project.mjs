// Project facts every skill script shares: Next.js version, app directory, TypeScript, import alias, package manager.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'
import { CliError } from './cli.mjs'
import { exists, firstLink, parseJsonc, readJsonIfExists } from './fs.mjs'
import { isGitRepo, trackedWorkspace } from './git.mjs'

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

export function versionInfo(version, installed) {
  const [major, minor = 0, patch = 0] = version.split(/[.+-]/).map(Number)
  return { version, major, minor, patch, installed }
}

/** True when the Next.js version is at least major.minor. */
export function atLeast(next, major, minor = 0) {
  if (!next || !Number.isFinite(next.major)) return false
  return next.major > major || (next.major === major && next.minor >= minor)
}

async function nextVersion(root, pkg, warnings) {
  try {
    const require = createRequire(join(root, 'package.json'))
    const { version } = JSON.parse(await readFile(require.resolve('next/package.json'), 'utf8'))
    return versionInfo(version, true)
  } catch {
    const declared = pkg.dependencies?.next ?? pkg.devDependencies?.next
    if (typeof declared !== 'string') return null
    warnings.push(`next is not installed here, so the version declared in package.json (${declared}) is used. Install dependencies for exact results.`)
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(declared)
    return match ? versionInfo(`${match[1]}.${match[2]}.${match[3] ?? 0}`, false) : { version: declared, major: null, minor: null, patch: null, installed: false }
  }
}

async function packageManager(root, pkg) {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared
  let dir = root
  for (let depth = 0; depth < 6; depth++) {
    for (const [file, name] of LOCKFILES) if (await exists(dir, file)) return name
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'npm'
}

/** tsconfig/jsconfig `paths` of the form "prefix/*": ["target/*"], as { prefix, target } with repo-relative targets. */
async function importPaths(root, file, warnings) {
  if (!file) return []
  let config
  try {
    config = parseJsonc(await readFile(join(root, file), 'utf8'))
  } catch {
    warnings.push(`${file} could not be parsed, so import aliases are ignored.`)
    return []
  }
  const options = config?.compilerOptions ?? {}
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.'
  const out = []
  for (const [key, targets] of Object.entries(options.paths ?? {})) {
    const first = Array.isArray(targets) ? targets[0] : null
    if (!key.endsWith('/*') || typeof first !== 'string' || !first.endsWith('/*')) continue
    const normalized = posix.normalize(posix.join(baseUrl, first.slice(0, -2))).replace(/\/$/, '')
    out.push({ prefix: key.slice(0, -1), target: normalized === '.' || normalized === '' ? '' : normalized })
  }
  return out
}

/** package.json, Next.js version, app directory, TypeScript and alias facts. Throws when there is no package.json. */
export async function loadProject(root, warnings = []) {
  const pkg = await readJsonIfExists(join(root, 'package.json'))
  if (!pkg) throw new CliError('unsupported', 'There is no package.json here. Run Fallback404 from the root folder of the Next.js app.')
  const appDir = (await exists(root, 'app')) ? 'app' : (await exists(root, 'src/app')) ? 'src/app' : null
  const pagesDir = (await exists(root, 'pages')) ? 'pages' : (await exists(root, 'src/pages')) ? 'src/pages' : null
  const srcDir = appDir === 'src/app'
  const tsconfigFile = (await exists(root, 'tsconfig.json')) ? 'tsconfig.json' : (await exists(root, 'jsconfig.json')) ? 'jsconfig.json' : null
  const paths = await importPaths(root, tsconfigFile, warnings)
  return {
    root,
    pkg,
    next: await nextVersion(root, pkg, warnings),
    appDir,
    pagesDir,
    srcDir,
    typescript: tsconfigFile === 'tsconfig.json',
    paths,
    alias: paths.find((entry) => entry.target === (srcDir ? 'src' : ''))?.prefix ?? null,
    componentsDir: srcDir ? 'src/components/fallback404' : 'components/fallback404',
    packageManager: await packageManager(root, pkg),
    hasDevScript: typeof pkg.scripts?.dev === 'string',
  }
}

/** Phase 0: Node, git, Next.js version and an App Router directory. Collects every problem instead of stopping at the first. */
export async function preflight(root, { nodeVersion = process.versions.node } = {}) {
  const problems = []
  const warnings = []
  if (Number(nodeVersion.split('.')[0]) < 20) problems.push(`Node.js 20 or newer is required; this is Node.js ${nodeVersion}.`)
  if (!(await isGitRepo(root))) {
    problems.push('This folder is not inside a git repository. Fallback404 writes on a new branch, so it needs git (run `git init` first).')
  } else {
    const tracked = await trackedWorkspace(root)
    if (tracked.length > 0) {
      const folders = [...new Set(tracked.map((path) => path.split('/')[0]))].join(' ')
      problems.push(
        `This repository tracks files in .fallback404/ (${tracked.slice(0, 3).join(', ')}), the folder Fallback404 keeps its own work in. Remove them from git with \`git rm -r --cached -- ${folders}\` before running Fallback404.`,
      )
    }
  }
  let project = null
  try {
    project = await loadProject(root, warnings)
  } catch (error) {
    problems.push(error.message)
  }
  if (project) {
    if (!project.next) problems.push('next is not in package.json, so this does not look like a Next.js app.')
    else if (Number.isFinite(project.next.major) && project.next.major < 15) problems.push(`Next.js ${project.next.version} is not supported. Fallback404 needs Next.js 15 or newer.`)
    else if (project.next.major === null) {
      problems.push(
        `Fallback404 cannot tell which Next.js version this app uses: package.json asks for "${project.next.version}" and next is not installed here. Install the dependencies (\`${project.packageManager ?? 'npm'} install\`), then run Fallback404 again.`,
      )
    }
    if (!project.appDir) {
      problems.push(project.pagesDir ? 'This app uses only the Pages Router, which Fallback404 does not support yet; it needs an app/ directory.' : 'There is no app/ or src/app/ directory.')
    }
    // The scanner and Claude's own tools follow links, so a link planted in a cloned repo must stop the run up front.
    const links = new Set()
    for (const dir of [project.appDir, project.componentsDir].filter(Boolean)) {
      const link = await firstLink(root, dir)
      if (link && !links.has(link)) {
        links.add(link)
        problems.push(`${link} is a symlink. Fallback404 works in ${dir} and never follows or writes through links: make it a real folder, or remove it.`)
      }
    }
  }
  return { ok: problems.length === 0, problems, warnings, project }
}
