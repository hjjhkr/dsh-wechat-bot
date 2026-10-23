import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatRunner } from '../lib/chat.js'
import { sleep, until } from './helpers.js'

// "续发": someone in the batch adds to what they said within one quiet window of the batch being
// handed over, before the reply goes out. The script sees it and has the reply written once more
// with it. Anyone else, or anything later, is simply the next batch.

const SELF = { id: 'bot', name: '机器人' }
const A = { id: 'member-a', name: '阿甲' }
const B = { id: 'member-b', name: '阿乙' }
const CHAT = { id: 'synthetic@chatroom', name: '测试群', kind: 'group' }
let sequence = 0
const message = (sender, text, extra = {}) => ({
  id: `m${++sequence}`, chatId: CHAT.id, time: Date.now(), sender, text, kind: 'text', mentions: [], ...extra,
})
const toBot = { mentions: [SELF.id] }
const QUIET = 60

// `slow`: how long the model "thinks"; `parts`: messages per reply; `sendMs`: per part.
function runner(t, { slow = 150, parts = 1, sendMs = 0, state } = {}) {
  const sent = [], calls = []
  const r = new ChatRunner({
    chat: CHAT, account: () => SELF, persona: '说短句', state,
    settings: { mode: 'free', quietMs: QUIET, maxWaitMs: 400, typingDelay: false, aliases: ['机器人'], maxTurnsPerMinute: 1000, commandsPerMinute: 100 },
    link: { members: async () => [SELF, A, B], canSend: () => true,
      send: async content => { await sleep(sendMs); sent.push(content.text); return { messageId: `sent-${sent.length}` } } },
    think: async args => {
      const input = JSON.parse(args.messages[0].text)
      const texts = input.new.order.map(id => input.new.members.flatMap(g => g.messages).find(m => m.id === id).text)
      calls.push(texts)
      await sleep(slow)
      return JSON.stringify({ to: input.new.order.at(-1), reply: Array.from({ length: parts }, (_, i) => `回[${texts.join('+')}]${i}`) })
    },
  })
  t.after(() => r.dispose())
  return { r, sent, calls }
}

test('the same person adding right after the batch went in gets one reply to all of it', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  await until(() => calls.length === 1)
  r.receive(message(A, '最好是喜剧'))
  await until(() => sent.length === 1 && r.status === 'idle')
  await sleep(QUIET * 2)
  assert.deepEqual(calls, [['@机器人 推荐个电影'], ['@机器人 推荐个电影', '最好是喜剧']])
  assert.deepEqual(sent, ['回[@机器人 推荐个电影+最好是喜剧]0'], 'the first draft was never sent')
  assert.ok(r.log.some(e => e.type === 'continued' && e.from === '阿甲'))
})

test('someone else talking meanwhile does not rewrite the reply; it is the next batch', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  await until(() => calls.length === 1)
  r.receive(message(B, '我也想知道'))
  await until(() => sent.length === 2 && r.status === 'idle')
  assert.deepEqual(calls, [['@机器人 推荐个电影'], ['我也想知道']])
  assert.equal(sent[0], '回[@机器人 推荐个电影]0')
})

test('the same person adding only after the quiet window is the next batch, not a rewrite', async t => {
  const { r, sent, calls } = runner(t, { slow: QUIET * 4 })
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  await until(() => calls.length === 1)
  await sleep(QUIET * 2)
  r.receive(message(A, '对了，顺便问下天气'))
  await until(() => sent.length === 2 && r.status === 'idle')
  assert.deepEqual(calls, [['@机器人 推荐个电影'], ['对了，顺便问下天气']])
  assert.ok(!r.log.some(e => e.type === 'continued'))
})

test('each message is written again at most once, so nobody can hold a reply back', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  for (let i = 1; i <= 3; i++) {
    await until(() => calls.length === i, { what: `call ${i}` })
    r.receive(message(A, `补充${i}`))
  }
  await until(() => sent.length >= 1)
  assert.deepEqual(calls.slice(0, 2), [['@机器人 推荐个电影'], ['@机器人 推荐个电影', '补充1']])
  assert.equal(sent[0], '回[@机器人 推荐个电影+补充1]0', 'one rewrite, then it went out although 补充2 had arrived')
  await until(() => r.status === 'idle' && sent.length >= 2)
  assert.ok(calls.slice(2).every(texts => !texts.includes('@机器人 推荐个电影')), 'the first message is never thought about again')
})

