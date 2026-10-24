import { readFileSync } from 'node:fs'

// Role instructions put in front of each model call's system prompt
// (lib/model-agents/<role>/AGENTS.md). Read once, when the plugin loads.
const read = role => readFileSync(new URL(`./model-agents/${role}/AGENTS.md`, import.meta.url), 'utf8')
const INSTRUCTIONS = { reply: read('reply'), memory: read('memory') }

export function loadAgentInstructions(role) {
  return INSTRUCTIONS[role]
}
