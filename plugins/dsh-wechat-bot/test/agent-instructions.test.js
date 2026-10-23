import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentInstructions } from '../lib/agent-instructions.js'

const MAX_INSTRUCTIONS_BYTES = 24 * 1024

async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-instructions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeInstructions(root, role, content) {
  const directory = join(root, 'model-agents', role)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'AGENTS.md'), content)
}

function isInvalidInstructions(error) {
  return error?.code === 'agent_instructions_invalid' && error.retryable === false
}

test('the production reply path is fixed next to the loader module', async () => {
  const expected = await readFile(new URL('../lib/model-agents/reply/AGENTS.md', import.meta.url), 'utf8')
  assert.equal(loadAgentInstructions('reply'), expected)
})

test('agent instruction loader reads each exact role file afresh', async t => {
  const root = await rootFor(t)
  await writeInstructions(root, 'reply', '第一次回复规则\n')
  await writeInstructions(root, 'memory', '记忆整理规则\n')

  assert.equal(loadAgentInstructions('reply', { root }), '第一次回复规则\n')
  assert.equal(loadAgentInstructions('memory', { root }), '记忆整理规则\n')

  await writeInstructions(root, 'reply', '刚刚编辑过的回复规则\n')
  assert.equal(loadAgentInstructions('reply', { root }), '刚刚编辑过的回复规则\n', 'the loader does not cache prior contents')
})

test('agent instruction loader never searches a parent directory', async t => {
  const outer = await rootFor(t)
  const root = join(outer, 'lib')
  await writeInstructions(outer, 'reply', '父目录里的规则不能代替缺失文件')

  assert.throws(() => loadAgentInstructions('reply', { root }), isInvalidInstructions)
})

test('agent instruction loader rejects unsupported roles, missing and empty files', async t => {
  const root = await rootFor(t)
  assert.throws(() => loadAgentInstructions('unknown', { root }), isInvalidInstructions)
  assert.throws(() => loadAgentInstructions('../reply', { root }), isInvalidInstructions)
  assert.throws(() => loadAgentInstructions('reply', { root }), isInvalidInstructions)

  await writeInstructions(root, 'reply', ' \r\n\t ')
  assert.throws(() => loadAgentInstructions('reply', { root }), isInvalidInstructions)
})

test('agent instruction loader rejects invalid UTF-8 and files larger than 24 KiB', async t => {
  const root = await rootFor(t)
  const directory = join(root, 'model-agents', 'reply')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'AGENTS.md')

  await writeFile(path, Buffer.from([0xc3, 0x28]))
  assert.throws(() => loadAgentInstructions('reply', { root }), isInvalidInstructions)

  const atLimit = Buffer.alloc(MAX_INSTRUCTIONS_BYTES, 0x61)
  await writeFile(path, atLimit)
  assert.equal(loadAgentInstructions('reply', { root }).length, MAX_INSTRUCTIONS_BYTES)

  await writeFile(path, Buffer.alloc(MAX_INSTRUCTIONS_BYTES + 1, 0x61))
  assert.throws(() => loadAgentInstructions('reply', { root }), isInvalidInstructions)
})
