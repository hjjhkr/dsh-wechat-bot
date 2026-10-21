import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const STATE_VERSION = 1

export class StateError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StateError'
    this.code = code
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function initialState() {
  return {
    version: STATE_VERSION,
    phase: 'stopped',
    runRequested: false,
    autoSendEnabled: false,
    sendGrant: null,
    cursor: null,
    lastPollAt: null,
    lastErrorCode: null,
    workerBound: false,
    workerClosed: true,
    gateActive: false,
    inbox: [],
    outbox: [],
  }
}

function validateState(value) {
  if (!value || value.version !== STATE_VERSION || !Array.isArray(value.inbox) || !Array.isArray(value.outbox)) {
    throw new StateError('state_file_invalid')
  }
  if (!['stopped', 'starting', 'running', 'paused', 'error'].includes(value.phase)) {
    throw new StateError('state_file_invalid')
  }
  if (value.gateActive !== true && value.gateActive !== false && value.gateActive !== null) {
    throw new StateError('state_file_invalid')
  }
  if (!Object.hasOwn(value, 'sendGrant')) value.sendGrant = null
  if (value.sendGrant !== null && (
    typeof value.sendGrant !== 'object' ||
    !/^[a-f0-9]{64}$/.test(value.sendGrant.scopeHash) ||
    typeof value.sendGrant.grantedAt !== 'string'
  )) throw new StateError('state_file_invalid')
  return value
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) throw new StateError('state_file_invalid')
    throw error
  }
}

export async function atomicWrite(file, data) {
  const dir = dirname(file)
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function acquireLock(lockPath) {
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(owner, 'utf8')
      await handle.sync()
      return { handle, owner }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existingText = await readFile(lockPath, 'utf8').catch((readError) => {
        if (readError?.code === 'ENOENT') return null
        throw readError
      })
      if (existingText === null) continue
      let existing
      try {
        existing = JSON.parse(existingText)
      } catch {
        throw new StateError('state_lock_unreadable')
      }
      if (!Number.isInteger(existing?.pid) || existing.pid < 1) throw new StateError('state_lock_unreadable')
      let alive = true
      try {
        process.kill(existing.pid, 0)
      } catch (probeError) {
        if (probeError?.code === 'ESRCH') alive = false
      }
      if (alive) throw new StateError('state_already_open')
      const checkAgain = await readFile(lockPath, 'utf8').catch((readError) => {
        if (readError?.code === 'ENOENT') return null
        throw readError
      })
      if (checkAgain === existingText) await unlink(lockPath).catch((removeError) => {
        if (removeError?.code !== 'ENOENT') throw removeError
      })
    }
  }
  throw new StateError('state_already_open')
}

export class StateStore {
  #state
  #lock
  #lockPath
  #statePath
  #tail = Promise.resolve()
  #closed = false

  constructor(root, lock, state) {
    this.root = root
    this.#statePath = join(root, 'state.json')
    this.#lockPath = join(root, 'state.lock')
    this.#lock = lock
    this.#state = validateState(state)
  }

  static async open(root) {
    if (!root) throw new StateError('state_root_missing')
    await mkdir(root, { recursive: true })
    const lockPath = join(root, 'state.lock')
    const lock = await acquireLock(lockPath)
    try {
      const statePath = join(root, 'state.json')
      const loaded = await readJson(statePath)
      const state = loaded === undefined ? initialState() : validateState(loaded)
      if (loaded === undefined) await atomicWrite(statePath, state)
      return new StateStore(root, lock, state)
    } catch (error) {
      await lock.handle.close().catch(() => {})
      const current = await readFile(lockPath, 'utf8').catch(() => '')
      if (current === lock.owner) await unlink(lockPath).catch(() => {})
      throw error
    }
  }

  snapshot() {
    return clone(this.#state)
  }

  async transact(mutator) {
    const run = this.#tail.then(async () => {
      if (this.#closed) throw new StateError('state_store_closed')
      const next = clone(this.#state)
      const result = await mutator(next)
      validateState(next)
      await atomicWrite(this.#statePath, next)
      this.#state = next
      return result
    })
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }

  async close() {
    if (this.#closed) return
    await this.#tail
    this.#closed = true
    await this.#lock.handle.close().catch(() => {})
    const current = await readFile(this.#lockPath, 'utf8').catch(() => '')
    if (current === this.#lock.owner) await unlink(this.#lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

export function dedupeKey(message) {
  return JSON.stringify([message.bot, message.target, message.shard, message.local_id, message.sort_seq])
}

export function hasUncertainSend(state) {
  return state.outbox.some((item) => item.status === 'attempted' || item.status === 'ambiguous')
}
