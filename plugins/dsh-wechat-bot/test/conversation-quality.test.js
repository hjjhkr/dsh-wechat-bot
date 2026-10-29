import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatRunner } from '../lib/chat.js'
import { until, sleep } from './helpers.js'

const SELF = { id: 'bot', name: '机器人' }
const A = { id: 'member-a', name: '阿甲', aliases: ['Alpha'] }
const B = { id: 'member-b', name: '阿乙', aliases: ['Beta'] }
const CHAT = { id: 'synthetic@chatroom', name: '测试群', kind: 'group' }
let sequence = 0
const message = (sender, text, extra = {}) => ({
  id: `message-${++sequence}`, chatId: CHAT.id, time: Date.now(),
  sender, text, kind: 'text', mentions: [], ...extra,
})

function runner(t, { learn, think, settings = {}, state, members } = {}) {
  const sent = [], calls = [], learned = []
  const r = new ChatRunner({
    chat: CHAT, account: () => SELF, persona: '说短句', state,
    settings: { quietMs: 5, maxWaitMs: 15, typingDelay: false, aliases: ['机器人'],
      memoryQuietMs: 10, memoryMaxWaitMs: 20, memoryCallsPerMinute: 2,
      memoryRateWindowMs: 100, memoryTimeoutMs: 300, ...settings },
    link: { members: members ?? (async () => [SELF, A, B]), canSend: () => true,
      send: async content => { sent.push(content.text); return { messageId: `sent-${sent.length}` } } },
    think: async args => {
      const input = JSON.parse(args.messages[0].text)
      calls.push(input)
      return JSON.stringify(think ? await think(input) : {
        intent: 'direct', to: input.new.order.at(-1), reply: ['收到'], memory: [],
      })
    },
    ...(learn && { learn: async args => {
      const input = JSON.parse(args.messages[0].text)
      learned.push(input)
      return JSON.stringify(await learn(input, args))
    } }),
  })
  t.after(() => r.dispose())
  return { r, sent, calls, learned }
}

test('infer can learn a natural background fact without replying or being asked to remember', async t => {
  let source
  const { r, sent, calls } = runner(t, {
    think: () => ({ reply: [] }),
    learn: async () => ({ memory: [{ who: A.id, topic: '工作', note: '在做语音编码器', evidence: source.id }] }),
  })
  source = message(A, '我最近在做语音编码器，正在调流式集成')
  r.receive(source)
  await until(() => r.memory.book.recall([A.id])[A.id]?.工作, { what: 'background memory' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].new.members[0].messages[0].addressed, 'none')
  assert.deepEqual(sent, [])
  assert.equal(r.memory.book.recall([A.id])[A.id].工作, '在做语音编码器')
})

