import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../lib/bot.js'
import { Store } from '../lib/store.js'
import { FAST, linkedSimulator, sleep, startBot, until } from './helpers.js'

const GROUP = 'demo@chatroom'
const say = (env, from, text, extra = {}) => env.simulator.inject({ chatId: GROUP, from, text, ...extra })
const sent = env => env.simulator.messages.get(GROUP).filter(m => m.fromSelf).map(m => m.text)
const logTypes = env => env.bot.chatLog().map(e => e.type)

async function watching(t, options) {
  const env = await startBot(t, options)
  await until(() => env.bot.ready, { what: 'account ready' })
  await env.bot.setChat(GROUP)
  return env
}

test('a burst of messages reaches the model as one merged JSON batch', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['收到'], memory: [] }) })
  say(env, 'wxid_alice', '今天')
  say(env, 'wxid_alice', '去吃火锅')
  say(env, 'wxid_bob', '我也去')
  await until(() => sent(env).length === 1, { what: 'reply' })
  assert.equal(env.model.calls.length, 1, 'one model call for the whole burst')
  const input = env.model.calls[0].input
  assert.deepEqual(input.new.map(m => m.text), ['今天', '去吃火锅', '我也去'])
  assert.deepEqual(input.new.map(m => m.from.name), ['阿离', '阿离', '老鲍'])
  assert.deepEqual(input.you, { id: 'wxid_bot', name: '小鲸鱼', aliases: ['小鲸鱼', 'DeepSeek'] })
  assert.equal(input.chat.kind, 'group')
})

test('addressing facts are attached to every message the model sees', async t => {
  const env = await watching(t)
  const first = say(env, 'wxid_bob', '我摔了')
  await until(() => env.model.calls.length === 1, { what: 'first call' })
  say(env, 'wxid_alice', '@老鲍 你没事吧', { mentions: ['wxid_bob'] })
  say(env, 'wxid_alice', '哈哈哈', { quote: { messageId: first.id } })
  say(env, 'wxid_carol', '小鲸鱼，你怎么看')
  say(env, 'wxid_bob', '今天好热')
  await until(() => env.model.calls.length >= 2, { what: 'second call' })
  const input = env.model.calls[1].input
  assert.deepEqual(input.new.map(m => m.addressed), ['other', 'other', 'you', 'none'])
  assert.deepEqual(input.new[1].quote, { from: '老鲍', senderId: 'wxid_bob', messageId: first.id, text: '我摔了' })
  assert.deepEqual(input.recent.map(m => m.text), ['我摔了'], 'already-processed messages move to recent')
})

test('silence is corrected once when someone addressed the bot directly', async t => {
  const env = await watching(t, { reply: (_input, _call, n) => n === 1 ? { reply: [] } : { to: null, reply: ['？'] } })
  say(env, 'wxid_alice', '在吗', { mentions: ['wxid_bot'] })
  await until(() => sent(env).length === 1, { what: 'corrected reply' })
  assert.equal(env.model.calls.length, 2)
  const retry = env.model.calls[1].messages
  assert.equal(retry.length, 3)
  assert.match(retry[2].text, /addressed=you/)
  assert.deepEqual(sent(env), ['？'])
})

test('nobody addressed: silence is accepted without a retry', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '@老鲍 走了', { mentions: ['wxid_bob'] })
  await until(() => logTypes(env).includes('silent'), { what: 'silent decision' })
  assert.equal(env.model.calls.length, 1)
  assert.deepEqual(sent(env), [])
})

test('invalid output gets one corrective retry, a second failure is logged and skipped', async t => {
  const outputs = ['我想想', '{"reply":["行"]}', '还是不对', '依旧不对', '{"reply":[]}']
  const env = await watching(t, { reply: (_i, _c, n) => outputs[n - 1] })
  say(env, 'wxid_alice', '1')
  await until(() => sent(env).length === 1, { what: 'reply after correction' })
  say(env, 'wxid_alice', '2')
  await until(() => logTypes(env).includes('error'), { what: 'error entry' })
  assert.equal(env.model.calls.length, 4)
  assert.deepEqual(logTypes(env).filter(t => t === 'invalid_output').length, 3)
  say(env, 'wxid_alice', '3')
  await until(() => logTypes(env).includes('silent'), { what: 'bot keeps working after a failed batch' })
  assert.equal(env.model.calls.length, 5)
})

