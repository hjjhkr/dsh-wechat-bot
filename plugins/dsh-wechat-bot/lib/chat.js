import { createHash, randomUUID } from 'node:crypto'
import { FOLLOW_UP_MS, addressOf, nameMatchers } from './addressing.js'
import { Batcher } from './batcher.js'
import { CommandRegistry, MODES, parseCommand } from './commands.js'
import { CronBook, cronLimits, parseSchedule } from './cron.js'
import { DecisionError, parseDecision } from './decision.js'
import { ENGAGEMENT_IDLE_MS, STYLES } from './engagement.js'
import { CircuitBreaker, RateWindow, SendLane, withDeadline } from './guard.js'
import { MemoryBook } from './memory.js'
import { MemoryLearner } from './memory-learning.js'
import { readableBatch, systemPrompt, turnInput } from './prompt.js'
import { ErrorCode } from './protocol.js'
import { MemberRoster } from './roster.js'

export const chatDefaults = Object.freeze({
  mode: 'infer',
  quietMs: 3000,               // a batch closes after this long without new messages…
  holdMs: 6000,                // …or this long when the last message looks unfinished ("在吗", "问个事", "，")
  maxWaitMs: 12_000,           // and never later than this after its first message
  maxMessages: 20,
  maxChars: 6000,
  recentLimit: 30,
  maxParts: 3,
  correctionRetries: 1,
  staleMs: 10 * 60_000,
  idleMinutes: 0,
  sendRetries: 2,
  retryDelayMs: 2000,
  typingDelay: true,
  // Guardrails
  maxTextChars: 2000,          // longer messages are truncated before anything else sees them
  maxTurnsPerMinute: 8,        // model calls per minute; extra batches wait (and merge) instead of spamming
  rateWindowMs: 60_000,
  modelTimeoutMs: 90_000,      // one model call never takes longer than this
  breakerThreshold: 3,         // consecutive model failures before pausing model calls
  breakerBaseMs: 30_000,       // first pause; doubles on each repeated trip
  breakerMaxMs: 10 * 60_000,
  commandsPerMinute: 6,        // per member, so commands cannot be used to spam the group
  echoWindowMs: 2 * 60_000,    // how long a sent text may take to come back from the adapter
  cronZone: '+08:00',          // time zone of /cron times without an explicit zone
  engagementIdleMs: ENGAGEMENT_IDLE_MS, // /attack, /comfort end after the target is silent this long
  // Background memory learning (only when a `learn` model call is given)
  memoryLearning: true,
  memoryQuietMs: 2000,
  memoryMaxWaitMs: 15_000,
  memoryCallsPerMinute: 2,     // its own budget: never takes calls from replies
  memoryRateWindowMs: 60_000,
  memoryTimeoutMs: 30_000,
  // Member list (current names of everyone in the group)
  memberLookupTimeoutMs: 1500, // a reply waits at most this long when no list is known yet
  memberCacheTtlMs: 5000,
})

const LOG_LIMIT = 300
const SEEN_LIMIT = 1000
const NOTICE_INTERVAL_MS = 5000
const COMMAND_SENDERS_LIMIT = 500
// Scheduled messages are checked at least this often, so long delays, sleep and clock changes are safe.
const CRON_TICK_MS = 60_000
// Signals that count as "@" for the `at` mode.
const AT_REASONS = new Set(['at_you', 'quotes_you', 'direct_chat'])

// Pace multi-part replies like someone typing.
const typingMs = text => Math.min(600 + 150 * [...text].length, 4000)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const today = () => new Date().toLocaleDateString('sv')

class Interrupted extends Error {
  constructor(reason) {
    super(`interrupted by ${reason}`)
    this.name = 'Interrupted'
  }
}

