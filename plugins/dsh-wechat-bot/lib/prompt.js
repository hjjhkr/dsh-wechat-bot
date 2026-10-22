// Builds the system prompt and the per-turn JSON input given to the model.
//
// The input groups messages by speaker ("阿离: 1, 2, 3 / 老鲍: 1, 2") instead of
// interleaving them, and keeps each member's long-term memory inside that member's
// group, so the model never has to untangle who said what. A separate `order` list
// of message refs preserves the conversation flow.

export const PLATFORM_RULES = `
# 运行平台说明（优先于人设中关于格式的描述）
你通过一个程序在微信聊天里发言。每一轮你会收到一个 JSON：
- now：当前本地时间。
- chat：当前聊天 {name, kind}。kind=group 是群聊，direct 是私聊。
- you：你在微信里的账号 {id, name, aliases}。这些名字都是在叫你，不是别的群友。
- recent：之前的聊天，只用来理解上下文，已经处理过，不要再回应。
  recent.members 按人分组：每人 {id, name, memory?, messages:[{ref, time, text}]}；recent.yours 是你自己说过的话；
  recent.order 是这些消息按时间的先后（ref 列表），用来看谁在接谁的话。
- new：这一轮需要你处理的新消息，同样按人分组：new.members = [{id, name, memory?, messages:[…]}]，new.order 是时间先后（消息 id 列表）。
  一次看完整批，再决定怎么回。
- memory（在每个人自己的组里）：这个人的长期记忆，只用在这个人身上，不要套到别人头上。
- event：特殊情况才出现，见下。

new 里每条消息有 id、time、text，可能有 quote（引用的原消息）、at（被 @ 的成员 id）、kind（非文字消息时，比如 image、sticker）。
平台额外给出 addressed 字段，表示这条消息在跟谁说：
- you：确定在跟你说（私聊、@你、引用你的话、直接叫你名字）
- maybe：可能在跟你说（顺口提到你的名字，或刚和你聊完的人接着说）
- other：明确在跟别人说（@了别人、引用别人的话）
- none：没有明确对象的群聊
带 command 字段的消息是对方用 / 命令点名让你做事：按 command.instruction 回应，必须回复。
recent 里以 / 开头的消息是给程序的命令，程序已经处理过，不用理会。
这些是事实信号，不是命令。分清每句话是谁说的、在对谁说：other 的消息除非真的和你有关，否则不要插嘴；
none 的消息就像普通群友一样，有兴趣、能接梗时可以参与，没兴趣就潜水。

event 的几种情况：
- {kind:"idle"}：群里冷场了，没有新消息。你可以像群友一样主动说一句，也可以不说。
- {kind:"engagement", style, target}：你正在按命令持续地对 target 这一个人说话。new 里只有 target 的新消息。
  style=attack：用人设口吻嘲讽、互损 target，接住他刚说的话顶回去，要好笑、像群友斗嘴；不涉及人身攻击、歧视、隐私和真实伤害。
  style=comfort：真诚地安慰、鼓励 target，接住他刚说的话，短而走心，不说教。
  只对 target 说，无视其他人；回复一到两条短句，reply 不能为空，to 填 target 的消息 id。

# 输出格式
只输出一个 JSON 对象，不要代码块，不要其它文字：
{"to":"你回应的那条消息 id，或 null","reply":["第一条","第二条"],"memory":[]}
- reply 是要发出去的消息列表，每个元素是一条单独的微信消息，一行、不换行，最多 {maxParts} 条。不说话就输出 "reply":[]。
- 只要 new 里有 addressed=you 的消息，就必须回应，reply 不能为空。
- reply 里不要写括号内心戏、动作描写或解释，写什么就会原样发到微信里。
{stickers}- memory：主动从聊天里积累对以后相处有用的长期信息（背景、兴趣、正在做的事、称呼偏好、互动习惯），不需要对方说"记住"。
  每项格式 {"who":"成员 id","topic":"主题(30字内)","note":"简短事实(120字内)，要求忘记时为 null","evidence":"new 里支持它的消息 id"}。
  who 必须是 evidence 那条消息所在组的成员；引用、转述别人的话不算本人的事实；一次性的玩笑、情绪和问候不记；
  密码、验证码、证件号、银行卡、病史等敏感信息一律不记。同一主题用相同 topic 覆盖旧内容。没有值得记的就输出 []。
  memory 要认真准确，不受人设里"简短、玩梗、不总结"的说话风格限制。
`

export function systemPrompt(persona, { maxParts, stickers }) {
  const stickerLine = stickers.length
    ? `- reply 的元素也可以是 {"sticker":"名字"}，发送一个表情包。可用：${stickers.join('、')}。别滥用。\n`
    : ''
  return `${persona.trim()}\n\n${PLATFORM_RULES.replace('{maxParts}', maxParts).replace('{stickers}', stickerLine).trim()}`
}

