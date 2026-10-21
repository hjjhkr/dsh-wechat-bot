import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ModelSessionActivity, modelSessionId } from '../lib/model-session.js'
import { generateReply } from '../lib/model.js'
import { BridgeManager } from '../lib/bridge.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-model-session-'))
  const rootCtx = new Context()
  let ctx, activity
  t.after(async () => {
    await activity?.dispose()
    await rootCtx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await rootCtx.plugin(SessionStore).await()
  await rootCtx.plugin(AgentRegistry).await()
  await rootCtx.plugin(SessionProjection).await()
  await rootCtx.plugin(SessionTitle, { fallbackMaxWords: 24, fallbackMaxBytes: 256, maxTitleBytes: 256 }).await()
  const persistence = rootCtx.plugin(JsonlPersistence, { root, compression: 'none' })
  await persistence.await()
  await rootCtx.plugin({ name: 'model-observer-test-owner',
    inject: ['sessions', 'agents', 'sessionTitle', 'sessionPersistence'],
    apply(value) { ctx = value },
  }).await()
  const config = { provider: 'test-provider', model: 'test-model', maxTokens: 128,
    dshWorkspace: root, worker: { botWxid: 'bot', targetWxid: 'friend', targetName: '测试会话' } }
  activity = await ModelSessionActivity.create(ctx, config)
  return { ctx, config, activity }
}

const optionsFor = (config, activity) => ({ config, activity, persona: '原有人设', incoming: '仅供离线验证',
  history: [{ role: 'user', content: [{ type: 'text', text: '原有历史' }] }] })

test('native session shows real in-flight chunks and persists one call without changing its request', async t => {
  const { ctx, config, activity } = await fixture(t)
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const frames = [], statuses = [], requests = []
  ctx.on('agent/assistant-stream', ({ agent, frame }) => { if (agent.id === activity.id) frames.push(frame) })
  ctx.on('agent/status', ({ agent, status }) => { if (agent.id === activity.id) statuses.push(status) })
  const llm = { async *stream(request) {
    requests.push(request)
    yield { type: 'text-delta', index: 0, text: '真实' }
    entered.resolve()
    await gate.promise
    yield { type: 'text-delta', index: 0, text: '输出' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = generateReply(llm, optionsFor(config, activity))
  await entered.promise
  assert.equal(activity.status, 'running')
  assert.equal(ctx.agents.get(activity.id), activity)
  assert.equal(frames.filter(f => f.type === 'chunk').length, 1)
  assert.equal(frames[1].chunk.text, '真实')
  assert.throws(() => activity.followup({}), /仅显示微信模型处理/)
  await assert.rejects(generateReply(llm, optionsFor(config, activity)), /model_session_busy/)
  gate.resolve()
  assert.deepEqual(await result, { reply: '真实输出', finish: 'stop' })
  assert.deepEqual(statuses, ['running', 'idle'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].system, '原有人设')
  assert.equal(requests[0].messages.length, 2)
  assert.equal(requests[0].reasoningEffort, 'off')
  assert.equal(requests[0].tools, undefined)
  assert.deepEqual(frames.map(f => f.revision), [1, 2, 3, 4, 5])
  const stored = await ctx.sessionPersistence.open(activity.id, 'read')
  const read = await stored.read()
  await stored.close()
  assert.equal(read.events.filter(e => e.type === 'assistant/message').length, 1)
  assert.equal(read.events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(ctx.sessionTitle.get(activity.session).title, '微信模型 · 测试会话')
})

test('failed and truncated requests close visibly without a successful assistant reply or retry', async t => {
  const { config, activity } = await fixture(t)
  for (const finish of ['error', 'max-tokens', 'missing', 'empty']) {
    let calls = 0
    const llm = { async *stream() {
      calls++
      if (finish !== 'empty') yield { type: 'text-delta', index: 0, text: '未完成' }
      if (finish === 'error') throw new Error('synthetic network error')
      if (finish !== 'missing') yield { type: 'finish', reason: { kind: finish === 'empty' ? 'stop' : finish } }
    } }
    await assert.rejects(generateReply(llm, optionsFor(config, activity)))
    assert.equal(activity.status, 'idle')
    assert.equal(calls, 1)
    assert.equal(activity.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'error')
  }
  assert.equal(activity.session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 0)
  assert.equal(activity.session.snapshotEvents().filter(e => e.type === 'assistant/attempt').length, 4)
})

test('DSH cancel aborts the same request and cannot produce a sendable reply', async t => {
  const { config, activity } = await fixture(t)
  const entered = Promise.withResolvers()
  const llm = { async *stream({ signal }) {
    yield { type: 'text-delta', index: 0, text: '前缀' }
    entered.resolve()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  } }
  const pending = generateReply(llm, optionsFor(config, activity))
  await entered.promise
  activity.cancel({ kind: 'user' })
  await assert.rejects(pending)
  await activity.whenIdle()
  assert.equal(activity.status, 'idle')
  assert.equal(activity.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted')
})

test('reopening restores the same session without replaying model calls, and keeps conversations separate', async t => {
  const { ctx, config, activity } = await fixture(t)
  const llm = { async *stream() {
    yield { type: 'text-delta', index: 0, text: '已完成' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  await generateReply(llm, optionsFor(config, activity))
  const id = activity.id
  await activity.dispose()
  assert.equal(ctx.agents.get(id), undefined)
  const restored = await ModelSessionActivity.create(ctx, config)
  t.after(() => restored.dispose())
  assert.equal(restored.id, id)
  assert.equal(restored.status, 'idle')
  assert.equal(restored.turn, 1)
  assert.equal(restored.session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 1)
  assert.notEqual(modelSessionId({ ...config, worker: { ...config.worker, targetWxid: 'group@chatroom' } }), id)
  await generateReply(llm, optionsFor(config, restored))
  assert.equal(restored.turn, 2)
  await restored.dispose()
})

test('bridge model diagnostics use the native activity and block a competing monitor start', async t => {
  const { ctx, config, activity } = await fixture(t)
  const personaPath = join(config.dshWorkspace, 'persona.md')
  await writeFile(personaPath, '原有人设')
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  let calls = 0, workerStarts = 0
  const llm = { async *stream() {
    calls++
    yield { type: 'text-delta', index: 0, text: '测试完成' }
    entered.resolve()
    await gate.promise
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const manager = await BridgeManager.create({
    runtime: { ...config, stateRoot: join(config.dshWorkspace, 'bridge-state'), personaPath,
      autoStart: false, autoSend: false, historyTurns: 4 },
    llm, createModelActivity: async () => activity,
    createWorker: async () => { workerStarts++; throw new Error('unexpected worker') },
  })
  t.after(() => manager.dispose())
  const pending = manager.testModel()
  await entered.promise
  assert.equal(manager.status().modelSessionId, activity.id)
  assert.equal(activity.status, 'running')
  await assert.rejects(manager.start(), /test_model_busy/)
  await assert.rejects(manager.testModel(), /test_model_busy/)
  gate.resolve()
  assert.equal((await pending).sentToWeChat, false)
  assert.equal(calls, 1)
  assert.equal(workerStarts, 0)
  assert.equal(activity.session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 1)
  await manager.dispose()
  assert.equal(ctx.agents.get(activity.id), undefined)
  await assert.rejects(manager.testModel(), /bridge_disposed/)
})

test('reopening an interrupted turn closes it without generating another reply', async t => {
  const { ctx, config, activity } = await fixture(t)
  activity.session.append('turn/start', { turn: 1 })
  activity.session.append('step/start', { turn: 1, step: 1 })
  await ctx.sessions.flush(activity.session)
  await activity.dispose()
  const restored = await ModelSessionActivity.create(ctx, config)
  t.after(() => restored.dispose())
  const events = restored.session.snapshotEvents()
  assert.equal(restored.status, 'idle')
  assert.equal(events.filter(e => e.type === 'step/end').length, 1)
  assert.equal(events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(events.filter(e => e.type === 'assistant/message').length, 0)
  await restored.dispose()
})
