import assert from 'node:assert/strict'
import test from 'node:test'
import * as pageLifetime from '../lib/page-lifetime.js'

const { PageLifetime } = pageLifetime

function fakeClock() {
  let nextId = 1
  let now = 0
  const timers = new Map()
  return {
    setTimeout(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const target = now + ms
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        timers.delete(id)
        now = timer.at
        timer.callback()
      }
      now = target
    },
  }
}

function createLifetime(options) {
  return new PageLifetime(options)
}

function makeLifetime(overrides = {}) {
  const clock = fakeClock()
  const exits = []
  const lifetime = createLifetime({
    enabled: true,
    exit: code => exits.push(code),
    shutdown: async () => {},
    graceMs: 5000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    ...overrides,
  })
  return { clock, exits, lifetime }
}

function pageRequest(signal = new AbortController().signal) {
  return new Request('http://127.0.0.1/api/wechat-bot.page-lifetime', { signal })
}

test('startup without any page connection never schedules process exit', () => {
  const { clock, exits, lifetime } = makeLifetime()

  assert.deepEqual(lifetime.snapshot(), { enabled: true, pages: 0, closing: false, quiescing: false, error: null })
  clock.advance(5000)
  assert.deepEqual(exits, [])
  lifetime.dispose()
})

test('closing one of multiple pages waits for the last page and exits after five seconds', async () => {
  const { clock, exits, lifetime } = makeLifetime()
  const first = lifetime.handle(pageRequest()).body.getReader()
  const second = lifetime.handle(pageRequest()).body.getReader()
  await first.read()
  await second.read()

  await first.cancel()
  assert.deepEqual(lifetime.snapshot(), { enabled: true, pages: 1, closing: false, quiescing: false, error: null })
  assert.deepEqual(exits, [])

  await second.cancel()
  assert.deepEqual(lifetime.snapshot(), { enabled: true, pages: 0, closing: true, quiescing: false, error: null })
  clock.advance(4999)
  assert.deepEqual(exits, [])
  clock.advance(1)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.deepEqual(exits, [0])
})

test('the final-page grace waits for safe shutdown acknowledgement before requesting app exit', async () => {
  const shutdown = Promise.withResolvers()
  let shutdownStarted = false
  const { clock, exits, lifetime } = makeLifetime({
    shutdown: () => { shutdownStarted = true; return shutdown.promise },
  })
  const reader = lifetime.handle(pageRequest()).body.getReader()
  await reader.read()
  await reader.cancel()

  clock.advance(5000)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.equal(shutdownStarted, true, 'the grace expiry begins safe shutdown')
  assert.deepEqual(exits, [])
  assert.equal(lifetime.snapshot().quiescing, true)

  shutdown.resolve()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.deepEqual(exits, [0])
})

test('a failed safe shutdown is reported and keeps the DSH process alive', async () => {
  const errors = []
  const { clock, exits, lifetime } = makeLifetime({
    shutdown: async () => { throw new Error('delivery.close failed') },
    onError: error => errors.push(error.message),
  })
  const reader = lifetime.handle(pageRequest()).body.getReader()
  await reader.read()
  await reader.cancel()

  clock.advance(5000)
  for (let i = 0; i < 5; i++) await Promise.resolve()

  assert.deepEqual(exits, [])
  assert.deepEqual(errors, ['delivery.close failed'])
  assert.equal(lifetime.snapshot().error, 'delivery.close failed')
  assert.equal(lifetime.snapshot().quiescing, false)
})

test('a refresh reconnect during the grace period cancels exit and starts a fresh five-second window later', async () => {
  const { clock, exits, lifetime } = makeLifetime()
  const original = lifetime.handle(pageRequest()).body.getReader()
  await original.read()
  await original.cancel()

  const refreshed = lifetime.handle(pageRequest()).body.getReader()
  await refreshed.read()
  assert.deepEqual(lifetime.snapshot(), { enabled: true, pages: 1, closing: false, quiescing: false, error: null })
  clock.advance(5000)
  assert.deepEqual(exits, [])

  await refreshed.cancel()
  clock.advance(4999)
  assert.deepEqual(exits, [])
  clock.advance(1)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.deepEqual(exits, [0])
})

