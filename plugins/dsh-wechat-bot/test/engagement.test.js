import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngagementError, resolveMember } from '../lib/engagement.js'
import { flattenInput, turnInput } from '../lib/prompt.js'
import { sleep, startBot, until } from './helpers.js'

const GROUP = 'demo@chatroom'
const MEMBERS = [{ id: 'wxid_alice', name: '阿离' }, { id: 'wxid_bob', name: '老鲍' }, { id: 'wxid_bob2', name: '老鲍二号' }, { id: 'wxid_bot', name: '小鲸鱼' }]

test('targets are resolved by script: @ first, then exact, then unique partial nickname', () => {
  const resolve = (ref, mentions = []) => resolveMember(ref, { mentions, members: MEMBERS, selfId: 'wxid_bot' })
  assert.equal(resolve('随便写', ['wxid_bob2']).id, 'wxid_bob2', 'an @ in the command wins over the text')
  assert.equal(resolve('@阿离 ').id, 'wxid_alice')
  assert.equal(resolve('老鲍').id, 'wxid_bob', 'exact beats partial')
  assert.equal(resolve('二号').id, 'wxid_bob2')
  assert.equal(resolve('wxid_alice').id, 'wxid_alice')
  for (const [ref, mentions, problem] of [
    ['', [], /要对谁/], ['小鲸鱼', [], /不能对我自己/], ['wxid_bot', [], /不能对我自己/],
    ['鲍', [], /可能是：老鲍、老鲍二号/], ['张三', [], /没找到「张三」/], ['x', ['wxid_alice', 'wxid_bob'], /一次只能/],
  ]) {
    assert.throws(() => resolve(ref, mentions), e => e instanceof EngagementError && problem.test(e.message), ref)
  }
})

test('the model input groups messages by speaker and keeps each member\'s memory with them', () => {
  const at = Date.UTC(2026, 9, 21, 2, 0)
  const msg = (id, sender, text) => ({ id, chatId: GROUP, time: at, kind: 'text', text, sender, mentions: [], fromSelf: sender.id === 'wxid_bot' })
  const [alice, bob, bot] = [MEMBERS[0], MEMBERS[1], MEMBERS[3]]
  const recent = [msg('r1', alice, '早'), msg('r2', bot, '早啊'), msg('r3', bob, '我先走了')]
  const batch = [msg('a1', alice, '一'), msg('b1', bob, '甲'), msg('a2', alice, '二'), msg('a3', alice, '三')]
  const address = new Map(batch.map(m => [m.id, { addressed: 'none', reasons: [] }]))
  const input = JSON.parse(turnInput({
    chat: { name: '群', kind: 'group' }, self: bot, aliases: [], recent, batch, address,
    memory: { wxid_alice: { 宠物: '养猫' }, wxid_bob: { 城市: '成都' } },
  }))
  assert.deepEqual(input.new.members.map(g => [g.name, g.messages.map(m => m.text)]), [['阿离', ['一', '二', '三']], ['老鲍', ['甲']]])
  assert.deepEqual(input.new.order, ['a1', 'b1', 'a2', 'a3'], 'the conversation order is kept separately')
  assert.deepEqual(input.new.members[0].memory, { 宠物: '养猫' })
  assert.deepEqual(input.recent.yours.map(m => m.text), ['早啊'])
  assert.deepEqual(input.recent.order, ['r1', 'r2', 'r3'])
  assert.equal(input.memory, undefined, 'no global memory blob that could be applied to the wrong person')
  assert.deepEqual(flattenInput(input).messages.map(m => `${m.from.name}:${m.text}`), ['阿离:一', '老鲍:甲', '阿离:二', '阿离:三'])
})

// ── the whole flow ────────────────────────────────────────────────────────

const say = (env, from, text, extra = {}) => env.simulator.inject({ chatId: GROUP, from, text, ...extra })
const sent = env => env.simulator.messages.get(GROUP).filter(m => m.fromSelf).map(m => m.text)
const logTypes = env => env.bot.chatLog().map(e => e.type)

// Replies show which situation the model was put in.
const engageModel = input => {
  if (input.event?.kind === 'engagement') return { to: input.new.at(-1).id, reply: [`${input.event.style}→${input.event.target.name}:${input.new.map(m => m.text).join('+')}`] }
  const command = input.new.find(m => m.command)
  if (command) return { reply: [`开场:${command.text}`] }
  return { reply: input.new.some(m => m.addressed === 'you') ? ['普通回复'] : [] }
}

async function watching(t, options = {}) {
  const env = await startBot(t, { reply: engageModel, ...options })
  await until(() => env.bot.ready)
  await env.bot.setChat(GROUP)
  return env
}

