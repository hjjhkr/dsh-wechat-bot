import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeManager } from '../lib/bridge.js'
import { StateStore } from '../lib/store.js'
import { buildHistory } from '../lib/model.js'
import { newMemory, ownerKey, parseMemoryReply } from '../lib/memory.js'
import { nextIdleCheck } from '../lib/group.js'

const workerConfig = { botWxid: 'bot', botName: 'bot', targetWxid: '123@chatroom', targetName: 'test',
  conversationType: 'group', groupReplyPolicy: 'model', proactiveEnabled: false,
  expectedExe: 'D:/Weixin.exe', expectedVersion: '4.1.15.13', mainWindowClass: 'Qt', mainWindowTitle: '微信',
  gateTimeoutSeconds: 30, gateModule: 'D:/Weixin.dll', gateRva: 1, gateExpectedOriginalByte: 0, gateEnabledByte: 1 }
const msg = (n, senderId, text) => ({ bot: 'bot', target: '123@chatroom', shard: 's',
  local_id: n, sort_seq: n, senderId, senderName: senderId, text, isSelf: false,
  timestamp: Math.floor(Date.now() / 1000), isGroupMember: true, mentionedBot: false })

async function until(check) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  assert.ok(check(), 'group bridge result timed out')
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-group-'))
  const store = await StateStore.open(root)
  const requests = [], sends = []
  let polls = 0, cursor = 0
  const worker = { ...workerConfig, proactiveEnabled: !!options.proactive, ...options.worker }
  const runtime = { stateRoot: root, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 512,
    pollIntervalMs: 10, historyTurns: 8, maxItems: 100, overlapSeq: 128, rpcTimeoutMs: 1000,
    autoStart: false, autoSend: false, batchQuietMs: 15, batchMaxWaitMs: 40, batchMaxMessages: 20,
    batchMaxChars: 8000, memoryEnabled: true, retentionMs: 1800000, worker }
  const transport = {
    async request(method, params) {
      if (method === 'probe') return { selfId: 'bot', targetId: '123@chatroom',
        binding: { version: worker.expectedVersion, mainWindowClass: 'Qt', mainWindowTitle: '微信', pid: 1 } }
      if (method === 'baseline') return { selfId: 'bot', targetId: '123@chatroom', cursor: { sortSeq: 0 } }
      if (method === 'poll') {
        const messages = options.poll ? options.poll(++polls) : []
        cursor = Math.max(cursor, ...messages.map(m => m.sort_seq))
        return { messages, nextCursor: { sortSeq: cursor }, complete: true,
          ...(worker.desktopName ? { desktopAvailable: options.desktopAvailable ? options.desktopAvailable() : true } : {}) }
      }
      if (method === 'send') {
        sends.push(params)
        if (options.send) return options.send(params)
        return { status: 'confirmed', gateActive: false, gateRestored: true, sendAttempted: true,
          outgoing: { target: '123@chatroom', senderId: 'bot', text: params.text,
            serverId: String(100 + sends.length), localId: 100 + sends.length, sortSeq: 100 + sends.length, shard: 's' } }
      }
      throw Error('unexpected_method')
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const llm = { async *stream(request) {
    requests.push(request)
    const response = options.reply ? await options.reply(request, requests.length) : { reply: null, memory: [] }
    yield { type: 'text-delta', text: JSON.stringify(response) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const manager = new BridgeManager({ runtime, store, llm, persona: 'persona', createWorker: async () => transport, sessionValid: () => true })
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }) })
  return { manager, store, requests, sends, root, runtime,
    start: () => manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'authorized' }) }
}

