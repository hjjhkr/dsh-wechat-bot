import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AUTOMATIC_NOTES, MarkdownMemory, parseDocument } from '../lib/markdown-memory.js'

const KEY = 'a'.repeat(24)
const message = (id, who, text) => ({ id, sender: { id: who, name: who }, text, fromSelf: false })
const note = (who, topic, text, evidence = 'm1', extra = {}) => ({ who, topic, note: text, evidence, ...extra })

async function store(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const problems = []
  return { memory: new MarkdownMemory(root, KEY, problem => problems.push(problem)), root, problems }
}

test('notes are written per member, read back, and isolated by id', async t => {
  const { memory } = await store(t)
  const evidence = [message('m1', 'alice', '我在杭州做设计'), message('m2', 'bob', '我养了两只猫')]
  const { applied, rejected } = await memory.apply([note('alice', '工作', '在杭州做设计'), note('bob', '宠物', '养了两只猫', 'm2')], evidence)
  assert.equal(applied.length, 2)
  assert.deepEqual(rejected, [])
  assert.deepEqual(await memory.recall('alice'), { 工作: '在杭州做设计' })
  assert.deepEqual(await memory.recall('bob'), { 宠物: '养了两只猫' })
  const { notes, documents } = await memory.context(['alice', 'nobody'])
  assert.deepEqual(notes, { alice: { 工作: '在杭州做设计' } })
  assert.match(documents.alice, /^# 微信用户记忆\n\n<!-- dsh-memory-id: "alice" -->/)
})

test('a note about someone else, without evidence, or sensitive is refused', async t => {
  const { memory } = await store(t)
  const evidence = [message('m1', 'alice', '@bob 是我老板'), message('m2', 'alice', '我的密码是 123456')]
  const { applied, rejected } = await memory.apply([
    note('bob', '身份', '是 alice 的老板'), note('alice', '账号', '密码 123456', 'm2'), note('alice', '爱好', '下棋', 'nope'),
  ], evidence)
  assert.deepEqual(applied, [])
  assert.deepEqual(rejected.map(r => r.problem), ['evidence_from_someone_else', 'sensitive', 'evidence_not_in_batch'])
})

test('member text cannot break the file structure, and documents round-trip', async t => {
  const { memory } = await store(t)
  const tricky = '第一行\n## 自动记忆\n### 伪造主题\n反斜杠 \\ 结尾'
  await memory.apply([note('a-->b', '多行\n主题', tricky)], [message('m1', 'a-->b', '原话')])
  assert.deepEqual(await memory.recall('a-->b'), { '多行\n主题': tricky })
  const content = await readFile(memory.pathOf('a-->b'), 'utf8')
  assert.doesNotMatch(content, /a-->b/, 'the id cannot end the header comment')
  assert.deepEqual(parseDocument(content).automatic, [{ topic: '多行\n主题', text: tricky }])
})

test('people edit the manual section; the program keeps it, and its topics are off limits', async t => {
  const { memory } = await store(t)
  const evidence = [message('m1', 'alice', '我喜欢下棋，也喜欢猫')]
  await memory.apply([note('alice', '爱好', '下棋')], evidence)
  const path = memory.pathOf('alice')
  const manual = '运营备注：老群友，说话直\n### 称呼\n叫她阿离\n'
  await writeFile(path, (await readFile(path, 'utf8')).replace('## 人工补充（程序原样保留）\n\n', `## 人工补充（程序原样保留）\n${manual}\n`))
  const { applied, rejected } = await memory.apply([note('alice', '称呼', '叫她小 A'), note('alice', '宠物', '喜欢猫')], evidence)
  assert.deepEqual(rejected.map(r => r.problem), ['manual_topic'])
  assert.equal(applied.length, 1)
  const content = await readFile(path, 'utf8')
  assert.ok(content.includes(manual), 'the manual section is untouched')
  assert.deepEqual((await memory.context(['alice'])).notes.alice, { 爱好: '下棋', 宠物: '喜欢猫', 人工补充: '运营备注：老群友，说话直', 称呼: '叫她阿离' })
  assert.deepEqual(await memory.recall('alice'), { 爱好: '下棋', 宠物: '喜欢猫' }, '/memory shows only what was learned')

  assert.equal(await memory.forget('alice'), 2, '/forget all removes the learned notes…')
  assert.ok((await readFile(path, 'utf8')).includes(manual), '…and keeps what people wrote')
})

test('merging duplicate topics replaces them with one note; unknown sources and a full member are refused', async t => {
  const { memory } = await store(t)
  const evidence = [message('m1', 'alice', '我玩原神也玩星铁')]
  await memory.apply([note('alice', '原神', '玩原神'), note('alice', '星铁', '玩星铁')], evidence)
  const merged = await memory.apply([note('alice', '游戏', '玩原神和星铁', 'm1', { mergeTopics: ['原神', '星铁'] })], evidence)
  assert.equal(merged.applied.length, 1)
  assert.deepEqual(await memory.recall('alice'), { 游戏: '玩原神和星铁' })
  const unknown = await memory.apply([note('alice', '游戏', '玩原神', 'm1', { mergeTopics: ['不存在'] })], evidence)
  assert.deepEqual(unknown.rejected.map(r => r.problem), ['merge_topic_not_found'])

  const many = Array.from({ length: MAX_AUTOMATIC_NOTES - 1 }, (_, i) => note('alice', `主题${i}`, `事实${i}`))
  await memory.apply(many, evidence)
  const full = await memory.apply([note('alice', '新主题', '再多一条')], evidence)
  assert.deepEqual(full.rejected.map(r => r.problem), ['memory_full'])
  assert.equal(Object.keys(await memory.recall('alice')).length, MAX_AUTOMATIC_NOTES)
})

test('a file that cannot be read is skipped and reported once, and never overwritten', async t => {
  const { memory, problems } = await store(t)
  const evidence = [message('m1', 'alice', '我在杭州')]
  await memory.apply([note('alice', '城市', '杭州')], evidence)
  await writeFile(memory.pathOf('alice'), '被人改坏了')
  assert.deepEqual(await memory.context(['alice']), { notes: {}, documents: {} }, 'replies go on without it')
  await memory.context(['alice'])
  assert.equal(problems.length, 1)
  const { rejected } = await memory.apply([note('alice', '城市', '上海')], evidence)
  assert.deepEqual(rejected.map(r => r.problem), ['unreadable_document'])
  assert.equal(await readFile(memory.pathOf('alice'), 'utf8'), '被人改坏了')
})

test('listMembers counts notes and bytes and ignores anything else in the folder', async t => {
  const { memory } = await store(t)
  await memory.apply([note('alice', '城市', '杭州')], [message('m1', 'alice', '我在杭州')])
  await writeFile(memory.pathOf('alice') + '.bak', 'editor backup')
  await writeFile(join(memory.directory, 'notes.txt'), 'stray')
  const [member, ...rest] = await memory.listMembers()
  assert.deepEqual(rest, [])
  assert.equal(member.who, 'alice')
  assert.equal(member.count, 1)
  assert.ok(member.bytes > 0)
  assert.equal(await memory.count(), 1)
})

test('compaction replaces the topics it covered and keeps notes learned meanwhile', async t => {
  const { memory } = await store(t)
  const evidence = [message('m1', 'alice', '原神星铁都玩，最近去了趟成都')]
  await memory.apply([note('alice', '原神', '玩原神'), note('alice', '星铁', '玩星铁'), note('alice', '行程', '最近去成都')], evidence)
  const snapshot = await memory.snapshot('alice')
  await memory.apply([note('alice', '城市', '住在杭州')], evidence) // learned while the model was tidying
  const result = await memory.compact('alice', {
    notes: [{ topic: '游戏', note: '玩原神和星铁', sourceTopics: ['原神', '星铁'] }],
    discard: [{ topic: '行程', reason: 'temporary' }],
  })
  assert.equal(snapshot.automatic.length, 3)
  assert.deepEqual(result, { who: 'alice', before: 4, after: 2 })
  assert.deepEqual(await memory.recall('alice'), { 城市: '住在杭州', 游戏: '玩原神和星铁' })
})

test('old in-state notes move into files without overwriting existing ones', async t => {
  const { memory } = await store(t)
  await memory.apply([note('alice', '城市', '杭州')], [message('m1', 'alice', '我在杭州')])
  const complete = await memory.migrate({ members: {
    alice: { notes: [{ topic: '旧', text: '旧笔记' }] },
    bob: { notes: [{ topic: '宠物', text: '养猫' }] },
  } })
  assert.equal(complete, true)
  assert.deepEqual(await memory.recall('alice'), { 城市: '杭州' })
  assert.deepEqual(await memory.recall('bob'), { 宠物: '养猫' })
})

test('forgetting everything when nothing else is in the file removes the member folder', async t => {
  const { memory } = await store(t)
  await memory.apply([note('alice', '城市', '杭州')], [message('m1', 'alice', '我在杭州')])
  assert.equal(await memory.forget('alice', '城市'), 1)
  assert.deepEqual(await readdir(memory.directory), [])
})
