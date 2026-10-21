import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationManager, selectedConfig, validateCatalog } from '../lib/conversations.js'

const raw = { stateRoot: 'E:/test/group', personaPath: 'E:/test/persona.md', pythonExe: 'E:/test/pythonw.exe',
  provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 512, pollIntervalMs: 2000,
  historyTurns: 8, autoStart: false, autoSend: false, memoryEnabled: true,
  worker: { dbRoot: 'E:/db', stateRoot: 'E:/reader', keyCacheFile: 'E:/reader/keys.json',
    botWxid: 'bot', botName: 'BOT_ACCOUNT', targetWxid: '123@chatroom', targetName: '群',
    conversationType: 'group', groupReplyPolicy: 'model', proactiveEnabled: true,
    expectedExe: 'E:/Weixin.exe', expectedVersion: '4.1.15.13', gateTimeoutSeconds: 30,
    mainWindowClass: 'Qt', mainWindowTitle: '微信' } }
const target = { id: 'friend', name: '朋友', type: 'direct' }
const token = 'authorized'
function fixture({ uncertain = false, selectionFails = false, writeFails = false } = {}) {
  const calls = []
  const managers = []
  const make = name => {
    const state = { phase: 'paused', uncertainSend: name === 'old' && uncertain, autoSendEnabled: true, sendGrantValid: true }
    const m = { state, status: () => state,
      async pause() { state.phase = 'paused'; calls.push(name + ':pause') },
      async revokeSendGrant() { calls.push(name + ':revoke') },
      async start(args) {
        assert.deepEqual(args, { autoSend: true, allowTemporaryGate: true, sessionToken: token })
        state.phase = 'running'; calls.push(name + ':start'); return state
      },
      async dispose() { calls.push(name + ':dispose') },
      async conversationOperation(method) {
        calls.push(name + ':' + method)
        if (method === 'conversations') return { selfId: 'bot', conversations: [target] }
        if (selectionFails) throw Error('selection_failed')
        return { selected: true }
      } }
    managers.push(m)
    return m
  }
  const runtime = { ...raw, configPath: 'E:/test/config.json' }
  const old = make('old')
  let saved = null
  const manager = new ConversationManager({ runtime, manager: old, sessionValid: value => value === token,
    readConfig: async () => JSON.stringify(raw), writeConfig: async (_path, value) => {
      if (writeFails) throw Error('disk_write_failed')
      calls.push('save'); saved = value
    },
    createManager: async args => { assert.equal(args.resume, false); return make('next') } })
  const select = extra => manager.selectConversation({ targetId: target.id, currentId: raw.worker.targetWxid,
    selectionConfirmed: true, sessionToken: token, ...extra })
  return { manager, select, calls, managers, old, saved: () => saved }
}

test('switch pauses old listener, verifies UI, saves new scope, and starts the selected listener', async () => {
  const f = fixture()
  const result = await f.select()
  assert.equal(result.switching, false)
  assert.deepEqual(f.calls, ['old:conversations', 'old:pause', 'next:pause', 'next:revoke', 'next:select', 'old:dispose', 'save', 'next:start'])
  assert.equal(f.saved().worker.targetWxid, target.id)
  assert.equal(f.manager.status().phase, 'running')
  assert.equal(f.saved().autoStart, true)
  assert.equal(f.manager.status().switching, false)
})

test('uncertain send, stale current conversation, and absent consent prevent any selection', async () => {
  const uncertain = fixture({ uncertain: true })
  await assert.rejects(uncertain.select(), /send_recovery_required/)
  assert.deepEqual(uncertain.calls, [])
  const stale = fixture()
  await assert.rejects(stale.select({ currentId: 'other' }), /conversation_selection_stale/)
  await assert.rejects(stale.select({ sessionToken: 'wrong' }), /selection_consent_required/)
  assert.deepEqual(stale.calls, [])
})

test('selection failure preserves config and leaves old conversation paused; candidate is closed', async () => {
  const f = fixture({ selectionFails: true })
  await assert.rejects(f.select(), /selection_failed/)
  assert.equal(f.saved(), null)
  assert.equal(f.manager.manager, f.old)
  assert.equal(f.old.state.phase, 'paused')
  assert.ok(f.calls.includes('next:dispose'))
  assert.equal(f.manager.status().switching, false)
})

test('config write failure recreates the old paused manager and does not automatically send', async () => {
  const f = fixture({ writeFails: true })
  await assert.rejects(f.select(), /disk_write_failed/)
  assert.equal(f.saved(), null)
  assert.equal(f.manager.runtime.worker.targetWxid, raw.worker.targetWxid)
  assert.equal(f.manager.status().phase, 'paused')
  assert.equal(f.managers.length, 3)
})

test('conversation state roots survive round trips and do not nest when choosing new peers', () => {
  const first = selectedConfig(raw, target)
  const another = selectedConfig(first, { id: 'other', name: '其他', type: 'direct' })
  const back = selectedConfig(another, { id: '123@chatroom', name: '群', type: 'group' })
  assert.equal(back.stateRoot, raw.stateRoot)
  assert.equal(first.conversationStateBaseRoot, another.conversationStateBaseRoot)
  assert.equal(first.worker.groupReplyPolicy, undefined)
  assert.equal(back.worker.groupReplyPolicy, 'model')
  assert.equal(back.worker.proactiveEnabled, true)
})

test('catalog rejects malformed, duplicate, cross-account and mismatched type identities', () => {
  assert.deepEqual(validateCatalog({ selfId: 'bot', conversations: [target] }, 'bot'), [target])
  for (const input of [
    { selfId: 'other', conversations: [target] }, { selfId: 'bot', conversations: [target, target] },
    { selfId: 'bot', conversations: [{ ...target, id: '../../state' }] },
    { selfId: 'bot', conversations: [{ ...target, type: 'group' }] },
  ]) assert.throws(() => validateCatalog(input, 'bot'), /conversation_catalog_invalid/)
})
