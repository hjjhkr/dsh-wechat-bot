// Real DSH workspace/storage integration, with synthetic sessions and no network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'

const ROUTE = { provider: 'test-provider', model: 'test-model', maxTokens: 100, reasoningEffort: 'off' }

async function workspaceHost(t, root) {
  const rootCtx = new Context()
  t.after(() => rootCtx.fiber.dispose())
  await rootCtx.plugin(SessionStore).await()
  await rootCtx.plugin(AgentRegistry).await()
  await rootCtx.plugin(SessionProjection).await()
  await rootCtx.plugin(SessionTitle, { fallbackMaxWords: 24, fallbackMaxBytes: 256, maxTitleBytes: 256 }).await()
  await rootCtx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' }).await()
  await rootCtx.plugin(Storage).await()
  await rootCtx.plugin(StorageJson, { root: join(root, 'storage') }).await()
  await rootCtx.plugin(StorageDomain, { backend: 'json' }).await()
  await rootCtx.plugin(WorkspaceRegistry).await()
  let ctx
  await rootCtx.plugin({
    name: 'wechat-workspace-test',
    inject: ['sessions', 'agents', 'sessionTitle', 'sessionPersistence', 'workspaceRegistry'],
    apply(value) { ctx = value },
  }).await()
  return { ctx, rootCtx }
}

test('a new host run keeps its live mirror grouped after an interrupted previous run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const before = await import('../lib/session.js?workspace-run=before')
  const first = await workspaceHost(t, root)
  const oldId = before.liveChatSessionId('wxid_bot', 'demo@chatroom')
  await before.ChatSession.openLive(first.ctx, { id: oldId, cwd: root, title: '微信 · 测试群', route: ROUTE })
  const durable = await before.ChatSession.open(first.ctx, { id: before.chatSessionId('wxid_bot', 'other@chatroom'),
    cwd: root, title: '其他已有会话', route: ROUTE })
  const durableId = durable.id
  await durable.dispose()
  const originalWorkspace = await first.ctx.workspaceRegistry.resolveByPath(root)
  assert.ok(originalWorkspace.sessionIds.includes(oldId))
  // Simulate host termination without the mirror's dispose/detach, retaining its durable workspace slot.
  await first.rootCtx.fiber.dispose()

  const after = await import('../lib/session.js?workspace-run=after')
  const second = await workspaceHost(t, root)
  const newId = after.liveChatSessionId('wxid_bot', 'demo@chatroom')
  const current = await after.ChatSession.openLive(second.ctx, { id: newId, cwd: root, title: '微信 · 测试群', route: ROUTE })
  const workspace = await second.ctx.workspaceRegistry.resolveByPath(root)
  assert.ok(workspace.sessionIds.includes(current.id), 'the new visible session belongs to its workspace')
  assert.notEqual(newId, oldId, 'a new runtime does not reuse the interrupted transient identity')
  assert.ok(workspace.sessionIds.includes(durableId), 'other persisted conversations retain their membership')
  assert.equal(await second.ctx.sessionPersistence.stat(newId), undefined, 'live mirrors still have no raw session log')
  await current.dispose()
  assert.ok(!workspace.sessionIds.includes(newId), 'disposing the current live mirror releases its own membership')
  assert.ok(workspace.sessionIds.includes(durableId))
})
