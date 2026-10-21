import assert from 'node:assert/strict'
import test from 'node:test'
import { addressOf, nameMatchers } from '../lib/addressing.js'
import { Batcher } from '../lib/batcher.js'
import { DecisionError, parseDecision } from '../lib/decision.js'
import { MemoryBook } from '../lib/memory.js'
import { parseMessage } from '../lib/protocol.js'
import { sleep } from './helpers.js'

const msg = (id, text, extra = {}) => parseMessage({
  id, chatId: 'g@chatroom', time: Date.now(), kind: 'text', text,
  sender: { id: 'alice', name: '阿离' }, ...extra,
})

test('batcher merges a burst and closes on quiet, on max wait, and on size', async () => {
  const batches = []
  const batcher = new Batcher({ quietMs: 30, maxWaitMs: 1000, maxMessages: 3 }, b => batches.push(b.map(m => m.id)))
  batcher.push(msg('1', 'a')); await sleep(10)
  batcher.push(msg('2', 'b')); await sleep(10)
  batcher.push(msg('3', 'c'))
  assert.deepEqual(batches, [['1', '2', '3']], 'size cap closes immediately')
  batcher.release()

  batcher.push(msg('4', 'd')); await sleep(60)
  assert.deepEqual(batches[1], ['4'], 'quiet period closes')

  const capped = []
  const slow = new Batcher({ quietMs: 40, maxWaitMs: 100 }, b => capped.push(b.length))
  for (let i = 0; i < 8; i++) { slow.push(msg(`s${i}`, 'x')); await sleep(25) }
  assert.ok(capped.length >= 1 && capped[0] < 8, 'max wait closes a never-quiet burst')
  slow.clear()
})

test('batcher accumulates while busy and delivers everything after release', async () => {
  const batches = []
  const batcher = new Batcher({ quietMs: 20, maxWaitMs: 500 }, b => batches.push(b.map(m => m.id)))
  batcher.push(msg('1', 'a')); await sleep(40)
  batcher.push(msg('2', 'b')); batcher.push(msg('3', 'c')); await sleep(40)
  assert.equal(batches.length, 1)
  batcher.requeue([msg('0', 'requeued')])
  batcher.release(); await sleep(40)
  assert.deepEqual(batches[1], ['0', '2', '3'])
})

test('addressing distinguishes you / maybe / other / none', () => {
  const names = nameMatchers(['小鲸鱼', 'DeepSeek'])
  const ctx = { chatKind: 'group', self: { id: 'bot' }, names }
  const cases = [
    [msg('a', '在吗', { mentions: ['bot'] }), 'you', 'at_you'],
    [msg('b', '对', { quote: { senderId: 'bot', text: '你好' } }), 'you', 'quotes_you'],
    [msg('c', '小鲸鱼，今天吃啥'), 'you', 'calls_your_name'],
    [msg('d', '小鲸鱼你怎么看'), 'you', 'calls_your_name'],
    [msg('e', '你说呢 DeepSeek?'), 'you', 'calls_your_name'],
    [msg('f', 'deepseek新模型出了没'), 'maybe', 'mentions_your_name'],
    [msg('g', '你今天去吗', { mentions: ['bob'] }), 'other', 'at_someone_else'],
    [msg('h', '哈哈', { quote: { senderId: 'bob', text: '我摔了' } }), 'other', 'quotes_someone_else'],
    [msg('i', '小鲸鱼你说', { mentions: ['bob'] }), 'you', 'calls_your_name'],
    [msg('j', '今天好热'), 'none', undefined],
    [msg('k', '开会了', { mentions: ['all'] }), 'none', 'at_all'],
  ]
  for (const [message, addressed, reason] of cases) {
    const result = addressOf(message, ctx)
    assert.equal(result.addressed, addressed, message.text)
    if (reason) assert.ok(result.reasons.includes(reason), `${message.text}: ${result.reasons}`)
  }
  assert.equal(addressOf(msg('l', '随便'), { ...ctx, chatKind: 'direct' }).addressed, 'you')
})

test('a follow-up from the person the bot just answered is "maybe", others stay "none"', () => {
  const now = Date.now()
  const ctx = { chatKind: 'group', self: { id: 'bot' }, names: nameMatchers([]), lastBotTurn: { time: now - 30_000, toSenderId: 'alice' } }
  assert.equal(addressOf(msg('a', '真的假的'), ctx).addressed, 'maybe')
  assert.equal(addressOf(msg('b', '真的假的', { sender: { id: 'bob', name: '老鲍' } }), ctx).addressed, 'none')
  assert.equal(addressOf(msg('c', '真的假的', { time: now + 10 * 60_000 }), ctx).addressed, 'none')
})