test('messages arriving while the model thinks are answered in the next turn, not re-thought', async t => {
  const gate = Promise.withResolvers()
  const env = await watching(t, {
    reply: async (input, _call, n) => {
      if (n === 1) await gate.promise
      return { to: null, reply: [input.new.map(m => m.text).join('+')] }
    },
  })
  say(env, 'wxid_alice', '有人玩游戏吗')
  await until(() => env.model.calls.length === 1, { what: 'thinking' })
  say(env, 'wxid_bob', '我')
  say(env, 'wxid_carol', '我也')
  await sleep(80)
  gate.resolve()
  await until(() => sent(env).length === 2, { what: 'two replies' })
  assert.deepEqual(sent(env), ['有人玩游戏吗', '我+我也'])
  assert.deepEqual(env.model.calls[1].input.recent.map(m => m.text), ['有人玩游戏吗', '有人玩游戏吗'], 'the next turn sees the earlier message and the reply as context')
})

test('multi-part replies are sent in order as separate messages', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['草', '不对', '其实挺好'] }) })
  say(env, 'wxid_alice', '我把车停水沟里了')
  await until(() => sent(env).length === 3, { what: 'three messages' })
  assert.deepEqual(sent(env), ['草', '不对', '其实挺好'])
  await until(() => env.model.calls.length === 1)
  say(env, 'wxid_alice', '？')
  await until(() => env.model.calls.length === 2, { what: 'second call' })
  const recent = env.model.calls[1].input.recent
  assert.deepEqual(recent.filter(m => m.from_you).map(m => m.text), ['草', '不对', '其实挺好'], 'own replies are context once, not duplicated by echoes')
})

test('dispose waits for the in-flight send classification before adapter shutdown acknowledgement', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['第一段', '第二段'] }) })
  const sendStarted = Promise.withResolvers()
  const finishSend = Promise.withResolvers()
  const finishShutdown = Promise.withResolvers()
  const originalSend = env.bot.adapter.send.bind(env.bot.adapter)
  let sendCalls = 0
  let shutdownCalls = 0
  env.bot.adapter.send = async (...args) => {
    sendCalls++
    if (sendCalls === 1) {
      sendStarted.resolve()
      await finishSend.promise
    }
    return originalSend(...args)
  }
  env.bot.adapter.shutdown = async () => {
    shutdownCalls++
    await finishShutdown.promise
  }

  say(env, 'wxid_alice', '来两句')
  await sendStarted.promise
  let disposed = false
  const dispose = env.bot.dispose().then(() => { disposed = true })
  try {
    await sleep(30)
    assert.equal(disposed, false, 'dispose cannot finish while message/send outcome is unresolved')
    assert.equal(shutdownCalls, 0, 'adapter shutdown starts only after the in-flight send settles')
    finishSend.resolve()
    await until(() => shutdownCalls === 1, { timeoutMs: 1000, what: 'safe shutdown after send completion' })
    assert.deepEqual(sent(env), ['第一段'], 'the active send is classified before shutdown begins and later parts are blocked')
    assert.equal(disposed, false, 'dispose waits for the adapter shutdown ACK')
    finishShutdown.resolve()
    await dispose
    assert.equal(sendCalls, 1, 'quiescing does not send or replay another part')
  } finally {
    finishSend.resolve()
    finishShutdown.resolve()
    await dispose
  }
})

