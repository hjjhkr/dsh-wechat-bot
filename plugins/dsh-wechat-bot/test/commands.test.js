import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRegistry, parseCommand } from '../lib/commands.js'
import { sleep, startBot, until } from './helpers.js'

const GROUP = 'demo@chatroom'
const say = (env, from, text, extra = {}) => env.simulator.inject({ chatId: GROUP, from, text, ...extra })
const sent = env => env.simulator.messages.get(GROUP).filter(m => m.fromSelf).map(m => m.text)
const logOf = env => env.bot.chatLog()

async function watching(t, options = {}) {
  const env = await startBot(t, options)
  await until(() => env.bot.ready)
  await env.bot.setChat(GROUP)
  return env
}

test('command syntax: leading @-mentions, full-width slash and Chinese names are accepted', () => {
  assert.deepEqual(parseCommand('/mode free'), { name: 'mode', text: 'free', args: ['free'] })
  assert.deepEqual(parseCommand('@小鲸鱼 /mode   at-only'), { name: 'mode', text: 'at-only', args: ['at-only'] })
  assert.deepEqual(parseCommand('／帮助'), { name: '帮助', text: '', args: [] })
  assert.equal(parseCommand('/ASK 为什么\n天是蓝的').text, '为什么\n天是蓝的')
  for (const text of ['看这个 /mode', '/usr/bin/env', 'http://x.com', '/', '//']) assert.equal(parseCommand(text), null, text)
})

test('modes decide which batches reach the model: free / infer / at / silent', async t => {
  const env = await watching(t, { reply: () => ({ reply: [] }) })
  // One batch per mode: plain chatter, a name mention in passing, a name call, an @.
  const probe = async (mode, expected) => {
    say(env, 'wxid_carol', `/mode ${mode}`)
    await until(() => env.bot.runner.mode === (mode === 'at-only' ? 'at' : mode))
    const before = env.model.calls.length
    for (const [text, extra] of [['今天好热', {}], ['deepseek出新模型了', {}], ['小鲸鱼，你热吗', {}], ['在吗', { mentions: ['wxid_bot'] }]]) {
      say(env, 'wxid_alice', text, extra)
      await sleep(80)
    }
    await sleep(80)
    const seen = [...new Set(env.model.calls.slice(before).flatMap(c => c.input.new.map(m => m.text)))]
    assert.deepEqual(seen, expected, mode)
  }
  await probe('free', ['今天好热', 'deepseek出新模型了', '小鲸鱼，你热吗', '在吗'])
  await probe('infer', ['deepseek出新模型了', '小鲸鱼，你热吗', '在吗'])
  await probe('at-only', ['在吗'])
  await probe('silent', [])
  assert.match(sent(env).at(-1), /^已执行：切换为 silent/)
  assert.equal(env.bot.view().chat.mode, 'silent')
})

test('a command is answered at once, ahead of a reply that is still being typed out', async t => {
  const env = await watching(t, { settings: { typingDelay: true }, reply: () => ({ reply: ['第一句', '第二句', '第三句'] }) })
  say(env, 'wxid_alice', '小鲸鱼讲个故事')
  await until(() => sent(env).includes('第一句'))
  say(env, 'wxid_bob', '/status')
  await until(() => sent(env).includes('第三句'), { timeoutMs: 8000 })
  const order = sent(env)
  assert.ok(order.findIndex(s => s.startsWith('模式')) < order.indexOf('第三句'), `status jumped the queue: ${order}`)
})

test('a state-changing command interrupts the answer still being thought out', async t => {
  const aborted = []
  const env = await watching(t, {
    reply: async (input, call) => {
      if (input.new.some(m => m.text === '慢慢想')) {
        await new Promise((resolve, reject) => {
          setTimeout(resolve, 1000)
          call.signal.addEventListener('abort', () => { aborted.push(true); reject(call.signal.reason) }, { once: true })
        })
      }
      return { reply: ['想好了'] }
    },
  })
  say(env, 'wxid_alice', '慢慢想')
  await until(() => env.model.calls.length === 1)
  const t0 = Date.now()
  say(env, 'wxid_carol', '/mute 5')
  await until(() => sent(env).includes('已执行：安静 5 分钟'))
  assert.ok(Date.now() - t0 < 500, 'acknowledged without waiting for the model')
  await until(() => aborted.length === 1, { what: 'model call aborted' })
  await sleep(100)
  assert.ok(!sent(env).includes('想好了'), 'the stale answer never went out')
  assert.ok(logOf(env).some(e => e.type === 'interrupted'))
  assert.ok(logOf(env).some(e => e.type === 'skipped' && e.reason === 'muted'), 'the batch was reconsidered under the new state')
})

test('/forget interrupts an answer that would re-learn what was just forgotten', async t => {
  const env = await watching(t, {
    reply: async (input, call) => {
      if (input.new.some(m => m.text.includes('杭州'))) await sleep(300)
      call.signal.throwIfAborted()
      const m = input.new.find(m => m.text.includes('杭州'))
      return { reply: [], memory: m ? [{ who: m.from.id, topic: '城市', note: '住在杭州', evidence: m.id }] : [] }
    },
  })
  say(env, 'wxid_alice', '我住在杭州')
  await until(() => env.model.calls.length === 1)
  say(env, 'wxid_alice', '/forget all')
  await until(() => sent(env).some(s => s.includes('已执行') || s.includes('没有叫')))
  await until(() => env.model.calls.length >= 2, { what: 'batch reconsidered' })
  await until(() => env.bot.runner.status === 'idle')
  // The reconsidered batch may legitimately learn it again from the original message;
  // what must never happen is the stale, pre-forget decision landing after the forget.
  assert.ok(logOf(env).some(e => e.type === 'interrupted'))
})

