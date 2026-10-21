import { createHash, randomUUID } from 'node:crypto'
import { addressOf, nameMatchers } from './addressing.js'
import { Batcher } from './batcher.js'
import { CommandRegistry, MODES, parseCommand } from './commands.js'
import { DecisionError, parseDecision } from './decision.js'
import { CircuitBreaker, RateWindow, withDeadline } from './guard.js'
import { MemoryBook } from './memory.js'
import { readableBatch, systemPrompt, turnInput } from './prompt.js'
import { ErrorCode } from './protocol.js'

export const chatDefaults = Object.freeze({
  mode: 'free',
  quietMs: 2000,
  maxWaitMs: 8000,
  maxMessages: 20,
  maxChars: 6000,
  recentLimit: 30,
  maxParts: 3,
  maxSupersede: 1,
  correctionRetries: 1,
  staleMs: 10 * 60_000,
  idleMinutes: 0,
  sendRetries: 2,
  retryDelayMs: 2000,
  typingDelay: true,
  // Guardrails
  maxTextChars: 2000,          // longer messages are truncated before anything else sees them
  maxTurnsPerMinute: 8,        // model calls per minute; extra batches wait (and merge) instead of spamming
  modelTimeoutMs: 90_000,      // one model call never takes longer than this
  breakerThreshold: 3,         // consecutive model failures before pausing model calls
  breakerBaseMs: 30_000,       // first pause; doubles on each repeated trip
  breakerMaxMs: 10 * 60_000,
})

const LOG_LIMIT = 300
const SEEN_LIMIT = 1000
const NOTICE_INTERVAL_MS = 5000

// Pace multi-part replies like someone typing.
const typingMs = text => Math.min(600 + 150 * [...text].length, 4000)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const today = () => new Date().toLocaleDateString('sv')

