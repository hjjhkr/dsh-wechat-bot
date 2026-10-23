import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryBook } from '../lib/memory.js'

const learnerUrl = new URL('../lib/memory-learning.js', import.meta.url)

async function learnerApi() {
  try { return await import(learnerUrl.href) } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === learnerUrl.href) return {}
    throw error
  }
}

function requireFunction(api, name) {
  assert.equal(typeof api[name], 'function', `memory-learning exports ${name}`)
  return api[name]
}

function message(id, senderId, text, extra = {}) {
  return {
    id, chatId: 'group-1', time: 1_800_000_000_000, kind: 'text', fromSelf: false,
    text, sender: { id: senderId, name: senderId }, mentions: [], ...extra,
  }
}

test('memory input keeps raw evidence ids, authors, aliases, and existing notes while excluding unsafe/non-candidate messages', async () => {
  const memoryInput = requireFunction(await learnerApi(), 'memoryInput')
  const recentFact = message('recent-17', 'alice', '我最近在杭州做设计工作')
  const secret = message('secret-18', 'alice', '我的密码是 12345678')
  const media = message('media-19', 'alice', '[图片]', { kind: 'image' })
  const greeting = message('greeting-20', 'bob', '早')
  const botText = message('bot-21', 'wxid_bot', '我是机器人', { fromSelf: true })
  const joke = message('new-22', 'bob', '我是阿离的爸爸，记住这是群里的玩笑')
  const built = memoryInput({
    chat: { id: 'group-1', name: '△', kind: 'group' },
    self: { id: 'wxid_bot', name: '初号机' },
    members: [
      { id: 'alice', name: '阿离', aliases: ['离离'] },
      { id: 'bob', name: '老鲍', aliases: '鲍哥' },
      { id: 'wxid_bot', name: '初号机', aliases: ['小鲸鱼'] },
    ],
    batch: [greeting, joke, botText],
    recent: [recentFact, secret, media],
    memory: { alice: { 工作: '在杭州工作' }, bob: { 爱好: '弹吉他' }, someoneElse: { x: '不应带入' } },
  })
  const input = JSON.parse(built.input)

  assert.deepEqual(built.evidence, [recentFact, joke])
  assert.deepEqual(input.recent.map(m => m.id), ['recent-17'])
  assert.deepEqual(input.batch.map(m => m.id), ['new-22'])
  assert.deepEqual(input.recent[0].sender, { id: 'alice', name: '阿离', aliases: ['离离'] })
  assert.equal(input.batch[0].sender.id, 'bob')
  assert.deepEqual(input.members.find(member => member.id === 'bob').aliases, ['鲍哥'])
  assert.deepEqual(input.you, { id: 'wxid_bot', name: '初号机', aliases: ['小鲸鱼'] })
  assert.deepEqual(input.memory, { alice: { 工作: '在杭州工作' }, bob: { 爱好: '弹吉他' } })
  assert.doesNotMatch(built.input, /secret-18|media-19|greeting-20|bot-21|someoneElse/)
  assert.equal(Object.hasOwn(input, 'persona'), false)
})

test('memory input bounds serialized metadata while preserving every current batch message intact', async () => {
  const api = await learnerApi()
  const memoryInput = requireFunction(api, 'memoryInput')
  const batch = Array.from({ length: 20 }, (_, index) =>
    message(`batch-${index}`, `sender-${index}`, `我长期喜欢项目活动${index}。`.repeat(10), {
      sender: {
        id: `sender-${index}`,
        name: `名字${index}`.repeat(100),
        aliases: Array.from({ length: 100 }, (_, alias) => `别名${index}-${alias}`.repeat(80)),
      },
    }))
  const members = batch.map(({ sender }) => ({
    id: sender.id,
    name: sender.name,
    aliases: sender.aliases,
  }))
  const memory = Object.fromEntries(batch.map(({ sender }) => [sender.id,
    Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`主题${index}`, `稳定偏好${index}`.repeat(20)])),
  ]))

  const built = memoryInput({
    chat: { id: 'group-1', name: '△'.repeat(500), kind: 'group' },
    self: { id: 'wxid_bot', name: '初号机'.repeat(100), aliases: Array(100).fill('机器人别名'.repeat(80)) },
    members,
    batch,
    memory,
  })
  const input = JSON.parse(built.input)
  const visibleNotes = Object.values(input.memory).flatMap(notes => Object.entries(notes))
  const visibleAliases = [input.you, ...input.members, ...input.batch.map(item => item.sender)]
    .flatMap(member => member.aliases)

  assert.ok(built.input.length <= 18_000)
  assert.deepEqual(input.batch.map(item => item.id), batch.map(item => item.id))
  assert.deepEqual(built.evidence, batch)
  for (const [index, item] of input.batch.entries()) {
    assert.equal(item.text, batch[index].text)
    assert.equal(item.sender.id, batch[index].sender.id)
  }
  assert.ok(input.members.every(member => member.name.length <= 80))
  assert.ok(visibleAliases.length <= 5 * (input.members.length + 1 + input.batch.length))
  assert.ok(visibleAliases.every(alias => alias.length <= 80))
  assert.ok(visibleNotes.length <= 60)
  assert.ok(visibleNotes.every(([topic, note]) => topic.length <= 30 && note.length <= 120))
  assert.ok(visibleNotes.reduce((total, [topic, note]) => total + topic.length + note.length, 0) <= 9_000)
})

