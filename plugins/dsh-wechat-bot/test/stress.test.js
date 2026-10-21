// Stress and chaos tests: a flooding group, a failing/hanging model, a crashing
// adapter, flaky sends with a flapping lock screen, and a hung runner.
// Every scenario checks the same promises: no unhandled errors, bounded memory,
// the rate limit holds, and the bot answers normally again once things calm down.
// Scale the load with STRESS_SCALE (default 1), e.g. STRESS_SCALE=5 node --test test/stress.test.js
import assert from 'node:assert/strict'
import test from 'node:test'
import { sleep, startBot, until } from './helpers.js'

const SCALE = Number(process.env.STRESS_SCALE ?? 1)
const GROUP = 'big@chatroom'
const BOT = { id: 'wxid_bot', name: '小鲸鱼' }
const MEMBERS = Array.from({ length: 50 }, (_, i) => ({ id: `wxid_m${i}`, name: `群友${i}` }))
const CHATS = [{ id: GROUP, name: '压力测试群', kind: 'group', members: [...MEMBERS, BOT] }]
const pick = list => list[Math.floor(Math.random() * list.length)]
const between = (min, max) => min + Math.random() * (max - min)

// Fails the test if anything escapes as an unhandled rejection / exception.
function watchProcess(t) {
  const escaped = []
  const onRejection = error => escaped.push(`unhandledRejection: ${error?.stack ?? error}`)
  const onException = error => escaped.push(`uncaughtException: ${error?.stack ?? error}`)
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  t.after(() => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
  })
  return () => assert.deepEqual(escaped, [], 'nothing escaped')
}

function assertBounded(env) {
  const runner = env.bot.runner
  const s = runner.settings
  assert.ok(runner.batcher.size <= s.maxMessages, `backlog ${runner.batcher.size} > ${s.maxMessages}`)
  assert.ok(runner.transcript.length <= s.recentLimit * 3, `transcript ${runner.transcript.length}`)
  assert.ok(runner.log.length <= 600, `chat log ${runner.log.length}`)
  assert.ok(runner.seen.size <= 1000, `seen ids ${runner.seen.size}`)
  assert.ok(env.bot.log.length <= 600, `bot log ${env.bot.log.length}`)
  for (const member of Object.values(runner.memory.members)) assert.ok(member.notes.length <= 20)
}

// Highest number of model calls inside any `windowMs`.
function peakRate(times, windowMs) {
  let peak = 0
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= windowMs) j++
    peak = Math.max(peak, i - j + 1)
  }
  return peak
}

async function group(t, options) {
  const env = await startBot(t, { ...options, simulator: { chats: CHATS, ...options.simulator } })
  await until(() => env.bot.ready, { what: 'ready' })
  await env.bot.setChat(GROUP)
  return env
}

const say = (env, text, extra = {}) => env.simulator.inject({ chatId: GROUP, from: extra.from ?? pick(MEMBERS).id, text, ...extra })
const sentTexts = env => env.simulator.messages.get(GROUP).filter(m => m.fromSelf).map(m => m.text)

// After any storm: a fresh @ must be seen by the model and answered.
async function answersAgain(env, { timeoutMs = 5000 } = {}) {
  const marker = `还在吗-${Math.random().toString(36).slice(2, 8)}`
  say(env, marker, { mentions: [BOT.id] })
  await until(() => env.model.calls.some(c => c.input.new.some(m => m.text === marker)), { timeoutMs, what: 'model sees the fresh @' })
  await until(() => sentTexts(env).some(text => text.includes(marker)), { timeoutMs, what: 'reply to the fresh @' })
}

const echoReply = input => {
  const target = input.new.findLast(m => m.addressed === 'you')
  return target ? { to: target.id, reply: [`回${target.text}`] } : { reply: [] }
}

