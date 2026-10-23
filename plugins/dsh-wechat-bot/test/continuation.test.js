import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatRunner } from '../lib/chat.js'
import { sleep, until } from './helpers.js'

// "续发": the person being answered adds to what they said while the reply is being written.
// The script decides (same person, not turned to someone else, words or a picture); the reply
// is written again once with everything, or its remaining parts are left for the next turn.

const SELF = { id: 'bot', name: '机器人' }
const A = { id: 'member-a', name: '阿甲' }
const B = { id: 'member-b', name: '阿乙' }
const CHAT = { id: 'synthetic@chatroom', name: '测试群', kind: 'group' }
let sequence = 0
const message = (sender, text, extra = {}) => ({
  id: `m${++sequence}`, chatId: CHAT.id, time: Date.now(), sender, text, kind: 'text', mentions: [], ...extra,
})
const toBot = { mentions: [SELF.id] }

// `slow`: how long the model "thinks"; `parts`: how many messages each reply has; `sendMs`: per part.
function runner(t, { slow = 80, parts = 1, sendMs = 0 } = {}) {
  const sent = [], calls = []
  const r = new ChatRunner({
    chat: CHAT, account: () => SELF, persona: '说短句',
    settings: { mode: 'infer', quietMs: 20, maxWaitMs: 200, typingDelay: false, aliases: ['机器人'], maxTurnsPerMinute: 1000 },
    link: { members: async () => [SELF, A, B], canSend: () => true,
      send: async content => { await sleep(sendMs); sent.push(content.text); return { messageId: `sent-${sent.length}` } } },
    think: async args => {
      const input = JSON.parse(args.messages[0].text)
      const texts = input.new.members.flatMap(g => g.messages.map(m => m.text))
      calls.push(texts)
      await sleep(slow)
      return JSON.stringify({ to: input.new.order.at(-1), reply: Array.from({ length: parts }, (_, i) => `回[${texts.join('+')}]${i}`) })
    },
  })
  t.after(() => r.dispose())
  return { r, sent, calls }
}

test('the person being answered adds something while the reply is written: one reply to all of it', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  await until(() => calls.length === 1)
  r.receive(message(A, '最好是喜剧'))
  await until(() => sent.length === 1 && r.status === 'idle')
  await sleep(100)
  assert.deepEqual(calls, [['@机器人 推荐个电影'], ['@机器人 推荐个电影', '最好是喜剧']])
  assert.deepEqual(sent, ['回[@机器人 推荐个电影+最好是喜剧]0'], 'the first draft was never sent')
  assert.ok(r.log.some(e => e.type === 'continued' && e.from === '阿甲'))
})

test('not a continuation: someone else, a turn to another member, or a sticker', async t => {
  for (const [name, extra] of [
    ['someone else', message(B, '今天好热')],
    ['turned to another member', message(A, '@阿乙 你昨天看的啥', { mentions: [B.id] })],
    ['a sticker', message(A, '[表情]', { kind: 'sticker' })],
  ]) {
    const { r, sent, calls } = runner(t)
    r.receive(message(A, '@机器人 推荐个电影', toBot))
    await until(() => calls.length === 1)
    r.receive(extra)
    await until(() => sent.length === 1)
    assert.equal(sent[0], '回[@机器人 推荐个电影]0', `${name}: the reply goes out as written`)
    assert.ok(!r.log.some(e => e.type === 'continued'), name)
  }
})

test('each message is rewritten at most once, so a member who keeps typing cannot hold a reply back', async t => {
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

test('a continuation in the middle of a multi-part reply stops the rest; the next turn answers it', async t => {
  const { r, sent, calls } = runner(t, { slow: 5, parts: 3, sendMs: 40 })
  r.receive(message(A, '@机器人 讲讲', toBot))
  await until(() => sent.length === 1)
  r.receive(message(A, '简短点'))
  await until(() => calls.length === 2 && sent.length >= 2 && r.status === 'idle')
  await sleep(150)
  assert.ok(!sent.includes('回[@机器人 讲讲]2'), 'the last part of the old reply was dropped')
  assert.ok(sent.some(s => s.startsWith('回[简短点]')), 'the addition is answered next')
  assert.ok(r.log.some(e => e.type === 'dropped' && e.reason === 'continued'))
})

test('commands are not continuations and never rewrite an answer', async t => {
  const { r, sent, calls } = runner(t)
  r.receive(message(A, '@机器人 推荐个电影', toBot))
  await until(() => calls.length === 1)
  r.receive(message(A, '/status'))
  await until(() => sent.some(s => s.startsWith('回[')))
  assert.ok(!r.log.some(e => e.type === 'continued'))
})