test('ordinary group messages reach the model in one batch; silent updates belong to their evidence senders', async t => {
  const f = await fixture(t, {
    poll: n => n === 1 ? [msg(1, 'alice', '我喜欢茶'), msg(2, 'bob', '我喜欢咖啡')] : [],
    reply: () => ({ reply: null, memory: [
      { action: 'upsert', category: 'preferences', topic: '饮品', text: '喜欢茶', messageId: '1', quote: '喜欢茶' },
      { action: 'upsert', category: 'preferences', topic: '饮品', text: '喜欢咖啡', messageId: '2', quote: '喜欢咖啡' },
    ] }),
  })
  const direct = { botWxid: 'bot', targetWxid: 'alice', targetName: 'alice' }
  const privateDoc = newMemory(direct)
  privateDoc.sections.profile.push({ topic: '私聊', text: 'private-only-fact' })
  await f.store.transact(s => { s.memories = { [ownerKey(direct)]: privateDoc } })
  await f.start()
  await until(() => f.store.snapshot().inbox[0]?.memoryPublishedAt)
  await f.manager.pause()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 0)
  assert.ok(!JSON.stringify(f.requests).includes('private-only-fact'))
  const input = JSON.parse(f.requests[0].messages.at(-1).content[0].text)
  assert.deepEqual(input.messages.map(m => m.senderId), ['alice', 'bob'])
  const a = JSON.parse(await readFile(join(f.root, 'memory/bot/groups/123@chatroom/alice.json'), 'utf8'))
  const b = JSON.parse(await readFile(join(f.root, 'memory/bot/groups/123@chatroom/bob.json'), 'utf8'))
  assert.equal(a.sections.preferences[0].text, '喜欢茶')
  assert.equal(b.sections.preferences[0].text, '喜欢咖啡')
  const history = buildHistory(f.store.snapshot(), 8, null, f.runtime)
  assert.equal(history.length, 2)
  assert.deepEqual(JSON.parse(history[1].content[0].text), { reply: null, memory: [] })
})

test('invalid historical memory evidence is corrected before any memory commit or send', async t => {
  const f = await fixture(t, {
    poll: n => n === 1 ? [msg(1, 'alice', '以后叫我小林')] : [],
    reply: (_, n) => ({ reply: n === 1 ? '错误回复' : '好的小林', memory: [
      { action: 'upsert', category: 'preferences', topic: '称呼', text: '称呼小林', messageId: '1',
        quote: n === 1 ? '上一轮才说过的原文' : '以后叫我小林' },
    ] }),
  })
  await f.start()
  await until(() => f.manager.status().deliveredCount === 1)
  assert.equal(f.manager.status().running, true)
  assert.equal(f.requests.length, 2)
  assert.match(f.requests[1].system, /memory_evidence_invalid/)
  assert.equal(f.sends.length, 1)
  assert.equal(f.store.snapshot().outbox[0].text, '好的小林')
  const document = JSON.parse(await readFile(join(f.root, 'memory/bot/groups/123@chatroom/alice.json'), 'utf8'))
  assert.equal(document.sections.preferences[0].text, '称呼小林')
  assert.equal(f.manager.logs().entries.filter(e => e.kind === 'model_retry').length, 1)
})

test('repeated model failure is durable and later group messages still receive replies without replaying the failed batch', async t => {
  let releaseNext = false, nextRead = false
  const f = await fixture(t, {
    poll: n => {
      if (n === 1) return [msg(1, 'alice', '这次知道你在跟我说话了')]
      if (releaseNext && !nextRead) { nextRead = true; return [msg(2, 'bob', '下一条正常消息')] }
      return []
    },
    reply: (_, n) => n <= 2 ? { reply: '不该发出', memory: [
      { action: 'upsert', category: 'explicit', topic: '称呼', text: '喵开头', messageId: '1', quote: '以后开头加喵' },
    ] } : { reply: '正常回复', memory: [] },
  })
  await f.start()
  await until(() => f.store.snapshot().inbox[0]?.status === 'model_failed')
  assert.equal(f.sends.length, 0)
  assert.equal(f.store.snapshot().memories, undefined)
  assert.equal(f.manager.status().running, true)
  const failed = f.manager.logs().entries.find(e => e.kind === 'model_failed')
  assert.equal(failed.level, 'error')
  assert.equal(failed.text, 'memory_evidence_invalid')
  const persisted = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'))
  assert.equal(persisted.inbox[0].status, 'model_failed')
  assert.equal(persisted.inbox[0].draft, null)
  await f.manager.pause()
  await f.start()
  releaseNext = true
  await until(() => f.manager.status().deliveredCount === 1)
  assert.equal(f.manager.status().running, true)
  assert.equal(f.requests.length, 3)
  assert.equal(f.store.snapshot().outbox.length, 1)
  assert.equal(f.store.snapshot().outbox[0].text, '正常回复')
  assert.equal(f.store.snapshot().inbox[0].status, 'model_failed')
})

