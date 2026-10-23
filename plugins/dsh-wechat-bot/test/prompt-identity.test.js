import assert from 'node:assert/strict'
import test from 'node:test'
import { systemPrompt, turnInput } from '../lib/prompt.js'

const chat = { name: '△ 群', kind: 'group' }
const at = Date.UTC(2026, 9, 22, 2, 0)

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

test('the model input keeps current member identities, raw message ids, mentions and quote authors', () => {
  const members = [
    { id: 'wxid_author', name: '阿哲', aliases: ['czq', '老号'] },
    { id: 'wxid_target', name: '目标群友', aliases: ['target'] },
    { id: 'wxid_quote_only', name: '引用人', aliases: ['引用旧名'] },
    { id: 'wxid_bot', name: '小鲸鱼', aliases: ['小鲸'] },
  ]
  const recent = [
    message('recent-1', { id: 'wxid_author', name: '旧群昵称', aliases: ['旧别名'] }, '之前说过', {
      mentions: ['wxid_target'],
      quote: { messageId: 'quoted-1', senderId: 'wxid_quote_only', senderName: '引用人的旧名', text: '你是谁爸爸' },
    }),
    message('recent-2', { id: 'wxid_bot', name: '旧机器人名' }, '接着说', {
      mentions: ['wxid_author'],
    }),
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

  assert.deepEqual(input.chat.members, members, 'the complete fresh roster includes members who did not speak')
  const currentAuthor = input.new.members.find(m => m.id === 'wxid_author')
  assert.equal(currentAuthor.name, '阿哲', 'the current roster name replaces stale message labels')
  assert.deepEqual(currentAuthor.aliases, ['czq', '老号', '消息别名'])
  assert.deepEqual(currentAuthor.messages[0], {
    id: 'new-1', time: '10:00:00', text: '你爸是谁？', at: ['wxid_target', 'all'],
    quote: {
      senderId: 'wxid_quote_only', senderName: '引用人', messageId: 'quoted-2',
      text: '爸爸是谁', from: '引用人',
    },
    addressed: 'none',
  })

  const recentAuthor = input.recent.members.find(m => m.id === 'wxid_author')
  assert.equal(recentAuthor.name, '阿哲')
  assert.equal(recentAuthor.messages[0].id, 'recent-1', 'the original id is visible for memory evidence')
  assert.equal(recentAuthor.messages[0].ref, 'r1', 'the stable id does not replace the chronological ref')
  assert.deepEqual(recentAuthor.messages[0].at, ['wxid_target'])
  assert.deepEqual(recentAuthor.messages[0].quote, {
    senderId: 'wxid_quote_only', senderName: '引用人', messageId: 'quoted-1',
    text: '你是谁爸爸', from: '引用人',
  })
  assert.equal(input.recent.yours[0].id, 'recent-2')
  assert.deepEqual(input.recent.yours[0].at, ['wxid_author'])
  assert.deepEqual(input.new.order, ['new-1', 'new-2'])
  assert.deepEqual(input.recent.order, ['r1', 'r2'])
})

test('a quote without senderId resolves from a locally visible message, while an unmatched quote stays unidentified', () => {
  const input = buildInput({
    members: [
      { id: 'wxid_speaker', name: '说话者', aliases: ['speaker'] },
      { id: 'wxid_quoted', name: '被引用的人', aliases: ['旧称'] },
    ],
    recent: [message('source-1', { id: 'wxid_quoted', name: '过期引用名' }, '原话')],
    batch: [
      message('new-1', { id: 'wxid_speaker', name: '说话者' }, '回复', {
        quote: { messageId: 'source-1', senderName: '过期引用名', text: '原话' },
      }),
      message('new-2', { id: 'wxid_speaker', name: '说话者' }, '无上下文的引用', {
        quote: { messageId: 'not-visible', senderName: '陌生显示名', text: '没见过的原话' },
      }),
    ],
  })

  assert.deepEqual(input.new.members[0].messages[0].quote, {
    senderId: 'wxid_quoted', senderName: '被引用的人', messageId: 'source-1',
    text: '原话', from: '被引用的人',
  })
  assert.deepEqual(input.new.members[0].messages[1].quote, {
    senderName: '陌生显示名', messageId: 'not-visible', text: '没见过的原话', from: '陌生显示名',
  }, 'a display name alone must not be promoted to a guessed stable id')
})

test('the input remains compatible without a roster and retains aliases from message senders', () => {
  const input = buildInput({
    recent: [],
    batch: [message('new-1', { id: 'wxid_alice', name: '阿离', aliases: ['alice', '阿离'] }, '你好')],
  })

  assert.deepEqual(input.chat.members, [])
  assert.deepEqual(input.new.members[0], {
    id: 'wxid_alice', name: '阿离', aliases: ['alice'],
    messages: [{ id: 'new-1', time: '10:00:00', text: '你好', addressed: 'none' }],
  })
})

test('the generated model contract binds memory evidence and relationship attribution to stable authorship', () => {
  const prompt = systemPrompt('人设', { maxParts: 3, stickers: [] })

  assert.match(prompt, /recent[\s\S]*原始消息 id/)
  assert.match(prompt, /主动.*不需要.*记住/)
  assert.doesNotMatch(prompt, /没有明确请求就输出 \[\]/)
  assert.match(prompt, /who.*sender\.id/)
  assert.match(prompt, /at 指向收件对象.*quote\.senderId 指向被引用消息的作者/)
  assert.match(prompt, /玩笑.*真实.*亲属关系/)
})