// One watched chat. Messages are processed strictly in order: collect a batch,
// ask the model once, deliver the reply, then take the next batch.
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
   */
  constructor({ chat, state = {}, settings, persona, account, link, think, commands, emit }) {
    this.chat = chat
    this.settings = { ...chatDefaults, ...settings }
    this.persona = persona
    this.account = account
    this.link = link
    this.think = think
    this.commands = commands ?? new CommandRegistry()
    this.emit = emit ?? (() => {})
    this.transcript = state.transcript ?? []
    this.memory = new MemoryBook(state.memory)
    this.log = state.log ?? []
    this.lastBotTurn = state.lastBotTurn
    // Only a mode chosen explicitly (console, /mode, tool) is persisted; otherwise config decides.
    this.modeOverride = MODES[state.mode] ? state.mode : undefined
    this.mutedUntil = state.mutedUntil ?? 0
    this.stats = state.stats?.date === today() ? state.stats : { date: today(), batches: 0, sent: 0 }
    this.seen = new Set(this.transcript.map(m => m.id))
    this.sentIds = new Set()
    this.status = 'idle'
    this.busySince = 0
    this.supersedes = new WeakMap()
    this.abort = new AbortController()
    this.rate = new RateWindow(this.settings.maxTurnsPerMinute)
    this.breaker = new CircuitBreaker({
      threshold: this.settings.breakerThreshold, baseMs: this.settings.breakerBaseMs, maxMs: this.settings.breakerMaxMs,
    })
    this.counters = { received: 0, overflow: 0, deferred: 0, modelErrors: 0, sendErrors: 0, internalErrors: 0 }
    this.notices = {}
    this.batcher = new Batcher(this.settings, batch => this.#run(batch), () => this.#overflow())
    this.#scheduleIdle()
  }

  // What the console and the watchdog need to know.
  health(now = Date.now()) {
    return {
      status: this.status, mode: this.mode, mutedUntil: this.mutedUntil,
      backlog: this.batcher.size, busyMs: this.stuckFor(now),
      breaker: this.breaker.view(now), turnsLastMinute: this.rate.used, counters: { ...this.counters },
    }
  }

  snapshot() {
    return {
      transcript: this.transcript.slice(-this.settings.recentLimit * 2),
      memory: this.memory.toJSON(),
      log: this.log.slice(-LOG_LIMIT),
      lastBotTurn: this.lastBotTurn,
      mode: this.modeOverride,
      mutedUntil: this.mutedUntil,
      stats: this.stats,
    }
  }

  get mode() {
    return this.modeOverride ?? this.settings.mode
  }

  dispose() {
    this.disposed = true
    this.abort.abort()
    this.batcher.clear()
    clearTimeout(this.idleTimer)
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
    if (message.text.length > this.settings.maxTextChars) {
      message = { ...message, text: message.text.slice(0, this.settings.maxTextChars) + '…（太长，已截断）' }
    }
    if (message.fromSelf) {
      // Echo of something we sent, or someone typing on the bot account's phone.
      if (!this.sentIds.has(message.id)) this.#record(message)
      return
    }
    this.counters.received++
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

  // ── commands ────────────────────────────────────────────────────────────

  async #command(message, command, parsed) {
    this.#write('command', { name: command.name, from: message.sender.name, text: parsed.text })
    let result
    try {
      result = await command.run({
        ...parsed, sender: message.sender, chat: this.chat, message,
        mode: this.mode,
        setMode: mode => this.setMode(mode),
        mute: ms => this.mute(ms),
        memory: {
          recall: id => this.memory.recall([id])[id] ?? {},
          forget: (id, topic) => this.memory.forget(id, topic),
        },
        resetContext: () => {
          this.transcript = []
          this.lastBotTurn = undefined
        },
        status: () => ({
          mode: this.mode, mutedUntil: this.mutedUntil, today: this.stats,
          context: this.transcript.length, members: Object.keys(this.memory.members).length,
        }),
        commands: this.commands.list(),
      })
    } catch (error) {
      this.#write('error', { message: `/${command.name}: ${error.message}` })
      return this.#say(`/${command.name} 出错了`)
    }
    if (typeof result === 'string') return this.#say(result)
    if (result?.reply) return this.#say(result.reply)
    if (result?.forward) {
      const { text = parsed.text, instruction, effort } = result.forward
      this.batcher.push({ ...message, text, command: { name: command.name, instruction, effort } })
    }
  }

  // Direct, model-free reply (command output). Queued behind nothing: it is short and immediate.
  async #say(text) {
    const clientId = `say:${randomUUID()}`
    const result = await this.#sendOne({ kind: 'text', text }, clientId, { started: Date.now() })
    if (result) this.#sent(result.messageId, { kind: 'text', text })
  }

  // ── model turns ─────────────────────────────────────────────────────────

  #names() {
    return nameMatchers([this.account().name, ...(this.settings.aliases ?? [])])
  }

  #addresses(batch) {
    const context = { chatKind: this.chat.kind, self: this.account(), names: this.#names(), lastBotTurn: this.lastBotTurn }
    return new Map(batch.map(m => [m.id, m.command ? { addressed: 'you', reasons: ['command'] } : addressOf(this.#withQuoteSender(m), context)]))
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
    return this.#decide({ batch, address, event, mustReply })
  }

  // Why this batch should not reach the model at all, if it shouldn't.
  #skipReason(batch, address) {
    if (batch.some(m => m.command)) return null
    if (this.muted) return 'muted'
    if (this.mode === 'silent') return 'silent_mode'
    if (this.mode === 'mention' && !batch.some(m => address.get(m.id).addressed === 'you')) return 'mention_only'
    return null
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

  // How long model calls must wait (rate limit or open breaker), in ms.
  #gate() {
    return Math.max(this.rate.wait(), this.breaker.wait())
  }

  // Thinking does not wait for the adapter to be able to send (e.g. a locked screen):
  // the reply waits in #sendOne instead, and is dropped if it goes stale meanwhile.
  // Returns a delay in ms when the batch was put back to wait for the rate limit / breaker.
  async #turn(batch, event) {
    const started = Date.now()
    const address = this.#addresses(batch)
    const skip = event ? null : this.#skipReason(batch, address)
    if (skip) return void this.#write('skipped', { reason: skip, count: batch.length })
    const wait = this.#gate()
    if (wait) {
      if (!batch.length) return
      this.counters.deferred++
      this.batcher.requeue(batch)
      this.#notice('deferred', { reason: this.breaker.wait() ? 'breaker_open' : 'rate_limited', waitMs: wait })
      return wait
    }
    if (batch.length) {
      this.#write('batch', { count: batch.length, addressed: Object.fromEntries([...address].map(([id, a]) => [id, a.addressed])) })
      if (this.stats.date !== today()) this.stats = { date: today(), batches: 0, sent: 0 }
      this.stats.batches++
    }
    this.#setStatus('thinking')
    const mustReply = batch.some(m => address.get(m.id).addressed === 'you')
    let decision
    try {
      decision = await this.#decide({ batch, address, event, mustReply })
      this.breaker.success()
    } catch (error) {
      if (this.disposed) return
      this.counters.modelErrors++
      const coolDown = this.breaker.failure()
      if (coolDown) this.#write('breaker_open', { coolDownMs: coolDown, reason: error.code ?? error.message })
      throw error
    }
    if (this.disposed) return

    const newer = this.batcher.arrived
    const superseded = this.supersedes.get(batch[0]) ?? 0
    // Re-asking only helps if the newer messages can join this batch.
    const canGrow = batch.length < this.settings.maxMessages
    if (newer && (event || (canGrow && superseded < this.settings.maxSupersede))) {
      // People kept talking while we were thinking; answer the whole conversation instead.
      if (batch.length) {
        this.supersedes.set(batch[0], superseded + 1)
        this.batcher.requeue(batch)
      }
      return this.#write('superseded', { newer, discarded: decision.reply.length })
    }

    if (batch.length) {
      const { applied, rejected } = this.memory.apply(decision.memory, batch)
      if (applied.length || rejected.length) this.#write('memory', { applied, rejected })
    }
    if (!decision.reply.length) {
      this.#write('silent', {})
      return this.emit('change')
    }
    const target = batch.find(m => m.id === decision.to)
    await this.#deliver(decision.reply, { batch, target, event, started })
  }

  async #decide({ batch, address, event, mustReply }) {
    const settings = this.settings
    const stickers = Object.keys(settings.stickers ?? {})
    const system = systemPrompt(this.persona, { maxParts: settings.maxParts, stickers })
    const input = turnInput({
      chat: this.chat, self: this.account(), aliases: settings.aliases ?? [],
      recent: this.#recent(batch), batch, address, memory: this.#memoryFor(batch), event,
    })
    const messages = [{ role: 'user', text: input }]
    const readable = event ? `${this.chat.name}：冷场 ${event.minutes} 分钟，看看要不要主动说话` : readableBatch(this.chat, batch, address)
    const effort = batch.find(m => m.command?.effort)?.command.effort
    let retries = settings.correctionRetries
    for (;;) {
      this.rate.record()
      const output = await withDeadline(
        signal => this.think({ chat: this.chat, system, messages, readable, effort, signal }),
        settings.modelTimeoutMs, this.abort.signal)
      let problem
      try {
        const decision = parseDecision(output, { batch, maxParts: settings.maxParts, stickers })
        if (mustReply && !decision.reply.length) {
          problem = new DecisionError('must_reply', 'new 里有 addressed=you 的消息，有人在直接找你，reply 不能为空')
        } else {
          this.#write('decision', { to: decision.to, reply: decision.reply, raw: output })
          return decision
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

  async #deliver(parts, { batch, target, event, started }) {
    this.#setStatus('sending')
    const turnId = createHash('sha256').update(this.chat.id + '\0' + (batch.map(m => m.id).join('\0') || `idle:${event?.at}`)).digest('hex').slice(0, 16)
    const commanded = batch.some(m => m.command)
    // A /mute or /mode silent that arrives mid-reply stops the rest of it (explicit /ask etc. still finish).
    const blocked = () => !commanded && (this.muted || this.mode === 'silent') ? 'muted' : null
    for (const [index, part] of parts.entries()) {
      if (index && this.settings.typingDelay) await sleep(typingMs(part.text ?? ''))
      const content = part.kind === 'sticker'
        ? { kind: 'sticker', path: this.settings.stickers[part.name] }
        : { kind: 'text', text: part.text }
      const result = await this.#sendOne(content, `${turnId}:${index}`, { started, blocked })
      if (!result) return
      this.#sent(result.messageId, part)
    }
    this.lastBotTurn = { time: Date.now(), toSenderId: target?.sender.id }
  }

  #sent(messageId, part) {
    this.sentIds.add(messageId)
    this.stats.sent++
    // The adapter's echo of this message may already have arrived and been recorded.
    if (!this.seen.has(messageId)) {
      this.#remember(messageId)
      this.#record({
        id: messageId, chatId: this.chat.id, time: Date.now(), kind: part.kind, fromSelf: true,
        text: part.kind === 'sticker' ? part.name : part.text, sender: this.account(), mentions: [],
      })
    }
    this.#write('sent', { part, messageId })
  }

  // Waits while sending is impossible (e.g. locked screen), drops the reply once
  // it is stale, retries definite failures, and never repeats an uncertain send.
  // `blocked()` may return a reason to give up (checked again after every wait).
  async #sendOne(content, clientId, { started, blocked = () => null }) {
    let failures = 0
    for (;;) {
      if (this.disposed) return null
      if (!this.link.canSend()) {
        const previous = this.status
        this.#setStatus('waiting')
        this.#write('waiting', { reason: 'adapter_cannot_send' })
        await this.link.whenCanSend(this.abort.signal)
        this.#setStatus(previous)
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

  // ── idle checks ─────────────────────────────────────────────────────────

  #scheduleIdle() {
    clearTimeout(this.idleTimer)
    const minutes = this.settings.idleMinutes
    if (!minutes || this.chat.kind !== 'group' || this.mode !== 'free' || this.disposed) return
    this.idleTimer = setTimeout(() => this.#idle(minutes), minutes * 60_000)
    this.idleTimer.unref?.()
  }

  #idle(minutes) {
    if (this.batcher.busy || this.batcher.size || this.muted) return this.#scheduleIdle()
    this.batcher.hold()
    this.#run([], { kind: 'idle', minutes, at: Date.now() }).finally(() => this.#scheduleIdle())
  }
}
