// Targeted engagement (/attack, /comfort): the bot keeps talking to one member.
// Everything that decides *whether* to speak is deterministic script logic:
//   - who the target is: an @-mention in the command, else a nickname lookup;
//   - when to speak: only after the target (by id) said something — one reply per
//     batch of their messages, nothing while they are silent, nobody else counts.
// The model only decides *what* to say.

export const STYLES = Object.freeze({ attack: '嘲讽', comfort: '安慰' })
export const ENGAGEMENT_IDLE_MS = 60 * 60_000 // ends by itself after the target is silent this long

export class EngagementError extends Error {}

const clean = text => text.replace(/^[@＠]/, '').replace(/[\s ]+$/, '').trim()

/**
 * Finds the member a command refers to.
 * @param {string} ref            what followed the command ("阿离", "@阿离", an id)
 * @param {object} o
 * @param {string[]} o.mentions   ids @-mentioned in the command message (most reliable)
 * @param {{id,name}[]} o.members known members of the group
 * @param {string} o.selfId       the bot's own id (never a target)
 */
export function resolveMember(ref, { mentions = [], members, selfId }) {
  const others = members.filter(m => m.id !== selfId)
  const mentioned = mentions.filter(id => id !== selfId && id !== 'all')
  if (mentioned.length === 1) {
    return others.find(m => m.id === mentioned[0]) ?? { id: mentioned[0], name: clean(ref) || mentioned[0] }
  }
  if (mentioned.length > 1) throw new EngagementError('一次只能指定一个人')
  const name = clean(ref)
  if (!name) throw new EngagementError('要对谁？在命令后面写昵称，或者直接 @ TA')
  if (selfId && name === selfId) throw new EngagementError('不能对我自己')
  const lower = name.toLowerCase()
  const exact = others.filter(m => m.id === name || m.name.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw new EngagementError(`有 ${exact.length} 个人叫「${name}」，请直接 @ TA`)
  const partial = others.filter(m => m.name.toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) throw new EngagementError(`「${name}」可能是：${partial.slice(0, 5).map(m => m.name).join('、')}，说全一点或直接 @ TA`)
  throw new EngagementError(`群里没找到「${name}」`)
}

export function openingInstruction(style, target) {
  return style === 'attack'
    ? `对方用 /attack 让你开始嘲讽 ${target.name}。现在主动对 ${target.name} 说第一句：用人设口吻损 TA、逗 TA，可以拿 recent 里 TA 说过的话做文章；要好笑、像群友斗嘴，不涉及人身攻击、歧视、隐私。只对 TA 说，一两句。`
    : `对方用 /comfort 让你开始安慰 ${target.name}。现在主动对 ${target.name} 说第一句：真诚、短而走心，可以接住 recent 里 TA 说过的话；不说教。只对 TA 说，一两句。`
}
