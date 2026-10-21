import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BridgeManager } from '../lib/bridge.js'
import { StateStore } from '../lib/store.js'

const identity = { botWxid: 'wxid_bot', botName: 'bot', targetWxid: 'wxid_user', targetName: 'user',
  expectedExe: 'D:/Weixin/Weixin.exe', expectedVersion: '4.1.15.13',
  mainWindowClass: 'Qt51514QWindowIcon', mainWindowTitle: '微信', gateTimeoutSeconds: 30,
  gateRva: 1, gateExpectedOriginalByte: 0, gateEnabledByte: 1, gateModule: 'D:/Weixin/Weixin.dll' }
function incoming(n, text) {
  return { bot: 'wxid_bot', target: 'wxid_user', senderId: 'wxid_user', shard: 's',
    local_id: n, sort_seq: n, timestamp: Math.floor(Date.now() / 1000), text, isSelf: false }
}
async function until(check) {
  const end = Date.now() + 2500
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 5))
  assert.ok(check(), 'expected bridge result within 2.5 seconds')
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-batch-'))
  const store = await StateStore.open(root)
  const requests = [], sends = []
  let polls = 0, cursor = 0
  const runtime = { stateRoot: root, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 512,
    pollIntervalMs: 10, historyTurns: 8, maxItems: 100, overlapSeq: 128, rpcTimeoutMs: 1000,
    autoStart: false, autoSend: false, batchQuietMs: 35, batchMaxWaitMs: 100,
    batchMaxMessages: 20, batchMaxChars: 8000, memoryEnabled: false, retentionMs: 1800000,
    worker: identity, ...options.runtime }
  const worker = {
    async request(method, params) {
      if (method === 'probe') return { selfId: identity.botWxid, targetId: identity.targetWxid,
        binding: { version: identity.expectedVersion, mainWindowClass: identity.mainWindowClass,
          mainWindowTitle: identity.mainWindowTitle, pid: 123 } }
      if (method === 'baseline') return { selfId: identity.botWxid, targetId: identity.targetWxid, cursor: { sortSeq: 0 } }
      if (method === 'poll') {
        const messages = (options.poll ?? (n => n === 1 ? [incoming(1, 'a'), incoming(2, 'b')] : []))(++polls)
        cursor = Math.max(cursor, ...messages.map(m => m.sort_seq))
        return { messages, nextCursor: { sortSeq: cursor }, complete: true }
      }
      if (method === 'send') {
        sends.push(params)
        if (options.ambiguous) return { status: 'ambiguous', gateActive: false, gateRestored: true, sendAttempted: true }
        return { status: 'confirmed', gateActive: false, gateRestored: true, sendAttempted: true,
          outgoing: { target: identity.targetWxid, senderId: identity.botWxid, text: params.text,
            serverId: String(100 + sends.length), localId: 500 + sends.length, sortSeq: 500 + sends.length, shard: 's' } }
      }
      throw Error('unexpected_worker_method')
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const llm = { async *stream(request) {
    requests.push(request)
    const text = options.reply ? await options.reply(request, requests.length) : '统一回复'
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const manager = new BridgeManager({ runtime, persona: '人设', store, llm,
    createWorker: async () => worker, sessionValid: () => true })
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }) })
  return { manager, store, requests, sends, root, runtime }
}

test('messages in adjacent polls become one JSON list, one model generation and one send', async t => {
  const f = await fixture(t, { poll: n => n === 1 ? [incoming(1, '你好')] : n === 2 ? [incoming(2, '顺便问一下'), incoming(3, '明天几点')] : [] })
  await f.manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'yes' })
  await until(() => f.manager.status().deliveredCount >= 1)
  await f.manager.pause()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 1)
  const list = JSON.parse(f.requests[0].messages.at(-1).content[0].text)
  assert.deepEqual(list.messages.map(m => m.text), ['你好', '顺便问一下', '明天几点'])
  assert.equal(f.store.snapshot().outbox[0].incomingKeys.length, 3)
  assert.ok(f.store.snapshot().inbox.every(m => m.status === 'delivered'))
})

