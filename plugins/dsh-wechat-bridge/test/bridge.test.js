import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BridgeManager } from '../lib/bridge.js'
import { StateStore } from '../lib/store.js'

const runtimeFor = (stateRoot) => ({
  stateRoot,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 512,
  pollIntervalMs: 1000,
  historyTurns: 4,
  overlapSeq: 128,
  maxItems: 100,
  rpcTimeoutMs: 1000,
  autoStart: false,
  autoSend: false,
  batchQuietMs: 0,
  batchMaxWaitMs: 0,
  worker: {
    botWxid: 'wxid_REDACTED_ACCOUNT', botName: 'BOT_ACCOUNT', targetWxid: 'wxid_REDACTED_ACCOUNT', targetName: 'USER_OWNER',
    expectedExe: 'D:/Weixin/Weixin.exe', expectedVersion: '4.1.15.13',
    mainWindowClass: 'Qt51514QWindowIcon', mainWindowTitle: '微信', gateTimeoutSeconds: 30,
    gateRva: 185818168, gateExpectedOriginalByte: 0, gateEnabledByte: 1,
    gateModule: 'D:/Weixin/4.1.15.13/Weixin.dll',
  },
})

const probe = () => ({
  selfId: 'wxid_REDACTED_ACCOUNT', targetId: 'wxid_REDACTED_ACCOUNT',
  binding: {
    pid: 100, processStartedAt: 'test', hwnd: 100, version: '4.1.15.13',
    mainWindowClass: 'Qt51514QWindowIcon', mainWindowTitle: '微信',
  },
})
const baseline = () => ({ selfId: 'wxid_REDACTED_ACCOUNT', targetId: 'wxid_REDACTED_ACCOUNT', cursor: { sortSeq: 0 } })
const message = {
  bot: 'wxid_REDACTED_ACCOUNT', target: 'wxid_REDACTED_ACCOUNT',
  shard: 'message__message_0.db', local_id: 21, sort_seq: 12,
  senderId: 'wxid_REDACTED_ACCOUNT', text: 'ping', timestamp: 1792476000, isSelf: false,
}
const draftLlm = {
  async *stream() {
    yield { type: 'text-delta', text: '你好，我是小鲸鱼。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

test('autoStart resumes a paused listener on host startup without a page session', async (t) => {
  const store = await makeStore(t)
  await store.transact(s => { s.phase = 'paused'; s.runRequested = false })
  let polls = 0
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') { polls++; return { messages: [], nextCursor: { sortSeq: 0 }, complete: true } }
      throw Error('unexpected send')
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const manager = new BridgeManager({ runtime: { ...runtimeFor(store.root), autoStart: true },
    persona: 'persona', llm: draftLlm, store, createWorker: async () => worker })
  t.after(() => manager.dispose())
  await manager.recover()
  assert.equal(manager.status().running, true)
  await waitFor(() => polls > 0)
  assert.equal(manager.status().autoSendEnabled, false)
  await manager.pause()
  await manager.dispose()
})

test('console logs retain full message and reply text and expose failed-send diagnostics without grant data', async (t) => {
  const store = await makeStore(t)
  const text = '完整正文\n<不是HTML>' + '长消息'.repeat(500)
  await store.transact(s => {
    s.inbox.push({ key: 'one', text, senderId: 'friend', senderName: '朋友',
      receivedAt: '2026-10-21T03:00:00.000Z', draft: '完整回复', draftAt: '2026-10-21T03:00:01.000Z', status: 'ambiguous' })
    s.outbox.push({ attemptId: 'attempt-one', incomingKey: 'one', text: '完整回复', status: 'ambiguous',
      attemptedAt: '2026-10-21T03:00:02.000Z', errorCode: 'send_ambiguous', reasonCode: 'uia_draft',
      sendAttempted: false, focusDiagnostic: { safe: true } })
    s.sendGrant = { scopeHash: 'a'.repeat(64), grantedAt: '2026-10-21T02:00:00.000Z' }
  })
  const manager = new BridgeManager({ runtime: runtimeFor(store.root), persona: 'private persona', llm: draftLlm, store })
  assert.equal(typeof manager.logs, 'function')
  const log = manager.logs()
  assert.equal(log.entries.find(e => e.kind === 'received').text, text)
  assert.equal(log.entries.find(e => e.kind === 'reply').text, '完整回复')
  const failed = log.entries.find(e => e.kind === 'send_result')
  assert.equal(failed.details.reasonCode, 'uia_draft')
  assert.equal(failed.details.sendAttempted, false)
  assert.equal(failed.details.focusDiagnostic.safe, true)
  assert.equal(JSON.stringify(log).includes('a'.repeat(64)), false)
  assert.equal(JSON.stringify(log).includes('private persona'), false)
})

test('isolated lock keeps polling without generating or sending, then processes pending messages after unlock', async (t) => {
  const store = await makeStore(t)
  let unlocked = false, polls = 0, modelCalls = 0, sends = 0
  const runtime = runtimeFor(store.root)
  runtime.worker.desktopName = 'DshWeChatBot_test'
  runtime.pollIntervalMs = 5
  const worker = {
    async request(method, params) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') return { messages: ++polls === 1 ? [message] : [],
        nextCursor: { sortSeq: 12 }, complete: true, desktopAvailable: unlocked }
      if (method === 'send') {
        sends++
        assert.equal(unlocked, true)
        return { status: 'confirmed', sendAttempted: true, gateActive: false, gateRestored: true,
          outgoing: { target: params.target, senderId: params.expectedSelfId, text: params.text,
            serverId: '42', localId: 22, shard: 's', sortSeq: 13 } }
      }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const llm = { async *stream(...args) { modelCalls++; yield* draftLlm.stream(...args) } }
  const manager = new BridgeManager({ runtime, persona: 'persona', llm, store,
    createWorker: async () => worker, sessionValid: () => true })
  t.after(() => manager.dispose())
  await manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'consent' })
  await waitFor(() => polls >= 3)
  assert.equal(manager.status().waitingForDesktop, true)
  assert.equal(manager.status().phase, 'running')
  assert.equal(store.snapshot().inbox[0].status, 'received')
  assert.equal(modelCalls, 0)
  assert.equal(sends, 0)
  unlocked = true
  await waitFor(() => manager.status().deliveredCount === 1)
  assert.equal(modelCalls, 1)
  assert.equal(sends, 1)
  assert.equal(manager.status().waitingForDesktop, false)
  await manager.pause()
  await manager.dispose()
})

test('a desktop block proved before any send can resume the same draft after unlock', async (t) => {
  const store = await makeStore(t)
  let polls = 0, sendRequests = 0, modelCalls = 0, unlocked = true
  const runtime = runtimeFor(store.root)
  runtime.worker.desktopName = 'DshWeChatBot_test'
  runtime.pollIntervalMs = 5
  const worker = {
    async request(method, params) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') return { messages: ++polls === 1 ? [message] : [],
        nextCursor: { sortSeq: 12 }, complete: true, desktopAvailable: unlocked }
      if (method === 'send') {
        if (++sendRequests === 1) {
          unlocked = false
          return { status: 'blocked', reasonCode: 'desktop_unavailable', sendAttempted: false,
            gateActive: false, gateRestored: true }
        }
        assert.equal(unlocked, true)
        return { status: 'confirmed', sendAttempted: true, gateActive: false, gateRestored: true,
          outgoing: { target: params.target, senderId: params.expectedSelfId, text: params.text,
            serverId: '43', localId: 22, shard: 's', sortSeq: 13 } }
      }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const llm = { async *stream(...args) { modelCalls++; yield* draftLlm.stream(...args) } }
  const manager = new BridgeManager({ runtime, persona: 'persona', llm, store,
    createWorker: async () => worker, sessionValid: () => true })
  t.after(() => manager.dispose())
  await manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'consent' })
  await waitFor(() => manager.status().waitingForDesktop === true && polls >= 3)
  assert.equal(manager.status().uncertainSend, false)
  assert.equal(manager.status().gateActive, false)
  assert.equal(store.snapshot().outbox.length, 0)
  assert.equal(sendRequests, 1)
  unlocked = true
  await waitFor(() => manager.status().deliveredCount === 1)
  assert.equal(modelCalls, 1)
  assert.equal(sendRequests, 2)
  assert.equal(store.snapshot().outbox.length, 1)
  await manager.pause()
  await manager.dispose()
})

