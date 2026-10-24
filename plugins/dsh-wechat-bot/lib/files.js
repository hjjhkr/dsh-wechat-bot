import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Atomic replace. On Windows a rename can briefly fail while another process
// (antivirus, indexer, a reader) holds the target open, so retry a few times.
export async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, text)
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(temp, path)
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await rm(temp, { force: true })
        throw error
      }
      await sleep(20 * (attempt + 1))
    }
  }
}
