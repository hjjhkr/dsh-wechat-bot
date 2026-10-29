import assert from 'node:assert/strict'
import test from 'node:test'
import { systemPrompt, turnInput, splitTurnInput } from '../lib/prompt.js'

const chat = { name: '△ 群', kind: 'group' }
const at = Date.UTC(2026, 9, 22, 2, 0)
const clock = new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) // the host's zone, like the bot

function message(id, sender, text, extra = {}) {
  return {
    id,
    chatId: 'triangle@chatroom',
    time: at,
    kind: 'text',
    text,
    sender,
    fromSelf: sender.id === 'wxid_bot',
    mentions: [],
    ...extra,
  }
}

function buildInput({ members, recent, batch }) {
  const address = new Map(batch.map(m => [m.id, { addressed: 'none', reasons: [] }]))
  return JSON.parse(turnInput({
    chat,
    self: { id: 'wxid_bot', name: '小鲸鱼', aliases: [] },
    aliases: [],
    members,
    recent,
    batch,
    address,
    memory: {},
    now: at,
  }))
}

test('the model input names everyone by their current name, keyed by id, with raw ids, mentions and quote authors', () => {
  const members = [
    { id: 'wxid_author', name: '阿哲', aliases: ['czq', '老号'] },
    { id: 'wxid_target', name: '目标群友', aliases: ['target'] },
    { id: 'wxid_quote_only', name: '引用人', aliases: ['引用旧名'] },
    { id: 'wxid_silent', name: '路人甲' },
    { id: 'wxid_bot', name: '小鲸鱼', aliases: ['小鲸'] },
  ]
  const recent = [
    message('recent-1', { id: 'wxid_author', name: '旧群昵称', aliases: ['旧别名'] }, '之前说过', {
      mentions: ['wxid_target'],
      quote: { messageId: 'quoted-1', senderId: 'wxid_quote_only', senderName: '引用人的旧名', text: '你是谁爸爸' },
    }),
    message('recent-2', { id: 'wxid_bot', name: '旧机器人名' }, '接着说', { mentions: ['wxid_author'] }),
  ]
  const batch = [
    message('new-1', { id: 'wxid_author', name: '发消息时旧名', aliases: ['消息别名'] }, '你爸是谁？', {
      mentions: ['wxid_target', 'all'],
      quote: { messageId: 'quoted-2', senderId: 'wxid_quote_only', senderName: '过期引用名', text: '爸爸是谁' },
    }),
    message('new-2', { id: 'wxid_target', name: '老目标名' }, '我再确认一下', {
      quote: { messageId: 'recent-1', senderName: '旧引用显示名', text: '之前说过' },
    }),
  ]

  const input = buildInput({ members, recent, batch })

  assert.deepEqual(input.chat.mentioned, [{ id: 'wxid_quote_only', name: '引用人', aliases: ['引用旧名'] }],
    'only members the messages refer to without speaking; not the silent rest of the group, not the bot')
  const author = input.new.members.find(m => m.id === 'wxid_author')
  assert.equal(author.name, '阿哲', 'the current name replaces the one the message was sent under')
  assert.deepEqual(author.aliases, ['czq', '老号', '消息别名'])
  assert.deepEqual(author.messages[0], {
    id: 'new-1', time: clock, text: '你爸是谁？', at: ['wxid_target', 'all'],
    quote: { from: '引用人', senderId: 'wxid_quote_only', messageId: 'quoted-2', text: '爸爸是谁' },
    addressed: 'none',
  })
  assert.deepEqual(input.new.members.find(m => m.id === 'wxid_target').messages[0].quote,
    { from: '阿哲', senderId: 'wxid_author', messageId: 'recent-1', text: '之前说过' }, 'a quote by id finds its author locally')

  const recentAuthor = input.recent.members.find(m => m.id === 'wxid_author')
  assert.equal(recentAuthor.name, '阿哲')
  assert.deepEqual(recentAuthor.messages[0], {
    id: 'recent-1', time: clock, text: '之前说过', at: ['wxid_target'],
    quote: { from: '引用人', senderId: 'wxid_quote_only', messageId: 'quoted-1', text: '你是谁爸爸' },
  })
  assert.deepEqual(input.recent.yours, [{ id: 'recent-2', time: clock, text: '接着说', at: ['wxid_author'] }])
  assert.deepEqual(input.recent.order, ['recent-1', 'recent-2'])
  assert.deepEqual(input.new.order, ['new-1', 'new-2'])
})

test('a member named in the text is listed by id; an unmatched quote keeps only its display name', () => {
  const input = buildInput({
    members: [
      { id: 'wxid_speaker', name: '说话者' },
      { id: 'wxid_wang', name: '王大锤', aliases: ['老王'] },
    ],
    recent: [],
    batch: [
      message('new-1', { id: 'wxid_speaker', name: '说话者' }, '老王最近在忙啥', {
        quote: { messageId: 'not-visible', senderName: '陌生显示名', text: '没见过的原话' },
      }),
    ],
  })
  assert.deepEqual(input.chat.mentioned, [{ id: 'wxid_wang', name: '王大锤', aliases: ['老王'] }])
  assert.deepEqual(input.new.members[0].messages[0].quote,
    { from: '陌生显示名', messageId: 'not-visible', text: '没见过的原话' },
    'a display name alone is never promoted to a guessed id')
})

