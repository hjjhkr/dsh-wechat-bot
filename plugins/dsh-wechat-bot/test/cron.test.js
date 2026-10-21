import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatRunner } from '../lib/chat.js'
import { CronBook, CronError, cronLimits, describeTime, nextDaily, parseSchedule, parseZone } from '../lib/cron.js'
import { sleep, startBot, until } from './helpers.js'

const GROUP = 'demo@chatroom'
const NOW = Date.UTC(2026, 9, 21, 2, 0) // 2026-10-21 10:00 in UTC+8
const at = (input, now = NOW) => parseSchedule(input, now)
const local = (r, now = NOW) => describeTime(r.at, r.zone, now)

test('cron times: relative, clock, dates, daily, zones; the text stays verbatim', () => {
  assert.equal(at('10m 开会').at, NOW + 10 * 60_000)
  assert.equal(at('1h30m 喝水').at, NOW + 90 * 60_000)
  assert.equal(at('2小时 x').at, NOW + 2 * 3_600_000)
  assert.equal(local(at('10:30 站会')), '今天 10:30（东八区）')
  assert.equal(local(at('9:00 早')), '10-22 09:00（东八区）', 'a passed clock time means tomorrow')
  assert.equal(local(at('10:00 整点')), '10-22 10:00（东八区）', 'exactly now counts as passed')
  assert.equal(local(at('10点半 x')), '今天 10:30（东八区）')
  assert.equal(local(at('9点15分 x')), '10-22 09:15（东八区）')
  assert.equal(local(at('10：45 全角冒号')), '今天 10:45（东八区）')
  assert.equal(local(at('明天 8:00 x')), '10-22 08:00（东八区）')
  assert.equal(local(at('后天 8:00 x')), '10-23 08:00（东八区）')
  assert.equal(local(at('10-01 8:00 x')), '2027-10-1 08:00（东八区）', 'a passed date without a year means next year')
  assert.equal(at('每天 22:00 晚安').repeat, 'daily')
  assert.equal(at('每天 22:00 晚安\n  第二行').text, '晚安\n  第二行')
  // 10:00 UTC+8 is 21:00 the day before in New York (UTC-4 in October).
  assert.equal(at('10:00 UTC-4 x').at, Date.UTC(2026, 9, 21, 14, 0))
  assert.equal(at('10:00 +09:00 x').at, Date.UTC(2026, 9, 22, 1, 0), '10:00 in Tokyo already passed')
  assert.equal(at('10:00 America/New_York x').at, Date.UTC(2026, 9, 21, 14, 0))
  assert.equal(at('12:00 UTC x').at, Date.UTC(2026, 9, 21, 12, 0))
  assert.equal(at('10:30 Tokyo 开会').text, 'Tokyo 开会', 'an unknown zone word is part of the text')
})

test('cron rejects what it cannot schedule, with a reason', () => {
  for (const [input, reason] of [
    ['', /缺少时间/], ['10m', /缺少要发的内容/], ['soon 开会', /看不懂/], ['25:00 x', /没有 25:00/],
    ['10:60 x', /没有/], ['2026-02-30 10:00 x', /没有这一天/], ['2025-01-01 10:00 x', /已经过了/],
    ['今天 9:00 x', /已经过了/], ['2s x', /至少要 5 秒/], ['400d x', /一年以内/], ['每天 10m x', /不能和/],
    ['10m ' + 'x'.repeat(501), /最多 500 字/],
  ]) {
    assert.throws(() => at(input), e => e instanceof CronError && reason.test(e.message), input)
  }
  assert.equal(parseZone('UTC+15'), null)
  assert.equal(parseZone('Mars/Base'), null)
})

test('daily jobs keep their wall-clock time across a DST change', () => {
  // 2026-03-08: New York springs forward; 10:00 local is UTC-5 before, UTC-4 after.
  const before = Date.UTC(2026, 2, 7, 15, 0) // 2026-03-07 10:00 EST
  const job = { at: before, zone: 'America/New_York', repeat: 'daily' }
  const next = nextDaily(job, before)
  assert.equal(next, Date.UTC(2026, 2, 8, 14, 0), '10:00 EDT the next day')
  assert.equal(describeTime(next, 'America/New_York', next), '今天 10:00（America/New_York）')
})

