import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../client/index.js', import.meta.url), 'utf8')

function makeState(reason, { chat = null, completed = true, pageLifetime = { enabled: false, pages: 0, closing: false } } = {}) {
  return {
    setup: { completedAt: completed ? '2026-10-22T00:00:00Z' : null, workspace: 'workspace' },
    here: { workspace: 'workspace' },
    account: { state: 'ready', self: { name: '初号机' } },
    adapter: { name: 'wechat-db', version: '1.0' },
    capabilities: {},
    model: { model: 'test-model', reasoningEffort: 'medium' },
    connection: {
      state: 'connected', canSend: false,
      reason, detail: '目标窗口没有准备好：测试说明',
    },
    pageLifetime,
    chat,
    recoveries: 0,
    log: [],
  }
}

async function renderClient(state, { pageResponses = [], pendingPageState = false } = {}) {
  const instances = new Map()
  const pendingEffects = []
  const clientEffects = []
  const clientDisposers = []
  const requests = []
  const pageRequests = []
  const pageStreams = []
  const warnings = []
  const errors = []
  const timers = new Map()
  let nextTimerId = 0
  let pageResponseIndex = 0
  let pageStateReads = 0
  let active = null
  let extension
  let body

  function renderComponent(component, props, path) {
    let instance = instances.get(path)
    if (!instance) {
      instance = { path, hooks: [], index: 0 }
      instances.set(path, instance)
    }
    const previous = active
    active = instance
    instance.index = 0
    try { return component(props) } finally { active = previous }
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        const parentPath = active?.path ?? 'root'
        return renderComponent(type, props ?? {}, `${parentPath}/${type.name}:${props?.key ?? ''}`)
      }
      return { type, props: props ?? {}, children: children.flat().filter(child => child !== false && child != null) }
    },
    useState(initial) {
      const instance = active
      const index = instance.index++
      if (!Object.hasOwn(instance.hooks, index)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [instance.hooks[index], value => {
        instance.hooks[index] = typeof value === 'function' ? value(instance.hooks[index]) : value
      }]
    },
    useEffect(effect, deps) {
      const instance = active
      const index = instance.index++
      const previous = instance.hooks[index]
      const changed = !previous || !deps || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))
      if (changed) {
        instance.hooks[index] = { deps }
        pendingEffects.push(async () => {
          const cleanup = effect()
          if (typeof cleanup === 'function') instance.hooks[index].cleanup = cleanup
          for (let i = 0; i < 5; i++) await Promise.resolve()
        })
      }
    },
  }

  const sandbox = {
    window: { __ModuleLoader__: { load: module => { extension = module.factory(id => {
      assert.equal(id, 'react')
      return React
    }) } } },
    fetch: async (url, init = {}) => {
      if (url === '/api/wechat-bot.page-lifetime') {
        pageRequests.push({ url, init })
        const next = pageResponses[pageResponseIndex++]
        return typeof next === 'function' ? next(init, pageStreams) : next ?? { status: 204, headers: { get: () => null }, body: null }
      }
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        requests.push(body)
        return { ok: true, json: async () => ({ ok: true, result: body.action === 'windowState'
          ? { visible: false, running: true } : body.action === 'window' ? { visible: body.visible, running: true } : {} }) }
      }
      if (url.startsWith('/api/wechat-bot.state')) {
        if (url === '/api/wechat-bot.state') pageStateReads++
        if (pendingPageState) return new Promise(() => {})
        return { ok: true, json: async () => state }
      }
      if (url === '/api/wechat-bot.log') return { ok: true, json: async () => ({ entries: [] }) }
      throw new Error(`unexpected request: ${url}`)
    },
    EventSource: class FakeEventSource {
      constructor(url) { this.url = url }
      close() {}
    },
    document: { visibilityState: 'hidden' },
    AbortController,
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout: id => timers.delete(id),
    setInterval: () => 1,
    clearInterval() {},
    console: { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
  }
  vm.runInNewContext(clientSource, sandbox, { filename: 'client/index.js' })

  extension.apply({
    effect: effect => {
      const result = effect()
      if (result && typeof result.then === 'function') {
        clientEffects.push(result.then(disposer => {
          if (typeof disposer === 'function') clientDisposers.push(disposer)
        }))
      } else if (typeof result === 'function') clientDisposers.push(result)
      return result
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { mounted: { getSnapshot: () => null }, openTab() {} },
    slots: {
      inject(_name, callback) { callback() },
      register(_spec, component) { body = component; return () => {} },
    },
  })
  await Promise.all(clientEffects)
  assert.equal(typeof body, 'function')

  let tree
  for (let i = 0; i < 5; i++) {
    tree = body({ sessionId: 'session-1', useTabInfo: () => ({ tab: { visible: true } }) })
    const effects = pendingEffects.splice(0)
    if (!effects.length) break
    for (const run of effects) await run()
  }
  return {
    tree, requests, pageStateReads, pageRequests, pageStreams, warnings, errors,
    get pendingTimers() { return timers.size },
    runNextTimeout() {
      const entry = timers.entries().next().value
      if (!entry) return false
      const [id, timer] = entry
      timers.delete(id)
      timer.callback()
      return timer.delay
    },
    flush: async () => { for (let i = 0; i < 10; i++) await Promise.resolve() },
    dispose: async () => { for (const dispose of clientDisposers.reverse()) await dispose() },
  }
}

