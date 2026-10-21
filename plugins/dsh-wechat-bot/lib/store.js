import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

// Atomic replace. On Windows a rename can briefly fail while another process
// (antivirus, indexer, a reader) holds the target open, so retry a few times.
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 1))
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

// Plugin state under one data directory: `bot.json` for settings changed by the
// console, commands and onboarding; `chats/<hash>.json` for each chat's context.
// Chat writes are coalesced and serialized per file.
export class Store {
  #timers = new Map()
  #pending = new Map()
  #chains = new Map()

  constructor(dir, { delayMs = 1000, onError = () => {} } = {}) {
    this.dir = dir
    this.delayMs = delayMs
    this.onError = onError
  }

  chatPath(chatId) {
    return join(this.dir, 'chats', createHash('sha256').update(chatId).digest('hex').slice(0, 24) + '.json')
  }

  loadBot() {
    return readJson(join(this.dir, 'bot.json'), {})
  }

  // Read-modify-write of bot.json, serialized with other writes to it.
  updateBot(change) {
    const path = join(this.dir, 'bot.json')
    return this.#serialize(path, async () => {
      const next = { ...(await readJson(path, {})), ...change }
      await writeJson(path, next)
      return next
    })
  }

  loadChat(chatId) {
    return readJson(this.chatPath(chatId), {})
  }

  // Schedule a write; the latest value (or value factory) wins.
  saveChatLater(chatId, snapshot) {
    const path = this.chatPath(chatId)
    this.#pending.set(path, snapshot)
    if (this.#timers.has(path)) return
    const timer = setTimeout(() => this.#flushOne(path).catch(this.onError), this.delayMs)
    timer.unref?.()
    this.#timers.set(path, timer)
  }

  flush() {
    return Promise.all([...this.#pending.keys()].map(path => this.#flushOne(path)))
  }

  #flushOne(path) {
    clearTimeout(this.#timers.get(path))
    this.#timers.delete(path)
    return this.#serialize(path, async () => {
      if (!this.#pending.has(path)) return
      const value = this.#pending.get(path)
      this.#pending.delete(path)
      await writeJson(path, typeof value === 'function' ? value() : value)
    })
  }

  #serialize(path, task) {
    const run = (this.#chains.get(path) ?? Promise.resolve()).then(task)
    this.#chains.set(path, run.catch(() => {}))
    return run
  }
}
