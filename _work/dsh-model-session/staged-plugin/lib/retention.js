import { incomingKeys } from './batch.js'

// Retire content only after the batch's memory transaction and file publication.
// Uncertain attempts remain intact until explicitly reconciled.
export function compactState(state, config, now = Date.now()) {
  const cutoff = now - config.retentionMs
  const protectedKeys = new Set(state.outbox.filter(o => ['attempted', 'ambiguous'].includes(o.status)).flatMap(incomingKeys))
  for (const entry of state.inbox) {
    if (protectedKeys.has(entry.key) || !['drafted', 'delivered', 'skipped'].includes(entry.status)) continue
    const at = Date.parse(entry.receivedAt ?? entry.draftAt ?? '')
    const ready = entry.memoryPublishedAt || (entry.status === 'skipped' && entry.decision !== 'silent')
    if (!ready || !Number.isFinite(at) || at > cutoff) continue
    delete entry.text
    delete entry.draft
    entry.purgedAt ??= new Date(now).toISOString()
  }
  const purged = new Set(state.inbox.filter(e => e.purgedAt).map(e => e.key))
  for (const record of state.outbox) {
    if (['attempted', 'ambiguous'].includes(record.status)) continue
    if (incomingKeys(record).every(key => purged.has(key))) {
      delete record.text
      record.purgedAt ??= new Date(now).toISOString()
    }
  }
  // Keep overlap tombstones; older poll pages cannot resurrect expired messages.
  const boundary = Math.max(0, (state.cursor?.sortSeq ?? 0) - config.overlapSeq)
  state.retiredBeforeSeq = Math.max(state.retiredBeforeSeq ?? 0, boundary)
  state.inbox = state.inbox.filter(e => !e.purgedAt || e.sortSeq >= boundary)
  const retired = state.outbox.filter(o => o.purgedAt)
  const keep = new Set(retired.slice(-200).map(o => o.attemptId))
  state.outbox = state.outbox.filter(o => !o.purgedAt || keep.has(o.attemptId))
}