test('uncertain batch blocks restart and manual skip resolves every member without resend', async t => {
  const f = await fixture(t, { ambiguous: true })
  await f.manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'yes' })
  await until(() => f.manager.status().uncertainSend && f.manager.status().workerClosed)
  assert.ok(f.store.snapshot().inbox.every(m => m.status === 'ambiguous'))
  await assert.rejects(f.manager.start(), /send_recovery_required/)
  await f.manager.acknowledgeNoRetry({ attemptId: f.store.snapshot().outbox[0].attemptId, confirmedNoRetry: true })
  assert.ok(f.store.snapshot().inbox.every(m => m.status === 'skipped'))
  assert.equal(f.sends.length, 1)
})

test('one model call writes per-user memory and a reopened bridge can read it without conversation history', async t => {
  const f = await fixture(t, { runtime: { memoryEnabled: true },
    poll: n => n === 1 ? [incoming(1, '以后叫我小林，我喜欢简短回复')] : [],
    reply: () => JSON.stringify({ reply: '记住啦，小林。', memory: [
      { action: 'upsert', category: 'preferences', topic: '称呼', text: '称呼用户为小林', messageId: '1', quote: '以后叫我小林' },
    ] }) })
  await f.manager.start()
  await until(() => f.manager.status().draftCount === 1)
  await f.manager.pause()
  const document = JSON.parse(await readFile(join(f.root, 'memory', 'wxid_bot', 'wxid_user.json'), 'utf8'))
  assert.equal(document.userId, 'wxid_user')
  assert.equal(document.sections.preferences[0].text, '称呼用户为小林')
  assert.equal(f.requests.length, 1)
  assert.equal(f.manager.latestDraft().draft.text, '记住啦，小林。')
  assert.ok(f.store.snapshot().inbox[0].memoryCommittedAt)
})

test('memory cannot be fabricated without exact evidence in a message and never reaches sending', async t => {
  const f = await fixture(t, { runtime: { memoryEnabled: true }, poll: n => n === 1 ? [incoming(1, '你好')] : [],
    reply: () => JSON.stringify({ reply: '好', memory: [
      { action: 'upsert', category: 'profile', topic: '工作', text: '用户是医生', messageId: '1', quote: '我是医生' },
    ] }) })
  await f.manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'yes' })
  await until(() => f.store.snapshot().inbox[0]?.status === 'model_failed')
  assert.equal(f.store.snapshot().inbox[0].modelErrorCode, 'memory_evidence_invalid')
  assert.equal(f.manager.status().running, true)
  assert.equal(f.requests.length, 2)
  assert.equal(f.store.snapshot().memories, undefined)
  assert.equal(f.sends.length, 0)
})

test('continuous messages hit the maximum wait; generation-time arrivals form a later batch', async t => {
  let firstGenerationStarted = false
  let laterMessageRead = false
  const f = await fixture(t, { runtime: { batchQuietMs: 100, batchMaxWaitMs: 120 },
    poll: n => {
      if (n < 5) return [incoming(n, `part-${n}`)]
      if (firstGenerationStarted && !laterMessageRead) { laterMessageRead = true; return [incoming(5, '下一批')] }
      return []
    },
    reply: async (_, n) => {
      if (n === 1) { firstGenerationStarted = true; await new Promise(r => setTimeout(r, 30)) }
      return `第${n}批回复`
    } })
  await f.manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'yes' })
  await until(() => f.manager.status().deliveredCount === 2)
  await f.manager.pause()
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests.map(r => JSON.parse(r.messages.at(-1).content[0].text).messages.map(m => m.text)),
    [['part-1', 'part-2', 'part-3', 'part-4'], ['下一批']])
})