test('an adapter that dies right after the handshake is restarted, not given up on', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wechat-bot-crash-'))
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }))
  const created = []
  const bot = new Bot({
    dataDir, store: new Store(dataDir, { delayMs: 5 }), persona: '', think: async () => '{"reply":[]}', settings: FAST,
    createAdapter: () => {
      const { client } = linkedSimulator({ loggedIn: true })
      // The first one answers the handshake, then fails reading the account.
      if (!created.length) client.accountStatus = async () => { throw new Error('adapter crashed') }
      created.push(client)
      return client
    },
  })
  t.after(() => bot.dispose())
  await bot.start()
  await until(() => created.length === 2 && bot.ready, { timeoutMs: 5000, what: 'a restarted, ready adapter' })
})

test('stopping while the adapter is down still completes', async t => {
  const env = await watching(t)
  env.bot.adapter.peer.close() // the adapter is gone; the bot waits to reconnect
  await until(() => env.bot.connection.state === 'adapter_down')
  await env.bot.dispose()
  assert.equal(env.bot.runner, null)
})

test('stopping while a chat is being opened leaves no runner behind', async t => {
  const env = await startBot(t)
  await until(() => env.bot.ready)
  const watch = env.bot.adapter.watch.bind(env.bot.adapter)
  const release = Promise.withResolvers()
  env.bot.adapter.watch = async ids => { await release.promise; return watch(ids) }
  const opening = env.bot.setChat(GROUP)
  const stopping = env.bot.dispose()
  release.resolve()
  await Promise.all([opening.catch(() => {}), stopping])
  assert.equal(env.bot.runner, null, 'no runner (and no timers) is created after stopping began')
})

test('stopping waits for a command that is still running', async t => {
  const finish = Promise.withResolvers()
  const env = await watching(t)
  env.bot.runner.commands.define({ name: 'slow', summary: 'test', run: async ({ setMode }) => { await finish.promise; setMode('at') } })
  say(env, 'wxid_alice', '/slow')
  await until(() => logTypes(env).includes('command'))
  const runner = env.bot.runner
  let stopped = false
  const stopping = env.bot.dispose().then(() => { stopped = true })
  await sleep(30)
  assert.equal(stopped, false, 'the command is still running')
  finish.resolve()
  await stopping
  assert.equal(runner.snapshot().mode, 'at', 'its change made it into the saved state')
})

test('dispose quiesces the current runner before waiting for a reconnect handshake', async t => {
  const env = await watching(t)
  const runner = env.bot.runner
  const received = runner.counters.received
  let receiveCalls = 0
  const receive = runner.receive.bind(runner)
  runner.receive = message => { receiveCalls++; return receive(message) }
  const initializeStarted = Promise.withResolvers()
  const finishInitialize = Promise.withResolvers()
  const createAdapter = env.bot.createAdapter
  let reconnectAdapter
  env.bot.createAdapter = () => {
    reconnectAdapter = createAdapter()
    const initialize = reconnectAdapter.initialize.bind(reconnectAdapter)
    reconnectAdapter.initialize = async options => {
      initializeStarted.resolve()
      await finishInitialize.promise
      return initialize(options)
    }
    return reconnectAdapter
  }

  env.bot.adapter.peer.close()
  await initializeStarted.promise
  let disposed = false
  const dispose = env.bot.dispose().then(() => { disposed = true })
  try {
    reconnectAdapter.emit('message', {
      id: 'during-page-close', chatId: GROUP, time: Date.now(), kind: 'text', text: 'close race',
      sender: { id: 'wxid_alice', name: '阿离' }, mentions: ['wxid_bot'], fromSelf: false,
    })
    await sleep(100)
    assert.equal(receiveCalls, 0, 'disposed Bot stops routing new adapter messages into the runner')
    assert.equal(runner.counters.received, received, 'the disposed runner cannot accept messages while reconnect is pending')
    assert.equal(env.model.calls.length, 0, 'a message delivered during disposal never reaches the model')
    assert.equal(disposed, false, 'disposal waits for the existing reconnect cleanup')
    finishInitialize.resolve()
    await dispose
  } finally {
    finishInitialize.resolve()
    await dispose
  }
})

