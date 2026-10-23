import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { JsonRpcPeer } from './rpc.js'
import {
  PROTOCOL_VERSION, ProtocolError, parseAccount, parseCapabilities, parseChat, parseMessage, parseOutgoing, parsePerson, parseStatus,
} from './protocol.js'

// Typed plugin-side view of an adapter. Emits:
//   'message' (Message), 'status' (Status), 'account' (Account), 'log' ({ level, message }), 'close' ()
export class AdapterClient extends EventEmitter {
  info = null
  capabilities = parseCapabilities()
  #inFlightSends = new Set()
  #sendAdmissionClosed = false

  constructor(peerOptions, { timeoutMs = 30_000, sendTimeoutMs = 90_000 } = {}) {
    super()
    this.timeoutMs = timeoutMs
    this.sendTimeoutMs = sendTimeoutMs
    this.peer = new JsonRpcPeer({
      ...peerOptions,
      onNotification: (method, params) => this.#notification(method, params),
      onInvalidLine: line => this.emit('log', { level: 'warn', message: `adapter wrote a non-protocol line: ${line.slice(0, 200)}` }),
    })
    this.peer.closed.then(() => this.emit('close'))
  }

  #notification(method, params) {
    try {
      if (method === 'event/message') this.emit('message', parseMessage(params.message))
      else if (method === 'event/status') this.emit('status', parseStatus(params))
      else if (method === 'event/account') this.emit('account', parseAccount(params))
      else if (method === 'event/log') this.emit('log', { level: params.level ?? 'info', message: String(params.message ?? '') })
    } catch (error) {
      this.emit('log', { level: 'warn', message: `adapter sent invalid ${method}: ${error.message}` })
    }
  }

  #call(method, params, timeoutMs = this.timeoutMs) {
    return this.peer.request(method, params, { timeoutMs })
  }

  async initialize({ dataDir, client }) {
    const result = await this.#call('initialize', { protocolVersion: PROTOCOL_VERSION, dataDir, client })
    if (result?.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolError('protocol_mismatch', `adapter speaks protocol ${result?.protocolVersion}, expected ${PROTOCOL_VERSION}`)
    }
    this.info = { name: String(result.adapter?.name ?? 'unknown'), version: String(result.adapter?.version ?? '') }
    this.capabilities = parseCapabilities(result.capabilities)
    return this.info
  }

  async accountStatus() {
    return parseAccount(await this.#call('account/status'))
  }

  async login() {
    return parseAccount(await this.#call('account/login'))
  }

  async listChats(query) {
    const { chats } = await this.#call('chats/list', query ? { query } : {})
    return chats.map(parseChat)
  }

  async members(chatId) {
    const { members } = await this.#call('chats/members', { chatId })
    return members.flatMap(m => {
      try {
        return [parsePerson({ ...m, id: m?.id == null ? m?.id : String(m.id) }, 'member')]
      } catch {
        return [] // one malformed entry must not hide the others
      }
    })
  }

  async history(chatId, limit) {
    if (!this.capabilities.history) return []
    const { messages } = await this.#call('chats/history', { chatId, limit })
    return messages.map(parseMessage)
  }

  async watch(chatIds) {
    const { watching } = await this.#call('watch/set', { chatIds })
    return watching
  }

  async #sendRequest(chatId, clientId, content) {
    return this.#call('message/send', { chatId, clientId, content: parseOutgoing(content) }, this.sendTimeoutMs)
  }

  send(chatId, clientId, content) {
    if (this.#sendAdmissionClosed) {
      return Promise.reject(new ProtocolError('closed', 'adapter is shutting down'))
    }
    const request = this.#sendRequest(chatId, clientId, content)
    let tracked
    tracked = request.finally(() => this.#inFlightSends.delete(tracked))
    this.#inFlightSends.add(tracked)
    return tracked
  }

  async waitForSends() {
    while (this.#inFlightSends.size > 0) {
      await Promise.allSettled([...this.#inFlightSends])
    }
  }

  async fetchMedia(chatId, messageId) {
    if (!this.capabilities.mediaFetch) throw new ProtocolError('unsupported', 'adapter cannot fetch media')
    return this.#call('media/fetch', { chatId, messageId })
  }

  async windowState() {
    if (!this.capabilities.window) throw new ProtocolError('unsupported', 'adapter cannot control the window')
    return this.#call('window/get')
  }

  async setWindowVisible(visible) {
    if (!this.capabilities.window) throw new ProtocolError('unsupported', 'adapter cannot control the window')
    return this.#call('window/set', { visible })
  }

  // Simulator-only extension used by the console's test panel.
  async simulate(params) {
    if (!this.capabilities.simulator) throw new ProtocolError('unsupported', 'adapter is not a simulator')
    return this.#call('sim/inject', params)
  }

  async shutdown(options = {}) {
    if (options?.strict === true) {
      this.#sendAdmissionClosed = true
      await this.waitForSends()
      const timeoutMs = options.timeoutMs ?? 30_000
      const result = await this.#call('shutdown', {}, timeoutMs)
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new ProtocolError('invalid_response', 'adapter shutdown acknowledgement was invalid')
      }
      return result
    }
    try {
      await this.#call('shutdown', {}, 5_000)
    } catch {}
    this.peer.close()
  }
}

// Launches an adapter executable speaking the protocol on stdio.
export function spawnAdapter({ command, args = [], cwd, env }, options) {
  const child = spawn(command, args, {
    cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const client = new AdapterClient({ input: child.stdout, output: child.stdin }, options)
  createInterface({ input: child.stderr }).on('line', line => client.emit('log', { level: 'debug', message: line }))
  // Writing to a process that just died must not crash the host.
  child.stdin.on('error', () => client.peer.close())
  let strictShutdownRequested = false
  let peerCloseKillTimer
  let startError
  // A closed connection means the process is of no further use; never leave it running.
  client.peer.closed.then(() => {
    if (!strictShutdownRequested && child.exitCode === null && child.signalCode === null) {
      peerCloseKillTimer = setTimeout(() => {
        if (!strictShutdownRequested && child.exitCode === null && child.signalCode === null) child.kill()
      }, 1_000)
      peerCloseKillTimer.unref()
    }
  })
  // Resolves with the exit code (or null if the process never started).
  client.exited = new Promise(resolve => {
    child.once('error', error => {
      startError = error
      client.emit('log', { level: 'error', message: `adapter failed to start: ${error.message}` })
      client.peer.close()
      resolve(null)
    })
    child.once('exit', code => {
      client.peer.close()
      resolve(code)
    })
  })
  const shutdown = client.shutdown.bind(client)
  client.shutdown = async (shutdownOptions = {}) => {
    if (shutdownOptions?.strict === true) {
      strictShutdownRequested = true
      if (peerCloseKillTimer) clearTimeout(peerCloseKillTimer)
      const timeoutMs = shutdownOptions.timeoutMs ?? 30_000
      try {
        await shutdown({ ...shutdownOptions, timeoutMs })
      } catch (error) {
        if (startError) {
          throw new Error(`adapter process failed before shutdown acknowledgement: ${startError.message}`, { cause: error })
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `adapter exited before shutdown acknowledgement (exitCode=${child.exitCode}, signal=${child.signalCode})`,
            { cause: error },
          )
        }
        throw error
      }
      let exitCode
      try {
        exitCode = await waitForChildExit(client.exited, timeoutMs)
      } catch (error) {
        if (startError) {
          throw new Error(`adapter process failed while shutting down: ${startError.message}`, { cause: error })
        }
        throw error
      }
      if (exitCode !== 0) {
        throw new Error(`adapter exited after shutdown with code ${exitCode ?? 'unknown'} (signal=${child.signalCode})`)
      }
      return
    }
    await shutdown(shutdownOptions)
    const timer = setTimeout(() => child.kill(), 3_000)
    await client.exited
    clearTimeout(timer)
  }
  return client
}

function waitForChildExit(exited, timeoutMs) {
  let timer
  return Promise.race([
    exited,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`adapter process did not exit within ${timeoutMs}ms after shutdown`)), timeoutMs)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}