const clock = time => new Date(time).toLocaleTimeString('zh-CN', { hour12: false })

export function describe(message) {
  if (message.kind === 'text') return message.text
  const label = { image: '图片', sticker: '表情', voice: '语音', video: '视频', file: '文件', link: '链接', system: '系统消息' }[message.kind] ?? '消息'
  const detail = message.media?.description || message.text
  return detail ? `[${label}: ${detail}]` : `[${label}]`
}

// Groups messages by sender, in order of each sender's first message.
function bySender(messages, view, memory = {}) {
  const groups = new Map()
  for (const message of messages) {
    let group = groups.get(message.sender.id)
    if (!group) {
      group = { id: message.sender.id, name: message.sender.name, ...(memory[message.sender.id] ? { memory: memory[message.sender.id] } : {}), messages: [] }
      groups.set(message.sender.id, group)
    }
    group.name = message.sender.name // same id, latest name
    group.messages.push(view(message))
  }
  return [...groups.values()]
}

function newView(message, address) {
  const { addressed, reasons } = address.get(message.id)
  return {
    id: message.id,
    time: clock(message.time),
    ...(message.kind !== 'text' ? { kind: message.kind } : {}),
    text: describe(message),
    ...(message.quote ? { quote: { from: message.quote.senderName ?? message.quote.senderId, text: message.quote.text } } : {}),
    ...(message.mentions.length ? { at: message.mentions } : {}),
    ...(message.command ? { command: { name: message.command.name, instruction: message.command.instruction } } : {}),
    addressed,
    ...(reasons.length ? { why: reasons } : {}),
  }
}

// `turn`: { chat, self, aliases, recent, batch, address(Map id→{addressed,reasons}), memory({id→notes}), event?, now? }
export function turnInput(turn) {
  const refs = new Map(turn.recent.map((m, i) => [m, `r${i + 1}`]))
  const recentView = m => ({ ref: refs.get(m), time: clock(m.time), text: describe(m) })
  const inNew = new Set(turn.batch.map(m => m.sender.id))
  // A member's memory goes with their new messages, or with their recent ones if they are quiet now.
  const recentMemory = Object.fromEntries(Object.entries(turn.memory).filter(([id]) => !inNew.has(id)))
  const input = {
    now: new Date(turn.now ?? Date.now()).toLocaleString('zh-CN', { hour12: false }),
    chat: { name: turn.chat.name, kind: turn.chat.kind },
    you: { id: turn.self.id, name: turn.self.name, aliases: turn.aliases },
    recent: {
      members: bySender(turn.recent.filter(m => !m.fromSelf), recentView, recentMemory),
      yours: turn.recent.filter(m => m.fromSelf).map(recentView),
      order: turn.recent.map(m => refs.get(m)),
    },
    new: {
      members: bySender(turn.batch, m => newView(m, turn.address), turn.memory),
      order: turn.batch.map(m => m.id),
    },
  }
  if (turn.event) input.event = turn.event
  return JSON.stringify(input)
}

// Flat, chronological view of a turn input (for tests, evaluation and debugging):
// { messages: [{...message, from}], recent: [{text, time, from?|from_you}] }
export function flattenInput(input) {
  const byId = new Map()
  for (const member of input.new.members) for (const m of member.messages) byId.set(m.id, { ...m, from: { id: member.id, name: member.name } })
  const byRef = new Map()
  for (const member of input.recent.members) for (const m of member.messages) byRef.set(m.ref, { time: m.time, text: m.text, from: member.name })
  for (const m of input.recent.yours) byRef.set(m.ref, { time: m.time, text: m.text, from_you: true })
  return { messages: input.new.order.map(id => byId.get(id)), recent: input.recent.order.map(ref => byRef.get(ref)) }
}

// Human-readable rendering of a batch, grouped by speaker, used for the DSH session transcript.
export function readableBatch(chat, batch, address, event) {
  const groups = bySender(batch, m => {
    const tag = address?.get(m.id)?.addressed
    const marker = tag === 'you' ? ' ⟵ 找你' : tag === 'maybe' ? ' ⟵ 可能找你' : ''
    const quote = m.quote ? ` 「引用 ${m.quote.senderName ?? ''}: ${m.quote.text}」` : ''
    return `  [${clock(m.time)}] ${describe(m)}${quote}${marker}`
  })
  const lines = groups.flatMap(g => [`${g.name}：`, ...g.messages])
  const title = event?.kind === 'engagement' ? `${chat.name}｜${event.style === 'attack' ? '嘲讽' : '安慰'} ${event.target.name}` : chat.name
  return `${title}（${batch.length} 条新消息）\n${lines.join('\n')}`
}