test('the job book: per-member and total limits, owner-only cancel, at-most-once take', () => {
  const limits = { ...cronLimits, perMember: 2, total: 3, graceMs: 20 * 60_000 }
  const book = new CronBook({}, limits)
  const alice = { id: 'a', name: '阿离' }, bob = { id: 'b', name: '老鲍' }
  const job = (minutes, repeat = null) => ({ at: NOW + minutes * 60_000, repeat, zone: 'UTC+8', text: `t${minutes}` })
  book.add(job(10), alice)
  book.add(job(20, 'daily'), alice)
  assert.throws(() => book.add(job(30), alice), /每人最多 2 个/)
  book.add(job(30), bob)
  assert.throws(() => book.add(job(40), bob), /定时已满/)
  assert.throws(() => book.cancel(1, bob), /只能由 TA 取消/)
  assert.throws(() => book.cancel(99, bob), /没有编号 99/)
  assert.deepEqual(book.list().map(j => j.id), [1, 2, 3])

  // At 10:25 #1 and #2 are due; the one-off is removed, the daily one moves to tomorrow.
  const { due, missed } = book.takeDue(NOW + 25 * 60_000)
  assert.deepEqual(due.map(j => j.id), [1, 2])
  assert.deepEqual(missed, [])
  assert.deepEqual(book.list().map(j => j.id), [3, 2])
  assert.equal(book.jobs.find(j => j.id === 2).at, NOW + 20 * 60_000 + 86_400_000)
  assert.deepEqual(book.takeDue(NOW + 25 * 60_000), { due: [], missed: [] }, 'nothing is taken twice')

  // Far past its time (e.g. the bot was off for hours): reported as missed, not sent.
  const late = book.takeDue(NOW + 30 * 60_000 + limits.graceMs + 1)
  assert.deepEqual(late.missed.map(j => j.id), [3])
  assert.deepEqual(late.due, [])
  assert.equal(new CronBook(JSON.parse(JSON.stringify(book))).nextId, 4, 'ids are never reused after a restart')
})

// ── through the whole bot ─────────────────────────────────────────────────

const FAST_CRON = { cronLimits: { minDelayMs: 300, graceMs: 2000 } }
const say = (env, from, text, extra = {}) => env.simulator.inject({ chatId: GROUP, from, text, ...extra })
const sent = env => env.simulator.messages.get(GROUP).filter(m => m.fromSelf).map(m => m.text)

async function watching(t, options = {}) {
  const env = await startBot(t, { ...options, settings: { ...FAST_CRON, ...options.settings } })
  await until(() => env.bot.ready)
  await env.bot.setChat(GROUP)
  return env
}

test('/cron acknowledges at once and sends the text on time, verbatim', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '/cron 1s 喝水\n别忘了')
  await until(() => sent(env).some(s => s.startsWith('已执行：#1')))
  assert.match(sent(env)[0], /今天 \d\d:\d\d（东八区） 发「喝水 别忘了」/)
  assert.equal(env.bot.runner.cron.list().length, 1)
  await until(() => sent(env).includes('喝水\n别忘了'), { timeoutMs: 3000 })
  assert.equal(env.bot.runner.cron.list().length, 0)
  assert.equal(env.model.calls.length, 0, 'no model involved')
})

test('scheduled text is never executed as a command, and mute does not stop it', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '/mute 30')
  say(env, 'wxid_alice', '/cron 1s /mode silent')
  await until(() => sent(env).includes('/mode silent'), { timeoutMs: 3000 })
  await sleep(100)
  assert.equal(env.bot.runner.mode, 'free', 'the echoed text did not switch the mode')
  assert.equal(env.bot.runner.muted, true)
})

test('/cron list and cancel: everyone can see, only the author can cancel', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '/cron 10m 阿离的')
  say(env, 'wxid_bob', '/定时 明天 9:00 UTC-5 老鲍的')
  await until(() => sent(env).filter(s => s.startsWith('已执行')).length === 2)
  say(env, 'wxid_bob', '/cron list')
  await until(() => sent(env).some(s => s.startsWith('#1')))
  const list = sent(env).find(s => s.startsWith('#1'))
  assert.match(list, /#1 今天 .*「阿离的」 阿离\n#2 .*（UTC-5） 「老鲍的」 老鲍/)
  say(env, 'wxid_bob', '/cron cancel #1')
  await until(() => sent(env).some(s => s.includes('只能由 TA 取消')))
  say(env, 'wxid_alice', '/cron cancel 1')
  await until(() => sent(env).some(s => s.startsWith('已执行：取消 #1')))
  assert.deepEqual(env.bot.runner.cron.list().map(j => j.id), [2])
  say(env, 'wxid_alice', '/cron 25:00 x')
  await until(() => sent(env).some(s => s.startsWith('定时没设成：没有 25:00')))
})

test('scheduled messages survive a restart; ones missed for too long are reported, not sent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-bot-cron-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  const first = await watching(t, { dir })
  say(first, 'wxid_alice', '/cron 1s 重启后也要发')
  say(first, 'wxid_bob', '/cron 1s 错过太久的')
  await until(() => first.bot.runner.cron.list().length === 2)
  await first.bot.dispose()

  // Restart 0.5s late: within the grace period → sent (late).
  await sleep(1500)
  const second = await startBot(t, { dir, settings: { ...FAST_CRON } })
  await until(() => sent(second).includes('重启后也要发') && sent(second).includes('错过太久的'), { timeoutMs: 3000 })
  await second.bot.dispose()

  // A job that is far past its time when the bot comes back is logged as missed.
  const third = await startBot(t, { dir, settings: { cronLimits: { minDelayMs: 300, graceMs: 100 } } })
  say(third, 'wxid_alice', '/cron 1s 太晚了')
  await until(() => third.bot.runner?.cron.list().length === 1)
  await third.bot.dispose()
  await sleep(1500)
  const fourth = await startBot(t, { dir, settings: { cronLimits: { minDelayMs: 300, graceMs: 100 } } })
  await until(() => fourth.bot.chatLog().some(e => e.type === 'cron_missed'))
  await sleep(100)
  assert.ok(!sent(fourth).includes('太晚了'))
})

