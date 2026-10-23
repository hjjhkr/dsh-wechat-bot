import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MarkdownMemory } from './markdown-memory.js'

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
  #memories = new Map()

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

  memoryFor(chatId) {
    return this.#memoryForKey(basename(this.chatPath(chatId), '.json'))
  }

  #memoryForKey(key) {
    if (!this.#memories.has(key)) this.#memories.set(key, new MarkdownMemory(this.dir, key))
    return this.#memories.get(key)
  }

  async loadChat(chatId) {
    const state = await readJson(this.chatPath(chatId), {})
    await migrateVerified(this.memoryFor(chatId), state.memory)
    return state
  }

  // Raw conversations are temporary. Keep only controls and recovery identifiers.
  async clearHistory() {
    await this.flush()
    let entries
    try { entries = await readdir(join(this.dir, 'chats'), { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{24}\.json$/.test(entry.name)) continue
      const path = join(this.dir, 'chats', entry.name)
      await this.#serialize(path, async () => {
        const state = await readJson(path, {})
        await migrateVerified(this.#memoryForKey(basename(entry.name, '.json')), state.memory)
        await writeJson(path, durableState(state))
      })
    }
    await Promise.all([...this.#memories.values()].map(memory => memory.flush()))
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
      await writeJson(path, durableState(typeof value === 'function' ? value() : value))
    })
  }

  #serialize(path, task) {
    const run = (this.#chains.get(path) ?? Promise.resolve()).then(task)
    this.#chains.set(path, run.catch(() => {}))
    return run
  }
}

function durableState(state) {
  return Object.fromEntries(['mode', 'wait', 'mutedUntil', 'stats', 'cron', 'engagement', 'forgottenEvidence']
    .filter(key => state[key] !== undefined).map(key => [key, state[key]]))
}

async function migrateVerified(memory, legacy) {
  await memory.migrate(legacy)
  const members = legacy?.members ?? {}
  const saved = await memory.context(Object.keys(members))
  for (const [id, member] of Object.entries(members)) {
    for (const note of member.notes ?? []) {
      if (saved.notes[id]?.[note.topic] !== note.text) {
        throw new Error(`legacy_memory_conflict: ${id}; resolve MEMORY.md before clearing the old snapshot`)
      }
    }
  }
}
