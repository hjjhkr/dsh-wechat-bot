import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadAgentInstructions } from './agent-instructions.js'

export class ModelError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ModelError'
    this.code = code
  }
}

function toLlmMessages(messages, route) {
  return messages.map(({ role, text }) => role === 'assistant'
    ? createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: route.provider, model: route.model } })
    : createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

async function streamText(llm, request, onChunk) {
  let text = ''
  let finish
  for await (const chunk of llm.stream(request)) {
    onChunk?.(chunk)
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind !== 'stop') {
    const failure = finish?.failure
    throw new ModelError(`model_${finish?.kind ?? 'unfinished'}`, failure && [failure.code, failure.message].filter(Boolean).join(' '))
  }
  return text
}

// What the DSH session shows for a call: the readable batch plus the exact
// JSON the model received, or just the correction on a retry.
function shownFor(readable, messages) {
  if (messages.length > 1) return messages.at(-1).text
  return `${readable}\n\n模型收到的输入：\n${messages[0].text}`
}

/**
 * Builds the ChatRunner `think` function on top of the DSH `llm` service.
 * @param {object} o
 * @param {object} o.llm                 ctx.llm
 * @param {() => {provider, model, maxTokens, reasoningEffort}} o.route
 * @param {(chat) => Promise<import('./session.js').ChatSession | undefined>} [o.mirror]
 */
export function createThink({ llm, route, mirror, role }) {
  return async ({ chat, system, messages, readable, effort, signal }) => {
    const r = route()
    const reasoningEffort = effort ?? r.reasoningEffort
    const request = {
      provider: r.provider, model: r.model, reasoningEffort,
      system: role ? `${loadAgentInstructions(role)}\n\n${system}` : system,
      messages: toLlmMessages(messages, r),
      // Thinking tokens share the budget, so a deliberate answer gets more room.
      maxTokens: reasoningEffort === 'off' ? r.maxTokens : r.maxTokens * 8,
    }
    const call = ({ signal: callSignal, onChunk }) => streamText(llm, { ...request, signal: callSignal }, onChunk)
    const session = await mirror?.(chat)
    return session ? session.run(shownFor(readable, messages), call, signal) : call({ signal })
  }
}
