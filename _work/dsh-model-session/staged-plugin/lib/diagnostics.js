import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { batchInput } from './batch.js'
import { generateReply, ModelError } from './model.js'
import { applyMemory, memoryContext, memoryInstructions, newMemory, parseMemoryReply, publishMemory } from './memory.js'

// Fixed synthetic users only. No worker, real conversation state or send capability.
export async function testBatchMemory(llm, { config, persona, signal, activity }) {
  const work = join(config.stateRoot, '_work')
  await mkdir(work, { recursive: true })
  const root = await mkdtemp(join(work, 'memory-check-'))
  try {
    const worker = { botWxid: 'synthetic_bot', targetWxid: 'synthetic_user', targetName: '测试用户' }
    const entries = [
      { key: 'synthetic-1', timestamp: Math.floor(Date.now() / 1000), text: '请记住：以后称呼我小松。' },
      { key: 'synthetic-2', timestamp: Math.floor(Date.now() / 1000), text: '把这两条消息合起来简短回一句。' },
    ]
    const first = await generateReply(llm, { persona: persona + '\n' + memoryInstructions,
      incoming: batchInput(entries), config, signal, activity })
    const parsed = parseMemoryReply(first.reply, entries)
    const document = applyMemory(newMemory(worker), parsed.updates, entries)
    if (!JSON.stringify(memoryContext(document)).includes('小松')) throw new ModelError('model_memory_not_captured')
    await publishMemory(root, document)
    const reloaded = JSON.parse(await readFile(join(root, 'memory', worker.botWxid, `${worker.targetWxid}.json`), 'utf8'))
    const secondEntries = [{ key: 'synthetic-3', timestamp: Math.floor(Date.now() / 1000), text: '我让你以后怎么称呼我？只回答称呼，不要新增记忆。' }]
    const input = { ...JSON.parse(batchInput(secondEntries)), rememberedUserFacts: memoryContext(reloaded) }
    const second = await generateReply(llm, { persona: persona + '\n' + memoryInstructions,
      incoming: JSON.stringify(input), history: [], config, signal, activity })
    const recalled = parseMemoryReply(second.reply, secondEntries)
    if (!recalled.reply.includes('小松')) throw new ModelError('model_memory_recall_failed')
    return { success: true, mode: 'batch-memory', modelCalls: 2, inputMessageCount: 2,
      firstReply: parsed.reply, recalledReply: recalled.reply, persistedMemoryReadback: true,
      secondTurnHistoryCount: 0, provider: config.provider, model: config.model,
      reasoningEffort: 'off', sentToWeChat: false, realUserMemoryModified: false }
  } finally {
    const actual = await realpath(root)
    if (dirname(actual).toLowerCase() !== (await realpath(work)).toLowerCase() ||
      !basename(actual).startsWith('memory-check-')) throw new Error('diagnostic_cleanup_path_invalid')
    await rm(root, { recursive: true, force: true })
  }
}