// The one group the bot serves. Messages are processed strictly in order:
// collect a batch, ask the model once, deliver the reply, take the next batch.
// Commands are the exception: they run on arrival, their output jumps the send
// queue, and state-changing ones interrupt an answer still being thought out.
export class ChatRunner {
  /**
   * @param {object} o
   * @param {{id,name,kind}} o.chat
   * @param {object} [o.state]      snapshot() of a previous run
   * @param {object} o.settings     chatDefaults overrides plus aliases/stickers
   * @param {string} o.persona
   * @param {() => {id,name}} o.account
   * @param {{send(content, clientId), canSend(): boolean, whenCanSend(signal): Promise}} o.link
   * @param {({chat, system, messages, readable, effort, signal}) => Promise<string>} o.think
   * @param {CommandRegistry} [o.commands]
   * @param {(type: 'log'|'status'|'change', payload?) => void} [o.emit]
   * @param {() => Promise<void>} [o.persist]  writes snapshot() to disk now
   * @param {import('./models.js').ModelControl} [o.models]  for /model and /think
   */
  constructor({ chat, state = {}, settings, persona, account, link, think, learn, commands, emit, persist, models }) {
    this.chat = chat
    this.settings = { ...chatDefaults, ...settings }
    this.persona = persona
    this.account = account
    this.link = link
    this.think = think
    this.learn = learn
    this.commands = commands ?? new CommandRegistry()
    this.emit = emit ?? (() => {})
    this.persist = persist ?? (async () => {})
    this.models = models
    this.transcript = state.transcript ?? []
    this.memory = new MemoryBook(state.memory)
    this.log = state.log ?? []
    // Whom the bot answered recently, one entry per member: their next message may be a follow-up.
    this.lastBotTurns = state.lastBotTurns ?? (state.lastBotTurn?.toSenderId ? [state.lastBotTurn] : [])
    // Messages of members who used /forget: never evidence for a note again.
    this.forgottenEvidence = new Set(state.forgottenEvidence ?? [])
    // Only a mode chosen explicitly (console, /mode, tool) is persisted; otherwise config decides.
    this.modeOverride = MODES[state.mode] ? state.mode : undefined
    this.mutedUntil = state.mutedUntil ?? 0
    this.stats = state.stats?.date === today() ? state.stats : { date: today(), batches: 0, sent: 0 }
    this.seen = new Set(this.transcript.map(m => m.id))
    this.sentIds = new Set()
    this.echoes = []
    this.status = 'idle'
    this.busySince = 0
    this.turn = null
    this.abort = new AbortController()
    this.lane = new SendLane()
    this.rate = new RateWindow(this.settings.maxTurnsPerMinute, this.settings.rateWindowMs)
    this.breaker = new CircuitBreaker({
      threshold: this.settings.breakerThreshold, baseMs: this.settings.breakerBaseMs, maxMs: this.settings.breakerMaxMs,
    })
    this.commandRates = new Map()
    this.counters = { received: 0, overflow: 0, deferred: 0, interrupted: 0, modelErrors: 0, breakerTrips: 0, sendErrors: 0, internalErrors: 0 }
    this.notices = {}
    this.batcher = new Batcher(this.settings, batch => this.#run(batch), () => this.#overflow())
    this.cronLimits = { ...cronLimits, ...this.settings.cronLimits }
    this.cron = new CronBook(state.cron, this.cronLimits)
    this.engagement = state.engagement ?? null // { id, style, target: {id, name}, since, lastTargetAt }
    this.roster = new MemberRoster({
      fetch: async () => (await this.link.members?.()) ?? [],
      ttlMs: this.settings.memberCacheTtlMs, timeoutMs: this.settings.memberLookupTimeoutMs, signal: this.abort.signal,
      onChange: () => this.emit('change'), onNotice: (type, data) => this.#notice(type, data),
      state: { members: state.memberCache, at: state.memberCacheAt },
    })
    this.learner = learn && this.settings.memoryLearning ? new MemoryLearner({
      learn, settings: this.settings,
      context: async batch => ({
        chat: this.chat, self: this.account(), members: await this.#members(), recent: this.#recent(batch), memory: this.#memoryFor(batch),
      }),
      apply: (updates, evidence) => this.memory.apply(updates, evidence),
      forgotten: id => this.forgottenEvidence.has(id),
      write: (type, data) => this.#write(type, data),
      notice: (type, data) => this.#notice(type, data),
      saved: async () => {
        this.emit('change')
        await this.persist()
      },
    }) : null
    this.selfNames = [] // the bot's own names in this group (e.g. its group nickname), from the member list
    this.#members() // learn them now; best-effort
    this.#scheduleIdle()
    this.#armCron(0)
  }

  // What the console and the watchdog need to know.
  health(now = Date.now()) {
    return {
      status: this.status, mode: this.mode, mutedUntil: this.mutedUntil,
      backlog: this.batcher.size, busyMs: this.stuckFor(now),
      breaker: this.breaker.view(now), turnsLastMinute: this.rate.used, counters: { ...this.counters },
      members: this.roster.view(),
      engagement: this.engagement && now - this.engagement.lastTargetAt <= this.settings.engagementIdleMs
        ? { style: this.engagement.style, target: this.engagement.target } : null,
    }
  }

  snapshot() {
    return {
      transcript: this.transcript.slice(-this.settings.recentLimit * 2),
      memory: this.memory.toJSON(),
      log: this.log.slice(-LOG_LIMIT),
      lastBotTurns: this.lastBotTurns,
      forgottenEvidence: [...this.forgottenEvidence].slice(-SEEN_LIMIT),
      memberCache: this.roster.members, memberCacheAt: this.roster.at,
      mode: this.modeOverride,
      mutedUntil: this.mutedUntil,
      stats: this.stats,
      cron: this.cron.toJSON(),
      engagement: this.engagement,
    }
  }

  get mode() {
    return this.modeOverride ?? this.settings.mode
  }

  dispose() {
    this.disposed = true
    this.abort.abort()
    this.learner?.dispose()
    this.batcher.clear()
    clearTimeout(this.idleTimer)
    clearTimeout(this.cronTimer)
  }

  // How long the runner has been thinking or sending without finishing (0 when idle or waiting).
  stuckFor(now = Date.now()) {
    return this.busySince ? now - this.busySince : 0
  }

  setMode(mode) {
    if (!MODES[mode]) throw new Error(`unknown mode ${mode}`)
    this.modeOverride = mode
    this.#write('mode', { mode })
    this.#scheduleIdle()
  }

  mute(ms) {
    this.mutedUntil = ms > 0 ? Date.now() + ms : 0
    this.#write('mute', { until: this.mutedUntil })
  }

  get muted() {
    return this.mutedUntil > Date.now()
  }

  // Never throws: one bad message must not stop the chat.
  receive(message) {
    try {
      this.#receive(message)
    } catch (error) {
      this.counters.internalErrors++
      this.#write('error', { message: `处理消息失败：${error.message}` })
    }
  }

  #receive(message) {
    if (this.disposed || this.seen.has(message.id)) return
    this.#remember(message.id)
    // Our own reply coming back (by id, or by text when the adapter only queued it).
    if (message.fromSelf && (this.sentIds.has(message.id) || this.#isEcho(message))) return
    if (message.text.length > this.settings.maxTextChars) {
      message = { ...message, text: message.text.slice(0, this.settings.maxTextChars) + '…（太长，已截断）' }
    }
    if (message.fromSelf) {
      // Someone typing on the bot account's phone: context only.
      this.#record(message)
      return
    }
    this.counters.received++
    // Expire first: the target coming back after a long silence does not revive an engagement.
    if (this.#activeEngagement()?.target.id === message.sender.id) {
      this.engagement.lastTargetAt = Date.now()
      this.engagement.target.name = message.sender.name // keyed by id; the label follows renames
    }
    this.#record(message)
    this.#write('message', { id: message.id, from: message.sender.name, text: message.text, kind: message.kind })
    this.#scheduleIdle()
    const parsed = message.kind === 'text' ? parseCommand(message.text) : null
    const command = parsed && this.commands.get(parsed.name)
    if (command) {
      this.#command(message, command, parsed).catch(error => !this.disposed && this.#write('error', { message: `/${command.name}: ${error.message}` }))
      return
    }
    this.batcher.push(message)
  }

  // Prime the context with history that should not be answered.
  prime(messages) {
    for (const message of messages) {
      if (this.seen.has(message.id)) continue
      this.#remember(message.id)
      this.#record(message)
    }
    this.transcript.sort((a, b) => a.time - b.time)
  }

  #remember(id) {
    this.seen.add(id)
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value)
  }