test('without a member list the input still works and keeps the aliases messages carry', () => {
  const input = buildInput({
    recent: [],
    batch: [message('new-1', { id: 'wxid_alice', name: '阿离', aliases: ['alice', '阿离'] }, '你好')],
  })
  assert.equal(input.chat.mentioned, undefined)
  assert.deepEqual(input.new.members[0], {
    id: 'wxid_alice', name: '阿离', aliases: ['alice'],
    messages: [{ id: 'new-1', time: clock, text: '你好', addressed: 'none' }],
  })
})

test('the rules tie authorship and memory to ids, and drop the memory format when a learner writes memory', () => {
  const prompt = systemPrompt('人设', { maxParts: 3, stickers: [] })
  assert.match(prompt, /身份只认 id/)
  assert.match(prompt, /at 是被 @ 的对象，quote\.senderId 是被引用那句话的作者/)
  assert.match(prompt, /玩笑.*不要当成真实的身份或关系/)
  assert.match(prompt, /不需要对方说"记住"/)
  assert.match(prompt, /who 必须是 evidence 那条消息的作者 id/)
  assert.match(prompt, /"memory":\[\]/)
  assert.match(prompt, /只输出一个 JSON 对象，不要代码块，不要其它文字/)
  assert.match(prompt, /普通括号.*颜文字.*字符串/)

  const withLearner = systemPrompt('人设', { maxParts: 3, stickers: [], memory: false })
  assert.doesNotMatch(withLearner, /memory：|"memory"/, 'the reply model is not asked for notes nobody uses')
  assert.match(withLearner, /\{"to":"你回应的那条消息 id，或 null","reply":\["第一条","第二条"\]\}/)
})

test('an "@昵称" in the text or the bot’s own name does not list extra members', () => {
  const input = buildInput({
    members: [
      { id: 'wxid_speaker', name: '说话者' },
      { id: 'wxid_wang', name: '王大锤' },
      { id: 'wxid_dachui', name: '大锤' },
      { id: 'wxid_fish', name: '鲸鱼' },
    ],
    recent: [],
    batch: [message('new-1', { id: 'wxid_speaker', name: '说话者' }, '@王大锤 @小鲸鱼 晚上吃啥', { mentions: ['wxid_wang', 'wxid_bot'] })],
  })
  assert.deepEqual(input.chat.mentioned, [{ id: 'wxid_wang', name: '王大锤' }], 'only the @-ed member, by id')
})

test('reply input keeps new messages visible and injects complete history and ID-scoped memory separately', () => {
  const original = {
    now: '2026/10/29 09:40:53', chat, you: { id: 'wxid_bot', name: '小鲸鱼' },
    recent: {
      members: [{ id: 'alice', name: '阿离', memory: { 宠物: '养猫' }, messages: [{ id: 'old', text: '昨晚说的话' }] }],
      yours: [{ id: 'bot-old', text: '之前的回复' }], order: ['old', 'bot-old'],
    },
    new: {
      members: [{ id: 'alice', name: '阿离', aliases: ['Alice'], memoryDocument: '# 阿离的完整记忆',
        messages: [{ id: 'new', text: '你是谁', addressed: 'you', quote: { messageId: 'bot-old', senderId: 'wxid_bot' } }] }],
      order: ['new'],
    },
    event: { kind: 'engagement', style: 'comfort', target: { id: 'alice', name: '阿离' } },
  }
  const serialized = JSON.stringify(original)
  const { background, input } = splitTurnInput(serialized)
  assert.deepEqual(JSON.parse(input), {
    now: original.now, chat, you: original.you,
    new: { members: [{ id: 'alice', name: '阿离', aliases: ['Alice'], messages: original.new.members[0].messages }], order: ['new'] },
    event: original.event,
  })
  assert.deepEqual(JSON.parse(background), {
    recent: {
      members: [{ id: 'alice', name: '阿离', messages: [{ id: 'old', text: '昨晚说的话' }] }],
      yours: [{ id: 'bot-old', text: '之前的回复' }], order: ['old', 'bot-old'],
    },
    memory: { alice: { memory: { 宠物: '养猫' }, memoryDocument: '# 阿离的完整记忆' } },
  })
  assert.equal(JSON.stringify(original), serialized, 'splitting does not mutate the source snapshot')
})

test('an idle reply retains the trigger and all history with no incoming messages or memory', () => {
  const { background, input } = splitTurnInput(JSON.stringify({
    recent: { members: [], yours: [{ id: 'last', text: '等你回复' }], order: ['last'] },
    new: { members: [], order: [] }, event: { kind: 'idle', minutes: 5 },
  }))
  assert.deepEqual(JSON.parse(input), { new: { members: [], order: [] }, event: { kind: 'idle', minutes: 5 } })
  assert.deepEqual(JSON.parse(background), {
    recent: { members: [], yours: [{ id: 'last', text: '等你回复' }], order: ['last'] }, memory: {},
  })
})