function streamResponse(signal, pageStreams) {
  const stream = { signal, reading: false, finish: null }
  pageStreams.push(stream)
  return {
    status: 200,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null },
    body: {
      getReader() {
        return {
          read() {
            stream.reading = true
            return new Promise(resolve => {
              const finish = () => resolve({ done: true })
              stream.finish = finish
              if (signal.aborted) finish()
              else signal.addEventListener('abort', finish, { once: true })
            })
          },
          releaseLock() {},
        }
      },
      async cancel() {},
    },
  }
}

function emptyResponse(status) {
  return { status, headers: { get: () => null }, body: null }
}

function textContent(node) {
  if (node == null || node === false) return ''
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node.type === 'style') return ''
  return textContent(node.children)
}

function findButton(node, label) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) return node.map(child => findButton(child, label)).find(Boolean) ?? null
  if (typeof node !== 'object') return null
  if (node.type === 'button' && textContent(node.children) === label) return node
  return findButton(node.children, label)
}

const selectedChat = { id: 'chat-target-△', name: '△', kind: 'group', status: 'idle', mode: 'infer', counters: null }

test('the reserved window control calls window/set through the existing console action', async () => {
  const state = makeState('sender_prepare_failed', { chat: selectedChat })
  state.capabilities.window = true
  const { tree, requests } = await renderClient(state)
  const show = findButton(tree, '显示小号 / 登录')
  assert.ok(show)
  await show.props.onClick()
  assert.ok(requests.some(body => body.action === 'window' && body.visible === true))
})

test('the page lease is a same-origin authenticated fetch stream owned by the global client fiber', async () => {
  const state = makeState('sender_prepare_failed', {
    chat: selectedChat,
    pageLifetime: { enabled: true, pages: 0, closing: false },
  })

  const streams = []
  const client = await renderClient(state, { pageResponses: [init => streamResponse(init.signal, streams)] })

  await client.flush()

  assert.equal(client.pageStateReads, 0, 'the lease does not wait for the state route')
  assert.equal(client.pageRequests.length, 1)
  assert.equal(client.pageRequests[0].url, '/api/wechat-bot.page-lifetime')
  assert.equal(client.pageRequests[0].init.credentials, 'same-origin')
  assert.equal(client.pageRequests[0].init.cache, 'no-store')
  assert.equal(client.pageRequests[0].init.headers.Accept, 'text/event-stream')
  assert.equal(streams[0].reading, true)
  assert.equal(client.pageRequests[0].init.signal.aborted, false)
  await client.dispose()
  assert.equal(client.pageRequests[0].init.signal.aborted, true, 'fiber disposal aborts the active fetch stream')
})

test('the initial missing host route retries until the page lease route becomes ready', async () => {
  const streams = []
  const client = await renderClient(makeState('sender_prepare_failed'), {
    pageResponses: [emptyResponse(404), init => streamResponse(init.signal, streams)],
  })
  await client.flush()

  assert.equal(client.pageRequests.length, 1)
  assert.equal(client.pendingTimers, 1)
  assert.equal(client.runNextTimeout(), 250)
  await client.flush()

  assert.equal(client.pageRequests.length, 2)
  assert.equal(streams[0].reading, true, 'the retry holds a lease after the host route appears')
  assert.equal(client.pageRequests[1].init.signal.aborted, false)
  assert.equal(client.pendingTimers, 0)
  await client.dispose()
  assert.equal(client.pageRequests[1].init.signal.aborted, true)
})