  #record(message) {
    this.transcript.push(message)
    if (this.transcript.length > this.settings.recentLimit * 3) this.transcript.splice(0, this.settings.recentLimit)
    this.emit('change')
  }

  #isEcho(message) {
    const now = Date.now()
    this.echoes = this.echoes.filter(e => now - e.at < this.settings.echoWindowMs)
    const index = this.echoes.findIndex(e => e.text === message.text)
    if (index < 0) return false
    this.echoes.splice(index, 1)
    return true
  }

  #write(type, data) {
    const entry = { time: Date.now(), type, ...data }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT * 2) this.log.splice(0, LOG_LIMIT)
    this.emit('log', entry)
  }

  // Writes at most one entry of `type` per few seconds (floods would drown the log otherwise).
  #notice(type, data) {
    const now = Date.now()
    if (now - (this.notices[type] ?? 0) < NOTICE_INTERVAL_MS) return
    this.notices[type] = now
    this.#write(type, data)
  }

  #overflow() {
    this.counters.overflow++
    this.#notice('overflow', { total: this.counters.overflow })
  }

  #setStatus(status) {
    const busy = status === 'thinking' || status === 'sending'
    if (!busy) this.busySince = 0
    else if (this.status !== status || !this.busySince) this.busySince = Date.now()
    this.status = status
    this.emit('status', status)
  }

  // ── commands: run on arrival, reply first, interrupt stale thinking ───────

  #commandAllowed(senderId) {
    let window = this.commandRates.get(senderId)
    if (!window) {
      if (this.commandRates.size >= COMMAND_SENDERS_LIMIT) this.commandRates.delete(this.commandRates.keys().next().value)
      window = new RateWindow(this.settings.commandsPerMinute, this.settings.rateWindowMs)
      this.commandRates.set(senderId, window)
    }
    if (window.wait()) return false
    window.record()
    return true
  }

  // Aborts the model call that is still thinking; its batch is reconsidered afterwards
  // under whatever the command changed (mode, mute, memory, context).
  #interrupt(reason) {
    if (this.status !== 'thinking' || !this.turn || this.turn.interrupted) return
    this.turn.interrupted = reason
    this.turn.controller.abort(new Interrupted(reason))
  }

  async #command(message, command, parsed) {
    if (!this.#commandAllowed(message.sender.id)) {
      return this.#notice('command_throttled', { from: message.sender.name, name: command.name })
    }
    this.#write('command', { name: command.name, from: message.sender.name, text: parsed.text })
    if (command.interrupts) this.#interrupt(`/${command.name}`)
    let result
    try {
      result = await command.run({
        ...parsed, sender: message.sender, chat: this.chat, message,
        mode: this.mode,
        setMode: mode => this.setMode(mode),
        mute: ms => this.mute(ms),
        memory: {
          recall: id => this.memory.recall([id])[id] ?? {},
          forget: (id, topic) => {
            this.learner?.cancel()
            for (const m of this.transcript) if (m.sender.id === id) this.forgottenEvidence.add(m.id)
            while (this.forgottenEvidence.size > SEEN_LIMIT) this.forgottenEvidence.delete(this.forgottenEvidence.values().next().value)
            return this.memory.forget(id, topic)
          },
        },
        resetContext: () => {
          this.learner?.cancel()
          this.transcript = []
          this.lastBotTurns = []
        },
        status: () => ({
          mode: this.mode, mutedUntil: this.mutedUntil, today: this.stats,
          context: this.transcript.length, members: Object.keys(this.memory.members).length,
          engagement: this.#activeEngagement(),
        }),
        commands: this.commands.list(),
        models: this.models,
        selfId: this.account().id,
        members: () => this.#members({ fresh: true }),
        engagement: {
          current: () => this.#activeEngagement(),
          start: (style, target) => {
            const previous = this.#activeEngagement()
            this.engagement = { id: randomUUID(), style, target: { id: target.id, name: target.name }, since: Date.now(), lastTargetAt: Date.now() }
            this.#write('engagement_start', { style, target: target.name })
            this.emit('change')
            return previous
          },
          stop: () => {
            const ended = this.engagement
            this.engagement = null
            if (ended) this.#write('engagement_end', { style: ended.style, target: ended.target.name, reason: 'command' })
            this.emit('change')
            return ended
          },
        },
        cron: {
          add: text => {
            const job = this.cron.add(parseSchedule(text, Date.now(), { defaultZone: this.settings.cronZone, limits: this.cronLimits }), message.sender)
            this.#write('cron_set', { id: job.id, at: job.at, text: job.text, from: message.sender.name })
            this.#armCron(0)
            this.emit('change')
            return job
          },
          list: () => this.cron.list(),
          cancel: id => {
            const job = this.cron.cancel(id, message.sender)
            this.#armCron(0)
            this.emit('change')
            return job
          },
        },
      })
    } catch (error) {
      this.#write('error', { message: `/${command.name}: ${error.message}` })
      return this.#say(`/${command.name} 出错了`)
    }
    if (typeof result === 'string') return this.#say(result)
    if (result?.reply) return this.#say(result.reply)
    if (result?.forward) {
      const { text = parsed.text, instruction, effort, engagement } = result.forward
      const ackText = result.forward.ack ?? command.ack
      const ack = ackText && this.#say(ackText)
      this.batcher.pushUrgent({ ...message, text, command: { name: command.name, instruction, effort, engagement } })
      await ack
    }
  }

  // Command output: sent ahead of any reply parts still waiting to go out.
  async #say(text) {
    const result = await this.#sendOne({ kind: 'text', text }, `say:${randomUUID()}`, { started: Date.now(), urgent: true })
    if (result) this.#sent(result.messageId, { kind: 'text', text })
  }

  // ── targeted engagement (/attack, /comfort) ─────────────────────────────

  // The engagement still in force, ending it if the target has been silent too long.
  #activeEngagement() {
    const engagement = this.engagement
    if (!engagement) return null
    if (Date.now() - engagement.lastTargetAt > this.settings.engagementIdleMs) {
      this.engagement = null
      this.#write('engagement_end', { style: engagement.style, target: engagement.target.name, reason: 'idle' })
      this.emit('change')
      return null
    }
    return engagement
  }

  // Everyone the bot knows in this chat, keyed by id with their latest names: the adapter's
  // member list (read fresh), plus whoever spoke recently (latest message wins).
  async #members({ fresh = false } = {}) {
    const listed = await this.roster.list({ fresh })
    const known = new Map(listed.map(m => [m.id, { id: m.id, name: m.name, aliases: m.aliases ?? [] }]))
    // Someone who spoke after the list was read shows the name they spoke under.
    for (const m of this.transcript) {
      if (!known.has(m.sender.id) || m.time >= this.roster.at) {
        known.set(m.sender.id, { id: m.sender.id, name: m.sender.name, aliases: m.sender.aliases ?? [] })
      }
    }
    const self = known.get(this.account()?.id)
    if (self) this.selfNames = [self.name, ...self.aliases]
    return [...known.values()]
  }

  // ── model turns ─────────────────────────────────────────────────────────

  #names() {
    return nameMatchers([this.account().name, ...this.selfNames, ...(this.settings.aliases ?? [])])
  }

  #addresses(batch) {
    const context = { chatKind: this.chat.kind, self: this.account(), names: this.#names(), lastBotTurns: this.lastBotTurns }
    return new Map(batch.map(m => {
      const index = this.transcript.findIndex(item => item.id === m.id)
      const recent = index < 0 ? this.transcript.filter(item => item.time <= m.time) : this.transcript.slice(0, index)
      return [m.id, m.command ? { addressed: 'you', reasons: ['command'] }
        : addressOf(this.#withQuoteSender(m), { ...context, recent })]
    }))
  }

  // Adapters may identify a quoted message only by id; look its sender up locally.
  #withQuoteSender(message) {
    if (!message.quote?.messageId || message.quote.senderId) return message
    const quoted = this.transcript.find(m => m.id === message.quote.messageId)
    return quoted ? { ...message, quote: { ...message.quote, senderId: quoted.sender.id, senderName: quoted.sender.name } } : message
  }

  #recent(excluding) {
    const skip = new Set(excluding.map(m => m.id))
    return this.transcript.filter(m => !skip.has(m.id)).slice(-this.settings.recentLimit)
  }

  #memoryFor(batch) {
    const ids = new Set(batch.map(m => m.sender.id))
    for (const m of this.transcript.slice(-10)) if (!m.fromSelf) ids.add(m.sender.id)
    return this.memory.recall(ids)
  }

  // Asks the model about `batch` without sending or remembering anything (dry runs, evaluation).
  decide(batch, event) {
    const address = this.#addresses(batch)
    const mustReply = batch.some(m => address.get(m.id).addressed === 'you')
    return this.#decide({ batch, address, event, mustReply, signal: this.abort.signal })
  }

  // Why this batch should not reach the model at all (the messages stay as context).
  #skipReason(batch, address) {
    if (batch.some(m => m.command)) return null
    if (this.muted) return 'muted'
    const signals = batch.map(m => address.get(m.id))
    switch (this.mode) {
      case 'silent': return 'silent_mode'
      case 'at': return signals.some(a => a.reasons.some(r => AT_REASONS.has(r))) ? null : 'at_only'
      case 'infer': return signals.some(a => a.addressed === 'you' || a.addressed === 'maybe') ? null : 'not_for_me'
      default: return null
    }
  }

  async #run(batch, event) {
    let deferMs = 0
    try {
      deferMs = await this.#turn(batch, event) ?? 0
    } catch (error) {
      if (!this.disposed) this.#write('error', { message: error.message, code: error.code })
    } finally {
      this.#setStatus(deferMs ? 'throttled' : 'idle')
      if (!this.disposed) {
        if (deferMs) this.batcher.defer(deferMs)
        else this.batcher.release()
      }
    }
  }

  // Thinking does not wait for the adapter to be able to send (e.g. a locked screen):
  // the reply waits in #sendOne instead, and is dropped if it goes stale meanwhile.
  // Returns a delay in ms when the batch was put back to wait for the rate limit / breaker.
  async #turn(batch, event) {
    const started = Date.now()
    // An /attack or /comfort opening whose engagement was stopped or replaced meanwhile is not wanted any more.
    const stale = batch.filter(m => m.command?.engagement && m.command.engagement !== this.engagement?.id)
    if (stale.length) {
      this.#write('skipped', { reason: 'engagement_changed', count: stale.length })
      batch = batch.filter(m => !stale.includes(m))
      if (!batch.length && !event) return
    }
    const urgent = batch.some(m => m.command)
    // Engaged with one member: the script decides — only their messages trigger a reply, one per batch.
    const engagement = !urgent && !event ? this.#activeEngagement() : null
    if (engagement) {
      const fromTarget = batch.filter(m => m.sender.id === engagement.target.id)
      this.learner?.queue(batch.filter(m => m.sender.id !== engagement.target.id))
      if (!fromTarget.length) return void this.#write('skipped', { reason: 'engaged', count: batch.length })
      if (this.muted || this.mode === 'silent') return void this.#write('skipped', { reason: 'muted', count: batch.length })
      batch = fromTarget
      event = { kind: 'engagement', style: engagement.style, target: engagement.target }
    }
    const address = this.#addresses(batch)
    const skip = event ? null : this.#skipReason(batch, address)
    if (skip) {
      this.learner?.queue(batch)
      return void this.#write('skipped', { reason: skip, count: batch.length,
        addressed: Object.fromEntries([...address].map(([id, a]) => [id, a.addressed])),
        why: Object.fromEntries([...address].map(([id, a]) => [id, a.reasons])) })
    }
    if (urgent) {
      // Explicit requests skip the rate limit, but an open breaker means the model is down.
      if (this.breaker.wait()) return void this.#say('模型暂时不可用，稍后再试')
    } else {
      const wait = Math.max(this.rate.wait(), this.breaker.wait())
      if (wait) {
        if (!batch.length) return
        this.counters.deferred++
        this.batcher.requeue(batch)
        this.#notice('deferred', { reason: this.breaker.wait() ? 'breaker_open' : 'rate_limited', waitMs: wait })
        return wait
      }
    }
    if (batch.length) {
      this.#write('batch', { count: batch.length, addressed: Object.fromEntries([...address].map(([id, a]) => [id, a.addressed])) })
      if (this.stats.date !== today()) this.stats = { date: today(), batches: 0, sent: 0 }
      this.stats.batches++
    }
    this.#setStatus('thinking')
    const mustReply = event?.kind === 'engagement' || batch.some(m => address.get(m.id).addressed === 'you')
    const turn = this.turn = { controller: new AbortController(), interrupted: null }
    let decision
    try {
      decision = await this.#decide({ batch, address, event, mustReply, signal: AbortSignal.any([this.abort.signal, turn.controller.signal]) })
      this.breaker.success()
      if (turn.interrupted) return this.#reconsider(batch, turn.interrupted)
    } catch (error) {
      if (this.disposed) return
      if (turn.interrupted) return this.#reconsider(batch, turn.interrupted)
      this.counters.modelErrors++
      const coolDown = this.breaker.failure()
      if (coolDown) {
        this.counters.breakerTrips++
        this.#write('breaker_open', { coolDownMs: coolDown, reason: error.code ?? error.message })
      }
      throw error
    } finally {
      this.turn = null
    }
    if (this.disposed) return

    // A reply answers what had arrived when thinking started; later messages form the next batch.
    // Only an unprompted idle remark is dropped if people started talking meanwhile.
    if (event?.kind === 'idle' && this.batcher.arrived) return void this.#write('idle_dropped', { newer: this.batcher.arrived })

    if (batch.length) {
      if (this.learner) {
        // Notes come from the separate learner, which reads the raw evidence without the persona.
        this.learner.queue(batch)
      } else {
        const evidence = decision.evidence.filter(m => !this.forgottenEvidence.has(m.id))
        const { applied, rejected } = this.memory.apply(decision.memory, evidence)
        if (applied.length || rejected.length) this.#write('memory', { applied, rejected })
      }
    }
    if (!decision.reply.length) {
      this.#write('silent', {})
      return void this.emit('change')
    }
    // In an engagement the script knows whom the reply is for; the model's `to` is not needed.
    const target = event?.kind === 'engagement' ? batch.at(-1) : batch.find(m => m.id === decision.to)
    const engagementId = event?.kind === 'engagement' ? engagement.id : batch.find(m => m.command?.engagement)?.command.engagement
    const sendStarted = Date.now()
    await this.#deliver(decision.reply, { batch, target, event, started, engagementId })
    this.#write('latency', { modelMs: decision.modelMs, sendMs: Date.now() - sendStarted,
      queueMs: batch.length ? Math.max(0, started - Math.min(...batch.map(m => m.time))) : 0,
      totalMs: batch.length ? Math.max(0, Date.now() - Math.min(...batch.map(m => m.time))) : Date.now() - started })
  }

  // An interrupted batch goes back where it came from; the next turn sees the new state.
  #reconsider(batch, reason) {
    this.counters.interrupted++
    this.#write('interrupted', { reason, count: batch.length })
    const commands = batch.filter(m => m.command)
    this.batcher.requeue(batch.filter(m => !m.command))
    for (const message of commands.reverse()) this.batcher.pushUrgent(message, { front: true })
  }

  async #decide({ batch, address, event, mustReply, signal }) {
    const modelStarted = Date.now()
    const settings = this.settings
    const stickers = Object.keys(settings.stickers ?? {})
    const system = systemPrompt(this.persona, { maxParts: settings.maxParts, stickers, memory: !this.learner })
    const recent = this.#recent(batch).map(m => this.#withQuoteSender(m))
    const members = await this.#members()
    const input = turnInput({
      chat: this.chat, self: this.account(), aliases: settings.aliases ?? [],
      members, recent, batch: batch.map(m => this.#withQuoteSender(m)), address, memory: this.#memoryFor(batch), event,
    })
    const messages = [{ role: 'user', text: input }]
    const readable = event?.kind === 'idle' ? `${this.chat.name}：冷场 ${event.minutes} 分钟，看看要不要主动说话` : readableBatch(this.chat, batch, address, event)
    const effort = batch.find(m => m.command?.effort)?.command.effort
    let retries = settings.correctionRetries
    for (;;) {
      this.rate.record()
      const output = await withDeadline(
        callSignal => this.think({ chat: this.chat, system, messages, readable, effort, signal: callSignal }),
        settings.modelTimeoutMs, signal)
      let problem
      try {
        const decision = parseDecision(output, { batch, maxParts: settings.maxParts, stickers })
        if (mustReply && !decision.reply.length) {
          problem = new DecisionError('must_reply', event?.kind === 'engagement'
            ? `你正在按命令回应 ${event.target.name}，TA 刚说了话，reply 不能为空`
            : 'new 里有 addressed=you 的消息，有人在直接找你，reply 不能为空')
        } else {
          this.#write('decision', { to: decision.to, reply: decision.reply, raw: output })
          // Memory may cite any message the model was shown, recent or new, by its id.
          return { ...decision, evidence: [...recent, ...batch], modelMs: Date.now() - modelStarted }
        }
      } catch (error) {
        if (!(error instanceof DecisionError)) throw error
        problem = error
      }
      this.#write('invalid_output', { code: problem.code, raw: output })
      if (retries-- <= 0) {
        if (problem.code === 'must_reply') return { to: null, reply: [], memory: [] }
        throw problem
      }
      messages.push({ role: 'assistant', text: output }, { role: 'user', text: `上一次输出不符合要求：${problem.hint}。请重新输出完整 JSON。` })
    }
  }

  // ── delivery ────────────────────────────────────────────────────────────

  async #deliver(parts, { batch, target, event, started, engagementId }) {
    this.#setStatus('sending')
    const turnId = createHash('sha256').update(this.chat.id + '\0' + (batch.map(m => m.id).join('\0') || `idle:${event?.at}`)).digest('hex').slice(0, 16)
    const commanded = batch.some(m => m.command)
    // A /mute or /mode silent that arrives mid-reply stops the rest of it (explicit /ask etc. still finish).
    // Likewise, /unattack or a new target stops what is left of a reply that belongs to the old engagement.
    const blocked = () => engagementId && this.engagement?.id !== engagementId ? 'engagement_changed'
      : !commanded && (this.muted || this.mode === 'silent') ? 'muted' : null
    for (const [index, part] of parts.entries()) {
      if (index && this.settings.typingDelay) await sleep(typingMs(part.text ?? ''))
      const content = part.kind === 'sticker'
        ? { kind: 'sticker', path: this.settings.stickers[part.name] }
        : { kind: 'text', text: part.text }
      const result = await this.#sendOne(content, `${turnId}:${index}`, { started, blocked, ownsStatus: true })
      if (!result) return
      this.#sent(result.messageId, part)
      if (target?.sender.id) this.#answered(target)
    }
  }

  // Remembers that the bot just answered this member (one entry per member, recent ones only).
  #answered(target) {
    const now = Date.now()
    const turn = { time: now, toSenderId: target.sender.id, sourceTime: target.time }
    this.lastBotTurns = [...this.lastBotTurns.filter(t => t.toSenderId !== turn.toSenderId && now - t.time <= FOLLOW_UP_MS), turn]
      .slice(-COMMAND_SENDERS_LIMIT)
  }

  #sent(messageId, part) {
    this.sentIds.add(messageId)
    this.stats.sent++
    const text = part.kind === 'sticker' ? part.name : part.text
    if (part.kind === 'text') this.echoes.push({ text, at: Date.now() })
    // The adapter's echo of this message may already have arrived and been recorded.
    if (!this.seen.has(messageId)) {
      this.#remember(messageId)
      this.#record({
        id: messageId, chatId: this.chat.id, time: Date.now(), kind: part.kind, fromSelf: true,
        text, sender: this.account(), mentions: [],
      })
    }
    this.#write('sent', { part, messageId })
  }

  // All sends go through one lane, so command output (urgent) overtakes reply parts.
  #sendOne(content, clientId, { urgent = false, ...options }) {
    return this.lane.run(() => this.#sendNow(content, clientId, options), { urgent })
  }

  // Waits while sending is impossible (e.g. locked screen), drops the reply once
  // it is stale, retries definite failures, and never repeats an uncertain send.
  // `blocked()` may return a reason to give up (checked again after every wait).
  async #sendNow(content, clientId, { started, blocked = () => null, ownsStatus = false }) {
    let failures = 0
    for (;;) {
      if (this.disposed) return null
      if (!this.link.canSend()) {
        if (ownsStatus) this.#setStatus('waiting')
        this.#write('waiting', { reason: 'adapter_cannot_send' })
        try {
          await this.link.whenCanSend(this.abort.signal)
        } catch {
          return null
        }
        if (ownsStatus && this.status === 'waiting') this.#setStatus('sending')
        if (this.disposed) return null
      }
      const reason = Date.now() - started > this.settings.staleMs ? 'stale' : blocked()
      if (reason) {
        this.#write('dropped', { reason, clientId })
        return null
      }
      try {
        const result = await this.link.send(content, clientId)
        return { messageId: result?.messageId ?? clientId }
      } catch (error) {
        if (error.code === ErrorCode.Unavailable) {
          await sleep(this.settings.retryDelayMs)
          continue
        }
        if (error.code === ErrorCode.SendFailed && failures++ < this.settings.sendRetries) {
          await sleep(this.settings.retryDelayMs * failures)
          continue
        }
        // A duplicate message is worse than a missing one, so anything but a definite failure is final.
        this.counters.sendErrors++
        this.#write('send_error', { code: error.code, message: error.message, uncertain: error.code !== ErrorCode.SendFailed, clientId })
        return null
      }
    }
  }

  // ── scheduled messages (/cron) ──────────────────────────────────────────

  #armCron(delay) {
    clearTimeout(this.cronTimer)
    if (this.disposed) return
    const next = this.cron.nextAt()
    if (next === Infinity) return
    const wait = delay ?? Math.min(Math.max(0, next - Date.now()), CRON_TICK_MS)
    this.cronTimer = setTimeout(() => this.#cronTick().catch(error => this.#write('error', { message: `定时：${error.message}` })), Math.min(wait, CRON_TICK_MS))
    this.cronTimer.unref?.()
  }

  // Jobs are taken off the book and the book is saved *before* sending: a crash can
  // lose one scheduled message but can never send it twice.
  async #cronTick() {
    if (this.disposed) return
    let taken
    try {
      taken = this.cron.takeDue()
    } finally {
      this.#armCron()
    }
    const { due, missed } = taken
    if (!due.length && !missed.length) return
    try {
      await this.persist()
    } catch (error) {
      // Sending anyway: the book in memory is already advanced, so this run cannot repeat
      // while the process lives; a crash before the next successful save could repeat it once.
      this.#write('error', { message: `定时保存失败：${error.message}` })
    }
    for (const job of missed) this.#write('cron_missed', { id: job.id, text: job.text, at: job.at })
    this.emit('change')
    for (const job of due) {
      this.#write('cron_fire', { id: job.id, text: job.text })
      // Plain text, never executed as a command; explicit, so mute/silent do not apply.
      await this.#say(job.text)
    }
  }

  // ── idle checks ─────────────────────────────────────────────────────────

  #scheduleIdle() {
    clearTimeout(this.idleTimer)
    const minutes = this.settings.idleMinutes
    if (!minutes || this.chat.kind !== 'group' || this.mode !== 'free' || this.disposed) return
    this.idleTimer = setTimeout(() => this.#idle(minutes), minutes * 60_000)
    this.idleTimer.unref?.()
  }

  #idle(minutes) {
    if (this.batcher.busy || this.batcher.size || this.muted || this.#activeEngagement()) return this.#scheduleIdle()
    this.batcher.hold()
    this.#run([], { kind: 'idle', minutes, at: Date.now() }).finally(() => this.#scheduleIdle())
  }
}
