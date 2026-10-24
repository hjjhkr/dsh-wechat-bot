import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeText } from './files.js'
import { MarkdownMemory } from './markdown-memory.js'

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

const writeJson = (path, value) => writeText(path, JSON.stringify(value, null, 1))

// Plugin state under one data directory: `bot.json` for settings changed by the
// console, commands and onboarding; `chats/<hash>.json` for each chat's controls
// (mode, mute, /cron, …: raw conversations are never written to disk);
// `memories/<hash>/…/MEMORY.md` for members' long-term notes.
// Chat writes are coalesced and serialized per file.
export class Store {
  #timers = new Map()
  #pending = new Map()
  #chains = new Map()
  #memories = new Map()
  #legacy = new Map() // chat file → old in-state memory that could not be migrated yet

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

  // `onProblem` reports memory files that cannot be read (first caller's is kept).
  memoryFor(chatId, onProblem) {
    const key = basename(this.chatPath(chatId), '.json')
    if (!this.#memories.has(key)) this.#memories.set(key, new MarkdownMemory(this.dir, key))
    const memory = this.#memories.get(key)
    if (onProblem) memory.onProblem = onProblem
    return memory
  }

  // A state written by an older version may still hold memory and history: the memory
  // moves to MEMORY.md files and the file is rewritten with the controls only. Memory that
  // cannot be migrated yet is kept (as legacyMemory) and tried again on the next load.
  async loadChat(chatId) {
    const path = this.chatPath(chatId)
    const state = await readJson(path, {})
    const legacy = state.memory ?? state.legacyMemory
    if (legacy || state.transcript || state.log) {
      if (!legacy || await this.memoryFor(chatId).migrate(legacy)) this.#legacy.delete(path)
      else this.#legacy.set(path, legacy)
      await this.#serialize(path, () => writeJson(path, this.#durable(path, state)))
    }
    return state
  }

  #durable(path, state) {
    const legacy = this.#legacy.get(path)
    return { ...durableState(state), ...(legacy ? { legacyMemory: legacy } : {}) }
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
      await writeJson(path, this.#durable(path, typeof value === 'function' ? value() : value))
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
