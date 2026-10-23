import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT_ROLES = new Set(['reply', 'memory'])
const MAX_INSTRUCTIONS_BYTES = 24 * 1024

function invalidInstructions(role, reason) {
  const error = new Error(`agent_instructions_invalid: ${reason}`)
  error.name = 'AgentInstructionsError'
  error.code = 'agent_instructions_invalid'
  error.retryable = false
  error.role = role
  return error
}

function instructionPath(role, root) {
  if (root === undefined) return fileURLToPath(new URL(`./model-agents/${role}/AGENTS.md`, import.meta.url))
  if (typeof root !== 'string' || !root.trim()) throw invalidInstructions(role, 'invalid_root')
  return resolve(root, 'model-agents', role, 'AGENTS.md')
}

/**
 * Read the current role instructions from the one plugin-owned file.
 * The default path is relative to this module; root exists only for isolated tests.
 */
export function loadAgentInstructions(role, options = {}) {
  if (!AGENT_ROLES.has(role)) throw invalidInstructions(role, 'unsupported_role')
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidInstructions(role, 'invalid_options')
  }

  const path = instructionPath(role, options.root)
  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    throw invalidInstructions(role, 'missing_or_unreadable')
  }
  if (bytes.byteLength > MAX_INSTRUCTIONS_BYTES) throw invalidInstructions(role, 'too_large')

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalidInstructions(role, 'invalid_utf8')
  }
  if (!text.trim()) throw invalidInstructions(role, 'empty')
  return text
}
