import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnAdapter } from '../lib/adapter.js'
import { Bot } from '../lib/bot.js'
import { parseAccount } from '../lib/protocol.js'
import { Store } from '../lib/store.js'
import { until } from './helpers.js'

const simulatorBin = fileURLToPath(new URL('../bin/simulator.js', import.meta.url))

function spawnSimulator(t, args = []) {
  const client = spawnAdapter({ command: process.execPath, args: [simulatorBin, ...args] })
  t.after(() => client.shutdown())
  return client
}

test('stdio adapter: handshake, login, chats, watch, events and idempotent send', async t => {
  const client = spawnSimulator(t)
  const events = { message: [], status: [], account: [] }
  for (const name of Object.keys(events)) client.on(name, value => events[name].push(value))

  const info = await client.initialize({ dataDir: '.', client: { name: 'test', version: '0' } })
  assert.equal(info.name, 'simulator')
  assert.equal(client.capabilities.simulator, true)

  assert.equal((await client.accountStatus()).state, 'login_required')
  await assert.rejects(client.listChats(), { code: 'not_ready' })
  const login = await client.login()
  assert.match(login.instructions, /登录/)
  await until(() => events.account.some(a => a.state === 'ready'), { what: 'login' })
  assert.equal((await client.accountStatus()).self.id, 'wxid_bot')

  const chats = await client.listChats()
  assert.deepEqual(chats.map(c => c.kind).sort(), ['direct', 'group'])
  const group = chats.find(c => c.kind === 'group')
  assert.ok((await client.members(group.id)).some(m => m.id === 'wxid_alice'))

  await client.watch([group.id])
  await client.simulate({ chatId: group.id, from: 'wxid_alice', text: '@小鲸鱼 在吗', mentions: ['wxid_bot'] })
  await until(() => events.message.length === 1, { what: 'message event' })
  assert.deepEqual(events.message[0].mentions, ['wxid_bot'])
  assert.equal(events.message[0].sender.name, '阿离')

  const first = await client.send(group.id, 'turn-1:0', { kind: 'text', text: '在' })
  const again = await client.send(group.id, 'turn-1:0', { kind: 'text', text: '在' })
  assert.equal(first.messageId, again.messageId, 'clientId makes send idempotent')
  await until(() => events.message.some(m => m.fromSelf), { what: 'echo of own message' })

  await assert.rejects(client.send('nope', 'x', { kind: 'text', text: 'a' }), { code: 'not_found' })
  await assert.rejects(client.send(group.id, 'x', { kind: 'text', text: '' }), { code: 'invalid_params' })
})

test('stdio adapter: delivery-state error codes reach the caller unchanged', async t => {
  const client = spawnSimulator(t, ['--logged-in'])
  await client.initialize({ dataDir: '.', client: { name: 'test', version: '0' } })
  const [chat] = await client.listChats()
  await client.peer.request('sim/fail', { code: 'send_uncertain' })
  await assert.rejects(client.send(chat.id, 'a', { kind: 'text', text: 'x' }), { code: 'send_uncertain' })
  await client.peer.request('sim/status', { canSend: false, reason: 'screen_locked' })
  await assert.rejects(client.send(chat.id, 'b', { kind: 'text', text: 'x' }), { code: 'unavailable' })
})

test('a crashed adapter rejects in-flight requests instead of hanging', async t => {
  const client = spawnAdapter({ command: process.execPath, args: ['-e', 'process.stdin.once("data", () => process.exit(3))'] })
  t.after(() => client.shutdown())
  await assert.rejects(client.initialize({ dataDir: '.' }), { code: 'closed' })
  assert.equal(await client.exited, 3)
})

test('an adapter that fails the handshake is ended, not leaked, before the next attempt', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wechat-bot-leak-'))
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }))
  // Answers every request as protocol v2, which the plugin refuses.
  const script = `require('readline').createInterface({ input: process.stdin }).on('line', line => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(line).id, result: { protocolVersion: 2 } }) + '\n')
  })`
  const spawned = []
  const bot = new Bot({
    dataDir, store: new Store(dataDir), persona: '', think: async () => '',
    createAdapter: () => {
      const client = spawnAdapter({ command: process.execPath, args: ['-e', script] })
      spawned.push(client)
      return client
    },
  })
  await bot.start()
  assert.ok(bot.log.some(e => e.message.includes('protocol')), 'the mismatch is reported')
  await until(() => spawned.length >= 2, { timeoutMs: 8000, what: 'a retry' })
  assert.notEqual(await spawned[0].exited, undefined, 'the first process exited before the retry')
  await bot.dispose()
  await Promise.all(spawned.map(client => client.exited))
})

test('an account reported ready must say which account it is', () => {
  assert.throws(() => parseAccount({ state: 'ready' }), { code: 'invalid_params' })
  assert.deepEqual(parseAccount({ state: 'ready', self: { id: 'wxid_bot' } }).self, { id: 'wxid_bot', name: 'wxid_bot' })
})