test('invalid idle memory remains a visible failed check and never stops polling or sends', async t => {
  let polls = 0
  const f = await fixture(t, { proactive: true, poll: () => { polls++; return [] },
    reply: () => ({ reply: '不该发送', memory: [
      { action: 'upsert', category: 'explicit', topic: '称呼', text: '喵开头', messageId: '1', quote: '旧消息原文' },
    ] }) })
  await f.store.transact(s => { s.nextIdleCheckAt = new Date(0).toISOString() })
  await f.start()
  await until(() => f.manager.status().lastIdleDecision?.decision === 'failed')
  const previousPolls = polls
  await until(() => polls > previousPolls)
  assert.equal(f.manager.status().running, true)
  assert.equal(f.requests.length, 2)
  assert.equal(f.sends.length, 0)
  assert.ok(Date.parse(f.manager.status().nextIdleCheckAt) > Date.now())
  const failure = f.manager.logs().entries.find(e => e.kind === 'idle')
  assert.equal(failure.level, 'error')
  assert.equal(failure.text, 'memory_evidence_invalid')
})

test('pausing during model correction neither sends nor turns cancellation into a failed batch', async t => {
  let correctionStarted = false
  const f = await fixture(t, {
    poll: n => n === 1 ? [msg(1, 'alice', '你好')] : [],
    reply: async (request, n) => {
      if (n === 1) return { reply: '错误回复', memory: [
        { action: 'upsert', category: 'explicit', topic: '称呼', text: '喵开头', messageId: '1', quote: '旧消息原文' },
      ] }
      correctionStarted = true
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
      return { reply: '已取消的回复', memory: [] }
    },
  })
  await f.start()
  await until(() => correctionStarted)
  await f.manager.pause()
  assert.equal(f.manager.status().phase, 'paused')
  assert.equal(f.store.snapshot().inbox[0].status, 'received')
  assert.equal(f.store.snapshot().inbox[0].modelErrorCode, undefined)
  assert.equal(f.store.snapshot().outbox.length, 0)
  assert.equal(f.sends.length, 0)
})

test('model chooses one group reply without an @ or prefix', async t => {
  const f = await fixture(t, { poll: n => n === 1 ? [msg(1, 'alice', '鲸鱼你觉得呢'), msg(2, 'bob', '聊一句')] : [],
    reply: () => ({ reply: '在呢', memory: [] }) })
  await f.start()
  await until(() => f.manager.status().deliveredCount === 1)
  await f.manager.pause()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 1)
  assert.equal(f.store.snapshot().outbox[0].incomingKeys.length, 2)
})

test('group identity and true mention survive polling, storage, model input and history without forcing a reply', async t => {
  const f = await fixture(t, {
    poll: n => n === 1 ? [{ ...msg(1, 'alice', '@bot 说话来'), mentionedBot: true },
      msg(2, 'bob', '@另一位 等一下')] : [],
    reply: () => ({ reply: null, memory: [] }),
  })
  await f.start()
  await until(() => f.store.snapshot().inbox[0]?.memoryPublishedAt)
  await f.manager.pause()
  assert.equal(f.requests.length, 1)
  const input = JSON.parse(f.requests[0].messages.at(-1).content[0].text)
  assert.deepEqual(input.self, { senderId: 'bot', displayName: 'bot' })
  assert.deepEqual(input.messages.map(m => m.mentionedBot), [true, false])
  assert.deepEqual(f.store.snapshot().inbox.map(m => m.mentionedBot), [true, false])
  const history = buildHistory(f.store.snapshot(), 8, null, f.runtime)
  assert.deepEqual(JSON.parse(history[0].content[0].text).messages.map(m => m.mentionedBot), [true, false])
  assert.equal(f.sends.length, 0, 'a true mention remains model-controlled')
})

test('missing group membership proof fails before model or send', async t => {
  const f = await fixture(t, { poll: n => n === 1 ? [{ ...msg(1, 'alice', 'hello'), isGroupMember: false }] : [] })
  await f.start()
  await until(() => f.manager.status().phase === 'error' && f.manager.status().workerClosed)
  assert.equal(f.manager.status().lastErrorCode, 'poll_group_member_invalid')
  assert.equal(f.requests.length, 0)
  assert.equal(f.sends.length, 0)
})

test('idle polling does not invoke the model before 30 minutes', async t => {
  const f = await fixture(t, { proactive: true })
  await f.start()
  await until(() => f.manager.status().nextIdleCheckAt)
  await f.manager.pause()
  const delay = Date.parse(f.manager.status().nextIdleCheckAt) - Date.now()
  assert.ok(delay > 1790000 && delay <= 1800000)
  assert.equal(nextIdleCheck(0), '1970-01-01T00:30:00.000Z')
  assert.equal(f.requests.length, 0)
})

