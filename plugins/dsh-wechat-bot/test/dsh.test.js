// Integration with the real DSH session/agent services (offline: fake LLM, no network).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createThink } from '../lib/model.js'
import { ChatSession, chatSessionId, liveChatSessionId } from '../lib/session.js'
import { WeChatBotApp } from '../lib/app.js'
import { Store } from '../lib/store.js'
import { registerRoutes } from '../lib/surface.js'
import { until } from './helpers.js'

const CHAT = { id: 'demo@chatroom', name: '测试群', kind: 'group' }
const ROUTE = { provider: 'test-provider', model: 'test-model', maxTokens: 100, reasoningEffort: 'off' }

async function fixture(t, llm = fakeLlm(async function* () {})) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-dsh-'))
  const rootCtx = new Context()
  const attached = []
  const detached = []
  let ctx
  t.after(async () => {
    await rootCtx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  await rootCtx.plugin(SessionStore).await()
  await rootCtx.plugin(AgentRegistry).await()
  await rootCtx.plugin(SessionProjection).await()
  await rootCtx.plugin(SessionTitle, { fallbackMaxWords: 24, fallbackMaxBytes: 256, maxTitleBytes: 256 }).await()
  await rootCtx.plugin(JsonlPersistence, { root, compression: 'none' }).await()
  await rootCtx.plugin(class extends Service {
    constructor(ctx) { super(ctx, 'llm') }
    stream(request) { return llm.stream(request) }
    resolveModelInfo(provider, model) { return llm.resolveModelInfo?.(provider, model) ?? { reasoning: { efforts: [{ id: 'off' }, { id: 'max' }] } } }
  }).await()
  await rootCtx.plugin(class extends Service {
    constructor(ctx) { super(ctx, 'workspaceRegistry') }
    async create(path) { return {
      attachSession: async id => attached.push({ path, id }),
      detachSession: async id => detached.push({ path, id }),
    } }
  }).await()
  await rootCtx.plugin({
    name: 'wechat-session-test',
    inject: ['sessions', 'agents', 'sessionTitle', 'sessionPersistence', 'workspaceRegistry', 'llm'],
    apply(value) { ctx = value },
  }).await()
  const open = () => ChatSession.open(ctx, { id: chatSessionId('wxid_bot', CHAT.id), cwd: root, title: `微信 · ${CHAT.name}`, route: ROUTE })
  const openLive = () => ChatSession.openLive(ctx, { id: liveChatSessionId('wxid_bot', CHAT.id), cwd: root, title: `微信 · ${CHAT.name}`, route: ROUTE })
  return { ctx, root, attached, detached, open, openLive }
}

function fakeLlm(script) {
  const requests = []
  return {
    requests,
    async *stream(request) {
      requests.push(request)
      yield* script(request)
    },
  }
}

test('each model call becomes a visible, persisted turn in the chat session', async t => {
  const { ctx, root, attached, open } = await fixture(t)
  const session = await open()
  t.after(() => session.dispose())
  const frames = []
  ctx.on('agent/assistant-stream', ({ agent, frame }) => agent.id === session.id && frames.push(frame.type))
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: '{"reply":' }
    yield { type: 'text-delta', index: 0, text: '["草"]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const think = createThink({ llm, route: () => ROUTE, mirror: async () => session })
  const output = await think({ chat: CHAT, system: '人设', messages: [{ role: 'user', text: '{"new":[]}' }], readable: '测试群（1 条新消息）' })

  assert.equal(output, '{"reply":["草"]}')
  assert.deepEqual(frames, ['start', 'chunk', 'chunk', 'chunk', 'end'], 'two deltas and the finish chunk')
  assert.equal(llm.requests[0].reasoningEffort, 'off')
  assert.equal(llm.requests[0].system, '人设')
  assert.equal(llm.requests[0].tools, undefined, 'the mirror never exposes tools to the model')
  assert.deepEqual(attached, [{ path: root, id: session.id }])
  assert.equal(ctx.sessionTitle.get(session.session).title, '微信 · 测试群')

  const events = session.session.snapshotEvents()
  const shown = events.find(e => e.type === 'user/message').data.content[0].text
  assert.equal(shown, '测试群（1 条新消息）\n\n模型收到的输入：\n{"new":[]}')
  assert.equal(events.filter(e => e.type === 'assistant/message').length, 1)
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
  assert.throws(() => session.followup({}), /只展示微信机器人/)
})

test('app startup binds the saved WeChat group to a native session and mirrors reply calls', async t => {
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: '{"to":null,"reply":[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const { ctx, root, attached } = await fixture(t, llm)
  const dataDir = join(root, 'wechat-bot')
  await new Store(dataDir).updateBot({ chat: CHAT,
    setup: { workspace: root, sessionId: 'setup-session', completedAt: 1, self: { id: 'wxid_bot', name: '小鲸鱼' } },
  })
  const config = { dataDir, adapter: { command: '' }, model: ROUTE, aliases: ['小鲸鱼'],
    behavior: { staleMinutes: 10, memoryLearning: false },
    guard: { maxTurnsPerMinute: 8, commandsPerMinute: 6, modelTimeoutSeconds: 30,
      maxTextChars: 2000, breakerThreshold: 3, breakerBaseSeconds: 30, stuckMinutes: 5 },
  }
  const app = await WeChatBotApp.create(ctx, config)
  try {
    await until(() => app.bot.runner)
    await until(() => attached.length > 0, { what: 'app startup binds its native WeChat session' })
    const mirror = ctx.agents.get(attached.at(-1).id)
    assert.ok(mirror, 'the application owns a native session before the first model call')
    const output = await app.bot.think({ chat: CHAT, system: '人设',
      messages: [{ role: 'user', text: '{"new":[]}' }], readable: '应用接线测试' })
    assert.equal(output, '{"to":null,"reply":[]}')
    assert.equal(mirror.session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 1)
    assert.equal(llm.requests.length, 1)
  } finally {
    await app.dispose()
  }
})

test('a live mirror appears in DSH without a persisted log and is forgotten on dispose', async t => {
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: '{"reply":["收到"]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const { ctx, root, attached, detached, openLive } = await fixture(t, llm)
  const id = liveChatSessionId('wxid_bot', CHAT.id)
  const first = await openLive()
  assert.equal(first.id, id)
  assert.equal(ctx.sessions.get(id), first.session)
  assert.equal(ctx.agents.get(id), first)
  assert.equal(await ctx.sessionPersistence.stat(id), undefined)

  const think = createThink({ llm, route: () => ROUTE, mirror: async () => first })
  const output = await think({ chat: CHAT, system: '人设',
    messages: [{ role: 'user', text: '测试输入' }], readable: '测试群（1 条新消息）' })
  assert.equal(output, '{"reply":["收到"]}')
  assert.ok(ctx.sessions.list().some(session => session.id === id), 'the DSH live session registry lists the mirror')
  assert.equal(first.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
  assert.equal(await ctx.sessionPersistence.stat(id), undefined, 'the model turn never creates a JSONL session log')

  await first.dispose()
  assert.equal(ctx.sessions.get(id), undefined)
  assert.equal(ctx.agents.get(id), undefined)
  assert.deepEqual(detached, [{ path: root, id }], 'workspace membership is removed with the live session')
  assert.equal(await ctx.sessionPersistence.stat(id), undefined)

  const second = await openLive()
  t.after(() => second.dispose())
  assert.equal(second.id, id)
  assert.equal(second.turn, 0)
  assert.equal(second.session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'assistant/message'), false,
    'reopening the same id starts with no prior transcript')
  assert.deepEqual(attached, [{ path: root, id }, { path: root, id }])
  assert.equal(await ctx.sessionPersistence.stat(id), undefined)
})

test('a failed adapter shutdown still releases the native mirror and reports the failure', async t => {
  const { ctx, root, detached, openLive } = await fixture(t)
  const mirror = await openLive()
  const app = new WeChatBotApp(ctx, { dataDir: join(root, 'wechat-bot') })
  const failure = new Error('adapter shutdown failed')
  app.bot = { dispose: async () => { throw failure } }
  app.sessions.set('test-chat', Promise.resolve(mirror))
  await assert.rejects(app.dispose(), error => error === failure)
  assert.equal(Boolean(ctx.agents.get(mirror.id)), false, 'a shutdown failure must not leak the mirror agent')
  assert.equal(Boolean(ctx.sessions.get(mirror.id)), false, 'a shutdown failure must not leak the live session')
  assert.deepEqual(detached, [{ path: root, id: mirror.id }])
  assert.equal(app.sessions.size, 0)
})

test('a deliberate /ask call raises the effort and the token budget', async t => {
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const think = createThink({ llm, route: () => ROUTE })
  await think({ chat: CHAT, system: '', messages: [{ role: 'user', text: 'x' }], effort: 'high' })
  assert.equal(llm.requests[0].reasoningEffort, 'high')
  assert.equal(llm.requests[0].maxTokens, 800)
})

test('failed and truncated calls end the turn as errors and reach the caller', async t => {
  const { open } = await fixture(t)
  const session = await open()
  t.after(() => session.dispose())
  for (const ending of ['throw', 'max-tokens']) {
    const llm = fakeLlm(async function* () {
      yield { type: 'text-delta', index: 0, text: '半句' }
      if (ending === 'throw') throw new Error('network down')
      yield { type: 'finish', reason: { kind: ending } }
    })
    const think = createThink({ llm, route: () => ROUTE, mirror: async () => session })
    await assert.rejects(think({ chat: CHAT, system: '', messages: [{ role: 'user', text: 'x' }], readable: 'r' }))
    assert.equal(session.status, 'idle')
    assert.equal(session.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'error')
  }
  assert.equal(session.session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 0)
})

test('stopping the turn in DSH aborts the request; concurrent calls are serialized', async t => {
  const { open } = await fixture(t)
  const session = await open()
  t.after(() => session.dispose())
  const entered = Promise.withResolvers()
  const llm = fakeLlm(async function* ({ signal }) {
    const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    aborted.catch(() => {})
    yield { type: 'text-delta', index: 0, text: '前缀' }
    entered.resolve()
    await aborted
  })
  const think = createThink({ llm, route: () => ROUTE, mirror: async () => session })
  const first = think({ chat: CHAT, system: '', messages: [{ role: 'user', text: '1' }], readable: '1' })
  const second = think({ chat: CHAT, system: '', messages: [{ role: 'user', text: '2' }], readable: '2' })
  await entered.promise
  assert.equal(llm.requests.length, 1, 'the second call waits for the first')
  session.cancel({ kind: 'user' })
  await assert.rejects(first)
  while (llm.requests.length < 2) await new Promise(resolve => setTimeout(resolve, 5))
  session.cancel({ kind: 'user' })
  await assert.rejects(second)
  const ends = session.session.snapshotEvents().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)
  assert.deepEqual(ends, ['aborted', 'aborted'])
})

