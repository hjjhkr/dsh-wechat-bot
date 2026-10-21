// /cron: scheduled messages. Parsing is structured (no model): a time spec,
// an optional time zone, then the text to send.
//
//   10m / 1h30m / 90s / 2小时 / 30分钟         relative
//   10:00 / 10：00 / 10点 / 10点半 / 9点15分     next occurrence of that clock time
//   明天 10:00 / 后天 8:00 / 2026-10-22 10:00 / 10-22 10:00
//   每天 10:00 / daily 10:00                    repeats every day
//   zone (after the time): UTC+9 / GMT-5 / +09:00 / -0530 / UTC / Asia/Tokyo; default UTC+8
//
// This module is pure (no timers); ChatRunner arms the timers.

export const DEFAULT_ZONE = '+08:00'
export const cronLimits = Object.freeze({
  minDelayMs: 5_000,
  maxHorizonMs: 366 * 86_400_000,
  maxText: 500,
  perMember: 5,
  total: 50,
  graceMs: 10 * 60_000, // a job missed by less than this (e.g. during a restart) still fires, late
})

export class CronError extends Error {}

const UNIT_MS = { d: 86_400_000, 天: 86_400_000, h: 3_600_000, 小时: 3_600_000, 时: 3_600_000, m: 60_000, 分钟: 60_000, 分: 60_000, s: 1000, 秒: 1000 }
const DURATION = /^(?:\d+(?:\.\d+)?(?:d|h|m|s|天|小时|时|分钟|分|秒))+$/
const DURATION_PART = /(\d+(?:\.\d+)?)(d|h|m|s|天|小时|时|分钟|分|秒)/g
const CLOCK = /^(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分?|(半))?)$/
const DATE = /^(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})$/
const RELATIVE_DAYS = { 今天: 0, today: 0, 明天: 1, tomorrow: 1, 后天: 2 }
const DAILY = new Set(['每天', 'daily', 'everyday'])
const OFFSET = /^(?:(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?|([+-])(\d{2}):?(\d{2}))$/i

// ── time zones ────────────────────────────────────────────────────────────

// Returns { name, offsetAt(utcMs) → minutes east of UTC } or null.
export function parseZone(token) {
  const match = OFFSET.exec(token)
  if (match) {
    const [, sign1, hours1, minutes1, sign2, hours2, minutes2] = match
    const sign = (sign1 ?? sign2) === '-' ? -1 : 1
    const hours = Number(hours1 ?? hours2 ?? 0)
    const minutes = Number(minutes1 ?? minutes2 ?? 0)
    if (hours > 14 || minutes > 59) return null
    const offset = sign * (hours * 60 + minutes)
    return { name: formatOffset(offset), offsetAt: () => offset }
  }
  if (!/^[A-Za-z_]+\/[A-Za-z_/+-]+$/.test(token)) return null
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: token, timeZoneName: 'longOffset' })
    return {
      name: token,
      offsetAt(utc) {
        const part = format.formatToParts(utc).find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
        const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(part)
        return m?.[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
      },
    }
  } catch {
    return null
  }
}

