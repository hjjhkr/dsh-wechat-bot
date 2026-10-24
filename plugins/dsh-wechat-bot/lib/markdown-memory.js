// Long-term memory of one chat's members, one Markdown file per member:
//   <dataDir>/memories/<chat key>/id-<sha256(wxid)>/MEMORY.md
//
//   # 微信用户记忆
//
//   <!-- dsh-memory-id: "wxid_…" -->
//
//   ## 人工补充（程序原样保留）
//   …written by people; never changed by the program (except /forget all deletes the file
//    when nothing else is left) — "### 主题" entries here also block that topic for the model
//   ## 自动记忆
//   ### 主题
//   正文 (topics and bodies are escaped so member text cannot start a heading)
//
// The automatic section belongs to the program: writes are topic-level (replace, merge,
// delete) and serialized per file, so concurrent learning, /forget and compaction compose.
// Reading is lenient — a file people edited badly is skipped and reported, never a reason
// to stop replying to the whole group. Content checks (evidence, sensitive words, sizes)
// happen when writing, in MemoryBook.validate and here.
import { createHash } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeText } from './files.js'
import { MAX_AUTOMATIC_NOTE_CHARS, MemoryBook } from './memory.js'

export const MAX_AUTOMATIC_NOTES = 30
export const MAX_DOCUMENT_BYTES = 16 * 1024
const TITLE = '# 微信用户记忆'
const MANUAL_HEADING = '## 人工补充（程序原样保留）'
const AUTOMATIC_HEADING = '## 自动记忆'
const MANUAL_PREFIX_TOPIC = '人工补充'

const directoryOf = id => 'id-' + createHash('sha256').update(id).digest('hex') // case-insensitive file systems cannot merge two ids