test('a new send grant does not resume a draft deferred under a previous grant', async (t) => {
  const store = await makeStore(t)
  const runtime = runtimeFor(store.root)
  runtime.worker.desktopName = 'DshWeChatBot_test'
  runtime.pollIntervalMs = 5
  let polls = 0, sends = 0
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') { polls++; return { messages: [], nextCursor: { sortSeq: 12 }, complete: true, desktopAvailable: true } }
      if (method === 'send') sends++
      throw Error('unexpected_method')
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  await store.transact(state => {
    state.cursor = { sortSeq: 12 }
    state.inbox.push({ key: 'old', status: 'drafted', draft: 'old draft', desktopDeferred: true, sendEligible: true })
  })
  const manager = new BridgeManager({ runtime, persona: 'persona', llm: draftLlm, store,
    createWorker: async () => worker, sessionValid: () => true })
  t.after(() => manager.dispose())
  await manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'new-consent' })
  await waitFor(() => polls >= 3)
  assert.equal(sends, 0)
  assert.equal(store.snapshot().inbox[0].desktopDeferred, undefined)
  assert.equal(store.snapshot().inbox[0].draft, 'old draft')
  await manager.pause()
  await manager.dispose()
})

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-bridge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return StateStore.open(root)
}

async function waitFor(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for bridge state')
}

