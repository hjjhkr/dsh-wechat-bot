import { createInterface } from 'node:readline'
import { ProtocolError } from './protocol.js'

// A symmetric JSON-RPC 2.0 peer over newline-delimited JSON streams.
// Both the plugin (client) and adapters (server) use it.
export class JsonRpcPeer {
  #nextId = 1
  #pending = new Map()
  #handlers = new Map()
  #notificationListener
  #output
  #lines
  #closed = false

  constructor({ input, output, onNotification, onInvalidLine }) {
    this.#output = output
    this.#notificationListener = onNotification
    this.#lines = createInterface({ input, crlfDelay: Infinity })
    this.#lines.on('line', line => this.#receive(line, onInvalidLine))
    this.closed = new Promise(resolve => this.#lines.once('close', () => {
      this.#fail(new ProtocolError('closed', 'adapter connection closed'))
      resolve()
    }))
  }

  handle(method, handler) {
    this.#handlers.set(method, handler)
    return this
  }

  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(new ProtocolError('closed', 'adapter connection closed'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new ProtocolError('timeout', `${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params = {}) {
    if (!this.#closed) this.#write({ jsonrpc: '2.0', method, params })
  }

  close() {
    this.#lines.close()
  }

  #write(frame) {
    this.#output.write(JSON.stringify(frame) + '\n')
  }

  #fail(error) {
    this.#closed = true
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.#pending.clear()
  }

  #receive(line, onInvalidLine) {
    if (!line.trim()) return
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      onInvalidLine?.(line)
      return
    }
    if (frame?.jsonrpc !== '2.0') return onInvalidLine?.(line)
    if ('method' in frame) return this.#dispatch(frame)
    const pending = this.#pending.get(frame.id)
    if (!pending) return
    this.#pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.error) {
      const { code, message, data } = frame.error
      pending.reject(new ProtocolError(data?.code ?? String(code), message, data))
    } else {
      pending.resolve(frame.result)
    }
  }

  async #dispatch({ id, method, params }) {
    if (id === undefined) return this.#notificationListener?.(method, params ?? {})
    const handler = this.#handlers.get(method)
    try {
      if (!handler) throw new ProtocolError('method_not_found', `unknown method ${method}`)
      const result = await handler(params ?? {})
      this.#write({ jsonrpc: '2.0', id, result: result ?? {} })
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : 'internal_error'
      this.#write({ jsonrpc: '2.0', id, error: {
        code: code === 'method_not_found' ? -32601 : -32000,
        message: error.message,
        data: { code, ...(error.data ?? {}) },
      } })
    }
  }
}
