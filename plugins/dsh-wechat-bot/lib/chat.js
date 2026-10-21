import { createHash } from 'node:crypto'
import { addressOf, nameMatchers } from './addressing.js'
import { Batcher } from './batcher.js'
import { CommandRegistry, MODES, parseCommand } from './commands.js'
import { DecisionError, parseDecision } from './decision.js'
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
})

const LOG_LIMIT = 300
const SEEN_LIMIT = 1000

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
   * @param {object} o.settings     chatDefaults overrides plus aliases/owner/admins/stickers
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
    this.mode = MODES[state.mode] ? state.mode : this.settings.mode
    this.mutedUntil = state.mutedUntil ?? 0
    this.stats = state.stats?.date === today() ? state.stats : { date: today(), batches: 0, sent: 0 }
    this.seen = new Set(this.transcript.map(m => m.id))
    this.sentIds = new Set()
    this.status = 'idle'
    this.supersedes = new WeakMap()
    this.abort = new AbortController()
    this.batcher = new Batcher(this.settings, batch => this.#run(batch))
    this.#scheduleIdle()
  }

  snapshot() {
    return {
      transcript: this.transcript.slice(-this.settings.recentLimit * 2),
      memory: this.memory.toJSON(),
      log: this.log.slice(-LOG_LIMIT),
      lastBotTurn: this.lastBotTurn,
      mode: this.mode,
      mutedUntil: this.mutedUntil,
      stats: this.stats,
    }
  }

  dispose() {
    this.disposed = true
    this.abort.abort()
    this.batcher.clear()
    clearTimeout(this.idleTimer)
  }

  setMode(mode) {
    if (!MODES[mode]) throw new Error(`unknown mode ${mode}`)
    this.mode = mode
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

  isOwner(id) {
    return id === this.settings.owner?.id || (this.settings.admins ?? []).includes(id)
  }

  receive(message) {
    if (this.disposed || this.seen.has(message.id)) return
    this.#remember(message.id)
    if (message.fromSelf) {
      // Echo of something we sent, or the account owner typing from their phone.
      if (!this.sentIds.has(message.id)) this.#record(message)
      return
    }
    this.#record(message)
    this.#write('message', { id: message.id, from: message.sender.name, text: message.text, kind: message.kind })
    this.#scheduleIdle()
    const parsed = message.kind === 'text' ? parseCommand(message.text) : null
    const command = parsed && this.commands.get(parsed.name)
    if (command) return void this.#command(message, command, parsed)
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

  #setStatus(status) {
    this.status = status
    this.emit('status', status)
  }

  // ── commands ────────────────────────────────────────────────────────────

  async #command(message, command, parsed) {
    const isOwner = this.isOwner(message.sender.id)
    this.#write('command', { name: command.name, from: message.sender.name, text: parsed.text })
    if (command.access === 'owner' && !isOwner) return this.#say(`/${command.name} 只有主人能用`)
    let result
    try {
      result = await command.run({
        ...parsed, sender: message.sender, chat: this.chat, isOwner, message,
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
    const clientId = createHash('sha256').update(`${this.chat.id}\0say\0${Date.now()}\0${text}`).digest('hex').slice(0, 16)
    const result = await this.#sendOne({ kind: 'text', text }, clientId, Date.now())
    if (result) this.#sent(result.messageId, { kind: 'text', text })
  }

  // ── model turns ─────────────────────────────────────────────────────────

  #names() {
    return nameMatchers([this.account().name, ...(this.settings.aliases ?? [])])
  }

  #addresses(batch) {
    const context = { chatKind: this.chat.kind, self: this.account(), names: this.#names(), lastBotTurn: this.lastBotTurn }
    return new Map(batch.map(m => [m.id, m.command ? { addressed: 'you', reasons: ['command'] } : addressOf(m, context)]))
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

  // Why this batch should not reach the model at all, if it shouldn't.
  #skipReason(batch, address) {
    if (batch.some(m => m.command)) return null
    if (this.muted) return 'muted'
    if (this.mode === 'silent') return 'silent_mode'
    if (this.mode === 'mention' && !batch.some(m => address.get(m.id).addressed === 'you')) return 'mention_only'
    return null
  }

  async #run(batch, event) {
    try {
      await this.#turn(batch, event)
    } catch (error) {
      if (!this.disposed) this.#write('error', { message: error.message, code: error.code })
    } finally {
      this.#setStatus('idle')
      if (!this.disposed) this.batcher.release()
    }
  }

  async #turn(batch, event) {
    const address = this.#addresses(batch)
    const skip = event ? null : this.#skipReason(batch, address)
    if (skip) return this.#write('skipped', { reason: skip, count: batch.length })
    if (!this.link.canSend()) {
      this.#setStatus('waiting')
      this.#write('waiting', { reason: 'adapter_cannot_send' })
      await this.link.whenCanSend(this.abort.signal)
    }
    if (batch.length) {
      this.#write('batch', { count: batch.length, addressed: Object.fromEntries([...address].map(([id, a]) => [id, a.addressed])) })
      if (this.stats.date !== today()) this.stats = { date: today(), batches: 0, sent: 0 }
      this.stats.batches++
    }
    this.#setStatus('thinking')
    const mustReply = batch.some(m => address.get(m.id).addressed === 'you')
    const decision = await this.#decide({ batch, address, event, mustReply })
    if (this.disposed) return

    const newer = this.batcher.size
    const superseded = this.supersedes.get(batch[0]) ?? 0
    if (newer && (event || superseded < this.settings.maxSupersede)) {
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
    await this.#deliver(decision.reply, { batch, target, event })
  }

  async #decide({ batch, address, event, mustReply }) {
    const settings = this.settings
    const stickers = Object.keys(settings.stickers ?? {})
    const system = systemPrompt(this.persona, { maxParts: settings.maxParts, stickers })
    const input = turnInput({
      chat: this.chat, self: this.account(), aliases: settings.aliases ?? [], owner: settings.owner,
      recent: this.#recent(batch), batch, address, memory: this.#memoryFor(batch), event,
    })
    const messages = [{ role: 'user', text: input }]
    const readable = event ? `${this.chat.name}：冷场 ${event.minutes} 分钟，看看要不要主动说话` : readableBatch(this.chat, batch, address)
    const effort = batch.find(m => m.command?.effort)?.command.effort
    let retries = settings.correctionRetries
    for (;;) {
      const output = await this.think({ chat: this.chat, system, messages, readable, effort, signal: this.abort.signal })
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

  async #deliver(parts, { batch, target, event }) {
    this.#setStatus('sending')
    const turnId = createHash('sha256').update(this.chat.id + '\0' + (batch.map(m => m.id).join('\0') || `idle:${event?.at}`)).digest('hex').slice(0, 16)
    const started = Date.now()
    for (const [index, part] of parts.entries()) {
      if (this.disposed) return
      if (index && this.settings.typingDelay) await sleep(typingMs(part.text ?? ''))
      const content = part.kind === 'sticker'
        ? { kind: 'sticker', path: this.settings.stickers[part.name] }
        : { kind: 'text', text: part.text }
      const result = await this.#sendOne(content, `${turnId}:${index}`, started)
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
  async #sendOne(content, clientId, started) {
    let failures = 0
    for (;;) {
      if (!this.link.canSend()) {
        this.#write('waiting', { reason: 'adapter_cannot_send' })
        await this.link.whenCanSend(this.abort.signal)
      }
      if (Date.now() - started > this.settings.staleMs) {
        this.#write('dropped', { reason: 'stale', clientId })
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
