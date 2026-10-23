import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_AUTOMATIC_NOTE_CHARS, MemoryBook, isSensitiveMemoryContent } from './memory.js'

const MAX_DOCUMENT_BYTES = 16 * 1024
const MAX_AUTOMATIC_NOTES = 30
const TITLE = '# 微信用户记忆'
const MANUAL_HEADING = '## 人工补充（程序原样保留）'
const AUTOMATIC_HEADING = '## 自动记忆'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true })
}

function assertId(id) {
  if (typeof id !== 'string' || !id || id.length > 512) {
    throw new MarkdownMemoryError('bad_id', '记忆用户 id 必须是 1 到 512 字符的字符串')
  }
}

function idDirectory(id) {
  // Hash every id so Windows case-insensitive paths cannot merge distinct users.
  // The readable, authoritative id remains in the Markdown header.
  return 'id-' + sha256(id)
}

function linesWithOffsets(value) {
  const lines = []
  let start = 0
  while (start < value.length) {
    const lf = value.indexOf('\n', start)
    if (lf < 0) {
      lines.push({ text: value.slice(start), start, end: value.length, eol: '' })
      break
    }
    const crlf = lf > start && value[lf - 1] === '\r'
    lines.push({ text: value.slice(start, crlf ? lf - 1 : lf), start, end: lf + 1, eol: crlf ? '\r\n' : '\n' })
    start = lf + 1
  }
  if (!value.length) return []
  return lines
}

function markdownIdLine(id) {
  // Keep the id readable in the header while preventing a value containing "-->"
  // from ending the HTML comment early.
  const encoded = JSON.stringify(id).replace(/-/g, '\\u002d')
  return '<!-- dsh-memory-id: ' + encoded + ' -->'
}

function decodeTopic(value) {
  return value.replace(/\\(\\|n|r)/g, (_, escaped) => {
    if (escaped === 'n') return '\n'
    if (escaped === 'r') return '\r'
    return '\\'
  })
}

function encodeTopic(value) {
  return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

function encodeNote(value, eol) {
  return value.split(/\r?\n/).map(line => {
    const escaped = line.replace(/\\/g, '\\\\')
    return /^#{1,6} /.test(line) ? '\\' + escaped : escaped
  }).join(eol)
}

function decodeNote(value) {
  return value.split(/\r?\n/).map(line => {
    const unmarked = /^\\(?=#)/.test(line) ? line.slice(1) : line
    return unmarked.replace(/\\\\/g, '\\')
  }).join('\n')
}

function splitEntries(section, { automatic = false } = {}) {
  const content = section.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '')
  if (!content.trim()) return { prefix: '', entries: [] }
  const lines = linesWithOffsets(content)
  const headings = []
  for (const line of lines) {
    if (line.text.startsWith('### ')) headings.push({ line, topic: line.text.slice(4) })
  }
  if (!headings.length) {
    if (automatic) throw new MarkdownMemoryError('bad_format', '自动记忆区只能包含 ### 主题 和正文')
    return { prefix: content.trim(), entries: [] }
  }
  const prefix = content.slice(0, headings[0].line.start).trim()
  if (automatic && prefix) throw new MarkdownMemoryError('bad_format', '自动记忆区主题前出现了无法识别的正文')
  const entries = []
  const seen = new Set()
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]
    const topic = automatic ? decodeTopic(current.topic) : current.topic
    if (!topic.trim()) throw new MarkdownMemoryError('bad_format', '记忆主题不能为空')
    if (seen.has(topic)) throw new MarkdownMemoryError('bad_format', '记忆文档中存在重复主题：' + topic)
    seen.add(topic)
    const bodyStart = current.line.end
    const bodyEnd = i + 1 < headings.length ? headings[i + 1].line.start : content.length
    const body = content.slice(bodyStart, bodyEnd).replace(/(?:\r?\n)+$/, '')
    const text = automatic ? decodeNote(body) : body.trim()
    if (!text.trim()) throw new MarkdownMemoryError('bad_format', '主题“' + topic + '”没有正文')
    if (isSensitiveMemoryContent(topic + ' ' + text)) {
      throw new MarkdownMemoryError('sensitive', '记忆文档包含敏感内容，拒绝读取')
    }
    entries.push({ topic, text })
  }
  return { prefix, entries }
}