test('reopening restores the history and closes a turn interrupted by a crash', async t => {
  const { open } = await fixture(t)
  const first = await open()
  first.session.append('turn/start', { turn: 1 })
  await first.owner.sessions.flush(first.session)
  await first.handle.close()
  first.detachAgent()
  first.detachSession()
  await first.scope.dispose()

  const reopened = await open()
  t.after(() => reopened.dispose())
  const events = reopened.session.snapshotEvents()
  assert.equal(events.filter(e => e.type === 'turn/start').length, 1)
  assert.ok(events.some(e => e.type === 'turn/end'), 'interrupted turn was closed on reopen')
  assert.equal(reopened.turn, 1)
})

test('reconnecting to an occupied mirror creates a new writable session without taking over the old one', async t => {
  const { ctx, root, open } = await fixture(t)
  const original = await open()
  t.after(() => original.dispose())
  const next = await ChatSession.openAvailable(ctx, { id: original.id, cwd: root, title: '微信 · 测试群', route: ROUTE })
  t.after(() => next.dispose())
  assert.notEqual(next.id, original.id)
  assert.equal(original.disposed, undefined)
  await next.run('新的微信消息', async () => '新的回复')
  assert.equal(next.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 1)
  assert.equal(original.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 0)
  assert.match(ctx.sessionTitle.get(next.session).title, /续接/)
})

