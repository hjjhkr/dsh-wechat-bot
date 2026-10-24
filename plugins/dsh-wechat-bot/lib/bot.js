import { EventEmitter } from 'node:events'
import { ChatRunner } from './chat.js'
import { CommandRegistry } from './commands.js'

const LOG_LIMIT = 300
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]

export const botDefaults = Object.freeze({
  watchdogMs: 15_000,       // how often the watchdog looks
  stuckMs: 5 * 60_000,      // thinking/sending longer than this = stuck → rebuild the chat runner
})

// Owns the adapter connection and the ChatRunner of the one group the bot serves.
// Self-healing: the adapter is restarted with backoff when it dies, and a
// watchdog rebuilds the runner (keeping its context and memory) if it hangs.
// Emits 'change' when something visible changed, 'log' for connection-level
// entries, 'chat-log' for the chat's entries and 'watch' (chat) when watching starts.
export class Bot extends EventEmitter {
  adapter = null
  connection = { state: 'starting', canSend: false }
  account = { state: 'offline' }
  chats = []
  chat = null
  runner = null
  log = []
  recoveries = 0
  #restarts = 0
  #disposed = false
  #disposing = null
  #connecting = null
  #canSendWaiters = new Set()
  #statusSeen = false
  #lastSelf
  #queue = Promise.resolve()
  #watchFailures = 0

  // `personas`: the persona library; or `persona`, a fixed persona text (tests, evaluation).
  constructor({ createAdapter, store, persona, personas, settings = {}, think, learn, dataDir, commands = new CommandRegistry(), models }) {
    super()
    Object.assign(this, { createAdapter, store, persona, personas, think, learn, dataDir, commands, models })
    this.settings = { ...botDefaults, ...settings }
    store.onError = error => this.note('error', `保存状态失败：${error.message}`)
  }

  async start() {
    this.chat = (await this.store.loadBot()).chat ?? null
    this.watchdog = setInterval(() => this.#checkStuck(), this.settings.watchdogMs)
    this.watchdog.unref?.()
    await this.#connect()
  }

  dispose() {
    return this.#disposing ??= this.#dispose()
  }

  // Stops taking messages, lets work in progress finish (a reply already being sent is never
  // cut in half), saves, then closes the adapter, which is killed if it does not exit.
  async #dispose() {
    this.#disposed = true
    clearTimeout(this.restartTimer)
    clearTimeout(this.watchRetryTimer)
    clearInterval(this.watchdog)
    for (const waiter of this.#canSendWaiters) waiter.reject(new Error('bot_disposed'))
    await this.#queue
    await this.#connecting
    const runner = this.runner
    try {
      if (runner) {
        await runner.quiesce()
        this.store.saveChatLater(this.chat.id, runner.snapshot())
      }
      this.runner = null
      await this.store.flush()
    } finally {
      await this.adapter?.shutdown()
    }
  }

  view() {
    return {
      adapter: this.adapter?.info ?? null,
      capabilities: this.adapter?.capabilities ?? null,
      connection: this.connection,
      account: this.account,
      recoveries: this.recoveries,
      chat: this.chat && { ...this.chat, ...(this.runner?.health() ?? { status: 'stopped' }) },
    }
  }

  chatLog() {
    return this.runner?.log ?? []
  }

  // Adds an entry to the connection log shown in the console.
  note(level, message) {
    const entry = { time: Date.now(), level, message }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT * 2) this.log.splice(0, LOG_LIMIT)
    this.emit('log', entry)
  }

