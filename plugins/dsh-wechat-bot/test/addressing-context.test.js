import assert from 'node:assert/strict'
import test from 'node:test'
import { addressOf, nameMatchers } from '../lib/addressing.js'

const BOT_ID = 'bot-id'
const member = id => ({ id, name: id })
const message = (id, senderId, time, extra = {}) => ({
  id,
  chatId: 'synthetic-group',
  time,
  kind: 'text',
  text: extra.text ?? 'follow-up',
  sender: member(senderId),
  fromSelf: extra.fromSelf ?? false,
  mentions: extra.mentions ?? [],
  ...(extra.quote ? { quote: extra.quote } : {}),
})
const context = extra => ({
  chatKind: 'group',
  self: member(BOT_ID),
  names: nameMatchers([]),
  ...extra,
})

test('each member follows their own recent bot reply instead of the latest group reply', () => {
  const ctx = context({
    lastBotTurns: [
      { time: 1_000, toSenderId: 'member-a' },
      { time: 1_250, toSenderId: 'member-b' },
    ],
  })

  assert.deepEqual(addressOf(message('a-in-window', 'member-a', 180_999), ctx), {
    addressed: 'maybe', reasons: ['follows_your_reply'],
  })
  assert.deepEqual(addressOf(message('b-in-window', 'member-b', 181_249), ctx), {
    addressed: 'maybe', reasons: ['follows_your_reply'],
  })
  assert.deepEqual(addressOf(message('c-no-turn', 'member-c', 1_300), ctx), {
    addressed: 'none', reasons: [],
  })
  assert.deepEqual(addressOf(message('a-expired', 'member-a', 181_001), ctx), {
    addressed: 'none', reasons: [],
  })
})

test('sourceTime admits queued follow-ups after the source but rejects earlier or expired messages', () => {
  const ctx = context({
    lastBotTurns: [{ time: 50_000, sourceTime: 30_000, toSenderId: 'member-a' }],
  })

  assert.deepEqual(addressOf(message('queued', 'member-a', 40_000), ctx), {
    addressed: 'maybe', reasons: ['follows_your_reply'],
  })
  assert.deepEqual(addressOf(message('before-source', 'member-a', 29_999), ctx), {
    addressed: 'none', reasons: [],
  })
  assert.deepEqual(addressOf(message('window-edge', 'member-a', 230_000), ctx), {
    addressed: 'maybe', reasons: ['follows_your_reply'],
  })
  assert.deepEqual(addressOf(message('expired', 'member-a', 230_001), ctx), {
    addressed: 'none', reasons: [],
  })
  assert.deepEqual(addressOf(message('invalid-source-order', 'member-a', 60_000), context({
    lastBotTurns: [{ time: 50_000, sourceTime: 50_001, toSenderId: 'member-a' }],
  })), {
    addressed: 'none', reasons: [],
  })
  assert.deepEqual(addressOf(message('before-unsourced-turn', 'member-a', 999), context({
    lastBotTurns: [{ time: 1_000, toSenderId: 'member-a' }],
  })), {
    addressed: 'none', reasons: [],
  })
})

test('legacy turns stay recipient-specific and an empty new map takes precedence', () => {
  const legacyTurn = { time: 1_000, toSenderId: 'member-a' }
  assert.deepEqual(addressOf(message('legacy-a', 'member-a', 1_500), context({ lastBotTurn: legacyTurn })), {
    addressed: 'maybe', reasons: ['follows_your_reply'],
  })
  assert.deepEqual(addressOf(message('legacy-b', 'member-b', 1_500), context({ lastBotTurn: legacyTurn })), {
    addressed: 'none', reasons: [],
  })
  assert.deepEqual(addressOf(message('untargeted', 'member-a', 1_500), context({ lastBotTurn: { time: 1_000 } })), {
    addressed: 'none', reasons: [],
  })
  assert.deepEqual(addressOf(message('empty-map', 'member-a', 1_500), context({
    lastBotTurns: [], lastBotTurn: legacyTurn,
  })), {
    addressed: 'none', reasons: [],
  })
})

