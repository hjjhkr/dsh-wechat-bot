import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store } from '../lib/store.js'
import { ChatRunner } from '../lib/chat.js'
import { until } from './helpers.js'

const self = { id: 'bot', name: '机器人' }
const members = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]
let sequence = 0
const message = (sender, text, extra = {}) => ({
  id: 'm' + ++sequence, chatId: 'group', time: Date.now(), kind: 'text', text, sender, mentions: [], ...extra,
})

function runner(t, { think, send, learn, settings = {}, state } = {}) {
  const sent = [], calls = [], learned = []
  const r = new ChatRunner({
    chat: { id: 'group', name: '群', kind: 'group' }, account: () => self, persona: '', state,
    settings: { quietMs: 3, maxWaitMs: 10, typingDelay: false, correctionRetries: 1, memoryQuietMs: 3, memoryMaxWaitMs: 10, ...settings },
    link: { members: async () => [self, ...members], canSend: () => true,
      send: async content => { if (send) await send(content); sent.push(content); return { messageId: 's' + sent.length } } },
    think: async args => { const input = JSON.parse(args.messages[0].text); calls.push(input); return JSON.stringify(await think(input, calls.length)) },
    ...(learn && { learn: async args => { learned.push(args); return JSON.stringify(await learn(args)) } }),
  })
  t.after(() => r.dispose())
  return { r, sent, calls, learned }
}

async function receive(r, calls, msg) {
  const before = calls.length
  r.receive(msg)
  await until(() => calls.length > before && r.status === 'idle', { timeoutMs: 1000, what: 'message processed' })
}

test('infer shares one interjection interval across members, even with a target id', async t => {
  const { r, sent, calls } = runner(t, { think: input => ({ intent: 'interject', to: input.new.order[0], reply: ['插一句'] }) })
  await receive(r, calls, message(members[0], '第一句'))
  await receive(r, calls, message(members[1], '第二句'))
  assert.equal(sent.length, 1)
  assert.deepEqual(r.lastBotTurns, [])
})

test('direct replies bypass an active interval and establish follow-up context', async t => {
  const { r, sent, calls } = runner(t, { think: input => ({ intent: input.new.members[0].messages[0].text === '插话' ? 'interject' : 'direct', to: input.new.order[0], reply: ['收到'] }) })
  await receive(r, calls, message(members[0], '插话'))
  await receive(r, calls, message(members[1], '问你个问题'))
  await receive(r, calls, message(members[1], '然后呢'))
  await receive(r, calls, message(members[0], '@机器人 直接问', { mentions: [self.id] }))
  assert.equal(sent.length, 4)
  assert.equal(calls[2].new.members[0].messages[0].addressed, 'maybe')
})

test('failed sends do not start the interval and the interval expires after a successful send', async t => {
  let attempts = 0
  const { r, sent, calls } = runner(t, { settings: { interjectionIntervalMs: 80 },
    send: () => { if (++attempts === 1) throw new Error('send failure') },
    think: input => ({ intent: 'interject', to: input.new.order[0], reply: ['插一句'] }) })
  await receive(r, calls, message(members[0], '第一句'))
  await receive(r, calls, message(members[1], '第二句'))
  assert.equal(sent.length, 1)
  await receive(r, calls, message(members[0], '第三句'))
  assert.equal(sent.length, 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  await receive(r, calls, message(members[1], '第四句'))
  assert.equal(sent.length, 2)
})

test('a rate-limited interjection still queues background learning', async t => {
  const { r, sent, calls, learned } = runner(t, {
    think: input => ({ intent: 'interject', to: input.new.order[0], reply: ['插一句'] }),
    learn: () => ({ memory: [] }),
  })
  await receive(r, calls, message(members[0], '第一句'))
  await until(() => learned.length === 1)
  await receive(r, calls, message(members[1], '第二句'))
  await until(() => learned.length === 2)
  assert.equal(sent.length, 1)
})

test('infer rejects missing or invalid intent after correction and sends nothing', async t => {
  for (const intent of [undefined, 'other']) {
    const { r, sent, calls } = runner(t, { think: input => ({ intent, to: input.new.order[0], reply: ['你好'] }) })
    await receive(r, calls, message(members[0], '普通消息'))
    assert.equal(calls.length, 2)
    assert.equal(sent.length, 0)
    assert.ok(r.log.some(x => x.type === 'invalid_output' && x.code === 'bad_intent'))
  }
})

test('infer validates direct target and interjection part count with a correction', async t => {
  for (const output of [{ intent: 'direct', reply: ['你好'] }, { intent: 'interject', reply: ['第一句', '第二句'] }]) {
    const { r, sent, calls } = runner(t, { think: () => output })
    await receive(r, calls, message(members[0], '普通消息'))
    assert.equal(calls.length, 2)
    assert.equal(sent.length, 0)
    assert.ok(r.log.some(x => x.type === 'invalid_output'))
  }
})

test('explicit addressing and free or at modes do not require intent', async t => {
  for (const [mode, extra] of [['infer', { mentions: [self.id] }], ['free', {}], ['at', { mentions: [self.id] }]]) {
    const { r, sent, calls } = runner(t, { settings: { mode }, think: input => ({ to: input.new.order[0], reply: ['收到'] }) })
    await receive(r, calls, message(members[0], '消息', extra))
    assert.equal(sent.length, 1)
    assert.equal(calls.length, 1)
  }
})

test('infer can correct a missing intent to a direct reply', async t => {
  const { r, sent, calls } = runner(t, { think: (input, count) => ({
    ...(count === 2 ? { intent: 'direct' } : {}), to: input.new.order[0], reply: ['收到'],
  }) })
  await receive(r, calls, message(members[0], '问你个问题'))
  assert.equal(calls.length, 2)
  assert.equal(sent.length, 1)
  assert.ok(r.log.some(x => x.type === 'invalid_output' && x.code === 'bad_intent'))
})

test('a saved cooldown still prevents an interjection after recreating the runner', async t => {
  const root = resolve(process.env.CODEX_TASK_WORK_DIR ?? tmpdir())
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'participation-'))
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(root + sep))
    await rm(dir, { recursive: true, force: true })
  })
  const store = new Store(dir)
  const think = input => ({ intent: 'interject', to: input.new.order[0], reply: ['插一句'] })
  const first = runner(t, { think })
  await receive(first.r, first.calls, message(members[0], '第一句'))
  assert.equal(first.sent.length, 1)
  store.saveChatLater('group', first.r.snapshot())
  await store.flush()
  first.r.dispose()
  const state = await store.loadChat('group')
  const second = runner(t, { think, state })
  await receive(second.r, second.calls, message(members[1], '第二句'))
  assert.equal(second.sent.length, 0)
})
