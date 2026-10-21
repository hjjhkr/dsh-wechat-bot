import { createAssistantMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { batchInput, incomingKeys } from './batch.js'

export class ModelError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ModelError'
    this.code = code
  }
}

export async function generateReply(llm, options) {
  if (options.activity) return options.activity.run(options, controls => generateUnobserved(llm, { ...options, ...controls }))
  return generateUnobserved(llm, options)
}

async function generateUnobserved(llm, { persona, incoming, history = [], config, signal, onChunk }) {
  const messages = [...history, {
    role: 'user',
    content: [{ type: 'text', text: incoming }],
  }]
  let text = ''
  let finish
  try {
    for await (const chunk of llm.stream({
      provider: config.provider,
      model: config.model,
      reasoningEffort: 'off',
      system: persona,
      messages,
      maxTokens: Math.min(config.maxTokens, 512),
      signal,
    })) {
      onChunk?.(chunk)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'finish') finish = chunk.reason
    }
  } catch {
    throw new ModelError('model_request_failed')
  }
  if (!finish || finish.kind !== 'stop') throw new ModelError('model_finish_not_stop')
  const reply = text.trim()
  if (!reply) throw new ModelError('model_reply_empty')
  return { reply, finish: finish.kind }
}

export function buildHistory(state, historyTurns, currentKey, config) {
  const entries = [...state.inbox].sort((a, b) => Number(a.sortSeq) - Number(b.sortSeq) || String(a.key).localeCompare(String(b.key)))
  const turns = []
  const seenBatches = new Set()
  for (const entry of entries) {
    if (entry.status === 'skipped' && entry.decision !== 'silent') continue
    if (entry.key === currentKey) break
    if (entry.batchId && seenBatches.has(entry.batchId)) continue
    const userContent = typeof entry.text === 'string' ? entry.text : ''
    if (!userContent) continue
    const batchEntries = entry.batchId ? entries.filter(m => m.batchId === entry.batchId && typeof m.text === 'string') : [entry]
    if (entry.batchId) seenBatches.add(entry.batchId)
    turns.push({ role: 'user', content: [{ type: 'text', text: entry.batchId ? batchInput(batchEntries) : userContent }] })
    if (entry.decision === 'silent') {
      const silent = createAssistantMessage({
        content: [{ type: 'text', text: JSON.stringify({ reply: null, memory: [] }) }],
        source: { provider: config.provider, model: config.model },
      })
      turns.push(freezeMessage({ ...silent, id: entry.batchId }))
      continue
    }
    const reply = state.outbox.find((item) => incomingKeys(item).includes(entry.key) && item.status === 'delivered')
    if (reply?.text) {
      if (typeof reply.attemptId !== 'string' || reply.attemptId.length === 0) {
        throw new ModelError('history_reply_missing_attempt_id')
      }
      if (typeof config?.provider !== 'string' || !config.provider || typeof config?.model !== 'string' || !config.model) {
        throw new ModelError('history_model_route_missing')
      }
      const assistant = createAssistantMessage({
        // Replay the same wire format requested for this turn. Memory updates
        // are not replayed: current authoritative facts arrive in user context.
        content: [{ type: 'text', text: config.memoryEnabled
          ? JSON.stringify({ reply: reply.text, memory: [] })
          : reply.text }],
        source: { provider: config.provider, model: config.model },
      })
      turns.push(freezeMessage({ ...assistant, id: reply.attemptId }))
    }
  }
  return turns.slice(-historyTurns * 2)
}