test('flood: thousands of messages from 50 members stay bounded and rate-limited', async t => {
  const escaped = watchProcess(t)
  const times = []
  const env = await group(t, {
    settings: { quietMs: 20, maxWaitMs: 100, maxTurnsPerMinute: 15, rateWindowMs: 1000 },
    reply: async input => {
      times.push(Date.now())
      await sleep(between(10, 40))
      return echoReply(input)
    },
  })
  const total = 3000 * SCALE
  const started = Date.now()
  for (let i = 0; i < total; i++) {
    say(env, `刷屏第${i}条`, Math.random() < 0.05 ? { mentions: [BOT.id] } : {})
    if (i % 25 === 0) {
      await sleep(20)
      assertBounded(env)
    }
  }
  await until(() => env.bot.runner.batcher.size === 0 && env.bot.runner.status === 'idle', { timeoutMs: 15_000, what: 'flood drained' })
  const health = env.bot.runner.health()
  t.diagnostic(`${total} msgs in ${Date.now() - started}ms → ${times.length} model calls, ${sentTexts(env).length} sent, ` +
    `${health.counters.overflow} overflowed to context, ${health.counters.deferred} deferred, peak ${peakRate(times, 1000)}/s`)
  assert.equal(health.counters.received, total)
  assert.ok(health.counters.overflow > 0, 'the backlog was capped')
  assert.ok(health.counters.deferred > 0, 'the rate limit made batches wait')
  assert.ok(peakRate(times, 1000) <= 15, `rate limit held (peak ${peakRate(times, 1000)})`)
  assert.ok(sentTexts(env).length <= times.length, 'never more replies than model calls')
  assertBounded(env)
  await answersAgain(env)
  escaped()
})

test('chaotic model: errors, hangs and garbage trip the breaker, and the bot recovers', async t => {
  const escaped = watchProcess(t)
  let chaos = true
  const env = await group(t, {
    settings: { quietMs: 10, maxWaitMs: 50, modelTimeoutMs: 150, breakerThreshold: 3, breakerBaseMs: 200, breakerMaxMs: 800, correctionRetries: 0 },
    reply: async (input, _call, n) => {
      if (chaos) {
        // The first calls always fail so the breaker must trip; after that it is random chaos.
        const roll = n <= 3 ? 0 : Math.random()
        if (roll < 0.25) throw new Error('model exploded')
        if (roll < 0.35) return new Promise(() => {}) // hangs forever and ignores the abort signal
        if (roll < 0.45) return '这不是 JSON'
      }
      await sleep(between(5, 30))
      return echoReply(input)
    },
  })
  const deadline = Date.now() + 3000 * SCALE
  let n = 0
  while (Date.now() < deadline) {
    say(env, `混乱${n++}`, Math.random() < 0.2 ? { mentions: [BOT.id] } : {})
    await sleep(7)
    assertBounded(env)
  }
  const health = env.bot.runner.health()
  t.diagnostic(`${n} msgs, ${env.model.calls.length} model calls, ${health.counters.modelErrors} failures, ` +
    `breaker trips ${env.bot.chatLog().filter(e => e.type === 'breaker_open').length}, ${sentTexts(env).length} sent`)
  assert.ok(health.counters.modelErrors > 0)
  assert.ok(env.bot.chatLog().some(e => e.type === 'breaker_open'), 'the breaker opened at least once')
  assert.ok(sentTexts(env).length > 0, 'replies still went out during the chaos')
  chaos = false
  await until(() => env.bot.runner.breaker.wait() === 0, { timeoutMs: 2000, what: 'breaker cool-down' })
  await answersAgain(env)
  assert.equal(env.bot.runner.breaker.view().open, false)
  assertBounded(env)
  escaped()
})

test('adapter crash storm: the adapter dies repeatedly under traffic and the bot keeps coming back', async t => {
  const escaped = watchProcess(t)
  const env = await group(t, { settings: { quietMs: 10, maxWaitMs: 50 }, reply: echoReply })
  const crashes = 4 * SCALE
  for (let crash = 0; crash < crashes; crash++) {
    for (let i = 0; i < 40; i++) say(env, `崩溃前${crash}-${i}`, i % 10 === 0 ? { mentions: [BOT.id] } : {})
    await sleep(20)
    const dying = env.simulator
    dying.close()
    await until(() => env.simulator !== dying && env.bot.ready, { timeoutMs: 5000, what: `reconnect after crash ${crash + 1}` })
  }
  t.diagnostic(`${crashes} crashes, ${env.bot.log.filter(e => e.message.includes('已连接适配器')).length} connections, ${sentTexts(env).length} sent on the last adapter`)
  assert.equal(env.bot.chat.id, GROUP, 'still serving the same group')
  await answersAgain(env)
  assertBounded(env)
  escaped()
})