test('due idle check can remain silent and schedules another half-hour without sending', async t => {
  const f = await fixture(t, { proactive: true })
  await f.store.transact(s => { s.nextIdleCheckAt = new Date(0).toISOString() })
  await f.start()
  await until(() => f.manager.status().lastIdleDecision)
  await f.manager.pause()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(f.manager.status().lastIdleDecision.decision, 'silent')
  assert.deepEqual(JSON.parse(f.requests[0].messages.at(-1).content[0].text).self,
    { senderId: 'bot', displayName: 'bot' })
  assert.ok(Date.parse(f.manager.status().nextIdleCheckAt) - Date.now() > 1790000)
})

test('due idle reply uses the same persisted send attempt and confirmation path', async t => {
  const f = await fixture(t, { proactive: true, reply: () => ({ reply: '突然想喝茶', memory: [] }) })
  await f.store.transact(s => { s.nextIdleCheckAt = new Date(0).toISOString() })
  await f.start()
  await until(() => f.manager.status().deliveredCount === 1)
  await f.manager.pause()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 1)
  assert.equal(f.store.snapshot().inbox[0].kind, 'idle')
  assert.equal(f.store.snapshot().outbox[0].status, 'delivered')
})

test('locking before an idle send skips that turn and unlock never replays it', async t => {
  let locked = false, lockedPolls = 0, unlockedPolls = 0
  const f = await fixture(t, {
    proactive: true,
    worker: { desktopName: 'DshWeChatBot_test' },
    desktopAvailable: () => {
      if (locked) lockedPolls++
      else if (lockedPolls) unlockedPolls++
      return !locked
    },
    reply: () => ({ reply: 'old proactive sentence', memory: [] }),
    send: () => {
      locked = true
      return { status: 'blocked', reasonCode: 'desktop_unavailable', sendAttempted: false,
        gateActive: false, gateRestored: true }
    },
  })
  await f.store.transact(s => { s.nextIdleCheckAt = new Date(0).toISOString() })
  await f.start()
  await until(() => lockedPolls >= 3)
  const state = f.store.snapshot()
  assert.equal(f.manager.status().waitingForDesktop, true)
  assert.equal(state.inbox[0].kind, 'idle')
  assert.equal(state.inbox[0].status, 'skipped')
  assert.equal(state.inbox[0].skipReason, 'desktop_unavailable')
  assert.equal(state.inbox[0].desktopDeferred, undefined)
  assert.equal(state.outbox.length, 0)
  assert.equal(state.gateActive, false)
  assert.equal(f.requests.length, 1, 'locked polls must not invoke the model')
  assert.equal(f.sends.length, 1)
  const nextCheck = state.nextIdleCheckAt
  assert.ok(Date.parse(nextCheck) - Date.now() > 1790000)

  locked = false
  await until(() => unlockedPolls >= 3 && !f.manager.status().waitingForDesktop)
  await f.manager.pause()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 1, 'unlock must not replay the old proactive sentence')
  assert.equal(f.store.snapshot().inbox[0].status, 'skipped')
  assert.equal(f.manager.status().nextIdleCheckAt, nextCheck)
})

test('new messages arriving during idle generation cancel the stale proactive reply', async t => {
  let generating = false, delivered = false
  const f = await fixture(t, { proactive: true,
    poll: () => {
      if (generating && !delivered) { delivered = true; return [msg(1, 'alice', '正在聊事情')] }
      return []
    },
    reply: (_request, n) => {
      if (n === 1) { generating = true; return { reply: '旧的主动发言', memory: [] } }
      return { reply: null, memory: [] }
    },
  })
  await f.store.transact(s => { s.nextIdleCheckAt = new Date(0).toISOString() })
  await f.start()
  await until(() => f.store.snapshot().inbox[0]?.memoryPublishedAt)
  await f.manager.pause()
  assert.equal(f.requests.length, 2)
  assert.equal(f.sends.length, 0)
  assert.equal(f.manager.status().lastIdleDecision, null)
})

test('silence is an explicit group contract, not accepted as a private reply', () => {
  assert.throws(() => parseMemoryReply('{"reply":null,"memory":[]}', []), /memory_response_invalid/)
  assert.throws(() => parseMemoryReply('{"reply":"","memory":[]}', [], { allowSilence: true }), /memory_response_invalid/)
})
