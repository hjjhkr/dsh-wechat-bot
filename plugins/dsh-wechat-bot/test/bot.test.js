import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep, startBot, until } from './helpers.js'

const GROUP = 'demo@chatroom'
const DIRECT = 'wxid_wuti'
const say = (env, from, text, extra = {}) => env.simulator.inject({ chatId: GROUP, from, text, ...extra })
const sent = env => env.simulator.messages.get(GROUP).filter(m => m.fromSelf).map(m => m.text)
const logTypes = (env, chat = GROUP) => env.bot.chatLog(chat).map(e => e.type)

async function watching(t, options) {
  const env = await startBot(t, options)
  await until(() => env.bot.ready, { what: 'account ready' })
  await env.bot.setWatched([GROUP])
  return env
}

test('a burst of messages reaches the model as one merged JSON batch', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['收到'], memory: [] }) })
  say(env, 'wxid_alice', '今天')
  say(env, 'wxid_alice', '去吃火锅')
  say(env, 'wxid_bob', '我也去')
  await until(() => sent(env).length === 1, { what: 'reply' })
  assert.equal(env.model.calls.length, 1, 'one model call for the whole burst')
  const input = env.model.calls[0].input
  assert.deepEqual(input.new.map(m => m.text), ['今天', '去吃火锅', '我也去'])
  assert.deepEqual(input.new.map(m => m.from.name), ['阿离', '阿离', '老鲍'])
  assert.deepEqual(input.you, { id: 'wxid_bot', name: '小鲸鱼', aliases: ['小鲸鱼', 'DeepSeek'] })
  assert.equal(input.chat.kind, 'group')
})

test('addressing facts are attached to every message the model sees', async t => {
  const env = await watching(t)
  const first = say(env, 'wxid_bob', '我摔了')
  await until(() => env.model.calls.length === 1, { what: 'first call' })
  say(env, 'wxid_alice', '@老鲍 你没事吧', { mentions: ['wxid_bob'] })
  say(env, 'wxid_alice', '哈哈哈', { quote: { messageId: first.id } })
  say(env, 'wxid_owner', '小鲸鱼，你怎么看')
  say(env, 'wxid_bob', '今天好热')
  await until(() => env.model.calls.length >= 2, { what: 'second call' })
  const input = env.model.calls[1].input
  assert.deepEqual(input.new.map(m => m.addressed), ['other', 'other', 'you', 'none'])
  assert.deepEqual(input.new[1].quote, { from: '老鲍', text: '我摔了' })
  assert.deepEqual(input.recent.map(m => m.text), ['我摔了'], 'already-processed messages move to recent')
})

test('silence is corrected once when someone addressed the bot directly', async t => {
  const env = await watching(t, { reply: (_input, _call, n) => n === 1 ? { reply: [] } : { to: null, reply: ['？'] } })
  say(env, 'wxid_alice', '在吗', { mentions: ['wxid_bot'] })
  await until(() => sent(env).length === 1, { what: 'corrected reply' })
  assert.equal(env.model.calls.length, 2)
  const retry = env.model.calls[1].messages
  assert.equal(retry.length, 3)
  assert.match(retry[2].text, /addressed=you/)
  assert.deepEqual(sent(env), ['？'])
})

test('nobody addressed: silence is accepted without a retry', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '@老鲍 走了', { mentions: ['wxid_bob'] })
  await until(() => logTypes(env).includes('silent'), { what: 'silent decision' })
  assert.equal(env.model.calls.length, 1)
  assert.deepEqual(sent(env), [])
})

test('invalid output gets one corrective retry, a second failure is logged and skipped', async t => {
  const outputs = ['我想想', '{"reply":["行"]}', '还是不对', '依旧不对', '{"reply":[]}']
  const env = await watching(t, { reply: (_i, _c, n) => outputs[n - 1] })
  say(env, 'wxid_alice', '1')
  await until(() => sent(env).length === 1, { what: 'reply after correction' })
  say(env, 'wxid_alice', '2')
  await until(() => logTypes(env).includes('error'), { what: 'error entry' })
  assert.equal(env.model.calls.length, 4)
  assert.deepEqual(logTypes(env).filter(t => t === 'invalid_output').length, 3)
  say(env, 'wxid_alice', '3')
  await until(() => logTypes(env).includes('silent'), { what: 'bot keeps working after a failed batch' })
  assert.equal(env.model.calls.length, 5)
})