test('a multi-part reply is sent in full; what arrives meanwhile is the next turn', async t => {
  const { r, sent, calls } = runner(t, { slow: 5, parts: 3, sendMs: 40 })
  r.receive(message(A, '@机器人 讲讲', toBot))
  await until(() => sent.length === 1)
  r.receive(message(A, '简短点'))
  await until(() => calls.length === 2 && sent.length === 6 && r.status === 'idle')
  assert.deepEqual(sent.slice(0, 3), ['回[@机器人 讲讲]0', '回[@机器人 讲讲]1', '回[@机器人 讲讲]2'])
  assert.deepEqual(calls[1], ['简短点'])
})

test('commands never wait in the batch, so they neither trigger nor suffer a rewrite', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  await until(() => calls.length === 1)
  r.receive(message(A, '/status'))
  await until(() => sent.some(s => s.startsWith('回[')))
  assert.ok(!r.log.some(e => e.type === 'continued'))
})

test('during /attack the target adding something rewrites the reply; others are still ignored', async t => {
  const engagement = { id: 'e1', style: 'attack', target: { id: A.id, name: A.name }, since: Date.now(), lastTargetAt: Date.now() }
  const { r, sent, calls } = runner(t, { state: { engagement } })
  r.receive(message(A, '你才菜'))
  await until(() => calls.length === 1)
  r.receive(message(B, '哈哈哈'))
  await until(() => sent.length === 1)
  assert.equal(sent[0], '回[你才菜]0', 'someone else talking does not rewrite the reply to the target')

  r.receive(message(A, '再来'))
  await until(() => calls.length === 2)
  r.receive(message(A, '服不服'))
  await until(() => sent.length === 2)
  assert.equal(sent[1], '回[再来+服不服]0')
})

test('/wait sets the batch timing for every mode at runtime, is kept across restarts, and can be reset', async t => {
  const { r, sent } = runner(t)
  const reply = () => sent.at(-1)
  r.receive(message(A, '/wait'))
  await until(() => sent.length === 1)
  assert.match(reply(), /静默 0\.06 秒、最多 0\.4 秒/)
  r.receive(message(A, '/wait 3 10'))
  await until(() => sent.length === 2)
  assert.equal(reply(), '已执行：合批等待改为 静默 3 秒、最多 10 秒')
  assert.deepEqual(r.wait, { quietMs: 3000, maxWaitMs: 10_000 })
  r.receive(message(A, '/wait 12'))
  await until(() => sent.length === 3)
  assert.deepEqual(r.wait, { quietMs: 12_000, maxWaitMs: 12_000 }, 'the limit follows a longer quiet window')
  for (const bad of ['/wait 0.1', '/wait 5 3', '/wait 3 500', '/wait abc']) {
    const before = sent.length
    r.receive(message(A, bad))
    await until(() => sent.length === before + 1)
    assert.match(reply(), /^没改成/, bad)
  }
  r.setMode('at')
  assert.deepEqual(r.wait, { quietMs: 12_000, maxWaitMs: 12_000 }, 'the same for every mode')

  const restarted = runner(t, { state: r.snapshot() })
  assert.deepEqual(restarted.r.wait, { quietMs: 12_000, maxWaitMs: 12_000 })
  r.receive(message(A, '/wait reset'))
  await until(() => reply()?.startsWith('已执行：合批等待恢复为'))
  assert.deepEqual(r.wait, { quietMs: QUIET, maxWaitMs: 400 })
})

test('in a flood a rewrite is skipped rather than pushing the batch out: the @ is still answered', async t => {
  const { r, sent, calls } = runner(t)
  r.batcher.maxMessages = 3
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  await until(() => calls.length === 1)
  r.receive(message(A, '要喜剧'))
  r.receive(message(B, '刷屏1'))
  r.receive(message(B, '刷屏2'))
  await until(() => sent.length >= 1)
  assert.equal(sent[0], '回[@机器人 推荐个电影]0', 'the draft goes out: batch + additions would not fit in one batch')
  assert.ok(!r.log.some(e => e.type === 'continued'))
})

test('messages that were already waiting when the batch went in (a size split) are not a continuation', async t => {
  const { r, calls } = runner(t, { slow: 30 })
  r.batcher.maxChars = 30
  const long = n => `${n}`.repeat(20)
  r.receive(message(A, long(1)))
  r.receive(message(A, long(2)))
  await until(() => calls.length === 2 && r.status === 'idle')
  await sleep(QUIET * 2)
  assert.deepEqual(calls, [[long(1)], [long(2)]], 'each message is thought about once')
})

test('/wait applies to a batch that is already collecting', async t => {
  const { r, sent } = runner(t)
  r.setWait({ quietMs: 5000, maxWaitMs: 20_000 })
  r.receive(message(A, '@机器人 在吗', toBot))
  await sleep(50)
  r.setWait({ quietMs: 500, maxWaitMs: 1000 })
  await until(() => sent.length === 1, { timeoutMs: 1500, what: 'the shorter wait took effect' })
})