test('while sending is impossible (locked screen) the bot keeps thinking; replies go out on unlock', async t => {
  const env = await watching(t, { reply: input => ({ to: null, reply: [`回${input.new.at(-1).text}`] }) })
  await env.simulator.handlers()['sim/status']({ canSend: false, reason: 'screen_locked' })
  await until(() => !env.bot.connection.canSend, { what: 'locked status' })
  say(env, 'wxid_alice', '小鲸鱼，在吗')
  await until(() => env.model.calls.length === 1, { what: 'thinking during the lock' })
  await until(() => env.bot.runner.status === 'waiting', { what: 'reply waiting to be sent' })
  assert.deepEqual(sent(env), [])
  say(env, 'wxid_bob', '它锁屏了吧')
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await until(() => sent(env).length === 2, { what: 'both replies after unlock' })
  assert.deepEqual(sent(env), ['回小鲸鱼，在吗', '回它锁屏了吧'])
})

test('a reply that became stale while locked is dropped instead of sent late', async t => {
  const env = await watching(t, {
    settings: { staleMs: 50 },
    reply: () => ({ to: null, reply: ['一', '二'] }),
  })
  // Lock the screen right after the first part goes out.
  env.bot.on('chat-log', entry => {
    if (entry.type === 'sent') env.simulator.handlers()['sim/status']({ canSend: false })
  })
  say(env, 'wxid_alice', '说两句')
  await until(() => logTypes(env).includes('waiting'), { what: 'waiting for unlock' })
  await sleep(100)
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await until(() => logTypes(env).includes('dropped'), { what: 'stale drop' })
  assert.deepEqual(sent(env), ['一'])
})

test('failed sends are retried, uncertain sends never are', async t => {
  const env = await watching(t, { reply: () => ({ to: null, reply: ['嗯'] }) })
  env.simulator.failNext.push('send_failed')
  say(env, 'wxid_alice', '1')
  await until(() => sent(env).length === 1, { what: 'retried send' })

  env.simulator.failNext.push('send_uncertain')
  say(env, 'wxid_alice', '2')
  await until(() => logTypes(env).includes('send_error'), { what: 'uncertain send logged' })
  await sleep(100)
  assert.deepEqual(sent(env), ['嗯'])
  assert.equal(env.bot.chatLog().find(e => e.type === 'send_error').uncertain, true)
})

test('a message typed on the bot account\'s phone is context, not a trigger', async t => {
  const env = await watching(t)
  say(env, 'wxid_bot', '我是本人，在手机上发的')
  await sleep(120)
  assert.equal(env.model.calls.length, 0)
  say(env, 'wxid_alice', '？')
  await until(() => env.model.calls.length === 1)
  assert.deepEqual(env.model.calls[0].input.recent, [{ from_you: true, time: env.model.calls[0].input.recent[0].time, text: '我是本人，在手机上发的' }])
})

test('Markdown memory survives exit while raw chat history is cleared', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bot-restart-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  const first = await watching(t, {
    dir,
    reply: input => ({ to: null, reply: [], memory: [{ who: input.new[0].from.id, topic: '宠物', note: '养了一只叫豆豆的猫', evidence: input.new[0].id }] }),
  })
  say(first, 'wxid_alice', '我家豆豆今天又把杯子推下去了，这猫')
  await until(() => logTypes(first).includes('memory'), { what: 'memory write' })
  await first.bot.dispose()

  const second = await startBot(t, { dir })
  await until(() => second.bot.runner, { what: 'watch restored from disk' })
  second.simulator.inject({ chatId: GROUP, from: 'wxid_alice', text: '早' })
  await until(() => second.model.calls.length === 1)
  const input = second.model.calls[0].input
  assert.match(second.model.calls[0].raw.new.members[0].memoryDocument, /养了一只叫豆豆的猫/)
  assert.equal(input.recent.some(m => m.text.includes('豆豆')), false, 'raw transcript is not restored')
  const saved = await second.bot.store.loadChat(GROUP)
  assert.equal(saved.transcript, undefined)
  assert.equal(saved.log, undefined)
  assert.equal(saved.memory, undefined)
  const path = second.bot.store.memoryFor(GROUP).memoryPath('wxid_alice')
  const document = await readFile(path, 'utf8')
  await writeFile(path, document.replace('养了一只叫豆豆的猫', '喜欢直说重点，回答先给结论'))
  second.simulator.inject({ chatId: GROUP, from: 'wxid_bob', text: '讲讲今天的安排' })
  await until(() => second.model.calls.length === 2)
  assert.equal(second.model.calls[1].raw.new.members[0].memoryDocument, undefined)
  assert.equal(JSON.stringify(second.model.calls[1].raw).includes('喜欢直说重点'), false)
  second.simulator.inject({ chatId: GROUP, from: 'wxid_alice', text: '帮我安排一下今天' })
  await until(() => second.model.calls.length === 3)
  assert.match(second.model.calls[2].raw.new.members[0].memoryDocument, /喜欢直说重点，回答先给结论/)
})