  #changed() {
    this.emit('change')
  }

  // ── adapter connection ──────────────────────────────────────────────────

  // Never rejects: a failed attempt closes the adapter, and its 'close' schedules the next one.
  #connect() {
    if (this.#disposed) return Promise.resolve()
    return this.#connecting ??= this.#connectOnce().finally(() => { this.#connecting = null })
  }

  async #connectOnce() {
    let adapter
    this.#statusSeen = false
    try {
      adapter = this.adapter = this.createAdapter()
      adapter.on('log', ({ level, message }) => this.note(level, message))
      adapter.on('status', status => this.#onStatus(status))
      adapter.on('account', account => this.#onAccount(account))
      adapter.on('message', message => {
        if (!this.#disposed && message.chatId === this.chat?.id) this.runner?.receive(message)
      })
      adapter.once('close', () => this.#onClose(adapter))
      const info = await adapter.initialize({ dataDir: this.dataDir, client: { name: 'dsh-wechat-bot', version: '1' } })
      this.note('info', `已连接适配器 ${info.name} ${info.version}`)
      this.#restarts = 0
      await this.#onAccount(await adapter.accountStatus())
    } catch (error) {
      this.note('error', `适配器启动失败：${error.message}`)
      await adapter?.shutdown()
    }
  }

  #onClose(adapter) {
    if (adapter !== this.adapter || this.#disposed) return
    this.connection = { state: 'adapter_down', canSend: false }
    // A fresh adapter process knows nothing; force re-login check and re-watch.
    this.account = { state: 'offline' }
    this.#changed()
    const delay = BACKOFF_MS[Math.min(this.#restarts++, BACKOFF_MS.length - 1)]
    this.note('warn', `适配器已断开，${delay / 1000} 秒后重连`)
    this.restartTimer = setTimeout(() => this.#connect(), delay)
    this.restartTimer.unref?.()
  }

  #onStatus(status, { synthetic = false } = {}) {
    if (!synthetic) this.#statusSeen = true
    const previous = this.connection
    this.connection = { state: status.connection, canSend: status.canSend, reason: status.reason, detail: status.detail }
    if (status.canSend) for (const waiter of this.#canSendWaiters) waiter.resolve()
    if (previous.state !== status.connection || previous.canSend !== status.canSend || previous.reason !== status.reason) {
      this.note('info', `连接状态：${status.connection}${status.canSend ? '' : '（暂不能发送）'}${status.reason ? ` ${status.reason}` : ''}`)
    }
    this.#changed()
  }

  async #onAccount(account) {
    const wasReady = this.account.state === 'ready'
    this.account = account
    this.#changed()
    if (account.state !== 'ready') {
      if (wasReady) this.note('warn', '小号已退出登录')
      return
    }
    this.#lastSelf = account.self
    // Adapters that never report status are assumed able to send once logged in.
    if (!this.#statusSeen) this.#onStatus({ connection: 'connected', canSend: true }, { synthetic: true })
    if (!wasReady) {
      this.note('info', `小号已登录：${account.self.name}`)
      await this.#watch().catch(() => {})
    }
  }

  get ready() {
    return this.account.state === 'ready' && this.connection.state !== 'adapter_down'
  }

  async login() {
    const account = await this.adapter.login()
    if (account.state === 'ready') await this.#onAccount(account)
    return account
  }

  async listChats(query) {
    this.chats = await this.adapter.listChats(query)
    return this.chats
  }

  // ── the watched group ───────────────────────────────────────────────────

  // Chooses the group to serve (null = none). Serialized with re-login so they never race.
  setChat(chatId) {
    return this.#serial(async () => {
      let chat = null
      if (chatId) {
        if (!this.chats.some(c => c.id === chatId)) await this.listChats()
        const found = this.chats.find(c => c.id === chatId)
        if (!found) throw new Error(`unknown chat ${chatId}`)
        chat = { id: found.id, name: found.name, kind: found.kind }
      }
      if (this.runner && this.chat?.id !== chat?.id) this.#stopRunner()
      this.chat = chat
      await this.store.updateBot({ chat })
      return chat
    }).then(async chat => {
      await this.#watch()
      return chat
    })
  }

  // Starts watching the chosen group; a failure (e.g. the adapter is slow to open its
  // databases) is retried with backoff until it succeeds, so the bot never stays deaf.
  #watch() {
    clearTimeout(this.watchRetryTimer)
    return this.#serial(() => this.#applyChat()).then(() => {
      this.#watchFailures = 0
    }, error => {
      const delay = BACKOFF_MS[Math.min(this.#watchFailures++, BACKOFF_MS.length - 1)]
      this.note('error', `监听失败，${delay / 1000} 秒后重试：${error.message}`)
      this.watchRetryTimer = setTimeout(() => {
        if (this.ready && !this.#disposed) this.#watch().catch(() => {})
      }, delay)
      this.watchRetryTimer.unref?.()
      throw error
    })
  }

  #serial(task) {
    const run = this.#queue.then(task)
    this.#queue = run.catch(() => {})
    return run
  }

  #stopRunner() {
    this.store.saveChatLater(this.chat.id, this.runner.snapshot())
    this.runner.dispose()
    this.runner = null
  }

  async #applyChat() {
    if (!this.ready || this.#disposed) return this.#changed()
    const chat = this.chat
    await this.adapter.watch(chat ? [chat.id] : [])
    if (!chat || this.runner) return this.#changed()
    const state = await this.store.loadChat(chat.id)
    if (this.#disposed) return
    this.runner = this.#createRunner(chat, state)
    try {
      this.runner.prime(await this.adapter.history(chat.id, this.runner.settings.recentLimit))
    } catch (error) {
      this.note('warn', `读取「${chat.name}」历史失败：${error.message}`)
    }
    this.note('info', `开始监听「${chat.name}」`)
    this.emit('watch', chat)
    this.#changed()
  }

  #createRunner(chat, state) {
    const runner = new ChatRunner({
      chat, state, persona: this.personas ? () => this.personas.text() : this.persona, personas: this.personas,
      commands: this.commands, settings: this.settings, models: this.models,
      memory: this.store.memoryFor(chat.id, message => this.note('warn', message)),
      // During an adapter restart the account is briefly unknown; keep using the last one.
      account: () => this.account.self ?? this.#lastSelf,
      think: args => this.think(args),
      learn: this.learn && (args => this.learn(args)),
      link: {
        send: (content, clientId) => this.adapter.send(chat.id, clientId, content),
        members: () => this.adapter.members(chat.id),
        canSend: () => this.connection.canSend,
        whenCanSend: signal => this.#whenCanSend(signal),
      },
      persist: () => {
        this.store.saveChatLater(chat.id, () => runner.snapshot())
        return this.store.flush()
      },
      emit: (type, payload) => {
        if (runner !== this.runner) return
        if (type === 'log') this.emit('chat-log', payload)
        if (type === 'memory-changed') this.emit('memory-changed', chat)
        this.store.saveChatLater(chat.id, () => runner.snapshot())
        this.#changed()
      },
    })
    return runner
  }

  // Watchdog: a runner that has been thinking/sending far longer than any
  // timeout allows is replaced by a fresh one built from its snapshot.
  #checkStuck() {
    const runner = this.runner
    if (!runner || this.#disposed) return
    const stuck = runner.stuckFor()
    if (stuck < this.settings.stuckMs) return
    const snapshot = runner.snapshot()
    runner.dispose()
    this.runner = this.#createRunner(this.chat, snapshot)
    this.recoveries++
    this.note('warn', `「${this.chat.name}」处理卡住 ${Math.round(stuck / 1000)} 秒，已自动重建（上下文和记忆保留）`)
    this.#changed()
  }

  #whenCanSend(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.connection.canSend) return Promise.resolve()
    const waiter = Promise.withResolvers()
    this.#canSendWaiters.add(waiter)
    const abort = () => waiter.reject(signal.reason ?? new Error('aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    return waiter.promise.finally(() => {
      this.#canSendWaiters.delete(waiter)
      signal?.removeEventListener('abort', abort)
    })
  }

  setMode(mode) {
    if (!this.runner) throw new Error('not watching any chat')
    this.runner.setMode(mode)
    this.store.saveChatLater(this.chat.id, () => this.runner.snapshot())
    this.#changed()
  }

  setWindowVisible(visible) {
    return this.adapter.setWindowVisible(visible)
  }

  windowState() {
    return this.adapter.windowState()
  }

  simulate(params) {
    return this.adapter.simulate(params)
  }
}