test('a slow memory learner never holds up a normal reply', async t => {
  let resolveLearning
  const waiting = new Promise(resolve => { resolveLearning = resolve })
  const { r, sent, learned } = runner(t, { learn: async () => waiting })
  r.receive(message(A, '@机器人 我最近在做音频模型', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && learned.length === 1)
  assert.equal(r.status, 'idle')
  resolveLearning({ memory: [] })
})

test('/forget cancels old background learning and prevents resurrection from recent evidence', async t => {
  let finish, source
  const waiting = new Promise(resolve => { finish = resolve })
  const { r, learned } = runner(t, { learn: async () => waiting })
  source = message(A, '我正在维护一个持续开发的编译器项目')
  r.receive(source)
  await until(() => learned.length === 1)
  r.receive(message(A, '/forget all'))
  finish({ memory: [{ who: A.id, topic: '项目', note: '维护编译器项目', evidence: source.id }] })
  await sleep(35)
  assert.deepEqual(r.memory.book.recall([A.id]), {})
  assert.equal(r.log.some(e => e.type === 'memory' && e.applied?.length), false)
})

test('a disposed runner rejects a learner that ignores cancellation', async t => {
  let finish, source
  const waiting = new Promise(resolve => { finish = resolve })
  const { r, learned } = runner(t, { learn: async () => waiting })
  source = message(A, '我一直在做数据库工具链开发')
  r.receive(source)
  await until(() => learned.length === 1)
  r.dispose()
  finish({ memory: [{ who: A.id, topic: '项目', note: '开发数据库工具链', evidence: source.id }] })
  await sleep(20)
  assert.deepEqual(r.memory.book.recall([A.id]), {})
})

test('without a learner the reply model may cite a recent message by id, and authorship is still checked', async t => {
  const old = message(A, '我在维护编译器项目', { id: 'original-evidence', time: Date.now() - 1000 })
  const { r } = runner(t, {
    think: input => ({ to: input.new.order[0], reply: ['收到'], memory: [
      { who: A.id, topic: '项目', note: '维护编译器项目', evidence: input.recent.order[0] },
      { who: B.id, topic: '项目', note: '冒用别人的证据', evidence: input.recent.order[0] },
    ] }),
  })
  r.prime([old])
  r.receive(message(A, '@机器人 你看到了吗', { mentions: [SELF.id] }))
  await until(() => r.memory.book.recall([A.id])[A.id]?.项目)
  assert.equal(r.memory.book.recall([A.id])[A.id].项目, '维护编译器项目')
  assert.deepEqual(r.memory.book.recall([B.id]), {})
  assert.ok(r.log.some(e => e.type === 'memory' && e.rejected?.some(x => x.problem === 'evidence_from_someone_else')))
})

test('independent member follow-ups survive another member receiving a bot reply', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 看看这个', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  r.receive(message(B, '@机器人 还有这个', { mentions: [SELF.id] }))
  await until(() => sent.length === 2 && r.status === 'idle')
  r.receive(message(A, '这次回复有点慢'))
  await until(() => calls.length === 3)
  assert.equal(calls[2].new.members[0].messages[0].addressed, 'maybe')
  assert.equal(r.snapshot().lastBotTurns.length, 2)
})