test('explicit human-to-human references after the bot turn block bare follow-ups', () => {
  const turn = { time: 1_000, toSenderId: 'member-a' }
  const followUp = message('current', 'member-a', 1_300)
  const history = [
    message('other-at-member', 'member-b', 1_100, { mentions: ['member-a'] }),
    message('member-at-other', 'member-a', 1_100, { mentions: ['member-b'] }),
    message('member-quotes-other', 'member-a', 1_100, { quote: { senderId: 'member-b' } }),
    message('other-quotes-member', 'member-b', 1_100, { quote: { senderId: 'member-a' } }),
  ]

  for (const interaction of history) {
    assert.deepEqual(addressOf(followUp, context({ lastBotTurns: [turn], recent: [interaction] })), {
      addressed: 'none', reasons: ['human_conversation_after_reply'],
    }, interaction.id)
  }
})

test('a quote identified by message id keeps explicit bot and human targets authoritative', () => {
  const quotedBotMessage = message('bot-message', BOT_ID, 900, { fromSelf: true })
  const quotedMemberMessage = message('member-message', 'member-b', 900)
  const ctx = context({
    lastBotTurns: [{ time: 1_000, toSenderId: 'member-a' }],
    recent: [quotedBotMessage, quotedMemberMessage],
  })

  assert.deepEqual(addressOf(message('quotes-bot', 'member-a', 1_100, {
    quote: { messageId: 'bot-message' },
  }), ctx), {
    addressed: 'you', reasons: ['quotes_you'],
  })
  assert.deepEqual(addressOf(message('quotes-member', 'member-a', 1_100, {
    quote: { messageId: 'member-message' },
  }), ctx), {
    addressed: 'other', reasons: ['quotes_someone_else'],
  })
})

test('human quote-by-id blocks a continuation while out-of-window and bot references do not', () => {
  const turn = { time: 1_000, toSenderId: 'member-a' }
  const followUp = message('current', 'member-a', 1_300)
  const unrelated = [
    message('before-turn', 'member-b', 900, { mentions: ['member-a'] }),
    message('after-current', 'member-b', 1_400, { mentions: ['member-a'] }),
    message('bot-at-member', BOT_ID, 1_100, { fromSelf: true, mentions: ['member-a'] }),
  ]

  for (const interaction of unrelated) {
    assert.deepEqual(addressOf(followUp, context({ lastBotTurns: [turn], recent: [interaction] })), {
      addressed: 'maybe', reasons: ['follows_your_reply'],
    }, interaction.id)
  }

  const quoted = message('quoted-target', 'member-b', 1_050)
  const humanQuote = message('human-quote', 'member-a', 1_100, {
    quote: { messageId: 'quoted-target' },
  })
  assert.deepEqual(addressOf(followUp, context({
    lastBotTurns: [turn], recent: [quoted, humanQuote],
  })), {
    addressed: 'none', reasons: ['human_conversation_after_reply'],
  })
})

test('explicit bot targeting and name signals keep their existing priority over human redirection', () => {
  const recent = [message('redirect', 'member-b', 1_100, { mentions: ['member-a'] })]
  const ctx = context({
    lastBotTurns: [{ time: 1_000, toSenderId: 'member-a' }],
    recent,
    names: nameMatchers(['bot-alias']),
  })

  assert.deepEqual(addressOf(message('explicit-at', 'member-a', 1_300, { mentions: [BOT_ID] }), ctx), {
    addressed: 'you', reasons: ['at_you'],
  })
  assert.deepEqual(addressOf(message('explicit-name', 'member-a', 1_300, {
    text: 'I saw bot-alias earlier',
  }), ctx), {
    addressed: 'maybe', reasons: ['mentions_your_name'],
  })
})