test('/attack: acknowledge, open, then answer only the target — once per batch, never on its own', async t => {
  const env = await watching(t)
  say(env, 'wxid_carol', '/attack 阿离')
  await until(() => sent(env).length === 2, { what: 'ack and opening' })
  assert.match(sent(env)[0], /^已执行：开始嘲讽 阿离。TA 说一句我回一句，\/unattack 停止$/)
  assert.equal(sent(env)[1], '开场:嘲讽 阿离')
  assert.match(env.model.calls[0].input.new[0].command.instruction, /嘲讽 阿离/)
  assert.deepEqual(env.bot.runner.health().engagement, { style: 'attack', target: { id: 'wxid_alice', name: '阿离' } })

  say(env, 'wxid_bob', '@小鲸鱼 你也损损我', { mentions: ['wxid_bot'] })
  await until(() => logTypes(env).includes('skipped'))
  assert.equal(env.model.calls.length, 1, 'other members are ignored, even when they @ the bot')

  say(env, 'wxid_alice', '你才菜')
  say(env, 'wxid_alice', '服不服')
  await until(() => sent(env).length === 3)
  assert.equal(sent(env)[2], 'attack→阿离:你才菜+服不服', 'one reply to the whole burst, only the target\'s messages')
  assert.equal(env.model.calls.at(-1).input.event.kind, 'engagement')

  await sleep(300)
  assert.equal(sent(env).length, 3, 'the target is silent, so the bot is too')
  say(env, 'wxid_alice', '哼')
  await until(() => sent(env).length === 4)
})

test('/comfort replaces an attack; /uncomfort stops it and normal chat resumes', async t => {
  const env = await watching(t)
  say(env, 'wxid_carol', '/attack 阿离')
  await until(() => sent(env).length === 2)
  say(env, 'wxid_carol', '/comfort 老鲍')
  await until(() => sent(env).some(s => s.includes('开始安慰 老鲍（原来的嘲讽 阿离 已结束）')))
  say(env, 'wxid_carol', '/unattack')
  await until(() => sent(env).some(s => s.startsWith('现在是在安慰 老鲍，用 /uncomfort 停止')))
  say(env, 'wxid_bob', '今天好难过')
  await until(() => sent(env).some(s => s.startsWith('comfort→老鲍:今天好难过')))
  say(env, 'wxid_carol', '/uncomfort')
  await until(() => sent(env).includes('已执行：停止安慰 老鲍'))
  say(env, 'wxid_alice', '@小鲸鱼 在吗', { mentions: ['wxid_bot'] })
  await until(() => sent(env).includes('普通回复'))
})

test('an @ in the command picks the target; unknown names are refused', async t => {
  const env = await watching(t)
  say(env, 'wxid_carol', '/comfort @老鲍 ', { mentions: ['wxid_bob'] })
  await until(() => sent(env).some(s => s.startsWith('已执行：开始安慰 老鲍')))
  say(env, 'wxid_carol', '/attack 张三')
  await until(() => sent(env).some(s => s.startsWith('没开始：群里没找到「张三」')))
  assert.equal(env.bot.runner.engagement.target.id, 'wxid_bob', 'a failed /attack leaves the current engagement alone')
})

test('mute pauses an engagement; a silent target lets it expire', async t => {
  const env = await watching(t, { settings: { engagementIdleMs: 400 } })
  say(env, 'wxid_carol', '/attack 阿离')
  await until(() => sent(env).length === 2)
  say(env, 'wxid_carol', '/mute 5')
  await until(() => sent(env).some(s => s.startsWith('已执行：安静')))
  say(env, 'wxid_alice', '你不是挺能说吗')
  await until(() => env.bot.chatLog().some(e => e.type === 'skipped' && e.reason === 'muted'))
  assert.ok(!sent(env).some(s => s.startsWith('attack→')))
  say(env, 'wxid_carol', '/unmute')
  await sleep(500) // the target stays silent longer than engagementIdleMs
  say(env, 'wxid_alice', '@小鲸鱼 还在吗', { mentions: ['wxid_bot'] })
  await until(() => sent(env).includes('普通回复'), { what: 'normal handling after expiry' })
  assert.ok(env.bot.chatLog().some(e => e.type === 'engagement_end' && e.reason === 'idle'))
  assert.equal(env.bot.runner.health().engagement, null)
})

test('an engagement survives a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bot-engage-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  const first = await watching(t, { dir })
  say(first, 'wxid_carol', '/comfort 阿离')
  await until(() => sent(first).length === 2)
  await first.bot.dispose()
  const second = await startBot(t, { dir, reply: engageModel })
  await until(() => second.bot.runner)
  say(second, 'wxid_alice', '还是很难过')
  await until(() => sent(second).some(s => s === 'comfort→阿离:还是很难过'))
})

test('an engaged turn must answer the target, and the script records whom it answered', async t => {
  const env = await watching(t, {
    reply: (input, call) => {
      if (input.event?.kind !== 'engagement') return engageModel(input)
      // First attempt stays silent and names no message; the correction gets a reply, still without `to`.
      return call.messages.length === 1 ? { to: null, reply: [] } : { to: null, reply: ['好吧好吧'] }
    },
  })
  say(env, 'wxid_carol', '/comfort 阿离')
  await until(() => sent(env).length === 2)
  say(env, 'wxid_alice', '唉')
  await until(() => sent(env).includes('好吧好吧'))
  assert.match(env.model.calls.at(-1).messages.at(-1).text, /你正在按命令回应 阿离/)
  assert.equal(env.bot.runner.lastBotTurn.toSenderId, 'wxid_alice')
})

