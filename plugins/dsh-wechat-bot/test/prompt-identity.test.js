import assert from 'node:assert/strict'
import test from 'node:test'
import { systemPrompt, turnInput } from '../lib/prompt.js'

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

  const withLearner = systemPrompt('人设', { maxParts: 3, stickers: [], memory: false })
  assert.doesNotMatch(withLearner, /memory：|"memory"/, 'the reply model is not asked for notes nobody uses')
  assert.match(withLearner, /\{"to":"你回应的那条消息 id，或 null","reply":\["第一条","第二条"\]\}/)
})
