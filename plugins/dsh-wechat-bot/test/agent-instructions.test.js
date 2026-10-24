import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAgentInstructions } from '../lib/agent-instructions.js'

test('each model role has its instructions, put in front of the system prompt', () => {
  assert.match(loadAgentInstructions('reply'), /^# 微信回复决策/)
  assert.match(loadAgentInstructions('memory'), /^# 微信成员记忆/)
})