test('background learning writes Markdown and the next reply consumes the same users document', async t => {
  const env = await watching(t, {
    settings: { mode: 'infer', memoryQuietMs: 10, memoryMaxWaitMs: 30 },
    reply: input => ({ to: input.new[0].id, reply: ['收到'] }),
    learn: async args => {
      const source = JSON.parse(args.messages[0].text).batch[0]
      return JSON.stringify({ memory: [{ who: source.sender.id, topic: '回答偏好', note: '先给结论，再解释原因', evidence: source.id }] })
    },
  })
  say(env, 'wxid_alice', '以后给我讲问题时，我更喜欢先给结论再解释原因')
  await until(() => logTypes(env).includes('memory_learning'))
  assert.equal(env.model.calls.length, 0, 'background learning does not require a reply')
  say(env, 'wxid_alice', '小鲸鱼，帮我比较一下两种方案')
  await until(() => env.model.calls.length === 1)
  assert.match(env.model.calls[0].raw.new.members[0].memoryDocument, /先给结论，再解释原因/)
})

test('stopping the bot\'s group stops processing it', async t => {
  const env = await watching(t)
  await env.bot.setChat(null)
  say(env, 'wxid_alice', '小鲸鱼？')
  await sleep(120)
  assert.equal(env.model.calls.length, 0)
})

test('a quiet group gets an idle check the model may use to speak first', async t => {
  const env = await watching(t, {
    settings: { idleMinutes: 0.002 },
    reply: input => input.event ? { reply: ['好安静'] } : { reply: [] },
  })
  await until(() => sent(env).length >= 1, { what: 'idle message' })
  const call = env.model.calls.find(c => c.input.event)
  assert.equal(call.input.event.kind, 'idle')
  assert.deepEqual(call.input.new, [])
})

test('the adapter is restarted after it crashes and watching resumes', async t => {
  const env = await watching(t)
  const crashed = env.simulator
  crashed.close()
  await until(() => env.simulator !== crashed && env.bot.ready, { timeoutMs: 5000, what: 'reconnect' })
  await until(() => env.bot.runner)
  say(env, 'wxid_alice', '还在吗')
  await until(() => env.model.calls.length === 1, { what: 'processing after reconnect' })
})

test('a reply to the bot identified only by message id still counts as addressing it', async t => {
  const env = await watching(t, { reply: () => ({ reply: ['在'] }) })
  say(env, 'wxid_alice', '有人吗', { mentions: ['wxid_bot'] })
  await until(() => sent(env).length === 1)
  const own = env.simulator.messages.get(GROUP).find(m => m.fromSelf)
  env.simulator.inject({ chatId: GROUP, from: 'wxid_alice', text: '你是谁', quote: { messageId: 'unknown-to-adapter' } })
  say(env, 'wxid_alice', '回你呢', { quote: { messageId: own.id } })
  await until(() => env.model.calls.length >= 2)
  const addressed = Object.fromEntries(env.model.calls.at(-1).input.new.map(m => [m.text, m.addressed]))
  assert.equal(addressed['回你呢'], 'you')
})

