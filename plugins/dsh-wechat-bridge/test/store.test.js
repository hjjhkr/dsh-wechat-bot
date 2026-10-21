import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dedupeKey, hasUncertainSend, StateStore } from '../lib/store.js'

test('StateStore persists cursor, deduplicates the composite WeChat identity, and refuses a second owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await StateStore.open(root)
  const message = { bot: 'bot', target: 'target', shard: 'shard', local_id: 7, sort_seq: 100 }
  const key = dedupeKey(message)

  await store.transact((state) => {
    state.cursor = { sortSeq: 100 }
    state.inbox.push({ key, text: 'incoming', status: 'received' })
    state.outbox.push({ attemptId: 'attempt-1', incomingKey: key, status: 'attempted', text: 'reply' })
  })
  await assert.rejects(StateStore.open(root), (error) => error.code === 'state_already_open')
  await store.close()

  const reopened = await StateStore.open(root)
  assert.equal(reopened.snapshot().cursor.sortSeq, 100)
  assert.equal(reopened.snapshot().inbox.length, 1)
  assert.equal(hasUncertainSend(reopened.snapshot()), true)
  assert.equal(dedupeKey({ ...message, text: 'different payload' }), key)
  assert.notEqual(dedupeKey({ ...message, shard: 'other-shard' }), key)
  await reopened.close()
})