test('an available recorded mirror id is restored rather than creating another session', async t => {
  const { ctx, root, open } = await fixture(t)
  const first = await open()
  const id = first.id
  await first.dispose()
  const restored = await ChatSession.openAvailable(ctx, { id, cwd: root, title: '微信 · 测试群', route: ROUTE })
  t.after(() => restored.dispose())
  assert.equal(restored.id, id)
})


async function maintenanceApp(t, llm, counts) {
  const f = await fixture(t, llm)
  const dataDir = join(f.root, 'wechat-bot')
  const store = new Store(dataDir)
  await store.updateBot({ chat: CHAT,
    setup: { workspace: f.root, sessionId: 'setup-session', completedAt: 1, self: { id: 'wxid_bot', name: '小鲸鱼' } },
  })
  const memory = store.memoryFor(CHAT.id)
  for (const [who, count] of Object.entries(counts)) {
    const evidence = Array.from({ length: count }, (_, i) => ({ id: `${who}-${i}`, sender: { id: who, name: who }, fromSelf: false, text: '我长期保持这个习惯' }))
    const result = await memory.apply(evidence.map((m, i) => ({ who, topic: `主题${i}`, note: `稳定事实${i}`, evidence: m.id })), evidence)
    assert.equal(result.applied.length, count)
  }
  const config = { dataDir, adapter: { command: '' }, model: ROUTE, aliases: ['小鲸鱼'],
    behavior: { staleMinutes: 10, memoryLearning: true, quietMs: 5, maxWaitMs: 15, memoryQuietMs: 5, memoryMaxWaitMs: 15, typingDelay: false },
    guard: { maxTurnsPerMinute: 8, commandsPerMinute: 6, modelTimeoutSeconds: 30,
      maxTextChars: 2000, breakerThreshold: 3, breakerBaseSeconds: 30, stuckMinutes: 5 },
  }
  const app = await WeChatBotApp.create(f.ctx, config)
  t.after(() => app.dispose())
  await until(() => app.bot.runner)
  return { ...f, app, memory: app.store.memoryFor(CHAT.id) }
}