test('an engagement overrides the speaking mode: in at mode the target is still answered without an @', async t => {
  const env = await watching(t, { settings: { mode: 'at' } })
  say(env, 'wxid_carol', '/attack 阿离')
  await until(() => sent(env).length === 2)
  say(env, 'wxid_alice', '你谁啊')
  await until(() => sent(env).includes('attack→阿离:你谁啊'))
})

test('other commands keep working during an engagement, from anyone', async t => {
  const env = await watching(t, {
    reply: input => input.new.some(m => m.command?.name === 'ask') ? { reply: [`答:${input.new.find(m => m.command).text}`] } : engageModel(input),
  })
  say(env, 'wxid_carol', '/attack 阿离')
  await until(() => sent(env).length === 2)
  say(env, 'wxid_bob', '/status')
  await until(() => sent(env).some(s => s.includes('正在嘲讽 阿离')), { what: '/status shows the engagement' })
  say(env, 'wxid_bob', '/ask 一加一')
  await until(() => sent(env).includes('答:一加一'), { what: 'an explicit /ask from someone else is still answered' })
  say(env, 'wxid_bob', '/mode at')
  await until(() => sent(env).some(s => s.startsWith('已执行：切换为 at')))
  say(env, 'wxid_bob', '/help')
  await until(() => sent(env).some(s => s.includes('/attack')))
  say(env, 'wxid_bob', '我随便说说')
  say(env, 'wxid_alice', '还来？')
  await until(() => sent(env).includes('attack→阿离:还来？'), { what: 'the engagement survives the other commands' })
  assert.ok(!sent(env).some(s => s.includes('我随便说说')))
})

test('an opening that is still being thought about is dropped when the engagement is stopped or replaced', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const env = await watching(t, {
    reply: async input => {
      if (input.new.some(m => m.command?.name === 'attack')) await gate // the /attack opening is slow
      return engageModel(input)
    },
  })
  say(env, 'wxid_carol', '/attack 阿离')
  await until(() => env.bot.runner.status === 'thinking')
  say(env, 'wxid_carol', '/unattack')
  await until(() => sent(env).includes('已执行：停止嘲讽 阿离'))
  release()
  say(env, 'wxid_carol', '/comfort 老鲍')
  await until(() => sent(env).includes('开场:安慰 老鲍'))
  await sleep(200)
  assert.ok(!sent(env).includes('开场:嘲讽 阿离'), 'no opening for an engagement that already ended')
})

test('a member is keyed by wxid and found by any of their current names', () => {
  const members = [
    { id: 'wxid_alice', name: '离离原上草', aliases: ['阿离', 'alice_2024'] }, // group nickname, nickname, WeChat ID
    { id: 'wxid_bob', name: '鲍哥', aliases: ['老鲍', 'baobao'] },            // remark, nickname, WeChat ID
    { id: 'wxid_bot', name: '群里的鲸鱼', aliases: ['小鲸鱼'] },
  ]
  const resolve = ref => resolveMember(ref, { members, selfId: 'wxid_bot' })
  for (const ref of ['离离原上草', '阿离', 'ALICE_2024', '原上', 'wxid_alice']) assert.equal(resolve(ref).id, 'wxid_alice', ref)
  assert.equal(resolve('老鲍').name, '鲍哥', 'found by nickname, shown by the name used in the group')
  assert.throws(() => resolve('小鲸鱼'), /不能对我自己/)
  assert.throws(() => resolve('a'), /可能是：离离原上草、鲍哥/, 'ambiguity across aliases is refused, not guessed')
})

test('renames are followed: same wxid, latest names for /attack, the prompt and the bot’s own group nickname', async t => {
  const env = await startBot(t, { reply: engageModel, settings: { mode: 'infer' } })
  await until(() => env.bot.ready)
  const members = env.simulator.chats.get(GROUP).members
  const member = id => members.find(m => m.id === id)
  Object.assign(member('wxid_bot'), { aliases: ['群里的鲸鱼'] })
  await env.bot.setChat(GROUP)
  await until(() => env.bot.runner.selfNames.includes('群里的鲸鱼'))
  say(env, 'wxid_alice', '群里的鲸鱼，在吗')
  await until(() => sent(env).includes('普通回复'), { what: 'the bot’s group nickname counts as its name' })

  Object.assign(member('wxid_alice'), { name: '离离原上草', aliases: ['阿离'] }) // she sets a group nickname
  say(env, 'wxid_carol', '/attack 离离原上草')
  await until(() => sent(env).some(s => s.startsWith('已执行：开始嘲讽 离离原上草')))
  Object.assign(member('wxid_alice'), { name: '改了个名', aliases: ['阿离'] }) // and renames again mid-engagement
  say(env, 'wxid_alice', '叫我新名字')
  await until(() => sent(env).includes('attack→改了个名:叫我新名字'), { what: 'still the same person after a rename' })
  assert.equal(env.bot.runner.health().engagement.target.name, '改了个名')
  const group = env.model.calls.at(-1).raw.new.members[0]
  assert.deepEqual([group.id, group.name], ['wxid_alice', '改了个名'])
})