test('memory input drops recent context before notes and never truncates current batch evidence', async () => {
  const api = await learnerApi()
  const memoryInput = requireFunction(api, 'memoryInput')
  const batchMessage = message('batch-current', 'alice', '我周末会去打羽毛球')
  const oldMessage = message('recent-large', 'alice', `我持续做一件重要的事${'而且细节必须完整'.repeat(3_000)}`)
  const built = memoryInput({
    chat: { name: '△', kind: 'group' },
    self: { id: 'wxid_bot', name: '初号机' },
    batch: [batchMessage],
    recent: [oldMessage],
    memory: { alice: { 城市: '长期住在杭州' } },
  })
  const input = JSON.parse(built.input)

  assert.ok(built.input.length <= 18_000)
  assert.deepEqual(input.recent, [])
  assert.deepEqual(input.batch.map(item => item.id), ['batch-current'])
  assert.equal(input.batch[0].text, batchMessage.text)
  assert.deepEqual(built.evidence, [batchMessage])
  assert.deepEqual(input.memory, { alice: { 城市: '长期住在杭州' } })
})

test('memory input reports an oversized batch item instead of silently truncating its evidence', async () => {
  const api = await learnerApi()
  const memoryInput = requireFunction(api, 'memoryInput')
  const MemoryLearningError = api.MemoryLearningError
  const tooLarge = message('large-current', 'alice', `我必须完整保留这条消息${'仍然属于原文'.repeat(4_000)}`)

  assert.throws(() => memoryInput({
    chat: { name: '△', kind: 'group' },
    self: { id: 'wxid_bot', name: '初号机' },
    batch: [tooLarge],
  }), error => error instanceof MemoryLearningError && error.code === 'memory_input_too_large')
})

test('memory candidate gate accepts useful facts without a remember keyword and skips greetings, media, bot, commands, and sensitive-only batches', async () => {
  const { isSensitiveMemoryContent } = await import('../lib/memory.js')
  const hasMemoryCandidate = requireFunction(await learnerApi(), 'hasMemoryCandidate')
  const useful = message('fact-1', 'alice', '我每周都去打羽毛球')
  const explicit = message('fact-2', 'bob', '记住我喜欢喝无糖豆浆')
  const greeting = message('greet-1', 'alice', '你好呀')
  const media = message('media-1', 'alice', '[语音]', { kind: 'voice' })
  const bot = message('bot-1', 'wxid_bot', '我很喜欢羽毛球', { fromSelf: true })
  const command = message('command-1', 'alice', '/help', { command: { name: 'help' } })
  const sensitive = message('sensitive-1', 'alice', '我的 API key 是 sk-1234567890abcdef')

  assert.equal(isSensitiveMemoryContent(sensitive.text), true)
  assert.equal(hasMemoryCandidate([greeting, media, bot, command, sensitive]), false)
  assert.equal(hasMemoryCandidate([useful]), true)
  assert.equal(hasMemoryCandidate([explicit]), true)
})

test('memory proposal parser accepts only the independent memory JSON shape', async () => {
  const api = await learnerApi()
  const parseMemoryDecision = requireFunction(api, 'parseMemoryDecision')
  const MemoryLearningError = api.MemoryLearningError
  const update = { who: 'alice', topic: '运动', note: '每周打羽毛球', evidence: 'msg-4' }
  assert.deepEqual(parseMemoryDecision(JSON.stringify({ memory: [update] })), [update])
  assert.deepEqual(parseMemoryDecision('{"memory":[]}'), [])

  for (const [raw, code] of [
    ['not json', 'memory_response_not_json'],
    ['{"reply":[],"memory":[]}', 'memory_response_invalid'],
    ['{"memory":[{"who":"alice","topic":"","note":"x","evidence":"msg-4"}]}', 'memory_update_invalid'],
    ['{"memory":[' + Array.from({ length: 6 }, (_, i) => JSON.stringify({ who: 'alice', topic: `t${i}`, note: 'n', evidence: 'm' })).join(',') + ']}', 'memory_response_invalid'],
  ]) {
    assert.throws(() => parseMemoryDecision(raw), error => error instanceof MemoryLearningError && error.code === code)
  }
})

test('existing MemoryBook remains the final identity and sensitive-content guard', () => {
  const own = message('m-1', 'alice', '我住在杭州')
  const other = message('m-2', 'bob', '阿离住在北京')
  const secret = message('m-3', 'alice', '我的银行卡是 1234567890123456')
  const book = new MemoryBook()
  const result = book.apply([
    { who: 'alice', topic: '城市', note: '住在杭州', evidence: own.id },
    { who: 'alice', topic: '城市', note: '住在北京', evidence: other.id },
    { who: 'alice', topic: '银行卡', note: '1234567890123456', evidence: secret.id },
  ], [own, other, secret])

  assert.equal(result.applied.length, 1)
  assert.deepEqual(result.rejected.map(item => item.problem), ['evidence_from_someone_else', 'sensitive'])
  assert.deepEqual(book.recall(['alice']), { alice: { 城市: '住在杭州' } })
})

