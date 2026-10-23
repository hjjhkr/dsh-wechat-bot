const encode = text => new TextEncoder().encode(text)

export class PageLifetime {
  #enabled
  #exit
  #shutdown
  #onError
  #graceMs
  #heartbeatMs
  #setTimeout
  #clearTimeout
  #setInterval
  #clearInterval
  #connections = new Set()
  #hasSeenPage = false
  #exitTimer = null
  #exitPromise = null
  #quiescing = false
  #error = null
  #disposed = false

  constructor({
    enabled = false,
    exit,
    shutdown,
    onError = () => {},
    graceMs = 5000,
    heartbeatMs = 15000,
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
  } = {}) {
    if (enabled && typeof exit !== 'function') {
      throw new TypeError('exitWithPage requires the DSH appExit function')
    }
    if (enabled && typeof shutdown !== 'function') {
      throw new TypeError('exitWithPage requires a safe shutdown function')
    }
    this.#enabled = enabled
    this.#exit = exit
    this.#shutdown = shutdown
    this.#onError = onError
    this.#graceMs = graceMs
    this.#heartbeatMs = heartbeatMs
    this.#setTimeout = setTimeoutFn
    this.#clearTimeout = clearTimeoutFn
    this.#setInterval = setIntervalFn
    this.#clearInterval = clearIntervalFn
  }

  snapshot() {
    return {
      enabled: this.#enabled,
      pages: this.#connections.size,
      closing: this.#exitTimer !== null || this.#quiescing,
      quiescing: this.#quiescing,
      error: this.#error,
    }
  }

  handle(request) {
    if (!this.#enabled) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    if (this.#disposed) return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } })
    if (this.#quiescing) return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } })

    this.#hasSeenPage = true
    this.#cancelExit()
    let connection
    const body = new ReadableStream({
      start: controller => {
        connection = { controller, signal: request.signal, abort: null, heartbeat: null, closed: false }
        this.#connections.add(connection)
        connection.abort = () => this.#close(connection, true)
        request.signal.addEventListener('abort', connection.abort, { once: true })
        if (request.signal.aborted) {
          connection.abort()
          return
        }
        controller.enqueue(encode('retry: 1000\n: connected\n\n'))
        connection.heartbeat = this.#setInterval(() => {
          if (!connection.closed) controller.enqueue(encode(': keep-alive\n\n'))
        }, this.#heartbeatMs)
      },
      cancel: () => this.#close(connection),
    })

    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#cancelExit()
    for (const connection of [...this.#connections]) this.#close(connection, true)
  }

  #close(connection, closeStream = false) {
    if (connection.closed) return
    connection.closed = true
    if (connection.heartbeat !== null) this.#clearInterval(connection.heartbeat)
    connection.signal.removeEventListener('abort', connection.abort)
    this.#connections.delete(connection)
    if (closeStream) connection.controller.close()
    if (!this.#disposed && this.#hasSeenPage && this.#connections.size === 0) this.#scheduleExit()
  }

  #scheduleExit() {
    if (this.#exitTimer !== null || this.#disposed) return
    this.#exitTimer = this.#setTimeout(() => {
      this.#exitTimer = null
      if (!this.#disposed && this.#hasSeenPage && this.#connections.size === 0) this.#beginExit()
    }, this.#graceMs)
  }

  #beginExit() {
    if (this.#exitPromise || this.#disposed) return
    this.#error = null
    this.#quiescing = true
    this.#exitPromise = (async () => {
      try {
        await this.#shutdown()
        await this.#exit(0)
      } catch (error) {
        this.#error = String(error?.message ?? error)
        this.#quiescing = false
        this.#exitPromise = null
        this.#onError(error)
      }
    })()
  }

  #cancelExit() {
    if (this.#exitTimer === null) return
    this.#clearTimeout(this.#exitTimer)
    this.#exitTimer = null
  }
}

export function registerPageLifetimeRoute(fetchRegistry, pageLifetime) {
  return fetchRegistry.register({
    path: '/api/wechat-bot.page-lifetime', methods: ['GET'], requestBody: 'buffered',
    fetch: request => pageLifetime.handle(request),
  })
}

export async function disposeInReverseOrder(disposers) {
  const failures = []
  for (const dispose of [...disposers].reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'route disposal failed')
}

export function createHostDisposer({ disposeRoutes, pageLifetime, app }) {
  let disposal
  return () => {
    if (disposal) return disposal
    disposal = (async () => {
      const failures = []
      try { await disposeRoutes() } catch (error) { failures.push(error) }
      try { pageLifetime.dispose() } catch (error) { failures.push(error) }
      try { await app.dispose() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'wechat-bot disposal failed')
    })()
    return disposal
  }
}
