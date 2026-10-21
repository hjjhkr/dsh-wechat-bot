import { createHash } from 'node:crypto'

export const batchDefaults = Object.freeze({
  batchQuietMs: 2000, batchMaxWaitMs: 8000, batchMaxMessages: 20, batchMaxChars: 8000,
  memoryEnabled: false, retentionMs: 30 * 60 * 1000,
})

export function selectBatch(inbox, config) {
  const pending = inbox.filter(m => m.status === 'received')
    .sort((a, b) => a.sortSeq - b.sortSeq || a.key.localeCompare(b.key))
  const result = []
  let chars = 0
  for (const entry of pending) {
    if (entry.text.length > config.batchMaxChars) throw new Error('batch_message_too_large')
    if (result.length === config.batchMaxMessages || chars + entry.text.length > config.batchMaxChars) break
    result.push(entry)
    chars += entry.text.length
  }
  return result
}

export function batchId(entries) {
  return createHash('sha256').update(JSON.stringify(entries.map(m => m.key))).digest('hex')
}

export function batchInput(entries) {
  if (entries.length === 1 && entries[0].kind === 'idle') {
    return JSON.stringify({ event: { kind: 'idle_check', timestamp: entries[0].timestamp }, messages: [] })
  }
  return JSON.stringify({ messages: entries.map((m, i) => ({
    id: String(i + 1), timestamp: m.timestamp, text: m.text,
    ...(m.senderName !== undefined ? { senderId: m.senderId, senderName: m.senderName } : {}),
    ...(typeof m.mentionedBot === 'boolean' ? { mentionedBot: m.mentionedBot } : {}),
  })) })
}

// Actual v0.1.0–0.1.3 records used one incomingKey; retain their audit semantics.
export function incomingKeys(record) {
  return record.incomingKeys ?? [record.incomingKey]
}