function validateStoredEntry(id, entry) {
  const book = new MemoryBook({}, {
    maxNotesPerMember: MAX_AUTOMATIC_NOTES,
    maxNoteChars: MAX_AUTOMATIC_NOTE_CHARS,
  })
  // MemoryBook's default object prototype treats names such as "constructor" as
  // inherited members. A null prototype keeps arbitrary WeChat ids isolated.
  book.members = Object.create(null)
  const evidence = { id: 'markdown-memory-validation', sender: { id, name: id }, text: '记忆文档中的已保存内容' }
  const result = book.apply([{
    who: id,
    topic: entry.topic,
    note: entry.text,
    evidence: evidence.id,
  }], [evidence])
  if (result.rejected.length) {
    const problem = result.rejected[0].problem
    throw new MarkdownMemoryError(problem, '自动记忆主题或正文不符合 MemoryBook 规则：' + problem)
  }
}

function parseDocument(content, expectedId) {
  const lines = linesWithOffsets(content)
  if (lines.length < 7 || lines[0].text !== TITLE || lines[1].text !== '' || lines[3].text !== '' || lines[4].text !== MANUAL_HEADING) {
    throw new MarkdownMemoryError('bad_format', '记忆文档格式错误：缺少固定标题或分区')
  }
  const idMatch = /^<!-- dsh-memory-id: (.+) -->$/.exec(lines[2].text)
  if (!idMatch) throw new MarkdownMemoryError('bad_format', '记忆文档格式错误：缺少用户 id header')
  let actualId
  try { actualId = JSON.parse(idMatch[1]) } catch {
    throw new MarkdownMemoryError('bad_format', '记忆文档格式错误：用户 id header 不是有效 JSON')
  }
  if (typeof actualId !== 'string') throw new MarkdownMemoryError('bad_format', '记忆文档格式错误：用户 id header 类型错误')
  if (actualId !== expectedId) throw new MarkdownMemoryError('id_mismatch', '记忆路径中的用户 id 与文档 header 不一致')
  const autoHeadings = lines.filter((line, index) => index > 4 && line.text === AUTOMATIC_HEADING)
  if (autoHeadings.length !== 1) throw new MarkdownMemoryError('bad_format', '记忆文档必须且只能有一个自动记忆区')
  const autoHeading = autoHeadings[0]
  if (autoHeading.start < lines[4].end) throw new MarkdownMemoryError('bad_format', '记忆文档分区顺序错误')
  const manualRaw = content.slice(lines[4].end, autoHeading.start)
  const automaticRaw = content.slice(autoHeading.end)
  const manual = splitEntries(manualRaw)
  const automatic = splitEntries(automaticRaw, { automatic: true }).entries
  if (manual.prefix && isSensitiveMemoryContent(manual.prefix)) {
    throw new MarkdownMemoryError('sensitive', '人工补充区包含敏感内容，拒绝读取')
  }
  if (automatic.length > MAX_AUTOMATIC_NOTES) {
    throw new MarkdownMemoryError('too_many_notes', '自动记忆超过每人 ' + MAX_AUTOMATIC_NOTES + ' 条上限')
  }
  for (const entry of automatic) validateStoredEntry(expectedId, entry)
  return {
    id: actualId,
    manualRaw,
    manualNotes: manual.prefix ? [{ topic: '人工补充', text: manual.prefix }, ...manual.entries] : manual.entries,
    automatic,
    eol: lines[0].eol || '\n',
  }
}

function renderDocument(id, parsed) {
  const eol = parsed.eol || '\n'
  const manualRaw = parsed.manualRaw ?? eol
  const automatic = parsed.automatic.map(entry => '### ' + encodeTopic(entry.topic) + eol + encodeNote(entry.text, eol)).join(eol + eol)
  const result = [
    TITLE,
    '',
    markdownIdLine(id),
    '',
    MANUAL_HEADING,
  ].join(eol) + eol + manualRaw + AUTOMATIC_HEADING + eol + (automatic ? automatic + eol : '')
  const size = Buffer.byteLength(result, 'utf8')
  if (size > MAX_DOCUMENT_BYTES) {
    throw new MarkdownMemoryError('document_too_large', '记忆文档将超过 ' + MAX_DOCUMENT_BYTES + ' 字节上限')
  }
  return result
}

async function readOptional(path, id) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new MarkdownMemoryError('document_too_large', '记忆文档超过 ' + MAX_DOCUMENT_BYTES + ' 字节上限')
  }
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new MarkdownMemoryError('bad_encoding', '记忆文档不是有效 UTF-8')
  }
  return { bytes, content, hash: sha256(bytes), parsed: parseDocument(content, id) }
}