test('the configured mode applies until someone explicitly changes it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bot-mode-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  const first = await watching(t, { dir })
  say(first, 'wxid_alice', '随便聊聊')
  await until(() => first.model.calls.length === 1)
  await first.bot.dispose()

  const second = await startBot(t, { dir, settings: { mode: 'at' } })
  await until(() => second.bot.runner)
  assert.equal(second.bot.runner.mode, 'at', 'config change takes effect')
  second.bot.setMode('silent')
  await second.bot.dispose()

  const third = await startBot(t, { dir, settings: { mode: 'at' } })
  await until(() => third.bot.runner)
  assert.equal(third.bot.runner.mode, 'silent', 'an explicit choice survives restarts')
})

test('stopping the group mid-reply stops the rest of the reply, even across a lock', async t => {
  const env = await watching(t, { reply: () => ({ reply: ['一', '二', '三'] }) })
  env.bot.on('chat-log', entry => {
    if (entry.type === 'sent') env.simulator.handlers()['sim/status']({ canSend: false })
  })
  say(env, 'wxid_alice', '说三句')
  await until(() => logTypes(env).includes('waiting'))
  await env.bot.setChat(null)
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await sleep(100)
  assert.deepEqual(sent(env), ['一'])
})

test('/mute during a multi-part reply stops the remaining parts', async t => {
  const env = await watching(t, { reply: () => ({ reply: ['一', '二'] }) })
  // Hold the second part back (as a locked screen would) while someone mutes the bot.
  env.bot.on('chat-log', entry => {
    if (entry.type === 'sent' && entry.part.text === '一') env.simulator.handlers()['sim/status']({ canSend: false })
  })
  say(env, 'wxid_alice', '说两句')
  await until(() => logTypes(env).includes('waiting'))
  say(env, 'wxid_carol', '/mute 10')
  await until(() => logTypes(env).includes('mute'))
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await until(() => sent(env).includes('已执行：安静 10 分钟'))
  await sleep(60)
  assert.deepEqual(sent(env), ['一', '已执行：安静 10 分钟'])
})

test('an adapter that reports it cannot send is believed after login', async t => {
  const env = await startBot(t, { simulator: { loggedIn: false } })
  await env.simulator.handlers()['sim/status']({ canSend: false, reason: 'screen_locked' })
  await until(() => env.bot.connection.reason === 'screen_locked')
  await env.bot.login()
  await until(() => env.bot.ready)
  await sleep(50)
  assert.equal(env.bot.connection.canSend, false)
})

test('concurrent group changes never leave a stray chat runner behind', async t => {
  const env = await startBot(t, { settings: { idleMinutes: 0.001 }, reply: () => ({ reply: ['在吗'] }) })
  await until(() => env.bot.ready)
  await Promise.all([env.bot.setChat(GROUP), env.bot.setChat(GROUP)])
  await env.bot.setChat(null)
  const before = env.model.calls.length
  await sleep(200)
  assert.equal(env.model.calls.length, before, 'no idle checks from an orphaned runner')
})

test('if watching fails at first (adapter still opening its databases), it is retried until it works', async t => {
  // The first two watch/set calls fail: the one at startup and the one for the chosen group.
  const env = await startBot(t, { simulator: { failWatch: 2 } })
  await until(() => env.bot.ready)
  await assert.rejects(env.bot.setChat(GROUP))
  await until(() => env.bot.runner, { timeoutMs: 3000, what: 'retried watch' })
  say(env, 'wxid_alice', '还在吗')
  await until(() => env.model.calls.length === 1)
})

test('a long reply echoed back under a different id is recognised before truncation', async t => {
  const long = '这是一段很长的回复'.repeat(5)
  const env = await watching(t, { settings: { maxTextChars: 20 }, reply: () => ({ reply: [long] }) })
  say(env, 'wxid_alice', '说点长的')
  await until(() => sent(env).includes(long))
  env.simulator.inject({ chatId: GROUP, from: 'wxid_bot', text: long }) // the "real" message, new id
  await sleep(100)
  assert.equal(env.bot.runner.transcript.filter(m => m.fromSelf).length, 1)
})