test('aborting the authenticated page request releases its connection and begins the grace period', async () => {
  const { clock, exits, lifetime } = makeLifetime()
  const abort = new AbortController()
  const response = lifetime.handle(pageRequest(abort.signal))
  const reader = response.body.getReader()
  await reader.read()

  abort.abort()

  assert.equal((await reader.read()).done, true)
  assert.deepEqual(lifetime.snapshot(), { enabled: true, pages: 0, closing: true, quiescing: false, error: null })
  clock.advance(5000)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.deepEqual(exits, [0])
})

test('disposing the host fiber closes page streams without requesting process exit', async () => {
  const { clock, exits, lifetime } = makeLifetime()
  const reader = lifetime.handle(pageRequest()).body.getReader()
  await reader.read()

  lifetime.dispose()

  assert.equal((await reader.read()).done, true)
  assert.deepEqual(lifetime.snapshot(), { enabled: true, pages: 0, closing: false, quiescing: false, error: null })
  clock.advance(5000)
  assert.deepEqual(exits, [])
})

test('disabled page lifetime returns without opening a lease or exiting', async () => {
  const exits = []
  const lifetime = createLifetime({ enabled: false, exit: code => exits.push(code) })
  const response = lifetime.handle(pageRequest())

  assert.equal(response.status, 204)
  assert.deepEqual(lifetime.snapshot(), { enabled: false, pages: 0, closing: false, quiescing: false, error: null })
  lifetime.dispose()
  assert.deepEqual(exits, [])
})

test('registered route disposers run sequentially in reverse registration order', async () => {
  const releaseLast = Promise.withResolvers()
  const events = []
  const disposal = pageLifetime.disposeInReverseOrder([
    async () => { events.push('first route') },
    async () => { events.push('last route started'); await releaseLast.promise; events.push('last route finished') },
  ])
  await Promise.resolve()

  assert.deepEqual(events, ['last route started'])
  releaseLast.resolve()
  await disposal
  assert.deepEqual(events, ['last route started', 'last route finished', 'first route'])
})

test('the host disposer waits for app cleanup after stopping routes and page streams', async () => {
  assert.equal(typeof pageLifetime.createHostDisposer, 'function')
  const events = []
  const routeCleanup = Promise.withResolvers()
  let finishAppCleanup
  const dispose = pageLifetime.createHostDisposer({
    disposeRoutes: async () => { events.push('routes started'); await routeCleanup.promise; events.push('routes finished') },
    pageLifetime: { dispose: () => events.push('page streams') },
    app: { dispose: () => {
      events.push('app cleanup started')
      return new Promise(resolve => { finishAppCleanup = () => { events.push('app cleanup finished'); resolve() } })
    } },
  })
  let settled = false
  const first = dispose()
  const second = dispose()
  assert.strictEqual(second, first, 'host lifecycle disposal shares one cleanup promise')
  const pending = first.then(() => { settled = true })
  await Promise.resolve()

  assert.deepEqual(events, ['routes started'])
  assert.equal(settled, false)
  routeCleanup.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['routes started', 'routes finished', 'page streams', 'app cleanup started'])
  finishAppCleanup()
  await pending
  assert.equal(settled, true)
  assert.deepEqual(events, ['routes started', 'routes finished', 'page streams', 'app cleanup started', 'app cleanup finished'])
})

test('the page lease registers a GET fetch handler and returns its route disposer', async () => {
  assert.equal(typeof pageLifetime.registerPageLifetimeRoute, 'function')
  let registered
  let receivedRequest
  let removed = false
  const request = pageRequest()
  const dispose = pageLifetime.registerPageLifetimeRoute({
    register: route => { registered = route; return () => { removed = true } },
  }, {
    handle: value => { receivedRequest = value; return new Response('lease') },
  })

  assert.equal(registered.path, '/api/wechat-bot.page-lifetime')
  assert.deepEqual(registered.methods, ['GET'])
  assert.equal(registered.requestBody, 'buffered')
  assert.equal(await (await registered.fetch(request)).text(), 'lease')
  assert.equal(receivedRequest, request)
  dispose()
  assert.equal(removed, true)
})

test('enabling page exit requires the DSH appExit service', () => {
  assert.throws(() => new PageLifetime({ enabled: true }), /appExit/)
})

test('the page lease is an uncacheable SSE response with a one-second reconnect hint', async () => {
  const { lifetime } = makeLifetime()
  const response = lifetime.handle(pageRequest())
  const reader = response.body.getReader()
  const firstChunk = await reader.read()

  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(new TextDecoder().decode(firstChunk.value), 'retry: 1000\n: connected\n\n')
  await reader.cancel()
  lifetime.dispose()
})