function retainingLlm() {
  return fakeLlm(async function* (request) {
    const input = JSON.parse(request.messages.at(-1).content[0].text)
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ who: input.who,
      notes: input.automatic.map(entry => ({ ...entry, sourceTopics: [entry.topic] })), discard: [] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
}

test('the console action runs all current-group memories through max native turns without sending WeChat', async t => {
  const llm = retainingLlm()
  const { app, ctx, attached } = await maintenanceApp(t, llm, { bob: 2, alice: 3 })
  const routes = []
  const unregister = registerRoutes({ connection: { fetch: { register: route => { routes.push(route); return () => {} } } } }, app,
    { snapshot: () => ({}), handle: () => new Response(null, { status: 204 }) })
  t.after(unregister)
  const action = routes.find(route => route.path === '/api/wechat-bot.action')
  const response = await action.fetch(new Request('http://localhost/api/wechat-bot.action', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'compactMemory', chatId: CHAT.id }),
  }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  await app.memoryMaintenance.flush()
  assert.equal(llm.requests.length, 2)
  assert.deepEqual(llm.requests.map(r => JSON.parse(r.messages.at(-1).content[0].text).who), ['alice', 'bob'])
  assert.ok(llm.requests.every(r => r.reasoningEffort === 'max' && r.maxTokens >= 32768))
  assert.ok(llm.requests.every(r => r.system.includes('记忆') && !r.system.includes('# 微信回复决策')))
  const state = app.state().memoryMaintenance
  assert.equal(state.completed, 2)
  assert.ok(state.results.every(result => result.status !== 'failed'))
  const mirrors = [...app.maintenanceSessions.values()]
  assert.equal(mirrors.length, 1)
  const mirror = await mirrors[0]
  assert.equal(mirror.options.reasoningEffort, 'max')
  assert.equal(ctx.sessionTitle.get(mirror.session).title, `记忆整理 · ${CHAT.name} · max`)
  assert.equal(mirror.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 2)
  assert.ok(attached.some(entry => entry.id === mirror.id))
  assert.equal(await ctx.sessionPersistence.stat(mirror.id), undefined)
  assert.equal(app.chatLog().filter(entry => entry.type === 'sent').length, 0)
  assert.throws(() => app.compactMemory('old-group'), /群已改变/)
})

test('startup automatically compacts 30 topics once and preserves 30 independent valid themes', async t => {
  const llm = retainingLlm()
  const { app, memory } = await maintenanceApp(t, llm, { alice: 30 })
  await until(() => llm.requests.length === 1)
  await app.memoryMaintenance.flush()
  await app.memoryMaintenance.observe(CHAT)
  await app.memoryMaintenance.flush()
  assert.equal(llm.requests.length, 1)
  assert.equal((await memory.snapshot('alice')).automatic.length, 30)
})

test('a model without max thinking tidies memory with the deepest effort it has', async t => {
  const llm = retainingLlm()
  llm.resolveModelInfo = () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })
  const { app, ctx } = await maintenanceApp(t, llm, { alice: 2 })
  await app.compactMemory(CHAT.id)
  await app.memoryMaintenance.flush()
  assert.deepEqual(llm.requests.map(r => r.reasoningEffort), ['high'])
  assert.equal(app.state().memoryMaintenance.results[0].status, 'completed')
  const mirror = await [...app.maintenanceSessions.values()][0]
  assert.equal(ctx.sessionTitle.get(mirror.session).title, `记忆整理 · ${CHAT.name} · high`)
})