test('bridge resumes persisted received messages after cursor has advanced, then pause confirms worker closure', async (t) => {
  const store = await makeStore(t)
  const key = JSON.stringify([message.bot, message.target, message.shard, message.local_id, message.sort_seq])
  await store.transact((state) => {
    state.cursor = { sortSeq: message.sort_seq }
    state.inbox.push({ key, bot: message.bot, target: message.target, shard: message.shard, localId: String(message.local_id), sortSeq: message.sort_seq, senderId: message.senderId, text: message.text, timestamp: message.timestamp, status: 'received', draft: null, draftAt: null })
  })
  let closed = 0
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') return { messages: [], nextCursor: { sortSeq: 12 }, complete: true }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { closed++; return { closed: true, gateActive: false, gateRestored: true } },
  }
  const manager = new BridgeManager({
    runtime: runtimeFor(store.root), persona: 'persona', llm: draftLlm, store,
    createWorker: async () => worker,
  })
  await manager.start()
  await waitFor(() => manager.status().draftCount === 1)
  assert.equal(manager.latestDraft().draft.text, '你好，我是小鲸鱼。')
  const status = await manager.pause()
  assert.equal(status.phase, 'paused')
  assert.equal(status.workerClosed, true)
  assert.equal(status.gateActive, false)
  assert.equal(closed, 1)
  await manager.dispose()
})

test('ambiguous send is persisted and a subsequent start cannot retry it', async (t) => {
  const store = await makeStore(t)
  let sends = 0
  let polls = 0
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') {
        polls++
        return { messages: polls === 1 ? [message] : [], nextCursor: { sortSeq: 12 }, complete: true }
      }
      if (method === 'send') {
        sends++
        return { status: 'ambiguous', gateActive: false, gateRestored: true }
      }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const manager = new BridgeManager({
    runtime: runtimeFor(store.root), persona: 'persona', llm: draftLlm, store,
    createWorker: async () => worker,
    sessionValid: (token) => token === 'user-consented-session',
  })
  await manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'user-consented-session' })
  await waitFor(() => manager.status().uncertainSend && manager.status().workerClosed)
  assert.equal(sends, 1)
  assert.equal(manager.status().workerClosed, true)
  await assert.rejects(
    manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'user-consented-session' }),
    (error) => error.code === 'send_recovery_required',
  )
  assert.equal(sends, 1)
  await manager.dispose()

  const reopenedStore = await StateStore.open(store.root)
  let recoveryWorkerStarts = 0
  const recovered = new BridgeManager({
    runtime: runtimeFor(store.root), persona: 'persona', llm: draftLlm, store: reopenedStore,
    createWorker: async () => { recoveryWorkerStarts++; return worker },
  })
  await recovered.recover()
  assert.equal(recovered.status().uncertainSend, true)
  assert.equal(recoveryWorkerStarts, 0)
  await assert.rejects(recovered.start(), (error) => error.code === 'send_recovery_required')
  assert.equal(sends, 1)
  await recovered.dispose()
})