test('decision parsing tolerates fences and prose, splits lines, strips stage directions', () => {
  const batch = [msg('m1', 'hi')]
  const parsed = parseDecision('好的：\n```json\n{"to":"m1","reply":["草（笑）","第二句\\n第三句"],"memory":[]}\n```', { batch })
  assert.equal(parsed.to, 'm1')
  assert.deepEqual(parsed.reply.map(p => p.text), ['草', '第二句', '第三句'])
  assert.deepEqual(parseDecision('{"reply":"单句","to":"nope"}', { batch }).reply, [{ kind: 'text', text: '单句' }])
  assert.equal(parseDecision('{"reply":"单句","to":"nope"}', { batch }).to, null)
  assert.deepEqual(parseDecision('{"reply":[],"memory":[]}', { batch }).reply, [])
  assert.deepEqual(parseDecision('{"reply":["（潜水）"]}', { batch }).reply, [], 'a pure aside is silence')
  assert.deepEqual(parseDecision('{"reply":[{"sticker":"狗头"}]}', { batch, stickers: ['狗头'] }).reply, [{ kind: 'sticker', name: '狗头' }])
  for (const [raw, code] of [
    ['我觉得不用回', 'not_json'],
    ['{"reply":["1","2","3","4"]}', 'too_many_parts'],
    ['{"reply":[{"sticker":"不存在"}]}', 'unknown_sticker'],
    ['{"reply":42}', 'bad_reply'],
  ]) {
    assert.throws(() => parseDecision(raw, { batch }), e => e instanceof DecisionError && e.code === code, raw)
  }
})

test('memory only accepts notes about the author of the cited message', () => {
  const book = new MemoryBook()
  const bob = { id: 'bob', name: '老鲍' }
  const batch = [msg('m1', '我在学吉他'), msg('m2', '阿离其实是程序员', { sender: bob }), msg('m3', '我的密码是123456')]
  const { applied, rejected } = book.apply([
    { who: 'alice', topic: '爱好', note: '在学吉他', evidence: 'm1' },
    { who: 'alice', topic: '职业', note: '程序员', evidence: 'm2' },
    { who: 'alice', topic: '密码', note: '123456', evidence: 'm3' },
    { who: 'alice', topic: '爱好', note: 'x', evidence: 'missing' },
    'junk',
  ], batch)
  assert.equal(applied.length, 1)
  assert.deepEqual(rejected.map(r => r.problem), ['evidence_from_someone_else', 'sensitive', 'evidence_not_in_batch', 'not_an_object'])
  assert.deepEqual(book.recall(['alice', 'bob']), { alice: { 爱好: '在学吉他' } })

  book.apply([{ who: 'alice', topic: '爱好', note: '改学钢琴了', evidence: 'm4' }], [msg('m4', '我改学钢琴了')])
  assert.deepEqual(book.recall(['alice']), { alice: { 爱好: '改学钢琴了' } })
  book.apply([{ who: 'alice', topic: '爱好', note: null, evidence: 'm5' }], [msg('m5', '别记我爱好了')])
  assert.deepEqual(book.recall(['alice']), {})
})

test('memory evicts the oldest note when a member is full', () => {
  const book = new MemoryBook({}, { maxNotesPerMember: 2 })
  for (const n of [1, 2, 3]) book.apply([{ who: 'alice', topic: `t${n}`, note: `n${n}`, evidence: `m${n}` }], [msg(`m${n}`, 'x')])
  assert.deepEqual(Object.keys(book.recall(['alice']).alice), ['t2', 't3'])
})

test('an urgent batch does not leave the pending batch without its max wait', async () => {
  const batches = []
  let batcher
  batcher = new Batcher({ quietMs: 100, maxWaitMs: 300 }, batch => {
    batches.push({ at: Date.now(), ids: batch.map(m => m.id) })
    setTimeout(() => batcher.release(), 30)
  })
  const start = Date.now()
  batcher.push(msg('n1', '普通'))
  await sleep(10)
  batcher.pushUrgent(msg('u1', '/ask'))
  for (let i = 0; i < 15; i++) { await sleep(60); batcher.push(msg(`c${i}`, '刷屏')) } // never quiet for 100ms
  const normal = batches.find(b => b.ids.includes('n1'))
  assert.ok(normal, 'the pending batch was flushed during the chatter')
  assert.ok(normal.at - start < 500, `flushed by its max wait (${normal.at - start}ms)`)
  batcher.clear()
})
