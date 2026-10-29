// Deterministic "who is this message talking to" signals. The model still makes
// the final call, but it receives facts instead of having to guess them.
//
//   you    — certainly addressed to the bot (direct chat, @bot, quoting the bot, called by name)
//   maybe  — plausibly to the bot (name mentioned in passing, follow-up to the bot)
//   other  — addressed to someone else (@someone, quoting someone else)
//   none   — general group chatter

// How long after the bot answered someone their next message may be a follow-up.
export const FOLLOW_UP_MS = 3 * 60_000
const PUNCT = '\\s,，.。!！?？~～:：;；、…'

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function nameMatchers(names, minLength = 2) {
  const unique = [...new Set(names.map(n => n?.trim()).filter(n => n && n.length >= minLength))]
  if (!unique.length) return { vocative: () => false, mentioned: () => false, textAt: () => false }
  const alt = unique.map(escape).join('|')
  // "小鲸鱼，…" / "小鲸鱼你…" / "…，小鲸鱼" / "…你说呢 小鲸鱼?"
  const vocative = new RegExp(`^[${PUNCT}@]*(?:${alt})(?:[${PUNCT}]|你|您|$)|[${PUNCT}](?:${alt})[${PUNCT}]*$`, 'i')
  const mentioned = new RegExp(alt, 'i')
  const textAt = new RegExp(`(?:^|[${PUNCT}])@(?:${alt})(?=[${PUNCT}]|$)`, 'i')
  return { vocative: text => vocative.test(text), mentioned: text => mentioned.test(text), textAt: text => textAt.test(text) }
}

// Source timestamps order messages; local arrival and send timestamps measure the window.
function isFollowUpTime(message, turn) {
  if (!Number.isFinite(message.receivedAt) || !Number.isFinite(turn?.time)) return false
  if (turn.sourceTime !== undefined) {
    return Number.isFinite(message.time) && Number.isFinite(turn.sourceTime)
      && message.time >= turn.sourceTime && message.receivedAt <= turn.time + FOLLOW_UP_MS
  }
  return message.receivedAt >= turn.time && message.receivedAt - turn.time <= FOLLOW_UP_MS
}

function quotedSenderId(message, recent = []) {
  if (typeof message.quote?.senderId === 'string' && message.quote.senderId) return message.quote.senderId
  const messageId = message.quote?.messageId
  const history = Array.isArray(recent) ? recent : []
  return messageId ? history.find(item => item?.id === messageId)?.sender?.id : undefined
}

function refersToAnotherMember(message, authorId, selfId, recent) {
  if ((message.mentions ?? []).some(id => id && id !== 'all' && id !== selfId && id !== authorId)) return true
  const quoted = quotedSenderId(message, recent)
  return Boolean(quoted && quoted !== selfId && quoted !== authorId)
}

function refersToMember(message, memberId, recent) {
  return (message.mentions ?? []).includes(memberId) || quotedSenderId(message, recent) === memberId
}

function humanConversationAfterTurn(message, turn, context) {
  const recent = Array.isArray(context.recent) ? context.recent : []
  const memberId = message.sender.id
  const selfId = context.self.id
  return recent.some(item => {
    if (!item || item.id === message.id || item.fromSelf === true
        || !Number.isFinite(item.receivedAt) || item.receivedAt <= turn.time || item.receivedAt > message.receivedAt) return false
    const authorId = item.sender?.id
    if (!authorId || authorId === selfId) return false
    if (authorId === memberId) return refersToAnotherMember(item, authorId, selfId, recent)
    return refersToMember(item, memberId, recent)
  })
}

// `context`: { chatKind, self: {id}, names: matchers, lastBotTurns?: [{time, toSenderId, sourceTime?}], recent?: Message[] }
export function addressOf(message, context) {
  const reasons = []
  const { self, names, textAtNames } = context
  const quoted = quotedSenderId(message, context.recent)
  if (context.chatKind === 'direct') return { addressed: 'you', reasons: ['direct_chat'] }
  const textAt = textAtNames?.textAt(message.text)
  if (message.mentions.includes(self.id)) reasons.push('at_you')
  if (textAt && !message.mentions.length) reasons.push('at_you_text')
  if (quoted === self.id) reasons.push('quotes_you')
  if (names.vocative(message.text) && !(textAt && message.mentions.length && !message.mentions.includes(self.id))) reasons.push('calls_your_name')
  if (reasons.length) return { addressed: 'you', reasons }

  const others = message.mentions.filter(id => id !== self.id && id !== 'all')
  if (others.length) reasons.push('at_someone_else')
  if (quoted && quoted !== self.id) reasons.push('quotes_someone_else')
  if (reasons.length) return { addressed: 'other', reasons }

  if (names.mentioned(message.text)) return { addressed: 'maybe', reasons: ['mentions_your_name'] }
  // The bot's latest answer to *this* member: answers to others do not make it a follow-up.
  const last = (context.lastBotTurns ?? [])
    .filter(turn => turn?.toSenderId === message.sender.id && Number.isFinite(turn.time))
    .reduce((latest, turn) => !latest || turn.time > latest.time ? turn : latest, null)
  if (last && isFollowUpTime(message, last)) {
    // …unless they have turned to another member since (an @ or a quote of someone else).
    if (humanConversationAfterTurn(message, last, context)) {
      return { addressed: 'none', reasons: ['human_conversation_after_reply'] }
    }
    return { addressed: 'maybe', reasons: ['follows_your_reply'] }
  }
  if (message.mentions.includes('all')) return { addressed: 'none', reasons: ['at_all'] }
  return { addressed: 'none', reasons: [] }
}