test('manual no-retry acknowledgement skips only the old message and leaves new messages available', async (t) => {
  const store = await makeStore(t)
  const newMessage = { ...message, local_id: 22, sort_seq: 13, text: 'new incoming' }
  let polls = 0
  let sends = 0
  let workerStarts = 0
  const sentTexts = []
  const draftedInputs = []
  const worker = {
    async request(method, params) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') {
        polls++
        return {
          messages: polls === 1 ? [message] : [message, newMessage],
          nextCursor: { sortSeq: polls === 1 ? 12 : 13 }, complete: true,
        }
      }
      if (method === 'send') {
        sends++
        sentTexts.push(params.text)
        if (sends === 1) {
          return { status: 'ambiguous', reasonCode: 'db_verify', sendAttempted: true, gateActive: false, gateRestored: true }
        }
        return {
          status: 'confirmed', sendAttempted: true, gateActive: false, gateRestored: true,
          outgoing: {
            target: 'wxid_REDACTED_ACCOUNT', senderId: 'wxid_REDACTED_ACCOUNT', text: params.text,
            serverId: '9007199254740993', localId: 23, shard: 'message__message_0.db', sortSeq: 14,
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const llm = {
    async *stream({ messages }) {
      const incoming = JSON.parse(messages.at(-1).content.find((part) => part.type === 'text').text).messages.map(m => m.text).join('\n')
      draftedInputs.push(incoming)
      yield { type: 'text-delta', text: `reply:${incoming}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const runtime = runtimeFor(store.root)
  runtime.pollIntervalMs = 5
  const manager = new BridgeManager({
    runtime, persona: 'persona', llm, store,
    createWorker: async () => { workerStarts++; return worker },
    sessionValid: (token) => token === 'user-consented-session',
  })
  const consent = { autoSend: true, allowTemporaryGate: true, sessionToken: 'user-consented-session' }
  await manager.start(consent)
  await waitFor(() => manager.status().uncertainSend && manager.status().workerClosed)

  const uncertain = manager.status().uncertainAttempts
  assert.equal(uncertain.length, 1)
  assert.deepEqual({ ...uncertain[0], attemptId: 'attempt-id-redacted' }, {
    attemptId: 'attempt-id-redacted', status: 'ambiguous', reasonCode: 'db_verify', sendAttempted: true, focusDiagnostic: null,
  })
  assert.equal(Object.hasOwn(uncertain[0], 'text'), false)
  const attemptId = uncertain[0].attemptId
  await assert.rejects(
    manager.acknowledgeNoRetry({ attemptId, confirmedNoRetry: false }),
    (error) => error.code === 'confirmation_required',
  )
  const grantBeforeAck = store.snapshot().sendGrant
  const acknowledged = await manager.acknowledgeNoRetry({ attemptId, confirmedNoRetry: true })
  assert.equal(acknowledged.phase, 'paused')
  assert.equal(acknowledged.runRequested, false)
  assert.equal(acknowledged.uncertainSend, false)
  assert.deepEqual(acknowledged.uncertainAttempts, [])
  assert.equal(workerStarts, 1)
  const afterAck = store.snapshot()
  assert.equal(afterAck.cursor.sortSeq, 12)
  assert.equal(afterAck.runRequested, false)
  assert.equal(afterAck.autoSendEnabled, true)
  assert.deepEqual(afterAck.sendGrant, grantBeforeAck)
  assert.equal(afterAck.inbox[0].status, 'skipped')
  assert.equal(afterAck.inbox[0].text, message.text)
  assert.equal(afterAck.inbox[0].draft, `reply:${message.text}`)
  assert.equal(afterAck.inbox[0].skipReason, 'confirmed_no_retry')
  assert.equal(afterAck.outbox[0].status, 'abandoned')
  assert.equal(afterAck.outbox[0].attemptId, attemptId)
  assert.equal(afterAck.outbox[0].text, `reply:${message.text}`)
  assert.equal(afterAck.outbox[0].errorCode, 'send_ambiguous')
  assert.equal(afterAck.outbox[0].reasonCode, 'db_verify')
  assert.equal(afterAck.outbox[0].sendAttempted, true)
  assert.equal(afterAck.outbox[0].resolution.confirmedNoRetry, true)

  await manager.start(consent)
  assert.equal(workerStarts, 2)
  await waitFor(() => manager.status().deliveredCount === 1)
  assert.deepEqual(draftedInputs, [message.text, newMessage.text])
  assert.deepEqual(sentTexts, [`reply:${message.text}`, `reply:${newMessage.text}`])
  const finalState = store.snapshot()
  assert.deepEqual(finalState.outbox.map((item) => item.status), ['abandoned', 'delivered'])
  assert.deepEqual(finalState.inbox.map((item) => item.status), ['skipped', 'delivered'])
  assert.equal(finalState.cursor.sortSeq, 13)
  await manager.pause()
  await manager.dispose()
})

test('RPC failure leaves a safe attempted marker and exposes no raw exception', async (t) => {
  const store = await makeStore(t)
  let polls = 0
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') {
        polls++
        return { messages: polls === 1 ? [message] : [], nextCursor: { sortSeq: 12 }, complete: true }
      }
      if (method === 'send') throw new Error('private exception detail must never be exposed')
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const runtime = runtimeFor(store.root)
  runtime.pollIntervalMs = 5
  const manager = new BridgeManager({
    runtime, persona: 'persona', llm: draftLlm, store,
    createWorker: async () => worker,
    sessionValid: (token) => token === 'user-consented-session',
  })
  await manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'user-consented-session' })
  await waitFor(() => manager.status().uncertainSend && manager.status().workerClosed)

  const status = manager.status()
  assert.deepEqual(status.uncertainAttempts.map(({ status: attemptStatus, reasonCode, sendAttempted }) => ({
    status: attemptStatus, reasonCode, sendAttempted,
  })), [{ status: 'attempted', reasonCode: 'send_unknown', sendAttempted: null }])
  assert.equal(JSON.stringify(status).includes('private exception detail'), false)
  assert.equal(JSON.stringify(status).includes(message.text), false)
  assert.equal(store.snapshot().outbox[0].errorCode, 'send_result_unknown')
  assert.equal(store.snapshot().outbox[0].reasonCode, 'send_unknown')

  await manager.acknowledgeNoRetry({
    attemptId: status.uncertainAttempts[0].attemptId, confirmedNoRetry: true,
  })
  const abandoned = store.snapshot().outbox[0]
  assert.equal(abandoned.status, 'abandoned')
  assert.equal(abandoned.errorCode, 'send_result_unknown')
  assert.equal(abandoned.reasonCode, 'send_unknown')
  await manager.dispose()
})

test('same-cursor empty polls make no model calls and repeated target messages draft only once', async (t) => {
  const store = await makeStore(t)
  let polls = 0
  let releaseTarget = false
  let modelCalls = 0
  const selfMessage = { ...message, bot: 'wxid_REDACTED_ACCOUNT', target: 'wxid_REDACTED_ACCOUNT', senderId: 'wxid_REDACTED_ACCOUNT', text: 'bot echo', isSelf: true }
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') {
        polls++
        return {
          messages: releaseTarget ? [message, selfMessage] : [],
          nextCursor: { sortSeq: releaseTarget ? 12 : 0 }, complete: true,
        }
      }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const llm = {
    async *stream() {
      modelCalls++
      yield { type: 'text-delta', text: '你好，我是小鲸鱼。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const runtime = runtimeFor(store.root)
  runtime.pollIntervalMs = 5
  const manager = new BridgeManager({ runtime, persona: 'persona', llm, store, createWorker: async () => worker })
  await manager.start()
  await waitFor(() => polls >= 3)
  assert.equal(modelCalls, 0)
  releaseTarget = true
  await waitFor(() => polls >= 6 && manager.status().draftCount === 1)
  assert.equal(modelCalls, 1)
  const status = await manager.pause()
  assert.equal(status.receivedCount, 1)
  assert.equal(status.draftCount, 1)
  await manager.dispose()
})

test('a message from any conversation other than the configured target fails closed without a model call', async (t) => {
  const store = await makeStore(t)
  let modelCalls = 0
  const unrelated = { ...message, target: 'different-chat', senderId: 'different-sender' }
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') return { messages: [unrelated], nextCursor: { sortSeq: 12 }, complete: true }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const llm = { async *stream() { modelCalls++; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const manager = new BridgeManager({
    runtime: runtimeFor(store.root), persona: 'persona', llm, store,
    createWorker: async () => worker,
  })
  await manager.start()
  await waitFor(() => manager.status().phase === 'error' && manager.status().workerClosed)
  assert.equal(manager.status().lastErrorCode, 'poll_target_mismatch')
  assert.equal(modelCalls, 0)
  await manager.dispose()
})

test('persistent send grant resumes after graceful host restart only within the same scope', async (t) => {
  const store = await makeStore(t)
  let sends = 0
  let polls = 0
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') { polls++; return { messages: [], nextCursor: { sortSeq: 0 }, complete: true } }
      if (method === 'send') { sends++; return { status: 'ambiguous', gateActive: false, gateRestored: true } }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const runtime = runtimeFor(store.root)
  const options = {
    runtime, persona: 'persona', llm: draftLlm,
    createWorker: async () => worker,
    sessionValid: (token) => token === 'fresh-control-session',
  }
  const first = new BridgeManager({ ...options, store })
  await first.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'fresh-control-session' })
  assert.equal(first.status().persistentSendGranted, true)
  await first.dispose() // Graceful host shutdown preserves runRequested and the scoped grant.

  const reopenedStore = await StateStore.open(store.root)
  const second = new BridgeManager({ ...options, store: reopenedStore, sessionValid: () => false })
  await second.recover()
  await waitFor(() => polls >= 2 && second.status().running)
  assert.equal(second.status().autoSendEnabled, true)
  assert.equal(second.status().persistentSendGranted, true)
  assert.equal(sends, 0)
  await second.pause()
  const revoked = await second.revokeSendGrant()
  assert.equal(revoked.autoSendEnabled, false)
  assert.equal(revoked.persistentSendGranted, false)
  await second.dispose()
})

for (const [changedField, changedValue] of [
  ['mainWindowTitle', '不是当前微信窗口'],
  ['desktopName', 'DshWeChatBot_new_scope'],
]) {
test(`${changedField} change invalidates the persistent send grant`, async (t) => {
  const store = await makeStore(t)
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') return { messages: [], nextCursor: { sortSeq: 0 }, complete: true }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const options = {
    persona: 'persona', llm: draftLlm, createWorker: async () => worker,
    sessionValid: (token) => token === 'user-consented-session',
  }
  const first = new BridgeManager({ ...options, runtime: runtimeFor(store.root), store })
  await first.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'user-consented-session' })
  assert.equal(first.status().persistentSendGranted, true)
  await first.dispose()

  const changedRuntime = runtimeFor(store.root)
  changedRuntime.worker[changedField] = changedValue
  const reopenedStore = await StateStore.open(store.root)
  let workerStarts = 0
  const recovered = new BridgeManager({
    ...options,
    runtime: changedRuntime,
    store: reopenedStore,
    createWorker: async () => { workerStarts++; return worker },
    sessionValid: () => false,
  })
  await recovered.recover()
  assert.equal(recovered.status().phase, 'paused')
  assert.equal(recovered.status().autoSendEnabled, false)
  assert.equal(recovered.status().persistentSendGranted, false)
  assert.equal(recovered.status().lastErrorCode, 'send_scope_changed')
  assert.equal(workerStarts, 0)
  await recovered.dispose()
})
}

test('real worker poll and confirmed send wire values preserve Unix seconds and large server ids', async (t) => {
  const store = await makeStore(t)
  let polls = 0
  let sends = 0
  const body = '你好，我是小鲸鱼。'
  const outgoing = {
    target: 'wxid_REDACTED_ACCOUNT', senderId: 'wxid_REDACTED_ACCOUNT', text: body,
    serverId: '9007199254740993', localId: 22, shard: 'message__message_0.db', sortSeq: 13,
  }
  const worker = {
    async request(method) {
      if (method === 'probe') return probe()
      if (method === 'baseline') return baseline()
      if (method === 'poll') {
        polls++
        return { messages: polls === 1 ? [message] : [], nextCursor: { sortSeq: 12 }, complete: true }
      }
      if (method === 'send') {
        sends++
        return { status: 'confirmed', sendAttempted: true, gateActive: false, gateRestored: true, outgoing }
      }
      throw new Error(`unexpected method ${method}`)
    },
    async close() { return { closed: true, gateActive: false, gateRestored: true } },
  }
  const runtime = runtimeFor(store.root)
  runtime.pollIntervalMs = 5
  const manager = new BridgeManager({
    runtime, persona: 'persona', llm: draftLlm, store, createWorker: async () => worker,
    sessionValid: (token) => token === 'user-consented-session',
  })
  await manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'user-consented-session' })
  await waitFor(() => manager.status().deliveredCount === 1)
  await manager.pause()
  const saved = store.snapshot().outbox[0]
  assert.equal(sends, 1)
  assert.equal(saved.status, 'delivered')
  assert.equal(saved.serverId, '9007199254740993')
  assert.equal(typeof saved.serverId, 'string')
  assert.equal(saved.outgoing.sortSeq, '13')
  assert.equal(store.snapshot().inbox[0].timestamp, 1792476000)
  await manager.dispose()
})

test('poll requires a non-negative safe-integer Unix timestamp', async (t) => {
  const invalidValues = ['1792476000', 1792476000.5, -1, Number.MAX_SAFE_INTEGER + 1]
  for (const timestamp of invalidValues) {
    await t.test(String(timestamp), async (subtest) => {
      const store = await makeStore(subtest)
      let modelCalls = 0
      const worker = {
        async request(method) {
          if (method === 'probe') return probe()
          if (method === 'baseline') return baseline()
          if (method === 'poll') return { messages: [{ ...message, timestamp }], nextCursor: { sortSeq: 12 }, complete: true }
          throw new Error(`unexpected method ${method}`)
        },
        async close() { return { closed: true, gateActive: false, gateRestored: true } },
      }
      const llm = { async *stream() { modelCalls++; yield { type: 'finish', reason: { kind: 'stop' } } } }
      const runtime = runtimeFor(store.root)
      runtime.pollIntervalMs = 5
      const manager = new BridgeManager({ runtime, persona: 'persona', llm, store, createWorker: async () => worker })
      await manager.start()
      await waitFor(() => manager.status().phase === 'error' && manager.status().workerClosed)
      assert.equal(manager.status().lastErrorCode, 'poll_message_invalid')
      assert.equal(modelCalls, 0)
      await manager.dispose()
    })
  }
})

test('confirmed sends require a restored gate and a positive decimal server-id string', async (t) => {
  const cases = [
    { name: 'gate restoration missing', gateRestored: false, serverId: '42' },
    { name: 'numeric server id rejected', gateRestored: true, serverId: Number('9007199254740993') },
    { name: 'zero-prefixed server id rejected', gateRestored: true, serverId: '042' },
    { name: 'blocked result cannot resume after a possible send', status: 'blocked', gateRestored: true, serverId: '42', isolated: true },
  ]
  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const store = await makeStore(subtest)
      let polls = 0
      let sends = 0
      const worker = {
        async request(method) {
          if (method === 'probe') return probe()
          if (method === 'baseline') return baseline()
          if (method === 'poll') {
            polls++
            return { messages: polls === 1 ? [message] : [], nextCursor: { sortSeq: 12 }, complete: true, desktopAvailable: true }
          }
          if (method === 'send') {
            sends++
            return {
              status: item.status ?? 'confirmed', reasonCode: 'desktop_unavailable', sendAttempted: true, gateActive: false, gateRestored: item.gateRestored,
              outgoing: {
                target: 'wxid_REDACTED_ACCOUNT', senderId: 'wxid_REDACTED_ACCOUNT',
                text: '你好，我是小鲸鱼。', serverId: item.serverId,
                localId: 22, shard: 'message__message_0.db', sortSeq: 13,
              },
            }
          }
          throw new Error(`unexpected method ${method}`)
        },
        async close() { return { closed: true, gateActive: false, gateRestored: true } },
      }
      const runtime = runtimeFor(store.root)
      if (item.isolated) runtime.worker.desktopName = 'DshWeChatBot_test'
      runtime.pollIntervalMs = 5
      const manager = new BridgeManager({
        runtime, persona: 'persona', llm: draftLlm, store, createWorker: async () => worker,
        sessionValid: (token) => token === 'user-consented-session',
      })
      await manager.start({ autoSend: true, allowTemporaryGate: true, sessionToken: 'user-consented-session' })
      await waitFor(() => manager.status().uncertainSend && manager.status().workerClosed)
      assert.equal(sends, 1)
      assert.equal(manager.status().deliveredCount, 0)
      assert.equal(store.snapshot().outbox[0].status, 'ambiguous')
      await manager.dispose()
    })
  }
})