test('/ask jumps ahead of a rate-limited queue and is acknowledged first', async t => {
  const env = await watching(t, {
    settings: { maxTurnsPerMinute: 1, rateWindowMs: 60_000 },
    reply: input => input.new.some(m => m.command) ? { reply: ['认真的回答'] } : { reply: [] },
  })
  say(env, 'wxid_alice', '随便聊聊')
  await until(() => env.model.calls.length === 1)
  say(env, 'wxid_bob', '还在聊')
  await until(() => logOf(env).some(e => e.type === 'deferred'), { what: 'rate limited' })
  say(env, 'wxid_carol', '/ask 地球为什么是圆的')
  await until(() => sent(env).includes('认真的回答'))
  assert.deepEqual(sent(env), ['收到，想一下', '认真的回答'])
  assert.equal(env.model.calls.at(-1).input.new[0].text, '地球为什么是圆的')
})

test('one member spamming commands is throttled; others are not', async t => {
  const env = await watching(t, { settings: { commandsPerMinute: 3 } })
  for (let i = 0; i < 10; i++) say(env, 'wxid_alice', '/status')
  say(env, 'wxid_bob', '/status')
  await until(() => sent(env).length === 4)
  await sleep(100)
  assert.equal(sent(env).length, 4)
  assert.ok(logOf(env).some(e => e.type === 'command_throttled'))
})

test('/mute silences the bot, but /ask still gets a deliberate answer', async t => {
  const env = await watching(t, { reply: input => ({ reply: [input.new.some(m => m.command) ? '认真回答' : '闲聊'] }) })
  say(env, 'wxid_carol', '/mute 5')
  await until(() => sent(env).includes('已执行：安静 5 分钟'))
  say(env, 'wxid_alice', '小鲸鱼 在吗')
  await until(() => logOf(env).some(e => e.reason === 'muted'))
  say(env, 'wxid_alice', '/ask 为什么天是蓝的')
  await until(() => sent(env).includes('认真回答'))
  const call = env.model.calls.at(-1)
  assert.equal(call.input.new.at(-1).text, '为什么天是蓝的')
  assert.equal(call.input.new.at(-1).addressed, 'you')
  assert.match(call.input.new.at(-1).command.instruction, /认真提问/)
  assert.equal(env.model.calls.length, 1)
  say(env, 'wxid_carol', '/unmute')
  await until(() => sent(env).includes('已执行：解除禁言'))
  assert.equal(env.bot.runner.muted, false)
})

test('/memory shows only your own notes and /forget removes them', async t => {
  const env = await watching(t, {
    reply: input => ({ reply: [], memory: input.new.map(m => ({ who: m.from.id, topic: '城市', note: `住在${m.text.slice(3)}`, evidence: m.id })) }),
  })
  say(env, 'wxid_alice', '我住在杭州')
  await until(() => logOf(env).some(e => e.type === 'memory'))
  say(env, 'wxid_bob', '我住在成都')
  await until(() => logOf(env).filter(e => e.type === 'memory').length === 2)
  say(env, 'wxid_alice', '/memory')
  await until(() => sent(env).length === 1)
  assert.equal(sent(env)[0], '关于你我记得：\n· 城市：住在杭州')
  say(env, 'wxid_alice', '/forget 城市')
  await until(() => sent(env).length === 2)
  assert.deepEqual(env.bot.runner.memory.recall(['wxid_alice', 'wxid_bob']), { wxid_bob: { 城市: '住在成都' } })
})

test('/tldr forwards to the model with a summary instruction and higher priority than mode', async t => {
  const env = await watching(t, { reply: () => ({ reply: ['在聊火锅'] }) })
  say(env, 'wxid_carol', '/mode silent')
  await until(() => sent(env).length === 1)
  say(env, 'wxid_alice', '/tldr')
  await until(() => sent(env).includes('在聊火锅'))
  assert.equal(env.model.calls[0].input.new[0].command.name, 'tldr')
})

test('/help lists the commands; unknown commands are ordinary chat', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '/help')
  await until(() => sent(env).length === 1)
  assert.match(sent(env)[0], /\/ask/)
  assert.match(sent(env)[0], /\/mode/)
  say(env, 'wxid_alice', '/摸鱼')
  await until(() => env.model.calls.length === 1)
  assert.equal(env.model.calls[0].input.new[0].text, '/摸鱼')
})

test('custom command scripts are loaded from a directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bot-commands-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  await writeFile(join(dir, 'roll.js'), `export default {
    name: 'roll', aliases: ['骰子'], summary: '掷骰子',
    run: ({ args }) => 'roll:' + (args[0] ?? 6),
  }`)
  const commands = new CommandRegistry()
  assert.deepEqual(await commands.load(dir), ['roll'])
  const env = await startBot(t)
  env.bot.commands = commands
  await until(() => env.bot.ready)
  await env.bot.setChat(GROUP)
  say(env, 'wxid_alice', '/骰子 20')
  await until(() => sent(env).length === 1)
  assert.equal(sent(env)[0], 'roll:20')
  await sleep(50)
  assert.equal(env.model.calls.length, 0)
})
