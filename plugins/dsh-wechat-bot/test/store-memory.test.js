import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Store } from '../lib/store.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-memory-store-'))
  const store = new Store(root, { delayMs: 100_000 })
  t.after(async () => { await store.flush(); await rm(root, { recursive: true, force: true }) })
  return store
}

test('new snapshots retain controls without writing chat bodies or duplicate memory', async t => {
  const store = await fixture(t)
  store.saveChatLater('group', {
    mode: 'at', wait: { quietMs: 1000, maxWaitMs: 3000 }, forgottenEvidence: ['old-id'],
    transcript: [{ text: 'temporary-chat-body' }], log: [{ raw: 'temporary-model-output' }],
    memory: { members: {} }, memberCache: [{ id: 'someone' }],
  })
  await store.flush()
  const raw = await readFile(store.chatPath('group'), 'utf8')
  assert.equal(raw.includes('temporary-'), false)
  assert.deepEqual(JSON.parse(raw), { mode: 'at', wait: { quietMs: 1000, maxWaitMs: 3000 }, forgottenEvidence: ['old-id'] })
})

test('exit migrates old notes before clearing raw snapshots for previously watched chats', async t => {
  const store = await fixture(t)
  const path = store.chatPath('previous-group')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ mode: 'infer', transcript: [{ text: 'old raw message' }], log: [{}],
    memory: { members: { alice: { name: 'Alice', notes: [{ topic: '表达偏好', text: '先给结论，再解释', at: 1, evidence: 'old-message' }] } } } }))
  await store.clearHistory()
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { mode: 'infer' })
  assert.match((await store.memoryFor('previous-group').context(['alice'])).documents.alice, /先给结论，再解释/)
})

test('a failed legacy migration retains the only copy of the source snapshot', async t => {
  const store = await fixture(t)
  const path = store.chatPath('group')
  await mkdir(dirname(path), { recursive: true })
  const original = JSON.stringify({ transcript: [{ text: 'source evidence' }],
    memory: { members: { alice: { notes: [{ topic: '主题', text: 'x'.repeat(481) }] } } } })
  await writeFile(path, original)
  await assert.rejects(store.clearHistory())
  assert.equal(await readFile(path, 'utf8'), original)
})

test('an existing divergent Markdown file blocks destructive legacy cleanup', async t => {
  const store = await fixture(t)
  const memory = store.memoryFor('group')
  await memory.migrate({ members: { alice: { notes: [{ topic: '偏好', text: '新偏好' }] } } })
  const path = store.chatPath('group')
  await mkdir(dirname(path), { recursive: true })
  const original = JSON.stringify({ memory: { members: { alice: { notes: [{ topic: '偏好', text: '旧偏好' }] } } } })
  await writeFile(path, original)
  await assert.rejects(store.clearHistory(), /legacy_memory_conflict/)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal((await memory.context(['alice'])).notes.alice.偏好, '新偏好')
})
