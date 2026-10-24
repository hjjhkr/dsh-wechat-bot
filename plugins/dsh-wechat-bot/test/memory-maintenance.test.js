import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarkdownMemory } from '../lib/markdown-memory.js'
import { MemoryMaintenance, parseCompactionProposal } from '../lib/memory-maintenance.js'

const CHAT = { id: 'g@chatroom', name: '群' }
const evidence = who => [{ id: 'm1', sender: { id: who, name: who }, text: '我说的', fromSelf: false }]
const until = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function setup(t, think) {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const memory = new MarkdownMemory(root, 'b'.repeat(24))
  const calls = []
  const maintenance = new MemoryMaintenance({
    memoryFor: () => memory,
    think: async args => { calls.push(JSON.parse(args.messages[0].text)); return think(JSON.parse(args.messages[0].text), args) },
    timeoutMs: 300,
  })
  t.after(() => maintenance.dispose())
  const give = (who, count, prefix = '主题') => memory.apply(
    Array.from({ length: count }, (_, i) => ({ who, topic: `${prefix}${i}`, note: `事实${i}`, evidence: 'm1' })), evidence(who))
  return { memory, maintenance, calls, give }
}

// Merges the first two topics; leaves the rest alone.
const mergeTwo = input => JSON.stringify({
  who: input.who,
  notes: [{ topic: '合并', note: `${input.automatic[0].note}、${input.automatic[1].note}`, sourceTopics: [input.automatic[0].topic, input.automatic[1].topic] }],
  discard: [],
})

test('a member reaching 30 notes is tidied automatically, once per cooldown', async t => {
  const { memory, maintenance, calls, give } = await setup(t, mergeTwo)
  await give('alice', 29)
  await maintenance.observe(CHAT)
  assert.equal(calls.length, 0, 'below the threshold')
  await give('alice', 1, '再来')
  await maintenance.observe(CHAT)
  await until(() => !maintenance.view(CHAT.id).running && calls.length === 1)
  assert.equal(Object.keys(await memory.recall('alice')).length, 29)
  assert.deepEqual(maintenance.view(CHAT.id).results.map(r => [r.who, r.status, r.before, r.after]), [['alice', 'completed', 30, 29]])
  await give('alice', 1, '又来')
  await maintenance.observe(CHAT)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(calls.length, 1, 'not again within the cooldown, even though it is back at 30')
})

test('the manual pass visits members with at least two notes; the manual section is never sent', async t => {
  const { memory, maintenance, calls, give } = await setup(t, mergeTwo)
  await give('alice', 3)
  await give('bob', 1)
  await maintenance.start(CHAT)
  await until(() => !maintenance.view(CHAT.id).running)
  assert.deepEqual(calls.map(c => c.who), ['alice'])
  assert.deepEqual(Object.keys(calls[0]), ['who', 'automatic'])
  assert.deepEqual(await memory.recall('alice'), { 主题2: '事实2', 合并: '事实0、事实1' })
  await assert.rejects(Promise.all([maintenance.start(CHAT), maintenance.start(CHAT)]), /busy/)
})

test('a failing or slow member is reported and the pass goes on to the next one', async t => {
  const { maintenance, give } = await setup(t, input => input.who === 'alice' ? new Promise(() => {}) : 'not json')
  await give('alice', 2)
  await give('bob', 2)
  await maintenance.start(CHAT)
  await until(() => !maintenance.view(CHAT.id).running)
  const results = maintenance.view(CHAT.id).results
  assert.deepEqual(results.map(r => r.status), ['failed', 'failed'])
  assert.deepEqual(results.map(r => r.error).sort(), ['compaction_response_not_json', 'timeout'])
})

test('dispose aborts the call in progress; nothing it returns is written', async t => {
  let finish
  const { memory, maintenance, give } = await setup(t, input => new Promise(resolve => { finish = () => resolve(mergeTwo(input)) }))
  await give('alice', 2)
  await maintenance.start(CHAT)
  await until(() => finish)
  const disposed = maintenance.dispose()
  finish()
  await disposed
  assert.equal(Object.keys(await memory.recall('alice')).length, 2)
  assert.equal(maintenance.view(CHAT.id).results[0].reason, 'cancelled')
})

test('the proposal parser: only topics it was given, each once, never longer than its sources', () => {
  const snapshot = { who: 'alice', automatic: [{ topic: 'a', note: '一二三' }, { topic: 'b', note: '四五六' }, { topic: 'c', note: '七' }] }
  const proposal = (notes, discard = []) => JSON.stringify({ who: 'alice', notes, discard })
  assert.deepEqual(parseCompactionProposal(proposal([{ topic: 'ab', note: '一二三四五六', sourceTopics: ['a', 'b'] }]), snapshot).notes.length, 1,
    'c is not mentioned: it simply stays')
  for (const [raw, code] of [
    ['不是 JSON', 'compaction_response_not_json'],
    [JSON.stringify({ who: 'bob', notes: [], discard: [] }), 'compaction_proposal_invalid'],
    [proposal([{ topic: 'x', note: '一', sourceTopics: ['zzz'] }]), 'compaction_source_unknown'],
    [proposal([{ topic: 'x', note: '一', sourceTopics: ['a'] }], [{ topic: 'a', reason: 'duplicate' }]), 'compaction_source_overlap'],
    [proposal([{ topic: 'x', note: '七'.repeat(30), sourceTopics: ['c'] }]), 'compaction_note_grew'],
    [proposal([{ topic: 'x', note: '我的密码', sourceTopics: ['a'] }]), 'compaction_note_invalid'],
    [proposal([{ topic: 'x', note: '一', sourceTopics: ['a'] }, { topic: 'x', note: '四', sourceTopics: ['b'] }]), 'compaction_duplicate_target'],
  ]) assert.throws(() => parseCompactionProposal(raw, snapshot), error => error.code === code, code)
})
