import { EventEmitter } from 'node:events'
import { ChatRunner } from './chat.js'
import { CommandRegistry } from './commands.js'

const LOG_LIMIT = 300
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]

// Owns the adapter connection and one ChatRunner per watched chat.
// Emits 'change' whenever something visible in the console changed, 'log' for
// connection-level log entries and 'watch' (chat) when a chat starts being watched.
export class Bot extends EventEmitter {
  adapter = null
  connection = { state: 'starting', canSend: false }
  account = { state: 'offline' }
  chats = []
  watched = []
  log = []
  runners = new Map()
  #restarts = 0
  #disposed = false
  #canSendWaiters = new Set()
  #statusSeen = false
  #lastSelf
  #watchQueue = Promise.resolve()

  constructor({ createAdapter, store, persona, settings = {}, think, dataDir, commands = new CommandRegistry() }) {
    super()
    Object.assign(this, { createAdapter, store, persona, settings, think, dataDir, commands })
    store.onError = error => this.note('error', `保存状态失败：${error.message}`)
  }

  async start() {
    const saved = await this.store.loadBot()
    this.watched = saved.watched ?? []
    await this.#connect()
  }

  async dispose() {
    this.#disposed = true
    clearTimeout(this.restartTimer)
    for (const runner of this.runners.values()) runner.dispose()
    for (const waiter of this.#canSendWaiters) waiter.reject(new Error('bot_disposed'))
    try {
      await this.#saveChats()
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
      watched: this.watched.map(chat => {
        const runner = this.runners.get(chat.id)
        return { ...chat, status: runner?.status ?? 'stopped', mode: runner?.mode, mutedUntil: runner?.mutedUntil }
      }),
    }
  }

  chatLog(chatId) {
    return this.runners.get(chatId)?.log ?? []
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

  async #connect() {
    if (this.#disposed) return
    let adapter
    this.#statusSeen = false
    try {
      adapter = this.adapter = this.createAdapter()
      adapter.on('log', ({ level, message }) => this.note(level, message))
      adapter.on('status', status => this.#onStatus(status))
      adapter.on('account', account => this.#onAccount(account))
      adapter.on('message', message => this.runners.get(message.chatId)?.receive(message))
      adapter.once('close', () => this.#onClose(adapter))
      const info = await adapter.initialize({ dataDir: this.dataDir, client: { name: 'dsh-wechat-bot', version: '1' } })
      this.note('info', `已连接适配器 ${info.name} ${info.version}`)
      this.#restarts = 0
      this.#onAccount(await adapter.accountStatus())
    } catch (error) {
      this.note('error', `适配器启动失败：${error.message}`)
      // Ends the process too; the resulting 'close' schedules the next attempt.
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
      await this.#applyWatch().catch(error => this.note('error', `恢复监听失败：${error.message}`))
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

  async setWatched(chatIds) {
    const known = new Map([...this.watched, ...this.chats].map(c => [c.id, c]))
    if (chatIds.some(id => !known.has(id))) await this.listChats()
    const byId = new Map([...this.watched, ...this.chats].map(c => [c.id, c]))
    const missing = chatIds.filter(id => !byId.has(id))
    if (missing.length) throw new Error(`unknown chats: ${missing.join(', ')}`)
    this.watched = chatIds.map(id => {
      const { name, kind } = byId.get(id)
      return { id, name, kind }
    })
    await this.store.updateBot({ watched: this.watched })
    await this.#applyWatch()
    return this.watched
  }

  // Serialized: concurrent callers (console clicks, re-login) must not race on runners.
  #applyWatch() {
    const run = this.#watchQueue.then(() => this.#applyWatchNow())
    this.#watchQueue = run.catch(() => {})
    return run
  }

  async #applyWatchNow() {
    const wanted = new Set(this.watched.map(c => c.id))
    for (const [id, runner] of this.runners) {
      if (wanted.has(id)) continue
      this.store.saveChatLater(id, runner.snapshot())
      runner.dispose()
      this.runners.delete(id)
    }
    if (!this.ready || this.#disposed) return this.#changed()
    // Register every runner before subscribing, so no new message finds its chat missing.
    const added = []
    for (const chat of this.watched) {
      if (this.runners.has(chat.id)) continue
      this.runners.set(chat.id, await this.#runner(chat))
      added.push(chat)
    }
    await this.adapter.watch([...wanted])
    for (const chat of added) {
      const runner = this.runners.get(chat.id)
      try {
        runner.prime(await this.adapter.history(chat.id, runner.settings.recentLimit))
      } catch (error) {
        this.note('warn', `读取「${chat.name}」历史失败：${error.message}`)
      }
      this.note('info', `开始监听「${chat.name}」`)
      this.emit('watch', chat)
    }
    this.#changed()
  }

  async #runner(chat) {
    const state = await this.store.loadChat(chat.id)
    const runner = new ChatRunner({
      chat, state, persona: this.persona, commands: this.commands,
      settings: { ...this.settings, ...this.settings.chats?.[chat.id] },
      // During an adapter restart the account is briefly unknown; keep using the last one.
      account: () => this.account.self ?? this.#lastSelf,
      think: args => this.think(args),
      link: {
        send: (content, clientId) => this.adapter.send(chat.id, clientId, content),
        canSend: () => this.connection.canSend,
        whenCanSend: signal => this.#whenCanSend(signal),
      },
      emit: (type, payload) => {
        if (type === 'log') this.emit('chat-log', chat.id, payload)
        this.store.saveChatLater(chat.id, () => runner.snapshot())
        this.#changed()
      },
    })
    return runner
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

  async #saveChats() {
    for (const [id, runner] of this.runners) this.store.saveChatLater(id, runner.snapshot())
    await this.store.flush()
  }

  setMode(chatId, mode) {
    const runner = this.runners.get(chatId)
    if (!runner) throw new Error(`not watching ${chatId}`)
    runner.setMode(mode)
    this.store.saveChatLater(chatId, () => runner.snapshot())
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
