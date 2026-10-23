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
import { ChatSession, chatSessionId } from '../lib/session.js'

const CHAT = { id: 'demo@chatroom', name: '测试群', kind: 'group' }
const ROUTE = { provider: 'test-provider', model: 'test-model', maxTokens: 100, reasoningEffort: 'off' }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-dsh-'))
  const rootCtx = new Context()
  const attached = []
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
    constructor(ctx) { super(ctx, 'workspaceRegistry') }
    async create(path) { return { attachSession: async id => attached.push({ path, id }) } }
  }).await()
  await rootCtx.plugin({
    name: 'wechat-session-test',
    inject: ['sessions', 'agents', 'sessionTitle', 'sessionPersistence', 'workspaceRegistry'],
    apply(value) { ctx = value },
  }).await()
  const open = () => ChatSession.open(ctx, { id: chatSessionId('wxid_bot', CHAT.id), cwd: root, title: `微信 · ${CHAT.name}`, route: ROUTE })
  return { ctx, root, attached, open }
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
