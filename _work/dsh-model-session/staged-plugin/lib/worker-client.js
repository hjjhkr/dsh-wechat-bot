import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const METHODS = new Set(['probe', 'baseline', 'poll', 'send', 'close', 'conversations', 'select'])

export class WorkerError extends Error {
  constructor(code = 'worker_unavailable') {
    super(code)
    this.name = 'WorkerError'
    this.code = code
  }
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(value) ? value : 'worker_error'
}

function waitForEvent(emitter, event, timeoutMs, rejectEvents = ['error']) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new WorkerError('worker_start_timeout')), timeoutMs)
    const cleanups = []
    const finish = (error, value) => {
      clearTimeout(timer)
      for (const cleanup of cleanups) cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    const onTarget = (...args) => finish(null, args)
    emitter.once(event, onTarget)
    cleanups.push(() => emitter.removeListener(event, onTarget))
    for (const rejectEvent of rejectEvents) {
      const onReject = () => finish(new WorkerError('worker_start_failed'))
      emitter.once(rejectEvent, onReject)
      cleanups.push(() => emitter.removeListener(rejectEvent, onReject))
    }
  })
}

export class JsonlWorkerClient {
  #child
  #reader
  #pending = new Map()
  #closed = false
  #closing = false
  #closeAcknowledged = false
  #closeResult = null

  constructor(child) {
    this.#child = child
    this.#reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.#reader.on('line', (line) => this.#onLine(line))
    this.#reader.on('close', () => this.#failAll(new WorkerError('worker_stdout_closed')))
    child.stderr.on('data', () => {}) // Keep the pipe drained; stderr may contain private text.
    child.on('error', () => this.#failAll(new WorkerError('worker_process_error')))
    child.on('exit', () => {
      this.#closed = true
      this.#failAll(new WorkerError(this.#closeAcknowledged ? 'worker_process_exited' : 'worker_close_unconfirmed'))
    })
  }

  static async start(config) {
    if (!config?.pythonExe || !config?.workerScript) throw new WorkerError('worker_config_missing')
    const child = spawn(config.pythonExe, ['-u', '-B', '-X', 'utf8', config.workerScript], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new JsonlWorkerClient(child)
    try {
      await waitForEvent(child, 'spawn', 10000)
      return client
    } catch (error) {
      child.kill()
      throw error
    }
  }

  #onLine(line) {
    let packet
    try {
      packet = JSON.parse(line)
    } catch {
      this.#failAll(new WorkerError('worker_protocol_invalid'))
      return
    }
    const pending = this.#pending.get(packet?.id)
    if (!pending) return
    this.#pending.delete(packet.id)
    clearTimeout(pending.timer)
    if (packet.error !== undefined) {
      pending.reject(new WorkerError(safeCode(packet.error?.code)))
      return
    }
    if (!Object.hasOwn(packet, 'result')) {
      pending.reject(new WorkerError('worker_protocol_invalid'))
      return
    }
    pending.resolve(packet.result)
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  request(method, params = {}, timeoutMs = 30000) {
    if (!METHODS.has(method)) return Promise.reject(new WorkerError('worker_method_invalid'))
    if (this.#closed || this.#closing || !this.#child.stdin.writable) return Promise.reject(new WorkerError('worker_unavailable'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new WorkerError(method === 'send' ? 'send_result_unknown' : 'worker_request_timeout'))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new WorkerError('worker_write_failed'))
      })
    })
  }

  async close() {
    if (this.#closed) {
      if (this.#closeAcknowledged && this.#closeResult?.closed === true && this.#closeResult?.gateActive === false && this.#closeResult?.gateRestored === true) return this.#closeResult
      throw new WorkerError('worker_close_unconfirmed')
    }
    if (this.#closing) throw new WorkerError('worker_close_unconfirmed')
    this.#closing = true
    let result
    try {
      // Allow the worker's independent 30 second gate watchdog to restore before it exits.
      result = await new Promise((resolve, reject) => {
        const id = randomUUID()
        const timeoutMs = 35000
        const timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new WorkerError('worker_close_unconfirmed'))
        }, timeoutMs)
        this.#pending.set(id, { resolve, reject, timer })
        this.#child.stdin.write(`${JSON.stringify({ id, method: 'close', params: {} })}\n`, (error) => {
          if (!error) return
          const pending = this.#pending.get(id)
          if (!pending) return
          this.#pending.delete(id)
          clearTimeout(timer)
          reject(new WorkerError('worker_close_unconfirmed'))
        })
      })
    } catch {
      throw new WorkerError('worker_close_unconfirmed')
    }
    if (result?.closed !== true || result?.gateActive !== false || result?.gateRestored !== true) throw new WorkerError('worker_close_unconfirmed')
    this.#closeAcknowledged = true
    this.#closeResult = result
    this.#child.stdin.end()
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new WorkerError('worker_exit_unconfirmed')), 5000)
        const onExit = () => finish(null)
        const finish = (error) => {
          clearTimeout(timer)
          this.#child.removeListener('exit', onExit)
          if (error) reject(error)
          else resolve()
        }
        this.#child.once('exit', onExit)
      })
    }
    if (!this.#closed) throw new WorkerError('worker_exit_unconfirmed')
    this.#closed = true
    return result
  }
}
