// Per-chat, per-member long-term notes. A note can only be written about the
// sender of the message cited as evidence, so one member can never edit (or
// impersonate) another member's memory.

const SENSITIVE = /密码|口令|验证码|api[\s_-]*key|私钥|助记词|身份证|银行卡|病史|确诊|password|secret|token|sk-[a-z0-9]{8,}|\b\d{15,19}\b/i
const MAX_TOPIC = 30
const DEFAULT_MAX_NOTE_CHARS = 120
export const MAX_AUTOMATIC_NOTE_CHARS = 480
const FORGET_REQUEST = /忘(?:了|掉|记)|删(?:掉|除)?|别(?:再)?记|不要(?:再)?记|不用记|\b(?:forget|delete|remove)\b/i

export function isSensitiveMemoryContent(value) {
  return SENSITIVE.test(String(value ?? ''))
}

export class MemoryBook {
  constructor({ members = {} } = {}, { maxNotesPerMember = 20, maxNoteChars = DEFAULT_MAX_NOTE_CHARS } = {}) {
    this.members = structuredClone(members)
    this.maxNotesPerMember = maxNotesPerMember
    this.maxNoteChars = maxNoteChars
  }

  toJSON() {
    return { members: this.members }
  }

  // Notes for the given member ids, in the compact shape shown to the model.
  recall(ids) {
    const result = {}
    for (const id of ids) {
      const member = this.members[id]
      if (member?.notes.length) result[id] = Object.fromEntries(member.notes.map(n => [n.topic, n.text]))
    }
    return result
  }

  // Removes one topic, or every note when `topic` is undefined. Returns the count removed.
  forget(memberId, topic) {
    const member = this.members[memberId]
    if (!member) return 0
    const before = member.notes.length
    member.notes = topic === undefined ? [] : member.notes.filter(n => n.topic !== topic)
    return before - member.notes.length
  }

  // Validates proposed updates without consulting or mutating stored member notes.
  // Persistent stores use this before reading their own current state.
  validate(updates, batch) {
    const valid = [], rejected = []
    for (const update of Array.isArray(updates) ? updates : []) {
      const problem = this.#check(update, batch)
      if (problem) rejected.push({ update, problem })
      else valid.push(update)
    }

    const byWho = new Map()
    for (const update of valid) {
      const list = byWho.get(update.who) ?? []
      list.push(update)
      byWho.set(update.who, list)
    }
    const conflicted = new Set()
    for (const [who, proposals] of byWho) {
      for (let leftIndex = 0; leftIndex < proposals.length; leftIndex++) {
        const left = proposals[leftIndex]
        for (let rightIndex = leftIndex + 1; rightIndex < proposals.length; rightIndex++) {
          const right = proposals[rightIndex]
          if (left.mergeTopics === undefined && right.mergeTopics === undefined) continue
          const leftTopics = new Set([left.topic.trim(), ...(left.mergeTopics ?? [])])
          const rightTopics = [right.topic.trim(), ...(right.mergeTopics ?? [])]
          if (rightTopics.some(topic => leftTopics.has(topic))) conflicted.add(who)
        }
      }
    }

    if (!conflicted.size) return { valid, rejected }
    const accepted = []
    for (const update of valid) {
      if (conflicted.has(update.who)) rejected.push({ update, problem: 'merge_conflict' })
      else accepted.push(update)
    }
    return { valid: accepted, rejected }
  }

  // Validates and applies model-proposed updates. Returns { applied, rejected }.
  // `batch` is the list of new messages the updates may cite as evidence.
  apply(updates, batch, now = Date.now()) {
    const validation = this.validate(updates, batch)
    const applied = [], rejected = [...validation.rejected]
    for (const update of validation.valid) {
      const source = batch.find(m => m.id === update.evidence)
      const topic = update.topic.trim()
      let member = this.members[source.sender.id]
      if (update.mergeTopics !== undefined) {
        if (!member || update.mergeTopics.some(mergeTopic => !member.notes.some(note => note.topic === mergeTopic))) {
          rejected.push({ update, problem: 'merge_topic_not_found' })
          continue
        }
        const targetExists = member.notes.some(note => note.topic === topic)
        const resultingCount = member.notes.length - update.mergeTopics.length + (targetExists ? 0 : 1)
        if (resultingCount > this.maxNotesPerMember) {
          rejected.push({ update, problem: 'memory_full' })
          continue
        }
        const sources = new Set(update.mergeTopics)
        member.notes = member.notes.filter(note => !sources.has(note.topic) && note.topic !== topic)
      } else {
        member ??= this.members[source.sender.id] = { name: source.sender.name, notes: [] }
      }
      member.name = source.sender.name
      const index = member.notes.findIndex(n => n.topic === topic)
      if (update.note === null) {
        if (index >= 0) member.notes.splice(index, 1)
      } else {
        const note = { topic, text: update.note.trim(), at: now, evidence: source.id }
        if (index >= 0) member.notes.splice(index, 1)
        member.notes.push(note)
        if (member.notes.length > this.maxNotesPerMember) member.notes.shift()
      }
      applied.push(update)
    }
    return { applied, rejected }
  }

  #check(update, batch) {
    if (!update || typeof update !== 'object') return 'not_an_object'
    if (typeof update.topic !== 'string' || !update.topic.trim() || update.topic.length > MAX_TOPIC) return 'bad_topic'
    if (update.note !== null && (typeof update.note !== 'string' || !update.note.trim() || update.note.length > this.maxNoteChars)) {
      return 'bad_note'
    }
    if (update.mergeTopics !== undefined) {
      if (update.note === null || !Array.isArray(update.mergeTopics) || update.mergeTopics.length < 1 ||
        update.mergeTopics.length > 30 || update.mergeTopics.some(topic => typeof topic !== 'string' || !topic.trim()) ||
        new Set(update.mergeTopics).size !== update.mergeTopics.length ||
        update.mergeTopics.includes(update.topic.trim())) {
        return 'merge_topics_invalid'
      }
    }
    const source = batch.find(m => m.id === update.evidence)
    if (!source) return 'evidence_not_in_batch'
    if (source.fromSelf) return 'evidence_from_bot'
    if (update.who !== source.sender.id) return 'evidence_from_someone_else'
    if (update.note === null && !FORGET_REQUEST.test(source.text)) return 'forget_not_requested'
    if (isSensitiveMemoryContent(`${update.topic} ${update.note ?? ''} ${(update.mergeTopics ?? []).join(' ')} ${source.text}`)) return 'sensitive'
    return null
  }
}
