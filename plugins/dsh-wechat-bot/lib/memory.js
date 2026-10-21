// Per-chat, per-member long-term notes. A note can only be written about the
// sender of the message cited as evidence, so one member can never edit (or
// impersonate) another member's memory.

const SENSITIVE = /密码|口令|验证码|api[\s_-]*key|私钥|助记词|身份证|银行卡|病史|确诊|password|secret|token|sk-[a-z0-9]{8,}|\b\d{15,19}\b/i
const MAX_TOPIC = 30
const MAX_NOTE = 120

export class MemoryBook {
  constructor({ members = {} } = {}, { maxNotesPerMember = 20 } = {}) {
    this.members = structuredClone(members)
    this.maxNotesPerMember = maxNotesPerMember
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

  // Validates and applies model-proposed updates. Returns { applied, rejected }.
  // `batch` is the list of new messages the updates may cite as evidence.
  apply(updates, batch, now = Date.now()) {
    const applied = [], rejected = []
    for (const update of Array.isArray(updates) ? updates : []) {
      const problem = this.#check(update, batch)
      if (problem) {
        rejected.push({ update, problem })
        continue
      }
      const source = batch.find(m => m.id === update.evidence)
      const member = this.members[source.sender.id] ??= { name: source.sender.name, notes: [] }
      member.name = source.sender.name
      const topic = update.topic.trim()
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
    if (update.note !== null && (typeof update.note !== 'string' || !update.note.trim() || update.note.length > MAX_NOTE)) {
      return 'bad_note'
    }
    const source = batch.find(m => m.id === update.evidence)
    if (!source) return 'evidence_not_in_batch'
    if (source.fromSelf) return 'evidence_from_bot'
    if (update.who !== source.sender.id) return 'evidence_from_someone_else'
    if (SENSITIVE.test(`${update.topic} ${update.note ?? ''} ${source.text}`)) return 'sensitive'
    return null
  }
}