test('a rebuilt runner fires each job once, never twice', async () => {
  const sends = []
  const link = { send: async (content, clientId) => { sends.push(content.text); return { messageId: clientId } }, canSend: () => true, whenCanSend: async () => {} }
  const options = { chat: { id: GROUP, name: '群', kind: 'group' }, persona: '', account: () => ({ id: 'bot', name: '小鲸鱼' }), link, think: async () => '{}' }
  const first = new ChatRunner({ ...options, settings: FAST_CRON })
  first.cron.add({ at: Date.now() + 400, repeat: null, zone: 'UTC+8', text: '只发一次' }, { id: 'a', name: '阿离' })
  const snapshot = first.snapshot()
  first.dispose()
  const second = new ChatRunner({ ...options, state: snapshot, settings: FAST_CRON })
  await sleep(1000)
  second.dispose()
  assert.deepEqual(sends, ['只发一次'])
})

test('far-future jobs never fire early (no setTimeout overflow)', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '/cron 300d 很久以后')
  await until(() => sent(env).some(s => s.startsWith('已执行')))
  await sleep(200)
  assert.ok(!sent(env).includes('很久以后'))
  assert.equal(env.bot.runner.cron.list().length, 1)
})

test('a job due while the screen is locked goes out on unlock', async t => {
  const env = await watching(t)
  say(env, 'wxid_alice', '/cron 1s 锁屏时到点')
  await until(() => sent(env).some(s => s.startsWith('已执行')))
  await env.simulator.handlers()['sim/status']({ canSend: false, reason: 'screen_locked' })
  await until(() => env.bot.chatLog().some(e => e.type === 'cron_fire'), { timeoutMs: 3000 })
  await sleep(100)
  assert.ok(!sent(env).includes('锁屏时到点'))
  await env.simulator.handlers()['sim/status']({ canSend: true })
  await until(() => sent(env).includes('锁屏时到点'))
})

test('daily jobs keep their intended time through a DST gap; 8时 is a clock time; Feb 29 rolls over safely', () => {
  // 02:30 does not exist in New York on 2027-03-14; the job must come back to 02:30 afterwards.
  const created = parseSchedule('每天 2:30 America/New_York 早', Date.UTC(2027, 2, 10, 12))
  const book = new CronBook()
  const job = book.add(created, { id: 'a', name: '阿离' })
  for (const day of [13, 14, 15, 16]) book.takeDue(job.at + 1) // fire four times
  assert.equal(describeTime(job.at, job.zone, job.at), '今天 02:30（America/New_York）')
  assert.equal(local(at('8时 起床')), '10-22 08:00（东八区）')
  assert.equal(local(at('8时30分 起床')), '10-22 08:30（东八区）')
  assert.throws(() => parseSchedule('2-29 10:00 x', Date.UTC(2028, 2, 5)), /明年没有这一天/)
})

test('a job with a zone this runtime cannot read ends as missed instead of breaking the book', () => {
  const book = new CronBook({ jobs: [
    { id: 1, at: NOW - 1000, repeat: 'daily', zone: 'Mars/Olympus', text: '坏的', owner: { id: 'a', name: '阿离' } },
    { id: 2, at: NOW - 1000, repeat: null, zone: 'UTC+8', text: '好的', owner: { id: 'a', name: '阿离' } },
  ], nextId: 3 })
  const { due } = book.takeDue(NOW)
  assert.deepEqual(due.map(j => j.text), ['坏的', '好的'])
  assert.deepEqual(book.list(), [], 'the broken daily job is not rescheduled')
  assert.equal(describeTime(NOW, 'Mars/Olympus', NOW), '今天 10:00（东八区）', 'display falls back instead of throwing')
})

test('a failed save never stops the scheduler', async () => {
  const sends = []
  const link = { send: async (content, clientId) => { sends.push(content.text); return { messageId: clientId } }, canSend: () => true, whenCanSend: async () => {} }
  const owner = { id: 'a', name: '阿离' }
  const book = new CronBook()
  book.add({ at: Date.now() + 100, repeat: null, zone: 'UTC+8', text: '第一个' }, owner)
  book.add({ at: Date.now() + 400, repeat: null, zone: 'UTC+8', text: '第二个' }, owner)
  const runner = new ChatRunner({
    chat: { id: GROUP, name: '群', kind: 'group' }, persona: '', account: () => ({ id: 'bot', name: '小鲸鱼' }), link,
    think: async () => '{}', settings: FAST_CRON, state: { cron: book.toJSON() }, persist: async () => { throw new Error('EPERM') },
  })
  await until(() => sends.length === 2, { timeoutMs: 3000, what: 'both jobs despite failing saves' })
  runner.dispose()
  assert.deepEqual(sends, ['第一个', '第二个'])
  assert.ok(runner.log.some(e => e.type === 'error' && e.message.includes('定时保存失败')))
})
