import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../client/index.js', import.meta.url), 'utf8')

function makeState(reason, { chat = null, completed = true } = {}) {
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
    chat,
    recoveries: 0,
    log: [],
  }
}

async function renderClient(state) {
  const instances = new Map()
  const pendingEffects = []
  const requests = []
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
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        requests.push(body)
        return { ok: true, json: async () => ({ ok: true, result: body.action === 'windowState'
          ? { visible: false, running: true } : body.action === 'window' ? { visible: body.visible, running: true } : {} }) }
      }
      if (url.startsWith('/api/wechat-bot.state')) return { ok: true, json: async () => state }
      if (url === '/api/wechat-bot.log') return { ok: true, json: async () => ({ entries: [] }) }
      throw new Error(`unexpected request: ${url}`)
    },
    document: { visibilityState: 'hidden' },
    setInterval: () => 1,
    clearInterval() {},
  }
  vm.runInNewContext(clientSource, sandbox, { filename: 'client/index.js' })

  extension.apply({
    effect: effect => effect(),
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { mounted: { getSnapshot: () => null }, openTab() {} },
    slots: {
      inject(_name, callback) { callback() },
      register(_spec, component) { body = component; return () => {} },
    },
  })
  assert.equal(typeof body, 'function')

  let tree
  for (let i = 0; i < 5; i++) {
    tree = body({ sessionId: 'session-1', useTabInfo: () => ({ tab: { visible: true } }) })
    const effects = pendingEffects.splice(0)
    if (!effects.length) break
    for (const run of effects) await run()
  }
  return { tree, requests }
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