test('flaky sends and a flapping lock screen never duplicate or lose control', async t => {
  const escaped = watchProcess(t)
  const env = await group(t, {
    settings: { quietMs: 10, maxWaitMs: 50, retryDelayMs: 5 },
    reply: input => {
      const target = input.new.findLast(m => m.addressed === 'you')
      return target ? { to: target.id, reply: [`甲${target.text}`, `乙${target.text}`] } : { reply: [] }
    },
  })
  let locked = false
  const flap = setInterval(() => {
    locked = !locked
    env.simulator.handlers()['sim/status']({ canSend: !locked, reason: locked ? 'screen_locked' : undefined })
  }, 60)
  t.after(() => clearInterval(flap))
  const total = 150 * SCALE
  for (let i = 0; i < total; i++) {
    if (Math.random() < 0.3) env.simulator.failNext.push(pick(['send_failed', 'send_uncertain', 'unavailable']))
    say(env, `#${i}`, { mentions: [BOT.id] })
    await sleep(15)
  }
  clearInterval(flap)
  env.simulator.failNext.length = 0
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await until(() => env.bot.runner.status === 'idle' && env.bot.runner.batcher.size === 0, { timeoutMs: 10_000, what: 'drained' })
  const sent = sentTexts(env)
  t.diagnostic(`${total} @s, ${sent.length} parts sent, ${env.bot.runner.counters.sendErrors} send errors`)
  assert.equal(new Set(sent).size, sent.length, 'no message was ever sent twice')
  await answersAgain(env)
  assertBounded(env)
  escaped()
})

test('watchdog: a runner hung on a send that never returns is rebuilt with its context', async t => {
  const escaped = watchProcess(t)
  const env = await group(t, { settings: { quietMs: 10, maxWaitMs: 50, stuckMs: 300, watchdogMs: 50 }, reply: echoReply })
  say(env, '这句话要记住', { from: MEMBERS[0].id })
  await until(() => env.model.calls.length === 1)
  env.bot.adapter.send = () => new Promise(() => {}) // the adapter swallows sends forever
  say(env, '卡住它', { mentions: [BOT.id] })
  await until(() => env.bot.recoveries === 1, { timeoutMs: 3000, what: 'watchdog recovery' })
  assert.ok(env.bot.log.some(e => e.message.includes('已自动重建')))
  delete env.bot.adapter.send
  await answersAgain(env)
  assert.ok(env.bot.runner.transcript.some(m => m.text === '这句话要记住'), 'context survived the rebuild')
  escaped()
})

test('soak: steady traffic with memory writes keeps state and the state file bounded', async t => {
  const escaped = watchProcess(t)
  const env = await group(t, {
    settings: { quietMs: 15, maxWaitMs: 80 },
    reply: input => ({
      reply: [],
      memory: input.new.map(m => ({ who: m.from.id, topic: `话题${Math.floor(Math.random() * 40)}`, note: m.text, evidence: m.id })),
    }),
  })
  const deadline = Date.now() + 4000 * SCALE
  let n = 0
  while (Date.now() < deadline) {
    say(env, `日常聊天第${n++}句`)
    if (n % 20 === 0) await sleep(10)
  }
  await until(() => env.bot.runner.status === 'idle' && env.bot.runner.batcher.size === 0, { timeoutMs: 10_000 })
  await env.bot.store.flush()
  const { size } = await import('node:fs/promises').then(fs => fs.stat(env.bot.store.chatPath(GROUP)))
  t.diagnostic(`${n} msgs, ${Object.keys(env.bot.runner.memory.members).length} members remembered, state file ${(size / 1024).toFixed(0)} KiB`)
  assertBounded(env)
  assert.ok(size < 1024 * 1024, 'state file stays under 1 MiB')
  escaped()
})
