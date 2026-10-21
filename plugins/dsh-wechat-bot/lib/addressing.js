// Deterministic "who is this message talking to" signals. The model still makes
// the final call, but it receives facts instead of having to guess them.
//
//   you    — certainly addressed to the bot (direct chat, @bot, quoting the bot, called by name)
//   maybe  — plausibly to the bot (name mentioned in passing, follow-up to the bot)
//   other  — addressed to someone else (@someone, quoting someone else)
//   none   — general group chatter

const FOLLOW_UP_MS = 3 * 60_000
const PUNCT = '\\s,，.。!！?？~～:：;；、…'

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function nameMatchers(names) {
  const unique = [...new Set(names.map(n => n?.trim()).filter(n => n && n.length >= 2))]
  if (!unique.length) return { vocative: () => false, mentioned: () => false }
  const alt = unique.map(escape).join('|')
  // "小鲸鱼，…" / "小鲸鱼你…" / "…，小鲸鱼" / "…你说呢 小鲸鱼?"
  const vocative = new RegExp(`^[${PUNCT}@]*(?:${alt})(?:[${PUNCT}]|你|您|$)|[${PUNCT}](?:${alt})[${PUNCT}]*$`, 'i')
  const mentioned = new RegExp(alt, 'i')
  return { vocative: text => vocative.test(text), mentioned: text => mentioned.test(text) }
}

// `context`: { chatKind, self: {id}, names: matchers, lastBotTurn?: {time, toSenderId} }
export function addressOf(message, context) {
  const reasons = []
  const { self, names } = context
  if (context.chatKind === 'direct') return { addressed: 'you', reasons: ['direct_chat'] }
  if (message.mentions.includes(self.id)) reasons.push('at_you')
  if (message.quote?.senderId === self.id) reasons.push('quotes_you')
  if (names.vocative(message.text)) reasons.push('calls_your_name')
  if (reasons.length) return { addressed: 'you', reasons }

  const others = message.mentions.filter(id => id !== self.id && id !== 'all')
  if (others.length) reasons.push('at_someone_else')
  if (message.quote && message.quote.senderId !== self.id) reasons.push('quotes_someone_else')
  if (reasons.length) return { addressed: 'other', reasons }

  if (names.mentioned(message.text)) return { addressed: 'maybe', reasons: ['mentions_your_name'] }
  const last = context.lastBotTurn
  if (last && message.time - last.time <= FOLLOW_UP_MS && (!last.toSenderId || last.toSenderId === message.sender.id)) {
    return { addressed: 'maybe', reasons: ['follows_your_reply'] }
  }
  if (message.mentions.includes('all')) return { addressed: 'none', reasons: ['at_all'] }
  return { addressed: 'none', reasons: [] }
}