// Escaping that keeps member text from forming Markdown structure in the file.
const encodeTopic = topic => topic.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
const decodeTopic = topic => topic.replace(/\\(\\|n|r)/g, (_, c) => c === 'n' ? '\n' : c === 'r' ? '\r' : '\\')
const encodeNote = note => note.split(/\r?\n/).map(line => (/^#{1,6} /.test(line) ? '\\' : '') + line.replace(/\\/g, '\\\\')).join('\n')
const decodeNote = note => note.split(/\r?\n/).map(line => line.replace(/^\\(?=#)/, '').replace(/\\\\/g, '\\')).join('\n')

// "### topic" entries of a section (and any text before the first one).
function entries(section, decode) {
  const parts = section.split(/^### /m)
  const prefix = parts.shift().trim()
  const list = parts.map(part => {
    const newline = part.indexOf('\n')
    const heading = newline < 0 ? part : part.slice(0, newline)
    const body = newline < 0 ? '' : part.slice(newline + 1)
    return decode ? { topic: decodeTopic(heading.trimEnd()), text: decodeNote(body.trim()) } : { topic: heading.trim(), text: body.trim() }
  }).filter(entry => entry.topic && entry.text)
  return { prefix, list }
}

// Returns null when the text is not a memory document.
export function parseDocument(content) {
  const text = content.replace(/\r\n/g, '\n')
  const id = /^<!-- dsh-memory-id: (".*") -->$/m.exec(text)
  const manualAt = text.indexOf(MANUAL_HEADING + '\n')
  const automaticAt = text.lastIndexOf('\n' + AUTOMATIC_HEADING + '\n') // notes cannot contain it: their headings are escaped
  if (!id || manualAt < 0 || automaticAt < manualAt) return null
  const manualRaw = text.slice(manualAt + MANUAL_HEADING.length + 1, automaticAt + 1)
  const manual = entries(manualRaw, false)
  return {
    id: JSON.parse(id[1]),
    manualRaw,
    manual: [...(manual.prefix ? [{ topic: MANUAL_PREFIX_TOPIC, text: manual.prefix }] : []), ...manual.list],
    automatic: entries(text.slice(automaticAt + AUTOMATIC_HEADING.length + 2), true).list,
  }
}

export function renderDocument(id, { manualRaw = '\n', automatic }) {
  const notes = automatic.map(entry => `### ${encodeTopic(entry.topic)}\n${encodeNote(entry.text)}`).join('\n\n')
  // "-" is escaped so an id containing "-->" cannot end the comment.
  return `${TITLE}\n\n<!-- dsh-memory-id: ${JSON.stringify(id).replace(/-/g, '\\u002d')} -->\n\n${MANUAL_HEADING}\n${manualRaw}${AUTOMATIC_HEADING}\n${notes ? notes + '\n' : ''}`
}

const noteMap = list => Object.fromEntries(list.map(entry => [entry.topic, entry.text]))

export class MarkdownMemory {
  #chains = new Map()
  #reported = new Set()

  /**
   * @param {string} root      the plugin data directory
   * @param {string} chatKey   the chat's state file name (Store.chatPath), a hash of its id
   * @param {(message: string) => void} [onProblem]  reports a file that cannot be read
   */
  constructor(root, chatKey, onProblem = () => {}) {
    this.directory = join(root, 'memories', chatKey)
    this.onProblem = onProblem
  }

  pathOf(id) {
    return join(this.directory, directoryOf(id), 'MEMORY.md')
  }

  // { notes: {id: {topic: text}} (automatic and manual), documents: {id: Markdown} }
  async context(ids) {
    const notes = {}, documents = {}
    for (const id of new Set(ids)) {
      const stored = await this.#read(id)
      if (!stored || (!stored.parsed.automatic.length && !stored.parsed.manual.length)) continue
      notes[id] = { ...noteMap(stored.parsed.automatic), ...noteMap(stored.parsed.manual) }
      documents[id] = stored.content
    }
    return { notes, documents }
  }

  // What /memory shows a member: the automatic notes about them.
  async recall(id) {
    return noteMap((await this.#read(id))?.parsed.automatic ?? [])
  }

  // Writes proposals that MemoryBook.validate accepted. Returns { applied, rejected }.
  async apply(updates, evidence) {
    const { valid, rejected } = new MemoryBook({}, { maxNoteChars: MAX_AUTOMATIC_NOTE_CHARS }).validate(updates, evidence)
    const applied = []
    const byWho = Map.groupBy(valid, update => update.who)
    await Promise.all([...byWho].map(([id, list]) => this.#update(id, ({ manual, automatic }) => {
      const blocked = new Set(manual.map(entry => entry.topic))
      for (const update of list) {
        const problem = mergeInto(automatic, update, blocked)
        if (problem) rejected.push({ update, problem })
        else applied.push(update)
      }
    }).catch(error => rejected.push(...list.map(update => ({ update, problem: error.code ?? 'write_failed' }))))))
    return { applied, rejected }
  }

  // Removes an automatic topic, or all automatic notes; the manual section stays.
  async forget(id, topic) {
    let removed = 0
    await this.#update(id, document => {
      const keep = topic === undefined ? [] : document.automatic.filter(entry => entry.topic !== topic)
      removed = document.automatic.length - keep.length
      document.automatic.splice(0, document.automatic.length, ...keep)
    })
    return removed
  }

  // The automatic notes of one member, for compaction.
  async snapshot(who) {
    return { who, automatic: ((await this.#read(who))?.parsed.automatic ?? []).map(({ topic, text }) => ({ topic, note: text })) }
  }

  // Applies a compaction (see memory-maintenance.js): the source topics it covered are replaced
  // by its notes and discarded topics go; anything learned meanwhile is kept.
  async compact(who, { notes, discard }) {
    let before = 0, after = 0
    await this.#update(who, ({ automatic }) => {
      before = automatic.length
      const covered = new Set([...notes.flatMap(note => note.sourceTopics), ...discard.map(item => item.topic)])
      const kept = automatic.filter(entry => !covered.has(entry.topic))
      automatic.splice(0, automatic.length, ...kept, ...notes.map(note => ({ topic: note.topic, text: note.note })))
      after = automatic.length
    })
    return { who, before, after }
  }

  // Members with a memory file: [{ who, count, bytes }]. Unreadable entries are skipped.
  async listMembers() {
    const directories = await readdir(this.directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
    const members = []
    for (const name of directories.filter(name => /^id-[a-f0-9]{64}$/.test(name))) {
      const content = await readFile(join(this.directory, name, 'MEMORY.md'), 'utf8').catch(() => null)
      const parsed = content && parseDocument(content)
      if (parsed && directoryOf(parsed.id) === name) members.push({ who: parsed.id, count: parsed.automatic.length, bytes: Buffer.byteLength(content) })
    }
    return members
  }

  async count() {
    return (await this.listMembers()).length
  }

  // Imports notes from the old in-state memory for members without automatic notes yet.
  // Returns whether every member made it (otherwise the old copy should be kept).
  async migrate(legacy) {
    let complete = true
    for (const [id, member] of Object.entries(legacy?.members ?? {})) {
      const automatic = (member.notes ?? []).map(note => ({ topic: note.topic, text: note.text }))
      if (automatic.length) await this.#update(id, document => {
        if (!document.automatic.length) document.automatic.push(...automatic)
      }).catch(error => {
        complete = false
        this.onProblem(`旧记忆迁移失败（${id}）：${error.message}`)
      })
    }
    return complete
  }

  async flush() {
    await Promise.allSettled([...this.#chains.values()])
  }

  async #read(id) {
    const path = this.pathOf(id)
    const content = await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (content === null) return null
    const parsed = parseDocument(content)
    if (!parsed || parsed.id !== id) {
      if (!this.#reported.has(path)) this.onProblem(`记忆文件格式不对，已跳过（改好后自动恢复）：${path}`)
      this.#reported.add(path)
      return null
    }
    this.#reported.delete(path)
    return { content, parsed }
  }

  // Read-modify-write of one member's file, serialized per file. `change` edits the parsed
  // document in place; the file is deleted when nothing is left in it.
  #update(id, change) {
    const path = this.pathOf(id)
    const run = (this.#chains.get(path) ?? Promise.resolve()).then(async () => {
      const stored = await this.#read(id)
      if (stored === null && await readFile(path).then(() => true, () => false)) {
        throw Object.assign(new Error('memory file needs fixing by hand'), { code: 'unreadable_document' })
      }
      const document = stored?.parsed ?? { id, manualRaw: '\n', manual: [], automatic: [] }
      const before = stored?.content
      change(document)
      if (!document.automatic.length && !document.manualRaw.trim()) {
        if (stored) await rm(dirname(path), { recursive: true, force: true })
        return
      }
      const content = renderDocument(id, document)
      if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
        throw Object.assign(new Error('memory file would be too large'), { code: 'memory_full' })
      }
      if (content !== before) await writeText(path, content)
    })
    this.#chains.set(path, run.catch(() => {}))
    return run
  }
}

// One validated update applied to a member's automatic notes; returns a problem or null.
function mergeInto(automatic, update, blocked) {
  const topic = update.topic.trim()
  if (blocked.has(topic) || (update.mergeTopics ?? []).some(source => blocked.has(source))) return 'manual_topic'
  const index = automatic.findIndex(entry => entry.topic === topic)
  if (update.note === null) {
    if (index >= 0) automatic.splice(index, 1)
    return null
  }
  const sources = new Set(update.mergeTopics ?? [])
  if ([...sources].some(source => !automatic.some(entry => entry.topic === source))) return 'merge_topic_not_found'
  const kept = automatic.filter(entry => entry.topic !== topic && !sources.has(entry.topic))
  if (kept.length >= MAX_AUTOMATIC_NOTES) return 'memory_full'
  automatic.splice(0, automatic.length, ...kept, { topic, text: update.note.trim() })
  return null
}
