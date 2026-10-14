// A lock file in .fallback404/ so parallel designer agents never interleave their writes (owned.json, the preview
// page). Created with O_EXCL, so two processes cannot both take it; a lock older than staleMs is taken over.
import { open, rm, stat } from 'node:fs/promises'
import { CliError } from './cli.mjs'
import { WORKSPACE, prepareWrite } from './fs.mjs'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

export async function withLock(root, name, task, { retryMs = 50, timeoutMs = 15000, staleMs = 60000 } = {}) {
  const file = await prepareWrite(root, `${WORKSPACE}/${name}.lock`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const info = await stat(file).catch(() => null)
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(file, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new CliError('locked', `Another Fallback404 write is still running (${WORKSPACE}/${name}.lock). Run this again in a moment; delete that file if no other agent is working.`)
      }
      await pause(retryMs)
    }
  }
  try {
    return await task()
  } finally {
    await rm(file, { force: true })
  }
}
