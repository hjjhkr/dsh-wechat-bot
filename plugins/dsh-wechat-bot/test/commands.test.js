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
const logOf = env => env.bot.chatLog(GROUP)

async function watching(t, options = {}) {
  const env = await startBot(t, options)
  await until(() => env.bot.ready)
  await env.bot.setWatched([GROUP])
  return env
}

test('command syntax: leading @-mentions, full-width slash and Chinese names are accepted', () => {
  assert.deepEqual(parseCommand('/mode free'), { name: 'mode', text: 'free', args: ['free'] })
  assert.deepEqual(parseCommand('@小鲸鱼 /mode   at-only'), { name: 'mode', text: 'at-only', args: ['at-only'] })
  assert.deepEqual(parseCommand('／帮助'), { name: '帮助', text: '', args: [] })
  assert.equal(parseCommand('/ASK 为什么\n天是蓝的').text, '为什么\n天是蓝的')
  for (const text of ['看这个 /mode', '/usr/bin/env', 'http://x.com', '/', '//']) assert.equal(parseCommand(text), null, text)
})

test('/mode mention: only addressed batches reach the model; /mode free restores', async t => {
  const env = await watching(t, { reply: () => ({ reply: ['嗯'] }) })
  say(env, 'wxid_carol', '/mode mention')
  await until(() => sent(env).some(s => s.includes('已切换为 mention')))
  say(env, 'wxid_alice', '今天好热')
  await until(() => logOf(env).some(e => e.type === 'skipped' && e.reason === 'mention_only'))
  assert.equal(env.model.calls.length, 0)
  say(env, 'wxid_alice', '@小鲸鱼 你热吗', { mentions: ['wxid_bot'] })
  await until(() => env.model.calls.length === 1)
  assert.ok(env.model.calls[0].input.recent.some(m => m.text === '今天好热'), 'skipped messages stay as context')
  assert.equal(env.bot.view().watched[0].mode, 'mention')
})

test('/mute silences the bot, but /ask still gets a deliberate answer', async t => {
  const env = await watching(t, { reply: input => ({ reply: [input.new.some(m => m.command) ? '认真回答' : '闲聊'] }) })
  say(env, 'wxid_carol', '/mute 5')
  await until(() => sent(env).includes('好，安静 5 分钟'))
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
  await until(() => sent(env).includes('我回来了'))
  assert.equal(env.bot.runners.get(GROUP).muted, false)
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
  assert.deepEqual(env.bot.runners.get(GROUP).memory.recall(['wxid_alice', 'wxid_bob']), { wxid_bob: { 城市: '住在成都' } })
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
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'roll.js'), `export default {
    name: 'roll', aliases: ['骰子'], summary: '掷骰子',
    run: ({ args }) => 'roll:' + (args[0] ?? 6),
  }`)
  const commands = new CommandRegistry()
  assert.deepEqual(await commands.load(dir), ['roll'])
  const env = await startBot(t)
  env.bot.commands = commands
  await until(() => env.bot.ready)
  await env.bot.setWatched([GROUP])
  say(env, 'wxid_alice', '/骰子 20')
  await until(() => sent(env).length === 1)
  assert.equal(sent(env)[0], 'roll:20')
  await sleep(50)
  assert.equal(env.model.calls.length, 0)
})