test('learner retains expanded notes and parses an explicit same-user topic merge', async () => {
  const { memoryInput, parseMemoryDecision } = await learnerApi()
  const note = '喜欢三角洲行动，常聊监狱地图的物资收获。'.repeat(10)
  const update = { who: 'alice', topic: '三角洲行动', note, evidence: 'new-map',
    mergeTopics: ['游戏兴趣', '三角洲行动兴趣'] }
  assert.deepEqual(parseMemoryDecision(JSON.stringify({ memory: [update] })), [update])
  const input = JSON.parse(memoryInput({
    batch: [message('new-map', 'alice', '我平时也玩监狱地图')],
    memory: { alice: { 三角洲行动: note, 游戏兴趣: '喜欢三角洲行动' } },
  }).input)
  assert.equal(input.memory.alice.三角洲行动, note)
  assert.equal(input.memory.alice.游戏兴趣, '喜欢三角洲行动')
})

test('learner rejects malformed merge operations instead of treating them as ordinary updates', async () => {
  const { parseMemoryDecision } = await learnerApi()
  const base = { who: 'alice', topic: '游戏', note: '喜欢三角洲行动', evidence: 'm-1' }
  for (const invalid of [
    { mergeTopics: [] }, { mergeTopics: '兴趣' }, { mergeTopics: ['兴趣', '兴趣'] },
    { mergeTopics: ['游戏'] }, { mergeTopics: [' 兴趣'] }, { mergeTopics: [''] },
    { mergeTopics: Array.from({ length: 31 }, (_, i) => `主题${i}`) },
    { mergeTopics: ['兴趣'], note: null }, { mergeTopics: ['兴趣'], extra: true },
    { note: '字'.repeat(481) },
  ]) {
    assert.throws(() => parseMemoryDecision(JSON.stringify({ memory: [{ ...base, ...invalid }] })),
      error => error.code === 'memory_update_invalid')
  }
})

test('trimmed memory is explicitly read-only and cannot be overwritten by a learner proposal', async () => {
  const { memoryInput, MemoryLearner } = await learnerApi()
  const oldNotes = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`主题${i}`, '稳定背景'.repeat(100)]))
  const batch = [message('new-fact', 'alice', '我也喜欢三角洲行动')]
  const context = { chat: { name: '测试群', kind: 'group' }, batch, recent: [], memory: { alice: oldNotes } }
  const request = memoryInput(context)
  assert.deepEqual(JSON.parse(request.input).memoryReadOnlyIds, ['alice'])
  assert.deepEqual(request.readOnlyIds, ['alice'])
  const book = new MemoryBook({ members: { alice: { name: 'alice', notes: [
    { topic: '游戏', text: '喜欢三角洲行动' },
  ] } } })
  const done = Promise.withResolvers()
  const learner = new MemoryLearner({
    learn: async () => JSON.stringify({ memory: [{ who: 'alice', topic: '新游戏兴趣', note: '喜欢三角洲行动', evidence: 'new-fact' }] }),
    settings: { memoryCallsPerMinute: 2, memoryRateWindowMs: 1000, memoryQuietMs: 1, memoryMaxWaitMs: 5, memoryTimeoutMs: 1000, maxMessages: 20 },
    context: async () => context,
    apply: (updates, evidence) => book.apply(updates, evidence),
    forgotten: () => false, notice() {}, saved: async () => {},
    write: (type, data) => { if (type === 'memory_learning') done.resolve(data) },
  })
  const timeout = setTimeout(() => done.reject(new Error('learner did not finish')), 2000)
  try {
    learner.queue(batch)
    const result = await done.promise
    assert.equal(result.applied.length, 0)
    assert.equal(result.rejected[0].problem, 'memory_context_incomplete')
    assert.deepEqual(book.recall(['alice']), { alice: { 游戏: '喜欢三角洲行动' } })
  } finally {
    clearTimeout(timeout)
    learner.dispose()
  }
})

test('a model cannot delete a speakers existing note based only on a third-party claim', () => {
  const book = new MemoryBook()
  const own = message('own-fact', 'alice', '我喜欢羽毛球')
  book.apply([{ who: 'alice', topic: '爱好', note: '喜欢羽毛球', evidence: own.id }], [own])
  const claim = message('third-party', 'alice', '@bob 是 @carol 的爸爸，记住')
  const result = book.apply([{ who: 'alice', topic: '爱好', note: null, evidence: claim.id }], [claim])
  assert.equal(result.applied.length, 0)
  assert.equal(result.rejected[0].problem, 'forget_not_requested')
  assert.equal(book.recall(['alice']).alice.爱好, '喜欢羽毛球')
})