test('messages arriving while the model thinks supersede the stale answer', async t => {
  const gate = Promise.withResolvers()
  const env = await watching(t, {
    reply: async (input, _call, n) => {
      if (n === 1) await gate.promise
      return { to: null, reply: [`看到${input.new.length}条`] }
    },
  })
  say(env, 'wxid_alice', '有人玩游戏吗')
  await until(() => env.model.calls.length === 1, { what: 'thinking' })
  say(env, 'wxid_bob', '我')
  say(env, 'wxid_owner', '我也')
  await sleep(80)
  gate.resolve()
  await until(() => sent(env).length === 1, { what: 'reply' })
  assert.deepEqual(sent(env), ['看到3条'], 'the stale one-message answer was never sent')
  assert.ok(logTypes(env).includes('superseded'))
})

test('supersede is bounded so a busy group still gets an answer', async t => {
  const env = await watching(t, {
    reply: async () => {
      await sleep(60)
      return { to: null, reply: ['好'] }
    },
  })
  const chatter = setInterval(() => say(env, 'wxid_bob', '刷屏'), 20)
  t.after(() => clearInterval(chatter))
  await until(() => sent(env).length >= 1, { what: 'a reply despite constant chatter' })
  clearInterval(chatter)
})

test('multi-part replies are sent in order as separate messages', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['草', '不对', '其实挺好'] }) })
  say(env, 'wxid_alice', '我把车停水沟里了')
  await until(() => sent(env).length === 3, { what: 'three messages' })
  assert.deepEqual(sent(env), ['草', '不对', '其实挺好'])
  await until(() => env.model.calls.length === 1)
  say(env, 'wxid_alice', '？')
  await until(() => env.model.calls.length === 2, { what: 'second call' })
  const recent = env.model.calls[1].input.recent
  assert.deepEqual(recent.filter(m => m.from_you).map(m => m.text), ['草', '不对', '其实挺好'], 'own replies are context once, not duplicated by echoes')
})

test('while sending is impossible (locked screen) replies wait, then go out on unlock', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['来了'] }) })
  await env.simulator.handlers()['sim/status']({ canSend: false, reason: 'screen_locked' })
  await until(() => !env.bot.connection.canSend, { what: 'locked status' })
  say(env, 'wxid_alice', '小鲸鱼，在吗')
  await sleep(150)
  assert.deepEqual(sent(env), [])
  assert.equal(env.bot.runners.get(GROUP).status, 'waiting')
  say(env, 'wxid_bob', '它锁屏了吧')
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await until(() => sent(env).length === 1, { what: 'reply after unlock' })
  assert.deepEqual(env.model.calls[0].input.new.map(m => m.text), ['小鲸鱼，在吗'], 'thinking waited for the unlock')
  await until(() => env.model.calls.length === 2, { what: 'message received while locked is still processed' })
})

test('a reply that became stale while locked is dropped instead of sent late', async t => {
  const env = await watching(t, {
    settings: { staleMs: 50 },
    reply: () => ({ to: null, reply: ['一', '二'] }),
  })
  // Lock the screen right after the first part goes out.
  env.bot.on('chat-log', (_chat, entry) => {
    if (entry.type === 'sent') env.simulator.handlers()['sim/status']({ canSend: false })
  })
  say(env, 'wxid_alice', '说两句')
  await until(() => logTypes(env).includes('waiting'), { what: 'waiting for unlock' })
  await sleep(100)
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await until(() => logTypes(env).includes('dropped'), { what: 'stale drop' })
  assert.deepEqual(sent(env), ['一'])
})

