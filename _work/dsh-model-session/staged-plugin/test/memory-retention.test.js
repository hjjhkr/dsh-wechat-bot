import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyMemory, memoryContext, newMemory, ownerKey, parseMemoryReply, publishMemory } from '../lib/memory.js'
import { compactState } from '../lib/retention.js'
import { buildHistory } from '../lib/model.js'
import { StateStore } from '../lib/store.js'

const worker = { botWxid: 'bot', targetWxid: 'alice', targetName: 'Alice' }
const entries = [{ key: 'a', text: '我喜欢短回复' }]
const update = { action: 'upsert', category: 'preferences', topic: '回复长度', text: '喜欢短回复', messageId: '1', quote: '喜欢短回复' }
const config = { retentionMs: 1800000, overlapSeq: 128, provider: 'p', model: 'm' }
const now = Date.now()
const old = new Date(now - 1800001).toISOString()

test('memory persists across reopening the state, is isolated by bot/user and forget removes the fact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await StateStore.open(root)
  const a = applyMemory(newMemory(worker), [update], entries, now)
  await store.transact(s => { s.memories = { [ownerKey(worker)]: a } })
  await publishMemory(root, a)
  await store.close()
  const reopened = await StateStore.open(root)
  assert.equal(memoryContext(reopened.snapshot().memories[ownerKey(worker)]).preferences[0].text, '喜欢短回复')
  assert.equal(reopened.snapshot().memories[ownerKey({ ...worker, targetWxid: 'bob' })], undefined)
  assert.equal(reopened.snapshot().memories[ownerKey({ ...worker, botWxid: 'other' })], undefined)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'memory', 'bot', 'alice.json'), 'utf8')), a)
  const forgotten = applyMemory(a, [{ ...update, action: 'forget', text: '' }], [{ key: 'b', text: '忘掉回复长度偏好' }], now + 1)
  assert.equal(forgotten.sections.preferences.length, 0)
  assert.equal(a.sections.preferences.length, 1)
  await reopened.close()
})

test('sensitive memories and unsupported erasure are rejected; ongoing facts expire', () => {
  assert.throws(() => parseMemoryReply(JSON.stringify({ reply: '记住', memory: [
    { ...update, text: '密码123456', quote: '密码123456' },
  ] }), [{ key: 'x', text: '密码123456' }]), /memory_sensitive_content_rejected/)
  assert.throws(() => parseMemoryReply(JSON.stringify({ reply: '已忘记', memory: [
    { ...update, action: 'forget' },
  ] }), entries), /memory_forget_not_requested/)
  const doc = applyMemory(newMemory(worker), [{ ...update, category: 'ongoing' }], entries, now)
  assert.equal(memoryContext(doc, now).ongoing.length, 1)
  assert.equal(memoryContext(doc, now + 31 * 86400000).ongoing.length, 0)
})

test('30-minute cleanup removes only memory-published terminal content and protects pending/uncertain batches', () => {
  const row = { receivedAt: old, memoryCommittedAt: old, memoryPublishedAt: old, text: 'old private text', draft: 'reply' }
  const state = { cursor: { sortSeq: 1100 }, memories: { keep: 'persistent' }, inbox: [
    { ...row, key: 'done', sortSeq: 900, status: 'delivered' },
    { ...row, key: 'overlap', sortSeq: 1090, status: 'drafted' },
    { ...row, key: 'pending', sortSeq: 902, status: 'received' },
    { ...row, key: 'uncertain', sortSeq: 903, status: 'ambiguous' },
    { ...row, key: 'unpublished', sortSeq: 904, status: 'drafted', memoryPublishedAt: null },
    { ...row, key: 'fresh', sortSeq: 1100, status: 'drafted', receivedAt: new Date(now).toISOString() },
  ], outbox: [
    { attemptId: 'delivered', incomingKey: 'done', incomingKeys: ['done'], status: 'delivered', text: 'reply' },
    { attemptId: 'bad', incomingKey: 'uncertain', status: 'ambiguous', text: 'keep draft' },
  ] }
  compactState(state, config, now)
  assert.ok(!JSON.stringify(state).includes('"done","sortSeq"'))
  assert.equal(state.inbox.find(i => i.key === 'done'), undefined)
  assert.equal(state.inbox.find(i => i.key === 'overlap').text, undefined)
  for (const key of ['pending', 'uncertain', 'unpublished', 'fresh']) assert.equal(state.inbox.find(i => i.key === key).text, 'old private text')
  assert.equal(state.outbox[0].text, undefined)
  assert.equal(state.outbox[1].text, 'keep draft')
  assert.deepEqual(state.memories, { keep: 'persistent' })
  assert.equal(state.retiredBeforeSeq, 972)
})

test('one historical batch makes one user turn and one delivered assistant turn', () => {
  const state = { inbox: [
    { key: 'a', sortSeq: 1, batchId: 'batch', text: 'first', timestamp: 1 },
    { key: 'b', sortSeq: 2, batchId: 'batch', text: 'second', timestamp: 2 },
    { key: 'c', sortSeq: 3, status: 'received', text: 'next', timestamp: 3 },
  ], outbox: [{ attemptId: 'out', incomingKey: 'a', incomingKeys: ['a', 'b'], status: 'delivered', text: 'one response' }] }
  const history = buildHistory(state, 8, 'c', config)
  assert.equal(history.length, 2)
  assert.deepEqual(JSON.parse(history[0].content[0].text).messages.map(m => m.text), ['first', 'second'])
  assert.equal(history[1].content[0].text, 'one response')
})