test('a closed page lease stream reconnects within the five-second exit grace', async () => {
  const streams = []
  const client = await renderClient(makeState('sender_prepare_failed'), {
    pageResponses: [init => streamResponse(init.signal, streams), init => streamResponse(init.signal, streams)],
  })
  await client.flush()

  streams[0].finish()
  await client.flush()

  assert.equal(client.pendingTimers, 1)
  assert.equal(client.runNextTimeout(), 250)
  await client.flush()
  assert.equal(client.pageRequests.length, 2)
  assert.equal(streams[1].reading, true)
  await client.dispose()
})

test('disposing the client fiber cancels a pending page lease retry', async () => {
  const client = await renderClient(makeState('sender_prepare_failed'), { pageResponses: [emptyResponse(404)] })
  await client.flush()

  assert.equal(client.pageRequests.length, 1)
  assert.equal(client.pendingTimers, 1)
  await client.dispose()

  assert.equal(client.pendingTimers, 0)
  assert.equal(client.runNextTimeout(), false)
  await client.flush()
  assert.equal(client.pageRequests.length, 1)
})

test('a disabled host lease returns 204 and stops without polling', async () => {
  const client = await renderClient(makeState('sender_prepare_failed'), { pageResponses: [emptyResponse(204)] })
  await client.flush()

  assert.equal(client.pageRequests.length, 1)
  assert.equal(client.pendingTimers, 0)
  assert.equal(client.runNextTimeout(), false)
  await client.dispose()
  assert.equal(client.pageRequests.length, 1)
})

test('a nontransient lease HTTP error is reported and does not enter the retry loop', async () => {
  const client = await renderClient(makeState('sender_prepare_failed'), { pageResponses: [emptyResponse(401)] })
  await client.flush()

  assert.equal(client.pageRequests.length, 1)
  assert.equal(client.pendingTimers, 0)
  assert.match(String(client.errors[0]?.[0]), /HTTP 401/)
  await client.dispose()
})

test('the page lease opens even when the initial page state request is still pending', async () => {
  const streams = []
  const client = await renderClient(makeState('sender_prepare_failed'), {
    pageResponses: [init => streamResponse(init.signal, streams)], pendingPageState: true,
  })

  assert.deepEqual(client.pageRequests.map(request => request.url), ['/api/wechat-bot.page-lifetime'])
  assert.equal(client.pageStateReads, 0)
  await client.dispose()
})

test('sender preparation failure is visible and retries the currently selected chat through watch', async () => {
  const { tree, requests } = await renderClient(makeState('sender_prepare_failed', { chat: selectedChat }))

  assert.match(textContent(tree), /独立微信窗口准备失败/)
  assert.match(textContent(tree), /目标窗口没有准备好：测试说明/)
  const retry = findButton(tree, '重新准备')
  assert.ok(retry)
  await retry.props.onClick()
  assert.deepEqual(requests, [{ action: 'watch', chatId: 'chat-target-△' }])
})

test('preparing and recovery-required states stay visible without offering an unsafe retry', async t => {
  for (const [reason, label, chat] of [
    ['sender_preparing', '独立微信窗口准备中', selectedChat],
    ['sender_recovery_required', '独立微信窗口恢复待确认', selectedChat],
    ['sender_prepare_failed', '独立微信窗口准备失败', null],
  ]) {
    await t.test(reason + (chat ? '' : ' without a current chat'), async () => {
      const { tree } = await renderClient(makeState(reason, { chat }))
      assert.match(textContent(tree), new RegExp(label))
      assert.equal(findButton(tree, '重新准备'), null)
    })
  }
})

test('sender status does not replace the separate setup initialization screen', async () => {
  const { tree } = await renderClient(makeState('sender_prepare_failed', { chat: selectedChat, completed: false }))
  assert.match(textContent(tree), /微信机器人还没有初始化/)
  assert.doesNotMatch(textContent(tree), /独立微信窗口准备失败/)
  assert.equal(findButton(tree, '重新准备'), null)
})
