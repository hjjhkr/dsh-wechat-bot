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

// Remove only explicit Chinese stage actions; ordinary parentheses and kaomoji are message text.
const STAGE_ACTION_ASIDE = /[（(](?:大笑|偷笑|坏笑|苦笑|冷笑|笑了|笑|潜水|冒泡|路过|围观|吃瓜|沉默|点头|摇头|挥挥手|挥手|摆手|耸肩|摊手|扶额|捂脸|捂嘴|叹气|叹息|鼓掌|拍桌|鞠躬|抱拳|敬礼|发呆|思考|翻白眼|眨眼|打哈欠|睡觉|离开|逃跑|装死|流泪|大哭|哭|跪地|趴桌|探头|歪头|擦汗|喝水|打盹|震惊|惊讶|无语|脸红|尴尬|坐下|起身|转身|走开|比心|拥抱|抱抱)[）)]/gu
const stripAsides = text => text.replace(STAGE_ACTION_ASIDE, '').trim()

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

export function parseDecision(text, { batch, maxParts = 3, stickers = [], requireIntent = false }) {
  const value = extractJson(String(text ?? ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionError('not_object', '输出必须是 JSON 对象')
  const reply = replyParts(value.reply, { maxParts, stickers })
  const to = typeof value.to === 'string' && batch.some(m => m.id === value.to) ? value.to : null
  let intent
  if (requireIntent && reply.length) {
    if (value.intent !== 'direct' && value.intent !== 'interject') {
      throw new DecisionError('bad_intent', '回复时 intent 必须是 direct 或 interject')
    }
    intent = value.intent
    if (intent === 'direct' && !to) throw new DecisionError('direct_target', 'direct 必须指定 new 中的消息 id')
    if (intent === 'interject' && reply.length > 1) throw new DecisionError('interject_parts', 'interject 最多回复一条')
  }
  const memory = Array.isArray(value.memory) ? value.memory : []
  return { to, reply, memory, intent }
}