test('failed sends are retried, uncertain sends never are', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['嗯'] }) })
  env.simulator.failNext.push('send_failed')
  say(env, 'wxid_alice', '1')
  await until(() => sent(env).length === 1, { what: 'retried send' })

  env.simulator.failNext.push('send_uncertain')
  say(env, 'wxid_alice', '2')
  await until(() => logTypes(env).includes('send_error'), { what: 'uncertain send logged' })
  await sleep(100)
  assert.deepEqual(sent(env), ['嗯'])
  assert.equal(env.bot.chatLog(GROUP).find(e => e.type === 'send_error').uncertain, true)
})

test('the account owner typing from the bot account is context, not a trigger', async t => {
  const env = await watching(t)
  say(env, 'wxid_bot', '我是本人，在手机上发的')
  await sleep(120)
  assert.equal(env.model.calls.length, 0)
  say(env, 'wxid_alice', '？')
  await until(() => env.model.calls.length === 1)
  assert.deepEqual(env.model.calls[0].input.recent, [{ from_you: true, time: env.model.calls[0].input.recent[0].time, text: '我是本人，在手机上发的' }])
})

test('memory is learned from conversation and survives a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bot-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = await watching(t, {
    dir,
    reply: input => ({ to: null, reply: [], memory: [{ who: input.new[0].from.id, topic: '宠物', note: '养了一只叫豆豆的猫', evidence: input.new[0].id }] }),
  })
  say(first, 'wxid_alice', '我家豆豆今天又把杯子推下去了，这猫')
  await until(() => logTypes(first).includes('memory'), { what: 'memory write' })
  await first.bot.dispose()

  const second = await startBot(t, { dir })
  await until(() => second.bot.runners.has(GROUP), { what: 'watch restored from disk' })
  second.simulator.inject({ chatId: GROUP, from: 'wxid_alice', text: '早' })
  await until(() => second.model.calls.length === 1)
  const input = second.model.calls[0].input
  assert.deepEqual(input.memory, { wxid_alice: { 宠物: '养了一只叫豆豆的猫' } })
  assert.ok(input.recent.some(m => m.text.includes('豆豆')), 'transcript restored too')
})

test('chats are processed in parallel, each strictly in order', async t => {
  const gate = Promise.withResolvers()
  const env = await startBot(t, {
    reply: async input => {
      if (input.chat.kind === 'group') await gate.promise
      return { to: null, reply: [`回${input.chat.name}`] }
    },
  })
  await until(() => env.bot.ready)
  await env.bot.setWatched([GROUP, DIRECT])
  say(env, 'wxid_alice', '群里')
  env.simulator.inject({ chatId: DIRECT, text: '私聊' })
  await until(() => env.simulator.messages.get(DIRECT).some(m => m.fromSelf), { what: 'direct reply while group is busy' })
  assert.deepEqual(sent(env), [])
  assert.equal(env.model.calls.find(c => c.input.chat.kind === 'direct').input.new[0].addressed, 'you')
  gate.resolve()
  await until(() => sent(env).length === 1)
})

test('unwatching a chat stops processing it', async t => {
  const env = await watching(t)
  await env.bot.setWatched([])
  say(env, 'wxid_alice', '小鲸鱼？')
  await sleep(120)
  assert.equal(env.model.calls.length, 0)
})

test('a quiet group gets an idle check the model may use to speak first', async t => {
  const env = await watching(t, {
    settings: { idleMinutes: 0.002 },
    reply: input => input.event ? { reply: ['好安静'] } : { reply: [] },
  })
  await until(() => sent(env).length >= 1, { what: 'idle message' })
  const call = env.model.calls.find(c => c.input.event)
  assert.equal(call.input.event.kind, 'idle')
  assert.deepEqual(call.input.new, [])
})

test('the adapter is restarted after it crashes and watching resumes', async t => {
  const env = await watching(t)
  const crashed = env.simulator
  crashed.close()
  await until(() => env.simulator !== crashed && env.bot.ready, { timeoutMs: 5000, what: 'reconnect' })
  await until(() => env.bot.runners.has(GROUP))
  say(env, 'wxid_alice', '还在吗')
  await until(() => env.model.calls.length === 1, { what: 'processing after reconnect' })
})