export function formatOffset(minutes) {
  if (!minutes) return 'UTC'
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : ''}`
}

// Wall-clock fields of `utc` in `zone`.
function fieldsIn(zone, utc) {
  const d = new Date(utc + zone.offsetAt(utc) * 60_000)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
}

// UTC instant of a wall-clock time in `zone` (two passes settle DST offsets).
export function zonedToUtc(zone, y, mo, d, h, mi) {
  const local = Date.UTC(y, mo - 1, d, h, mi)
  let utc = local - zone.offsetAt(local) * 60_000
  utc = local - zone.offsetAt(utc) * 60_000
  return utc
}

// ── parsing ───────────────────────────────────────────────────────────────

function parseDuration(token) {
  if (!DURATION.test(token)) return null
  let ms = 0
  for (const [, value, unit] of token.matchAll(DURATION_PART)) ms += Number(value) * UNIT_MS[unit]
  return Math.round(ms)
}

function parseClock(token) {
  const m = CLOCK.exec(token)
  if (!m) return null
  const h = Number(m[1])
  const mi = m[2] !== undefined ? Number(m[2]) : m[4] ? 30 : Number(m[3] ?? 0)
  if (h > 23 || mi > 59) throw new CronError(`没有 ${token} 这个时间`)
  return { h, mi }
}

// Reads whitespace-separated tokens off the front of a string; the rest stays verbatim.
function tokenizer(input) {
  let rest = input.trim()
  return {
    peek: () => rest.match(/^\S+/)?.[0],
    take() {
      const token = rest.match(/^\S+/)?.[0]
      if (token) rest = rest.slice(token.length).trimStart()
      return token
    },
    rest: () => rest.trim(),
  }
}

/**
 * Parses the `/cron` argument text into { at, repeat, zone, text } (at = UTC ms of the first run).
 * The message text keeps its own spacing and line breaks.
 * Throws CronError with a human message for anything it cannot use.
 */
export function parseSchedule(input, now = Date.now(), { defaultZone = DEFAULT_ZONE, limits = cronLimits } = {}) {
  const tokens = tokenizer(input)
  let repeat = null
  if (DAILY.has(tokens.peek()?.toLowerCase())) {
    repeat = 'daily'
    tokens.take()
  }
  let dayOffset = null
  let date = null
  const head = tokens.peek()
  if (head && RELATIVE_DAYS[head.toLowerCase()] !== undefined) {
    dayOffset = RELATIVE_DAYS[tokens.take().toLowerCase()]
  } else if (head && DATE.test(head)) {
    const [, y, mo, d] = DATE.exec(tokens.take())
    date = { y: y ? Number(y) : null, mo: Number(mo), d: Number(d) }
  }
  const spec = tokens.take()
  if (!spec) throw new CronError('缺少时间')
  const duration = parseDuration(spec)
  const clock = duration === null ? parseClock(spec) : null
  if (duration === null && !clock) throw new CronError(`看不懂时间「${spec}」`)
  if (duration !== null && (repeat || date || dayOffset !== null)) throw new CronError('相对时间（如 10m）不能和日期或「每天」一起用')

  let zone = parseZone(defaultZone) ?? parseZone(DEFAULT_ZONE)
  const explicit = tokens.peek() && parseZone(tokens.peek())
  if (explicit) {
    zone = explicit
    tokens.take()
  }
  const text = tokens.rest()
  if (!text) throw new CronError('缺少要发的内容')
  if ([...text].length > limits.maxText) throw new CronError(`内容最多 ${limits.maxText} 字`)

  let at
  if (duration !== null) {
    at = now + duration
  } else {
    const today = fieldsIn(zone, now)
    if (date) {
      const y = date.y ?? today.y
      at = zonedToUtc(zone, y, date.mo, date.d, clock.h, clock.mi)
      const check = fieldsIn(zone, at)
      if (check.mo !== date.mo || check.d !== date.d) throw new CronError('没有这一天')
      // A date without a year that already passed means next year.
      if (date.y === null && at <= now) at = zonedToUtc(zone, y + 1, date.mo, date.d, clock.h, clock.mi)
    } else {
      at = zonedToUtc(zone, today.y, today.mo, today.d + (dayOffset ?? 0), clock.h, clock.mi)
      if (dayOffset === null && at <= now) at = zonedToUtc(zone, today.y, today.mo, today.d + 1, clock.h, clock.mi)
    }
  }
  if (at - now < limits.minDelayMs) throw new CronError(at <= now ? '这个时间已经过了' : '至少要 5 秒以后')
  if (at - now > limits.maxHorizonMs) throw new CronError('最多只能定一年以内')
  return { at, repeat, zone: zone.name, text }
}

// Next run of a daily job after `after`, at the same wall-clock time in its zone.
export function nextDaily(job, after) {
  const zone = parseZone(job.zone)
  const first = fieldsIn(zone, job.at)
  const day = fieldsIn(zone, after)
  let at = zonedToUtc(zone, day.y, day.mo, day.d, first.h, first.mi)
  if (at <= after) at = zonedToUtc(zone, day.y, day.mo, day.d + 1, first.h, first.mi)
  return at
}

export function describeTime(at, zoneName, now = Date.now()) {
  const zone = parseZone(zoneName)
  const f = fieldsIn(zone, at)
  const today = fieldsIn(zone, now)
  const clock = `${String(f.h).padStart(2, '0')}:${String(f.mi).padStart(2, '0')}`
  const sameDay = f.y === today.y && f.mo === today.mo && f.d === today.d
  const day = sameDay ? '今天' : `${f.y === today.y ? '' : f.y + '-'}${f.mo}-${f.d}`
  return `${day} ${clock}（${zone.name === 'UTC+8' ? '东八区' : zone.name}）`
}

// ── the job book ──────────────────────────────────────────────────────────

// Persisted list of scheduled messages for one chat.
export class CronBook {
  constructor({ jobs = [], nextId = 1 } = {}, limits = cronLimits) {
    this.jobs = jobs.map(job => ({ ...job }))
    this.nextId = nextId
    this.limits = limits
  }

  toJSON() {
    return { jobs: this.jobs, nextId: this.nextId }
  }

  add({ at, repeat, zone, text }, owner) {
    if (this.jobs.length >= this.limits.total) throw new CronError(`定时已满（最多 ${this.limits.total} 个）`)
    if (this.jobs.filter(j => j.owner.id === owner.id).length >= this.limits.perMember) {
      throw new CronError(`每人最多 ${this.limits.perMember} 个定时，/cron list 看看，/cron cancel 编号 取消`)
    }
    const job = { id: this.nextId++, at, repeat, zone, text, owner: { id: owner.id, name: owner.name }, createdAt: Date.now() }
    this.jobs.push(job)
    return job
  }

  cancel(id, requester) {
    const job = this.jobs.find(j => j.id === id)
    if (!job) throw new CronError(`没有编号 ${id} 的定时`)
    if (job.owner.id !== requester.id) throw new CronError(`#${id} 是 ${job.owner.name} 设的，只能由 TA 取消`)
    this.jobs = this.jobs.filter(j => j !== job)
    return job
  }

  list() {
    return [...this.jobs].sort((a, b) => a.at - b.at)
  }

  nextAt() {
    return this.jobs.reduce((min, job) => Math.min(min, job.at), Infinity)
  }

  // Removes (or advances, for daily jobs) everything due by `now` *before* it is sent,
  // so a crash mid-send can lose one message but never send it twice.
  // Returns { due: jobs to send now, missed: jobs too late to send }.
  takeDue(now = Date.now()) {
    const due = [], missed = []
    for (const job of this.jobs.filter(j => j.at <= now)) {
      ;(now - job.at <= this.limits.graceMs ? due : missed).push({ ...job })
      if (job.repeat === 'daily') job.at = nextDaily(job, now)
      else this.jobs = this.jobs.filter(j => j !== job)
    }
    return { due, missed }
  }
}