test('one completed reply reports bounded model and delivery timings', async t => {
  const { r, sent } = runner(t)
  r.receive(message(A, '@机器人 测一下', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  const timing = r.log.find(e => e.type === 'latency')
  assert.ok(timing)
  for (const key of ['modelMs', 'sendMs', 'queueMs', 'totalMs']) {
    assert.equal(typeof timing[key], 'number')
    assert.ok(timing[key] >= 0)
  }
})

test('a stalled member roster cannot hold up a reply indefinitely', async t => {
  const { r, sent, calls } = runner(t, {
    members: () => new Promise(() => {}), settings: { memberLookupTimeoutMs: 15 },
  })
  r.receive(message(A, '@机器人 继续', { mentions: [SELF.id] }))
  await until(() => sent.length === 1, { timeoutMs: 300, what: 'reply despite unavailable roster' })
  assert.equal(calls[0].new.members[0].id, A.id)
  assert.ok(r.log.some(e => e.type === 'members_pending'))
})

test('an already timed-out roster does not delay every later reply', async t => {
  let lookups = 0
  const { r, sent } = runner(t, {
    members: () => { lookups++; return new Promise(() => {}) },
    settings: { memberLookupTimeoutMs: 100 },
  })
  r.receive(message(A, '@机器人 第一问', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  r.receive(message(A, '@机器人 第二问', { mentions: [SELF.id] }))
  await until(() => sent.length === 2 && r.status === 'idle')
  const latest = r.log.filter(e => e.type === 'latency').at(-1)
  assert.ok(latest.modelMs < 70, `second reply waited ${latest.modelMs}ms for a known stalled roster`)
  assert.equal(lookups, 1, 'only one underlying request may remain outstanding')
})

test('a queued roster refresh keeps the last complete roster and does not report it unavailable', async t => {
  let lookups = 0
  const { r, sent, calls } = runner(t, {
    members: () => ++lookups === 1 ? Promise.resolve([SELF, A, B]) : new Promise(() => {}),
    settings: { memberLookupTimeoutMs: 100, memberCacheTtlMs: 1 },
  })
  r.receive(message(A, '@机器人 第一问', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  await sleep(5)
  r.receive(message(A, '@机器人 阿乙去哪了', { mentions: [SELF.id] }))
  await until(() => sent.length === 2 && r.status === 'idle')
  assert.deepEqual(calls.at(-1).chat.mentioned, [B], 'the model input still uses the last complete list')
  assert.ok(r.log.filter(e => e.type === 'latency').at(-1).modelMs < 70)
  assert.equal(r.log.some(e => e.type === 'members_unavailable'), false)
})

test('a roster result arriving after the initial deadline is still cached for later turns', async t => {
  let resolveMembers
  const { r, sent, calls } = runner(t, {
    members: () => new Promise(resolve => { resolveMembers = resolve }),
    settings: { memberLookupTimeoutMs: 15 },
  })
  r.receive(message(A, '@机器人 第一问', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  resolveMembers([SELF, A, B])
  await sleep(5)
  r.receive(message(A, '@机器人 阿乙在吗', { mentions: [SELF.id] }))
  await until(() => sent.length === 2 && r.status === 'idle')
  assert.deepEqual(calls.at(-1).chat.mentioned, [B], 'the late list is used: 阿乙 is known by name')
})

test('background learning stays bounded and uses its own call budget under a flood', async t => {
  const { r, learned, calls, sent } = runner(t, {
    think: () => ({ reply: [] }),
    learn: async () => ({ memory: [] }),
    settings: { maxMessages: 3, memoryCallsPerMinute: 1, memoryRateWindowMs: 150 },
  })
  r.receive(message(A, '我正在做编译器长期项目'))
  await until(() => learned.length === 1)
  for (let i = 0; i < 20; i++) r.receive(message(B, `我还在处理工具链的第${i}个模块`))
  await sleep(40)
  assert.equal(learned.length, 1, 'memory calls have an independent bounded rate')
  assert.ok(r.learner.pending <= 3)
  assert.ok(calls.length > 0, 'ordinary messages reach the reply model')
  assert.deepEqual(sent, [], 'the reply model can stay silent')
  await until(() => learned.length === 2)
})

test('the independent learner checks every author even when the main reply proposes just one note', async t => {
  let a, b
  const { r, learned } = runner(t, {
    think: input => ({ to: input.new.order[0], reply: ['收到'], memory: [
      { who: A.id, topic: '项目', note: '维护编译器项目', evidence: a.id },
    ] }),
    learn: () => ({ memory: [
      { who: A.id, topic: '项目', note: '维护编译器项目', evidence: a.id },
      { who: B.id, topic: '偏好', note: '喜欢短回复', evidence: b.id },
    ] }),
  })
  a = message(A, '@机器人 我在维护编译器项目', { mentions: [SELF.id] })
  b = message(B, '我喜欢短回复，记住这个偏好')
  r.receive(a); r.receive(b)
  await until(() => r.memory.book.recall([B.id])[B.id]?.偏好)
  assert.equal(learned.length, 1)
  assert.equal(r.memory.book.recall([A.id])[A.id].项目, '维护编译器项目')
})

test('persona reply proposals cannot turn a third-party claim into the speakers own memory', async t => {
  let source
  const { r, learned } = runner(t, {
    think: input => ({ to: input.new.order[0], reply: ['看到了'], memory: [
      { who: A.id, topic: '群内称呼', note: '本人自称是Gamma的爸爸', evidence: source.id },
    ] }),
    learn: () => ({ memory: [] }),
  })
  source = message(A, '@机器人 @Beta 是Gamma的爸爸，记住', { mentions: [SELF.id, B.id] })
  r.receive(source)
  await until(() => learned.length === 1 && r.log.some(e => e.type === 'memory_learning'))
  assert.deepEqual(r.memory.book.recall([A.id]), {})
  assert.equal(learned[0].batch[0].sender.id, A.id)
  assert.deepEqual(learned[0].batch[0].at, [SELF.id, B.id])
})

test('a transient learner failure retries once without waiting for another user message', async t => {
  let source, attempts = 0
  const { r } = runner(t, {
    learn: () => {
      if (++attempts === 1) throw new Error('temporary model failure')
      return { memory: [{ who: A.id, topic: '偏好', note: '喜欢短回复', evidence: source.id }] }
    },
  })
  source = message(A, '我喜欢短回复，记住这个偏好')
  r.receive(source)
  await until(() => r.memory.book.recall([A.id])[A.id]?.偏好)
  assert.equal(attempts, 2)
})

test('infer follows a reply when WeChat message timestamps are ahead of the local clock', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 看看这个', { mentions: [SELF.id], time: Date.now() + 56_000 }))
  await until(() => sent.length === 1 && r.status === 'idle')
  r.receive(message(A, '你个大肥鱼', { time: Date.now() + 56_000 }))
  await until(() => calls.length === 2, { what: 'follow-up reaches the model' })
  assert.equal(calls[1].new.members[0].messages[0].addressed, 'maybe')
})

test('infer gives ordinary messages from both members a model decision, including beside a follow-up', async t => {
  const { r, sent, calls } = runner(t, {
    think: input => ({ to: input.new.order.at(-1), reply: input.new.members.some(m => m.messages.some(x => x.addressed === 'you')) ? ['收到'] : [] }),
  })
  r.receive(message(A, '同一句普通聊天'))
  await until(() => calls.length === 1 && r.status === 'idle', { timeoutMs: 500, what: 'first ordinary message' })
  r.receive(message(B, '同一句普通聊天'))
  await until(() => calls.length === 2 && r.status === 'idle', { timeoutMs: 500, what: 'second ordinary message' })
  assert.equal(calls[0].new.members[0].messages[0].addressed, 'none')
  assert.equal(calls[1].new.members[0].messages[0].addressed, 'none')
  assert.deepEqual(sent, [])
  r.receive(message(A, '@机器人 在吗', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  r.receive(message(A, '相同的后续消息'))
  await until(() => calls.length === 4 && r.status === 'idle')
  r.receive(message(B, '相同的后续消息'))
  await until(() => calls.length === 5 && r.status === 'idle', { timeoutMs: 500, what: 'other member ordinary message' })
  assert.equal(calls[3].new.members[0].messages[0].addressed, 'maybe')
  assert.equal(calls[4].new.members[0].messages[0].addressed, 'none')
  assert.deepEqual(sent, ['收到'])
})

test('infer skips messages directed to other people and a redirected follow-up', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 在吗', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  await sleep(10)
  const skipped = () => r.log.filter(e => e.type === 'skipped' && e.reason === 'not_for_me')
  r.receive(message(A, '@阿乙 看看', { mentions: [B.id] }))
  await until(() => skipped().length === 1 && r.status === 'idle')
  r.receive(message(A, '回复阿乙', { quote: { senderId: B.id, text: '消息' } }))
  await until(() => skipped().length === 2 && r.status === 'idle')
  r.receive(message(B, '大家好', { mentions: ['all'] }))
  await until(() => skipped().length === 3 && r.status === 'idle')
  r.receive(message(A, '你说得对'))
  await until(() => skipped().length === 4 && r.status === 'idle')
  assert.deepEqual(skipped().map(e => Object.values(e.why)[0]), [
    ['at_someone_else'], ['quotes_someone_else'], ['at_all'], ['human_conversation_after_reply'],
  ])
  assert.equal(calls.length, 1)
  assert.deepEqual(sent, ['收到'])
})

test('infer retries an empty reply when someone explicitly addresses the bot', async t => {
  let attempts = 0
  const { r, sent, calls } = runner(t, { think: input => ({
    to: input.new.order[0], reply: ++attempts === 1 ? [] : ['收到'],
  }) })
  r.receive(message(B, '@机器人 在吗', { mentions: [SELF.id] }))
  await until(() => sent.length === 1 && r.status === 'idle')
  assert.equal(calls.length, 2)
  assert.ok(r.log.some(e => e.type === 'invalid_output' && e.code === 'must_reply'))
  assert.deepEqual(sent, ['收到'])
})