test('production reply and learning calls load only their own AGENTS contract', async t => {
  const llm = fakeLlm(async function* () {
    yield { type: 'text-delta', index: 0, text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const { app } = await maintenanceApp(t, llm, {})
  const args = { chat: CHAT, system: '当前调用协议', messages: [{ role: 'user', text: '{}' }], readable: '测试角色' }
  await app.bot.think(args)
  await app.bot.learn(args)
  assert.match(llm.requests[0].system, /# 微信回复决策/)
  assert.match(llm.requests[0].system, /当前调用协议/)
  assert.doesNotMatch(llm.requests[1].system, /# 微信回复决策/)
  assert.match(llm.requests[1].system, /AGENTS|记忆/)
})


test('the thirtieth learned theme automatically enters maintenance through the live runner notification', async t => {
  const llm = fakeLlm(async function* (request) {
    const input = JSON.parse(request.messages.at(-1).content[0].text)
    const output = request.reasoningEffort === 'max'
      ? { who: input.who, notes: input.automatic.map(entry => ({ ...entry, sourceTopics: [entry.topic] })), discard: [] }
      : { memory: [{ who: 'alice', topic: '新项目', note: '长期维护编译器项目', evidence: 'last-stable-fact' }] }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const { app, memory } = await maintenanceApp(t, llm, { alice: 29 })
  app.bot.runner.receive({ id: 'last-stable-fact', chatId: CHAT.id, time: Date.now(),
    kind: 'text', text: '我长期在维护一个编译器项目', fromSelf: false, sender: { id: 'alice', name: '阿甲' }, mentions: [] })
  await until(() => llm.requests.some(request => request.reasoningEffort === 'max'), { timeoutMs: 5000, what: '30th learned theme triggers max maintenance' })
  await app.memoryMaintenance.flush()
  assert.equal(llm.requests.filter(request => request.reasoningEffort === 'max').length, 1)
  assert.equal((await memory.snapshot('alice')).automatic.length, 30)
  assert.equal(app.state().memoryMaintenance.results[0].status, 'completed')
  assert.equal(app.chatLog().filter(entry => entry.type === 'sent').length, 0)
})
