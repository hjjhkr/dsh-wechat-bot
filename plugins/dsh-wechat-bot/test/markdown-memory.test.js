import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { MarkdownMemory, MarkdownMemoryError, MARKDOWN_MEMORY_LIMITS } from '../lib/markdown-memory.js'
import { MAX_AUTOMATIC_NOTE_CHARS, MemoryBook } from '../lib/memory.js'

const CHAT_A = 'a'.repeat(24)
const CHAT_B = 'b'.repeat(24)

async function memoryFor(t, chatKey = CHAT_A) {
  const root = await mkdtemp(join(tmpdir(), 'markdown-memory-test-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  return { root, memory: new MarkdownMemory(root, chatKey) }
}

function message(id, senderId, text) {
  return { id, sender: { id: senderId, name: senderId }, fromSelf: false, text }
}

function update(who, topic, note, evidence) {
  return { who, topic, note, evidence }
}

function mergeUpdate(who, topic, note, evidence, mergeTopics) {
  return { who, topic, note, evidence, mergeTopics }
}

test('MemoryBook keeps its 120-character default and allows an explicit 480-character limit', () => {
  const source = message('limits', 'alice', '我长期保持这个习惯')
  const defaultBook = new MemoryBook()
  const overDefault = defaultBook.apply([
    update('alice', '习惯', '习'.repeat(121), source.id),
  ], [source])
  assert.equal(overDefault.rejected[0].problem, 'bad_note')

  const extendedBook = new MemoryBook({}, { maxNoteChars: MAX_AUTOMATIC_NOTE_CHARS })
  const extended = extendedBook.apply([
    update('alice', '习惯', '习'.repeat(480), source.id),
  ], [source])
  assert.equal(extended.applied.length, 1)
  assert.equal(extendedBook.recall(['alice']).alice.习惯.length, 480)
})

test('MemoryBook applies only explicit same-member topic merges', () => {
  const book = new MemoryBook({ members: { alice: { name: 'alice', notes: [
    { topic: '兴趣1', text: '喜欢骑车' },
    { topic: '兴趣2', text: '喜欢徒步' },
    { topic: '工作', text: '从事设计工作' },
  ] } } })
  const source = message('merge-book', 'alice', '我喜欢骑车和徒步')
  const merged = book.apply([
    mergeUpdate('alice', '兴趣', '喜欢骑车，也喜欢徒步', source.id, ['兴趣1', '兴趣2']),
  ], [source])
  assert.equal(merged.applied.length, 1)
  assert.deepEqual(book.recall(['alice']), { alice: { 工作: '从事设计工作', 兴趣: '喜欢骑车，也喜欢徒步' } })

  const unknown = message('unknown-book', 'alice', '我喜欢旅行')
  const rejected = book.apply([
    mergeUpdate('alice', '兴趣', '喜欢旅行', unknown.id, ['不存在']),
  ], [unknown])
  assert.equal(rejected.rejected[0].problem, 'merge_topic_not_found')
  assert.deepEqual(book.recall(['alice']), { alice: { 工作: '从事设计工作', 兴趣: '喜欢骑车，也喜欢徒步' } })
})

test('same-member merge proposals with overlapping targets or sources are rejected as a group', async t => {
  const scenarios = [
    {
      topics: ['A', 'B', 'X', 'C', '其他'],
      proposals: [
        evidence => mergeUpdate('alice', 'A', '合并 B', evidence[0].id, ['B']),
        evidence => mergeUpdate('alice', 'C', '合并 A 和 X', evidence[1].id, ['A', 'X']),
      ],
    },
    {
      topics: ['A', 'B', '其他'],
      proposals: [
        evidence => mergeUpdate('alice', 'A', '合并 B', evidence[0].id, ['B']),
        evidence => update('alice', 'B', '更新 B', evidence[1].id),
      ],
    },
  ]

  for (const scenario of scenarios) {
    const notes = scenario.topics.map(topic => ({ topic, text: '原始 ' + topic }))
    const memoryBook = new MemoryBook({ members: {
      alice: { name: 'alice', notes },
      bob: { name: 'bob', notes: [{ topic: '已有', text: '原始 Bob' }] },
    } })
    const beforeBook = memoryBook.recall(['alice'])
    const evidence = scenario.proposals.map((_, index) => message('conflict-' + index, 'alice', '我长期喜欢户外活动'))
    const proposals = scenario.proposals.map(create => create(evidence))
    const bobEvidence = message('conflict-bob', 'bob', '我喜欢咖啡')
    const bobProposal = update('bob', '新偏好', '喜欢咖啡', bobEvidence.id)
    const direct = memoryBook.apply([...proposals, bobProposal], [...evidence, bobEvidence])
    assert.deepEqual(direct.applied, [bobProposal])
    assert.deepEqual(direct.rejected.map(item => item.problem), proposals.map(() => 'merge_conflict'))
    assert.deepEqual(memoryBook.recall(['alice']), beforeBook)
    assert.equal(memoryBook.recall(['bob']).bob.新偏好, '喜欢咖啡')

    const { memory } = await memoryFor(t)
    const initial = await memory.context(['alice', 'bob'])
    const seedEvidence = scenario.topics.map((topic, index) => message('seed-conflict-' + index, 'alice', '我长期保留主题 ' + topic))
    const bobSeed = message('seed-conflict-bob', 'bob', '我喜欢原来的偏好')
    const seedUpdates = scenario.topics.map((topic, index) => update('alice', topic, '原始 ' + topic, seedEvidence[index].id))
    const seeded = await memory.apply([...seedUpdates, update('bob', '已有', '原始 Bob', bobSeed.id)], [...seedEvidence, bobSeed], initial.versions)
    assert.equal(seeded.applied.length, scenario.topics.length + 1)
    const before = await memory.context(['alice', 'bob'])
    const persistent = await memory.apply([...proposals, bobProposal], [...evidence, bobEvidence], before.versions)
    assert.deepEqual(persistent.applied, [bobProposal])
    assert.deepEqual(persistent.rejected.map(item => item.problem), proposals.map(() => 'merge_conflict'))
    const after = await memory.context(['alice', 'bob'])
    assert.deepEqual(after.notes.alice, before.notes.alice)
    assert.equal(after.notes.bob.新偏好, '喜欢咖啡')
  }
})

test('memory files round-trip and stay isolated by chat and user id', async t => {
  const { root, memory } = await memoryFor(t)
  const otherChat = new MarkdownMemory(root, CHAT_B)
  const initial = await memory.context(['alice', 'bob'])

  assert.deepEqual(initial.notes, {})
  assert.deepEqual(initial.documents, {})
  assert.deepEqual(initial.versions, { alice: null, bob: null })
  assert.equal(memory.memoryPath('alice'), join(root, 'memories', CHAT_A, 'id-' + createHash('sha256').update('alice').digest('hex'), 'MEMORY.md'))
  assert.notEqual(memory.memoryPath('wxid_A'), memory.memoryPath('wxid_a'))
  assert.equal(memory.memoryPath('..'), join(root, 'memories', CHAT_A, 'id-' + createHash('sha256').update('..').digest('hex'), 'MEMORY.md'))
  const forgetMissing = message('forget-missing', 'bob', '别记这个主题')
  const noOp = await memory.apply([update('bob', '临时', null, forgetMissing.id)], [forgetMissing], initial.versions)
  assert.equal(noOp.applied.length, 1)
  assert.equal(await memory.count(), 0)
  assert.equal(Object.hasOwn((await memory.context(['bob'])).documents, 'bob'), false)

  const source = message('message-1', 'alice', '我现在住在杭州')
  const pending = memory.apply([update('alice', '城市', '住在杭州', source.id)], [source], initial.versions)
  await memory.flush()
  assert.equal((await pending).applied.length, 1)

  const saved = await memory.context(['alice', 'bob'])
  assert.deepEqual(saved.notes, { alice: { 城市: '住在杭州' } })
  assert.match(saved.documents.alice, /<!-- dsh-memory-id: "alice" -->/)
  assert.doesNotMatch(saved.documents.alice, /message-1|我现在住在杭州/)
  assert.equal(saved.versions.bob, null)
  assert.equal((await otherChat.context(['alice'])).notes.alice, undefined)
  assert.equal(await memory.count(), 1)
})

test('multi-id apply queues every user before a concurrent forget can finish', async t => {
  const { memory } = await memoryFor(t)
  const view = await memory.context(['alice', 'bob'])
  const aliceMessage = message('alice-fact', 'alice', '我住在杭州')
  const bobMessage = message('bob-fact', 'bob', '我喜欢徒步')

  const applying = memory.apply([
    update('alice', '城市', '住在杭州', aliceMessage.id),
    update('bob', '爱好', '喜欢徒步', bobMessage.id),
  ], [aliceMessage, bobMessage], view.versions)
  const forgetting = memory.forget('bob')
  const [applied, forgotten] = await Promise.all([applying, forgetting])

  assert.equal(applied.applied.length, 2)
  assert.equal(forgotten, 1)
  const after = await memory.context(['alice', 'bob'])
  assert.deepEqual(after.notes, { alice: { 城市: '住在杭州' } })
  assert.equal(Object.hasOwn(after.documents, 'bob'), false)
  assert.equal(after.versions.bob, null)
})

test('context reloads manual Markdown edits and stale model versions cannot overwrite them', async t => {
  const { memory } = await memoryFor(t)
  const firstView = await memory.context(['alice'])
  const firstMessage = message('first', 'alice', '我喜欢早起')
  assert.equal((await memory.apply([update('alice', '作息', '喜欢早起', 'first')], [firstMessage], firstView.versions)).applied.length, 1)
  const staleView = await memory.context(['alice'])
  const path = memory.memoryPath('alice')
  const original = await readFile(path, 'utf8')
  const edited = original.replace('\n\n## 自动记忆\n', '\n### 生活习惯\n每天晨跑\n\n## 自动记忆\n')
  await writeFile(path, edited, 'utf8')

  const refreshed = await memory.context(['alice'])
  assert.equal(refreshed.notes.alice.生活习惯, '每天晨跑')
  assert.equal(refreshed.documents.alice, edited)
  const staleMessage = message('stale', 'alice', '我每周游泳')
  const stale = await memory.apply([update('alice', '运动', '每周游泳', 'stale')], [staleMessage], staleView.versions)
  assert.deepEqual(stale.applied, [])
  assert.equal(stale.rejected[0].problem, 'version_conflict')
  assert.equal(await readFile(path, 'utf8'), edited)

  const freshMessage = message('fresh', 'alice', '我每周游泳')
  const fresh = await memory.apply([update('alice', '运动', '每周游泳', 'fresh')], [freshMessage], refreshed.versions)
  assert.equal(fresh.applied.length, 1)
  const after = await readFile(path, 'utf8')
  assert.match(after, /### 生活习惯\n每天晨跑/)
  assert.deepEqual((await memory.context(['alice'])).notes.alice, {
    作息: '喜欢早起',
    运动: '每周游泳',
    生活习惯: '每天晨跑',
  })
})

test('manual notes take precedence and model updates cannot replace them', async t => {
  const { memory } = await memoryFor(t)
  const path = memory.memoryPath('alice')
  await mkdir(join(path, '..'), { recursive: true })
  const manual = [
    '# 微信用户记忆',
    '',
    '<!-- dsh-memory-id: "alice" -->',
    '',
    '## 人工补充（程序原样保留）',
    '',
    '### 爱好',
    '喜欢骑行',
    '',
    '## 自动记忆',
    '',
  ].join('\n')
  await writeFile(path, manual, 'utf8')
  const view = await memory.context(['alice'])
  assert.deepEqual(view.notes.alice, { 爱好: '喜欢骑行' })
  const source = message('m', 'alice', '我也喜欢骑行')
  const result = await memory.apply([update('alice', '爱好', '每天骑行', 'm')], [source], view.versions)
  assert.equal(result.applied.length, 0)
  assert.equal(result.rejected[0].problem, 'manual_note_conflict')
  assert.equal(await readFile(path, 'utf8'), manual)
})

test('an automatic topic shadowed by a same-named manual topic cannot be a merge source', async t => {
  const { memory } = await memoryFor(t)
  const initial = await memory.context(['alice'])
  const source = message('seed-shadowed', 'alice', '我长期喜欢骑行')
  await memory.apply([update('alice', '兴趣', '自动区中的兴趣记录', source.id)], [source], initial.versions)
  const path = memory.memoryPath('alice')
  const original = await readFile(path, 'utf8')
  const edited = original.replace('\n\n## 自动记忆\n', '\n### 兴趣\n人工区的兴趣记录\n\n## 自动记忆\n')
  await writeFile(path, edited, 'utf8')
  const shadowed = await memory.context(['alice'])
  assert.deepEqual(shadowed.notes.alice, { 兴趣: '人工区的兴趣记录' })

  const proposal = message('merge-shadowed', 'alice', '我还喜欢徒步')
  const result = await memory.apply([
    mergeUpdate('alice', '户外爱好', '喜欢骑行和徒步', proposal.id, ['兴趣']),
  ], [proposal], shadowed.versions)
  assert.deepEqual(result.applied, [])
  assert.equal(result.rejected[0].problem, 'manual_note_conflict')
  assert.equal(await readFile(path, 'utf8'), edited)
  assert.deepEqual((await memory.context(['alice'])).notes.alice, { 兴趣: '人工区的兴趣记录' })
})

test('merging four automatic topics keeps manual and other notes, then the target can keep expanding', async t => {
  const { memory } = await memoryFor(t)
  const initial = await memory.context(['alice', 'bob'])
  const aliceFacts = [
    ['运动1', '喜欢骑车'],
    ['运动2', '喜欢徒步'],
    ['艺术', '喜欢摄影'],
    ['休闲', '喜欢游泳'],
    ['工作', '从事设计工作'],
  ].map(([topic, note], index) => message('alice-' + index, 'alice', '我长期' + note))
  const aliceUpdates = aliceFacts.map((source, index) => update('alice', ['运动1', '运动2', '艺术', '休闲', '工作'][index],
    ['喜欢骑车', '喜欢徒步', '喜欢摄影', '喜欢游泳', '从事设计工作'][index], source.id))
  const bobFact = message('bob-1', 'bob', '我喜欢下棋')
  assert.equal((await memory.apply([...aliceUpdates, update('bob', '爱好', '喜欢下棋', bobFact.id)], [...aliceFacts, bobFact], initial.versions)).applied.length, 6)

  const alicePath = memory.memoryPath('alice')
  const beforeManual = await readFile(alicePath, 'utf8')
  const withManual = beforeManual.replace('\n\n## 自动记忆\n', '\n### 阅读偏好\n喜欢纸质书\n\n## 自动记忆\n')
  await writeFile(alicePath, withManual, 'utf8')
  const bobPath = memory.memoryPath('bob')
  const bobBefore = await readFile(bobPath, 'utf8')

  const current = await memory.context(['alice', 'bob'])
  const mergeNote = '喜欢骑车、徒步、摄影和游泳，也愿意尝试新的户外活动。'.repeat(10)
  assert.ok(mergeNote.length > 120 && mergeNote.length <= 480)
  const mergedSource = message('merge-alice', 'alice', '我喜欢骑车徒步摄影游泳，也想尝试其他户外活动')
  const merged = await memory.apply([
    mergeUpdate('alice', '兴趣', mergeNote, mergedSource.id, ['运动1', '运动2', '艺术', '休闲']),
  ], [mergedSource], current.versions)
  assert.equal(merged.applied.length, 1)
  assert.deepEqual((await memory.context(['alice'])).notes.alice, {
    工作: '从事设计工作',
    阅读偏好: '喜欢纸质书',
    兴趣: mergeNote,
  })
  assert.equal(await readFile(bobPath, 'utf8'), bobBefore)

  const afterMerge = await memory.context(['alice'])
  const manualMergeSource = message('manual-merge', 'alice', '我继续喜欢阅读')
  const manualMerge = await memory.apply([
    mergeUpdate('alice', '新主题', '喜欢阅读', manualMergeSource.id, ['阅读偏好']),
  ], [manualMergeSource], afterMerge.versions)
  assert.deepEqual(manualMerge.applied, [])
  assert.equal(manualMerge.rejected[0].problem, 'manual_note_conflict')
  assert.equal((await memory.context(['alice'])).notes.alice.阅读偏好, '喜欢纸质书')

  const expandedView = await memory.context(['alice'])
  const expandSource = message('expand-alice', 'alice', '我现在还喜欢做饭')
  const expanded = await memory.apply([
    update('alice', '兴趣', mergeNote + '；现在还喜欢做饭', expandSource.id),
  ], [expandSource], expandedView.versions)
  assert.equal(expanded.applied.length, 1)
  assert.deepEqual((await memory.context(['alice'])).notes.alice, {
    工作: '从事设计工作',
    阅读偏好: '喜欢纸质书',
    兴趣: mergeNote + '；现在还喜欢做饭',
  })
})

test('a merge creates capacity when all 30 automatic slots are full', async t => {
  const { memory } = await memoryFor(t)
  const initial = await memory.context(['alice'])
  const evidence = Array.from({ length: 30 }, (_, index) => message('full-' + index, 'alice', '我长期保留记录 ' + index))
  const topics = evidence.map((_, index) => '主题' + index)
  const updates = evidence.map((source, index) => update('alice', topics[index], '稳定事实 ' + index, source.id))
  assert.equal((await memory.apply(updates, evidence, initial.versions)).applied.length, 30)

  const fullView = await memory.context(['alice'])
  const source = message('full-merge', 'alice', '这些经历都属于长期兴趣')
  const merged = await memory.apply([
    mergeUpdate('alice', '长期兴趣', '持续参加户外活动和摄影', source.id, topics.slice(0, 4)),
  ], [source], fullView.versions)
  assert.equal(merged.applied.length, 1)
  assert.deepEqual(merged.rejected, [])
  const result = await memory.context(['alice'])
  assert.equal(Object.keys(result.notes.alice).length, 27)
  for (const topic of topics.slice(0, 4)) assert.equal(Object.hasOwn(result.notes.alice, topic), false)
  assert.equal(result.notes.alice.长期兴趣, '持续参加户外活动和摄影')
})

test('invalid merges, unknown source topics, and overlong notes are rejected without deleting source memories', async t => {
  const { memory } = await memoryFor(t)
  const initial = await memory.context(['alice'])
  const topics = ['骑行', '徒步', '摄影']
  const evidence = topics.map((topic, index) => message('seed-' + index, 'alice', '我喜欢' + topic))
  const seed = await memory.apply(topics.map((topic, index) => update('alice', topic, '喜欢' + topic, evidence[index].id)), evidence, initial.versions)
  assert.equal(seed.applied.length, 3)
  const view = await memory.context(['alice'])
  const original = await readFile(memory.memoryPath('alice'), 'utf8')

  const cases = [
    { update: mergeUpdate('alice', '兴趣', '户外运动', 'bad-duplicate', ['骑行', '骑行']), evidence: message('bad-duplicate', 'alice', '我喜欢户外运动'), problem: 'merge_topics_invalid' },
    { update: mergeUpdate('alice', '兴趣', '户外运动', 'bad-target', ['骑行', '兴趣']), evidence: message('bad-target', 'alice', '我喜欢户外运动'), problem: 'merge_topics_invalid' },
    { update: mergeUpdate('alice', '兴趣', null, 'bad-null', ['骑行']), evidence: message('bad-null', 'alice', '忘掉兴趣'), problem: 'merge_topics_invalid' },
    { update: mergeUpdate('alice', '兴趣', '户外运动', 'unknown', ['不存在']), evidence: message('unknown', 'alice', '我喜欢户外运动'), problem: 'merge_topic_not_found' },
    { update: mergeUpdate('alice', '兴趣', '户外运动', 'wrong-author', ['骑行']), evidence: message('wrong-author', 'bob', '我喜欢户外运动'), problem: 'evidence_from_someone_else' },
    { update: mergeUpdate('alice', '兴趣', '长'.repeat(481), 'too-long', ['骑行']), evidence: message('too-long', 'alice', '我长期喜欢户外运动'), problem: 'bad_note' },
  ]
  for (const item of cases) {
    const result = await memory.apply([item.update], [item.evidence], view.versions)
    assert.deepEqual(result.applied, [])
    assert.equal(result.rejected[0].problem, item.problem)
    assert.equal(await readFile(memory.memoryPath('alice'), 'utf8'), original)
  }

  const overlongDocument = original.replace('\n\n## 自动记忆\n',
    '\n' + 'x'.repeat(MARKDOWN_MEMORY_LIMITS.maxBytes - Buffer.byteLength(original) - 200) + '\n\n## 自动记忆\n')
  await writeFile(memory.memoryPath('alice'), overlongDocument, 'utf8')
  assert.ok(Buffer.byteLength(overlongDocument) < MARKDOWN_MEMORY_LIMITS.maxBytes)
  const latest = await memory.context(['alice'])
  const longSource = message('too-large', 'alice', '我长期参加徒步活动')
  const tooLarge = await memory.apply([
    mergeUpdate('alice', '兴趣', '稳'.repeat(400), longSource.id, ['徒步']),
  ], [longSource], latest.versions)
  assert.deepEqual(tooLarge.applied, [])
  assert.equal(tooLarge.rejected[0].problem, 'document_too_large')
  assert.equal(await readFile(memory.memoryPath('alice'), 'utf8'), overlongDocument)
})

test('a stale merge CAS rejects without removing source memories', async t => {
  const { memory } = await memoryFor(t)
  const initial = await memory.context(['alice'])
  const sources = ['徒步', '露营', '骑行'].map((topic, index) => message('cas-seed-' + index, 'alice', '我喜欢' + topic))
  await memory.apply(sources.map((source, index) => update('alice', ['徒步', '露营', '骑行'][index], '喜欢' + ['徒步', '露营', '骑行'][index], source.id)), sources, initial.versions)
  const stale = await memory.context(['alice'])
  const path = memory.memoryPath('alice')
  const before = await readFile(path, 'utf8')
  const edited = before.replace('\n\n## 自动记忆\n', '\n### 手工备注\n保留这行\n\n## 自动记忆\n')
  await writeFile(path, edited, 'utf8')
  const proposal = message('stale-merge', 'alice', '我喜欢这些户外活动')
  const result = await memory.apply([
    mergeUpdate('alice', '户外', '长期参加户外活动', proposal.id, ['徒步', '露营', '骑行']),
  ], [proposal], stale.versions)
  assert.deepEqual(result.applied, [])
  assert.equal(result.rejected[0].problem, 'version_conflict')
  assert.equal(await readFile(path, 'utf8'), edited)
  assert.deepEqual((await memory.context(['alice'])).notes.alice, {
    手工备注: '保留这行', 徒步: '喜欢徒步', 露营: '喜欢露营', 骑行: '喜欢骑行',
  })
})

test('forget removes automatic notes while preserving manual text; migration never clobbers existing files', async t => {
  const { memory } = await memoryFor(t)
  const legacy = {
    members: {
      alice: { notes: [{ topic: '城市', text: '住在杭州', evidence: 'old-1' }] },
      bob: { notes: [{ topic: '爱好', text: '喜欢骑行', evidence: 'old-2' }] },
    },
  }
  assert.deepEqual(await memory.migrate(legacy), { imported: 2, skipped: 0 })
  const alicePath = memory.memoryPath('alice')
  const original = await readFile(alicePath, 'utf8')
  const edited = original.replace('\n\n## 自动记忆\n', '\n### 补充\n仍在杭州\n\n## 自动记忆\n')
  await writeFile(alicePath, edited, 'utf8')

  assert.deepEqual(await memory.migrate({ members: { alice: { notes: [{ topic: '新主题', text: '新内容' }] } } }), {
    imported: 0,
    skipped: 1,
  })
  assert.equal(await readFile(alicePath, 'utf8'), edited)
  assert.equal(await memory.forget('alice', '城市'), 1)
  const alice = await memory.context(['alice'])
  assert.deepEqual(alice.notes.alice, { 补充: '仍在杭州' })
  assert.match(alice.documents.alice, /### 补充\n仍在杭州/)
  assert.equal(await memory.forget('bob'), 1)
  assert.equal(await memory.forget('alice'), 1)
  assert.equal(await memory.count(), 0)
  const bobAfterForget = await memory.context(['bob'])
  assert.equal(Object.hasOwn(bobAfterForget.documents, 'bob'), false)
  assert.equal(bobAfterForget.versions.bob, null)
  const aliceAfterForget = await memory.context(['alice'])
  assert.equal(Object.hasOwn(aliceAfterForget.documents, 'alice'), false)
})

test('proposal validation reuses MemoryBook evidence checks and rejects new notes when all 30 slots are full', async t => {
  const { memory } = await memoryFor(t)
  const view = await memory.context(['alice'])
  const evidence = Array.from({ length: 30 }, (_, index) => message('m-' + index, 'alice', '我长期做项目 ' + index))
  const updates = evidence.map((source, index) => update('alice', '主题' + index, '稳定事实 ' + index, source.id))
  const result = await memory.apply(updates, evidence, view.versions)
  assert.equal(result.applied.length, 30)
  assert.deepEqual(result.rejected, [])
  const notes = (await memory.context(['alice'])).notes.alice
  assert.equal(Object.keys(notes).length, 30)
  assert.equal(notes.主题0, '稳定事实 0')

  const extra = message('m-extra', 'alice', '我长期喜欢摄影')
  const full = await memory.apply([
    update('alice', '主题30', '稳定事实 30', extra.id),
  ], [extra], (await memory.context(['alice'])).versions)
  assert.deepEqual(full.applied, [])
  assert.equal(full.rejected[0].problem, 'memory_full')
  assert.deepEqual((await memory.context(['alice'])).notes.alice, notes)

  const correction = message('m-correction', 'alice', '我改成喜欢徒步')
  const corrected = await memory.apply([
    update('alice', '主题0', '喜欢徒步', correction.id),
  ], [correction], (await memory.context(['alice'])).versions)
  assert.equal(corrected.applied.length, 1)
  assert.equal((await memory.context(['alice'])).notes.alice.主题0, '喜欢徒步')

  const secret = message('secret', 'alice', '我的 API key 是 sk-1234567890abcdef')
  const rejected = await memory.apply([
    update('alice', '凭据', 'API key', 'secret'),
  ], [secret], (await memory.context(['alice'])).versions)
  assert.equal(rejected.applied.length, 0)
  assert.equal(rejected.rejected[0].problem, 'sensitive')
  assert.equal(MARKDOWN_MEMORY_LIMITS.maxAutomaticNotes, 30)
  assert.equal(MARKDOWN_MEMORY_LIMITS.maxBytes, 16 * 1024)
})

test('migration rejects invalid legacy notes without creating a Markdown document', async t => {
  const { memory } = await memoryFor(t)
  const legacy = {
    members: {
      alice: { notes: [{ topic: '记录', text: 'x'.repeat(481), evidence: 'old-evidence' }] },
    },
  }
  await assert.rejects(memory.migrate(legacy), error => error instanceof MarkdownMemoryError && error.code === 'bad_note')
  assert.equal(await memory.count(), 0)
  assert.equal(await memory.context(['alice']).then(result => result.versions.alice), null)
  assert.equal(legacy.members.alice.notes[0].text.length, 481)
})

test('a document that would exceed 16 KiB is rejected without truncation or overwrite', async t => {
  const { memory } = await memoryFor(t)
  const view = await memory.context(['alice'])
  const evidence = Array.from({ length: 30 }, (_, index) => message('m-' + index, 'alice', '我喜欢项目 ' + index))
  const updates = evidence.map((source, index) => update('alice', '主题' + index, '事实 ' + index, source.id))
  await memory.apply(updates, evidence, view.versions)

  const path = memory.memoryPath('alice')
  const original = await readFile(path, 'utf8')
  const heading = original.indexOf('## 自动记忆')
  const paddingLength = MARKDOWN_MEMORY_LIMITS.maxBytes - Buffer.byteLength(original) - 50
  const edited = original.slice(0, heading) + 'x'.repeat(paddingLength) + '\n\n' + original.slice(heading)
  await writeFile(path, edited, 'utf8')
  assert.ok(Buffer.byteLength(edited) < MARKDOWN_MEMORY_LIMITS.maxBytes)
  const fresh = await memory.context(['alice'])
  const longMessage = message('long', 'alice', '我长期坚持运动')
  const result = await memory.apply([
    update('alice', '主题0', '稳'.repeat(60), 'long'),
  ], [longMessage], fresh.versions)
  assert.deepEqual(result.applied, [])
  assert.equal(result.rejected[0].problem, 'document_too_large')
  assert.equal(await readFile(path, 'utf8'), edited)
})

test('invalid UTF-8, malformed headers, oversized files, and missing CAS versions fail explicitly', async t => {
  const { memory } = await memoryFor(t)
  const path = memory.memoryPath('alice')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'not a memory document', 'utf8')
  await assert.rejects(memory.context(['alice']), error => error instanceof MarkdownMemoryError && error.code === 'bad_format')
  await writeFile(path, Buffer.from([0xff]))
  await assert.rejects(memory.context(['alice']), error => error instanceof MarkdownMemoryError && error.code === 'bad_encoding')

  await writeFile(path, Buffer.alloc(MARKDOWN_MEMORY_LIMITS.maxBytes + 1, 0x61))
  await assert.rejects(memory.context(['alice']), error => error instanceof MarkdownMemoryError && error.code === 'document_too_large')

  await rm(path)
  const source = message('m', 'alice', '我喜欢散步')
  const missingVersion = await memory.apply([update('alice', '爱好', '喜欢散步', 'm')], [source])
  assert.equal(missingVersion.rejected[0].problem, 'version_missing')
  assert.equal(await memory.count(), 0)
})
