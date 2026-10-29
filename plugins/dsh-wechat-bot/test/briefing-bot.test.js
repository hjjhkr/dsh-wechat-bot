import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../lib/bot.js'
import { Store } from '../lib/store.js'
import { FAST, linkedSimulator, sleep, until } from './helpers.js'

test('the selected group receives a due briefing once and the result survives restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-briefing-bot-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  const group = 'demo@chatroom'
  const now = Date.now()
  const date = new Date(Math.floor((now + 8 * 3600_000) / 86_400_000) * 86_400_000).toISOString().slice(0, 10)
  const store = new Store(dir, { delayMs: 5 })
  store.saveChatLater(group, { briefings: { date, hltv: { at: now - 1000, status: 'pending' }, apex: { at: now + 3600_000, status: 'pending' } } })
  await store.flush()
  let calls = 0
  const start = async () => {
    const pair = linkedSimulator({ loggedIn: true })
    const bot = new Bot({ dataDir: dir, store: new Store(dir, { delayMs: 5 }), persona: '', think: async () => '{"reply":[]}', settings: FAST,
      briefings: { hltv: async () => { calls++; return 'HLTV 测试新闻' }, apex: async () => '排位测试' }, createAdapter: () => pair.client })
    await bot.start()
    await until(() => bot.ready)
    if (!bot.chat) await bot.setChat(group)
    await until(() => bot.runner)
    return { bot, simulator: pair.simulator }
  }
  const first = await start()
  await until(() => first.simulator.messages.get(group).some(m => m.fromSelf && m.text === 'HLTV 测试新闻'))
  await until(() => first.bot.runner.snapshot().briefings.hltv.status === 'sent')
  await first.bot.dispose()
  const second = await start()
  await sleep(100)
  assert.equal(calls, 1)
  assert.equal((await second.bot.store.loadChat(group)).briefings.hltv.status, 'sent')
  assert.equal(second.simulator.messages.get(group).filter(m => m.fromSelf).length, 0)
  await second.bot.dispose()
})
