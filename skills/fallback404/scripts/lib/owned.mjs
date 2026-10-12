// Files an earlier Fallback404 run wrote, read back from its manifest so a new run can tell its own files from yours.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonIfExists, readText } from './fs.mjs'

export const hashText = (text) => `sha256-${createHash('sha256').update(text).digest('hex')}`

/** Owned file → 'unchanged' | 'edited' | 'missing', from <componentsDir>/manifest.json; empty when there is none. */
export async function readOwned(root, componentsDir) {
  const manifest = await readJsonIfExists(join(root, componentsDir, 'manifest.json')).catch(() => null)
  const owned = new Map()
  for (const [file, hash] of Object.entries(manifest?.owned ?? {})) {
    const text = await readText(root, file)
    owned.set(file, text === null ? 'missing' : hashText(text) === hash ? 'unchanged' : 'edited')
  }
  return owned
}
