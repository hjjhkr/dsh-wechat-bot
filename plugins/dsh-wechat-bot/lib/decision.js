// Parses the model's JSON decision. Anything that cannot be sent as-is is
// rejected with a reason that is fed back to the model for one correction.

export class DecisionError extends Error {
  constructor(code, hint) {
    super(code)
    this.name = 'DecisionError'
    this.code = code
    this.hint = hint
  }
}

// Models occasionally wrap JSON in a code fence or add a sentence around it.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < start) throw new DecisionError('not_json', '只输出一个 JSON 对象')
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    throw new DecisionError('not_json', '输出必须是合法 JSON')
  }
}

// Drop stage directions such as "（潜水）" or "(笑)" that would otherwise be sent verbatim.
const stripAsides = text => text.replace(/[（(][^（）()]{0,20}[）)]/g, '').trim()

function replyParts(reply, { maxParts, stickers }) {
  if (reply === null || reply === undefined || reply === '') return []
  const items = typeof reply === 'string' ? [reply] : reply
  if (!Array.isArray(items)) throw new DecisionError('bad_reply', 'reply 必须是数组')
  const parts = []
  for (const item of items) {
    if (typeof item === 'string') {
      for (const line of item.split(/\r?\n/)) {
        const text = stripAsides(line)
        if (text) parts.push({ kind: 'text', text })
      }
    } else if (item && typeof item.sticker === 'string') {
      if (!stickers.includes(item.sticker)) throw new DecisionError('unknown_sticker', `没有叫「${item.sticker}」的表情包`)
      parts.push({ kind: 'sticker', name: item.sticker })
    } else {
      throw new DecisionError('bad_reply', 'reply 的元素必须是字符串')
    }
  }
  if (parts.length > maxParts) throw new DecisionError('too_many_parts', `reply 最多 ${maxParts} 条`)
  return parts
}

export function parseDecision(text, { batch, maxParts = 3, stickers = [] }) {
  const value = extractJson(String(text ?? ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionError('not_object', '输出必须是 JSON 对象')
  const reply = replyParts(value.reply, { maxParts, stickers })
  const to = typeof value.to === 'string' && batch.some(m => m.id === value.to) ? value.to : null
  const memory = Array.isArray(value.memory) ? value.memory : []
  return { to, reply, memory }
}