function rejected(update, problem) {
  return { update, problem }
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return []
  return evidence.filter(item => item && typeof item === 'object' &&
    typeof item.id === 'string' && typeof item.text === 'string' &&
    item.sender && typeof item.sender === 'object' && typeof item.sender.id === 'string')
}

async function writeTemp(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.' + randomUUID() + '.tmp'
  let handle
  try {
    handle = await open(temp, 'wx')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    return temp
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await open(dirname(path), 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function createNoClobber(path, content) {
  const temp = await writeTemp(path, content)
  try {
    try {
      await link(temp, path)
      await syncDirectory(path)
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function replaceIfUnchanged(path, content, expectedHash) {
  const temp = await writeTemp(path, content)
  try {
    for (let attempt = 0; ; attempt++) {
      const current = await readFile(path).then(bytes => sha256(bytes), error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (current !== expectedHash) return false
      try {
        await rename(temp, path)
        await syncDirectory(path)
        return true
      } catch (error) {
        if (error.code === 'ENOENT') {
          const after = await readFile(path).then(bytes => sha256(bytes), readError => {
            if (readError.code === 'ENOENT') return null
            throw readError
          })
          if (after !== expectedHash) return false
        }
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
      }
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function removeEmptyDirectories(path, chatDirectory) {
  const memberDirectory = dirname(path)
  try { await rmdir(memberDirectory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
  if (memberDirectory !== chatDirectory) {
    try { await rmdir(chatDirectory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
  }
}

function notesFromDocument(parsed) {
  const notes = {}
  for (const entry of parsed.automatic) setOwn(notes, entry.topic, entry.text)
  for (const entry of parsed.manualNotes) setOwn(notes, entry.topic, entry.text)
  return notes
}

function updateAutomatic(automatic, updates) {
  const next = automatic.map(entry => ({ ...entry }))
  const applied = []
  const rejected = []
  let changed = false
  for (const update of updates) {
    const topic = update.topic.trim()
    if (update.note === null) {
      const index = next.findIndex(entry => entry.topic === topic)
      if (index >= 0) {
        next.splice(index, 1)
        changed = true
      }
      applied.push(update)
      continue
    }

    // Resolve merge sources against exact topic strings currently present in
    // the automatic section. Work on a candidate so any rejection leaves all
    // source notes intact.
    const candidate = next.map(entry => ({ ...entry }))
    const mergeTopics = update.mergeTopics ?? []
    if (mergeTopics.some(mergeTopic => !candidate.some(entry => entry.topic === mergeTopic))) {
      rejected.push({ update, problem: 'merge_topic_not_found' })
      continue
    }
    if (mergeTopics.length) {
      const sources = new Set(mergeTopics)
      for (let index = candidate.length - 1; index >= 0; index--) {
        if (sources.has(candidate[index].topic)) candidate.splice(index, 1)
      }
    }
    const index = candidate.findIndex(entry => entry.topic === topic)
    if (index < 0 && candidate.length >= MAX_AUTOMATIC_NOTES) {
      rejected.push({ update, problem: 'memory_full' })
      continue
    }
    const entry = { topic: update.topic.trim(), text: update.note.trim() }
    if (index >= 0) candidate.splice(index, 1)
    candidate.push(entry)
    next.splice(0, next.length, ...candidate)
    changed = true
    applied.push(update)
  }
  return { next, changed, applied, rejected }
}

function validStoredEntries(id, notes) {
  if (notes === undefined) return []
  if (!Array.isArray(notes)) throw new MarkdownMemoryError('bad_legacy_memory', '旧记忆成员的 notes 必须是数组')
  if (notes.length > MAX_AUTOMATIC_NOTES) {
    throw new MarkdownMemoryError('too_many_notes', '旧记忆超过每人 ' + MAX_AUTOMATIC_NOTES + ' 条上限，拒绝迁移')
  }
  const entries = []
  const seen = new Set()
  for (const note of notes) {
    if (!note || typeof note.topic !== 'string' || typeof note.text !== 'string') {
      throw new MarkdownMemoryError('bad_legacy_note', '旧记忆包含格式无效的 note，拒绝迁移')
    }
    const entry = { topic: note.topic.trim(), text: note.text.trim() }
    validateStoredEntry(id, entry)
    if (seen.has(entry.topic)) throw new MarkdownMemoryError('bad_legacy_note', '旧记忆包含重复主题，拒绝迁移：' + entry.topic)
    seen.add(entry.topic)
    entries.push(entry)
  }
  return entries
}

export class MarkdownMemoryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MarkdownMemoryError'
    this.code = code
  }
}

export class MarkdownMemory {
  #chains = new Map()
  #inflight = new Set()

  constructor(root, chatKey) {
    if (typeof root !== 'string' || !root) throw new TypeError('root 必须是插件 dataDir 路径')
    if (typeof chatKey !== 'string' || !/^[a-f0-9]{24}$/.test(chatKey)) {
      throw new MarkdownMemoryError('bad_chat_key', 'chatKey 必须是 store.chatPath(chatId) 的 24 位十六进制文件名')
    }
    this.root = root
    this.chatKey = chatKey
    this.chatDirectory = join(root, 'memories', chatKey)
  }

  memoryPath(id) {
    assertId(id)
    return join(this.chatDirectory, idDirectory(id), 'MEMORY.md')
  }

  async context(ids) {
    if (!Array.isArray(ids)) throw new TypeError('ids 必须是数组')
    const notes = {}, documents = {}, versions = {}
    for (const id of new Set(ids)) {
      assertId(id)
      const stored = await readOptional(this.memoryPath(id), id)
      setOwn(versions, id, stored?.hash ?? null)
      if (!stored) continue
      if (!stored.parsed.automatic.length && !stored.parsed.manualNotes.length && !stored.parsed.manualRaw.trim()) continue
      setOwn(documents, id, stored.content)
      const memberNotes = notesFromDocument(stored.parsed)
      if (Object.keys(memberNotes).length) setOwn(notes, id, memberNotes)
    }
    return { notes, documents, versions }
  }

  async apply(updates, evidence, versions = {}) {
    const book = new MemoryBook({}, {
      maxNotesPerMember: MAX_AUTOMATIC_NOTES,
      maxNoteChars: MAX_AUTOMATIC_NOTE_CHARS,
    })
    const checked = book.validate(Array.isArray(updates) ? updates : [], normalizeEvidence(evidence))
    const applied = []
    const rejectedUpdates = [...checked.rejected]
    const byId = new Map()
    for (const update of checked.valid) {
      const list = byId.get(update.who) ?? []
      list.push(update)
      byId.set(update.who, list)
    }

    const pending = []
    for (const [id, memberUpdates] of byId) {
      // Enqueue every member synchronously before awaiting any one file. This
      // gives later operations (such as forget) a consistent place in each
      // per-file chain even when this batch spans multiple ids.
      pending.push(this.#serialize(this.memoryPath(id), async path => {
        if (!Object.hasOwn(versions ?? {}, id)) return { problem: 'version_missing', updates: memberUpdates }
        const expected = versions[id]
        if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) {
          return { problem: 'bad_version', updates: memberUpdates }
        }
        const stored = await readOptional(path, id)
        if ((stored?.hash ?? null) !== expected) return { problem: 'version_conflict', updates: memberUpdates }
        const parsed = stored?.parsed ?? {
          id,
          manualRaw: '\n',
          manualNotes: [],
          automatic: [],
          eol: '\n',
        }
        const permitted = []
        const localRejected = []
        const manualTopics = new Set(parsed.manualNotes.map(entry => entry.topic))
        for (const update of memberUpdates) {
          if (manualTopics.has(update.topic.trim()) || (update.mergeTopics ?? []).some(topic => manualTopics.has(topic))) {
            localRejected.push(rejected(update, 'manual_note_conflict'))
          } else {
            permitted.push(update)
          }
        }
        if (!permitted.length) return { applied: [], rejected: localRejected }
        const changed = updateAutomatic(parsed.automatic, permitted)
        localRejected.push(...changed.rejected)
        if (!changed.applied.length) return { applied: [], rejected: localRejected }
        if (!changed.changed) return { applied: changed.applied, rejected: localRejected }
        parsed.automatic = changed.next
        let content
        try {
          content = renderDocument(id, parsed)
        } catch (error) {
          if (error.code === 'document_too_large') {
            return { problem: error.code, updates: changed.applied, rejected: localRejected }
          }
          throw error
        }
        const written = stored
          ? await replaceIfUnchanged(path, content, stored.hash)
          : await createNoClobber(path, content)
        if (!written) return { problem: 'version_conflict', updates: changed.applied, rejected: localRejected }
        return { applied: changed.applied, rejected: localRejected }
      }))
    }

    const results = await Promise.all(pending)
    for (const result of results) {
      rejectedUpdates.push(...(result?.rejected ?? []))
      if (result?.problem) {
        for (const update of result.updates ?? []) rejectedUpdates.push(rejected(update, result.problem))
      } else {
        applied.push(...(result?.applied ?? []))
      }
    }

    return { applied, rejected: rejectedUpdates }
  }

  async forget(id, topic) {
    assertId(id)
    const path = this.memoryPath(id)
    return this.#serialize(path, async () => {
      const stored = await readOptional(path, id)
      if (!stored) return 0
      if (topic === undefined) {
        const removed = stored.parsed.automatic.length + stored.parsed.manualNotes.length
        const latest = await readFile(path).then(bytes => sha256(bytes), error => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (latest !== stored.hash) throw new MarkdownMemoryError('version_conflict', '记忆文档在删除期间被手工修改')
        try {
          await unlink(path)
          await syncDirectory(path)
          await removeEmptyDirectories(path, this.chatDirectory)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        return removed
      }
      const before = stored.parsed.automatic.length
      const automatic = stored.parsed.automatic.filter(entry => entry.topic !== topic)
      const removed = before - automatic.length
      if (!removed) return 0
      const parsed = { ...stored.parsed, automatic }
      const manualHasContent = stored.parsed.manualNotes.length > 0 || stored.parsed.manualRaw.trim().length > 0
      if (!automatic.length && !manualHasContent) {
        const latest = await readFile(path).then(bytes => sha256(bytes), error => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (latest !== stored.hash) throw new MarkdownMemoryError('version_conflict', '记忆文档在删除期间被手工修改')
        try {
          await unlink(path)
          await removeEmptyDirectories(path, this.chatDirectory)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        return removed
      }
      const content = renderDocument(id, parsed)
      const written = await replaceIfUnchanged(path, content, stored.hash)
      if (!written) throw new MarkdownMemoryError('version_conflict', '记忆文档在删除期间被手工修改')
      return removed
    })
  }

  async migrate(legacy) {
    const members = legacy?.members
    if (members === undefined) return { imported: 0, skipped: 0 }
    if (!members || typeof members !== 'object' || Array.isArray(members)) {
      throw new MarkdownMemoryError('bad_legacy_memory', '旧记忆格式必须包含对象 memory.members')
    }
    let imported = 0
    let skipped = 0
    for (const [id, member] of Object.entries(members)) {
      assertId(id)
      if (!member || typeof member !== 'object' || Array.isArray(member)) {
        throw new MarkdownMemoryError('bad_legacy_member', '旧记忆成员格式错误，拒绝迁移：' + id)
      }
      const notes = validStoredEntries(id, member?.notes)
      if (!notes.length) continue
      const path = this.memoryPath(id)
      const created = await this.#serialize(path, async () => {
        try {
          await stat(path)
          return false
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        const parsed = { id, manualRaw: '\n', manualNotes: [], automatic: notes, eol: '\n' }
        return createNoClobber(path, renderDocument(id, parsed))
      })
      if (created) imported += notes.length
      else skipped++
    }
    return { imported, skipped }
  }

  async count() {
    let directories
    try {
      directories = await readdir(this.chatDirectory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return 0
      throw error
    }
    let total = 0
    for (const directory of directories) {
      if (!directory.isDirectory()) continue
      try {
        const info = await stat(join(this.chatDirectory, directory.name, 'MEMORY.md'))
        if (info.isFile()) total++
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return total
  }

  async flush() {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight])
  }

  #serialize(path, task) {
    const previous = this.#chains.get(path) ?? Promise.resolve()
    const run = previous.then(() => task(path))
    const tail = run.catch(() => {})
    this.#chains.set(path, tail)
    this.#inflight.add(run)
    const cleanup = () => {
      this.#inflight.delete(run)
      if (this.#chains.get(path) === tail) this.#chains.delete(path)
    }
    run.then(cleanup, cleanup)
    return run
  }
}

export const MARKDOWN_MEMORY_LIMITS = Object.freeze({
  maxBytes: MAX_DOCUMENT_BYTES,
  maxAutomaticNotes: MAX_AUTOMATIC_NOTES,
  maxNoteChars: MAX_AUTOMATIC_NOTE_CHARS,
})
