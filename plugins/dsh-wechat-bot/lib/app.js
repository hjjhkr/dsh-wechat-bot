import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { AdapterClient, spawnAdapter } from './adapter.js'
import { Bot } from './bot.js'
import { CommandRegistry } from './commands.js'
import { formatEval, runEval } from './eval.js'
import { createThink } from './model.js'
import { ModelControl } from './models.js'
import { MemoryMaintenance } from './memory-maintenance.js'
import { ChatSession, liveChatSessionId } from './session.js'
import { PersonaLibrary } from './personas.js'
import { Simulator } from './simulator.js'
import { Store } from './store.js'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const BUNDLED_PERSONAS = join(PACKAGE_ROOT, 'personas')

// The built-in simulator, connected in-process. Used until a real adapter is configured.
function inProcessSimulator(options) {
  const toAdapter = new PassThrough()
  const toPlugin = new PassThrough()
  new Simulator({ input: toAdapter, output: toPlugin, ...options })
  return new AdapterClient({ input: toPlugin, output: toAdapter })
}

export function dataDirOf(config) {
  if (config.dataDir) return config.dataDir
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wechat-bot')
}

// Everything the plugin does, as plain operations. The console API, the
// `/wechat` DSH command and the `wechat_bot` agent tool all call these.
export class WeChatBotApp {
  sessions = new Map()
  maintenanceSessions = new Map()
  #disposePromise = null

  static async create(ctx, config) {
    const app = new WeChatBotApp(ctx, config)
    try {
      await app.#start()
      return app
    } catch (error) {
      // Startup may already own an adapter when the native session fails.
      if (app.bot) {
        try { await app.dispose() }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], '微信机器人启动和清理失败') }
      }
      throw error
    }
  }

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.dataDir = dataDirOf(config)
    this.store = new Store(this.dataDir)
  }

  async #start() {
    const config = this.config
    const commands = new CommandRegistry()
    if (config.commandsDir) await commands.load(config.commandsDir)
    const saved = await this.store.loadBot()
    this.personas = new PersonaLibrary({
      dir: config.personasDir || join(this.dataDir, 'personas'), fallback: config.persona, current: saved.persona ?? undefined,
      save: name => this.store.updateBot({ persona: name ?? null }),
    })
    await this.personas.seed(BUNDLED_PERSONAS)
    this.setup = saved.setup ?? null
    this.models = new ModelControl({
      llm: this.ctx.llm, base: () => this.#configuredRoute(), override: saved.modelOverride,
      save: modelOverride => this.store.updateBot({ modelOverride }),
    })
    const { adapter } = config
    this.memoryMaintenance = new MemoryMaintenance({
      memoryFor: chatId => this.store.memoryFor(chatId),
      think: args => this.#compactThink(args),
      onEvent: event => this.#memoryEvent(event),
    })
    this.bot = new Bot({
      dataDir: this.dataDir, store: this.store, personas: this.personas, commands, models: this.models,
      settings: {
        ...config.behavior,
        staleMs: config.behavior.staleMinutes * 60_000,
        maxTurnsPerMinute: config.guard.maxTurnsPerMinute,
        commandsPerMinute: config.guard.commandsPerMinute,
        modelTimeoutMs: config.guard.modelTimeoutSeconds * 1000,
        maxTextChars: config.guard.maxTextChars,
        breakerThreshold: config.guard.breakerThreshold,
        breakerBaseMs: config.guard.breakerBaseSeconds * 1000,
        stuckMs: config.guard.stuckMinutes * 60_000,
        aliases: config.aliases,
        stickers: config.stickers,
      },
      think: this.#thinkWithSupportedEffort(createThink({ llm: this.ctx.llm, role: 'reply', route: () => this.route(), mirror: chat => this.#mirror(chat) })),
      learn: this.#thinkWithSupportedEffort(createThink({ llm: this.ctx.llm, role: 'memory',
        route: () => ({ ...this.route(), reasoningEffort: 'off', maxTokens: 600 }) })),
      createAdapter: () => adapter.command
        ? spawnAdapter({ command: adapter.command, args: adapter.args, cwd: adapter.cwd || undefined, env: adapter.env })
        // Like a real client, the simulated account stays logged in once set up.
        : inProcessSimulator({ loggedIn: Boolean(this.setup?.completedAt) }),
    })
    this.bot.on('watch', chat => {
      this.#mirror(chat).catch(error => this.bot.note('error', `DSH 会话绑定失败：${error.message}`))
      this.#observeMemory(chat)
    })
    this.bot.on('memory-changed', chat => this.#observeMemory(chat))
    await this.bot.start()
    if (this.bot.chat) {
      await this.#mirror(this.bot.chat)
      this.#observeMemory(this.bot.chat)
    }
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposePromise = (async () => {
      const failures = []
      try { await this.memoryMaintenance?.dispose() }
      catch (error) { failures.push(error) }
      try { await this.bot.dispose() }
      catch (error) { failures.push(error) }
      const results = await Promise.allSettled([...this.sessions.values(), ...this.maintenanceSessions.values()].map(async pending => (await pending).dispose()))
      failures.push(...results.filter(result => result.status === 'rejected').map(result => result.reason))
      this.sessions.clear()
      this.maintenanceSessions.clear()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, '微信机器人和 DSH 会话关闭失败')
    })()
    return this.#disposePromise
  }

  // A per-call effort (e.g. /ask's "high") falls back to the current one if the model lacks it.
  #thinkWithSupportedEffort(think) {
    return async args => think(args.effort && !(await this.models.supports(args.effort)) ? { ...args, effort: undefined } : args)
  }

  // What the configuration (or DSH's default model) says, before any /model or /think change.
  #configuredRoute() {
    const { model } = this.config
    const fallback = !model.provider && this.ctx.get?.('agentDefaultModel')?.currentSelection()
    return {
      provider: model.provider || fallback?.provider || 'deepseek-account',
      model: model.model || fallback?.model || 'deepseek-flash',
      reasoningEffort: model.reasoningEffort,
    }
  }

  route() {
    const { provider, model, reasoningEffort } = this.models.current()
    return { provider, model, reasoningEffort, maxTokens: this.config.model.maxTokens }
  }

  async #mirror(chat) {
    if (!this.setup?.completedAt) return undefined
    const self = this.bot.account.self ?? this.setup.self
    const key = `${self.id}\0${chat.id}`
    if (!this.sessions.has(key)) {
      const opening = ChatSession.openLive(this.ctx, {
        id: liveChatSessionId(self.id, chat.id), cwd: this.setup.workspace,
        title: `微信 · ${chat.name}`, route: this.route(),
      }).catch(error => {
        this.sessions.delete(key)
        throw error
      })
      this.sessions.set(key, opening)
    }
    return this.sessions.get(key)
  }

  #observeMemory(chat) {
    if (this.#disposePromise || !this.setup?.completedAt) return
    this.memoryMaintenance.observe(chat).catch(error => this.bot.note('error', `记忆整理检查失败：${error.message}`))
  }

  #memoryEvent(event) {
    // Maintenance never enters the WeChat send pipeline.
    if (event.type === 'result') {
      const result = event.result
      this.bot.note(result.status === 'failed' ? 'error' : 'info',
        result.status === 'failed' ? `记忆整理失败（${result.who}）：${result.error}`
          : result.status === 'skipped' ? `记忆整理（${result.who}）：${result.reason === 'cancelled' ? '已取消' : '无需整理'}`
            : `记忆整理（${result.who}）：${result.before} → ${result.after} 个主题`)
    }
  }

  async #compactThink(args) {
    if (!this.setup?.completedAt) throw new Error('请先完成微信机器人初始化')
    const route = { ...this.route(), reasoningEffort: 'max', maxTokens: Math.max(4096, this.config.model.maxTokens) }
    const efforts = await this.models.efforts(route.provider, route.model)
    if (!efforts.includes('max')) throw new Error(`${route.model} 不支持 max 记忆整理，请切换支持 max 的模型`)
    args.signal.throwIfAborted()
    const self = this.bot.account.self ?? this.setup.self
    const key = `${self.id}\0${args.chat.id}`
    let session = await this.maintenanceSessions.get(key)
    if (session && (session.options.provider !== route.provider || session.options.model !== route.model)) {
      await session.dispose()
      this.maintenanceSessions.delete(key)
      session = undefined
    }
    if (!session) {
      const opening = ChatSession.openLive(this.ctx, {
        id: liveChatSessionId(self.id, `memory\0${args.chat.id}`), cwd: this.setup.workspace,
        title: `记忆整理 · ${args.chat.name} · max`, route,
      }).catch(error => { this.maintenanceSessions.delete(key); throw error })
      this.maintenanceSessions.set(key, opening)
      session = await opening
    }
    args.signal.throwIfAborted()
    return createThink({ llm: this.ctx.llm, role: 'memory', route: () => route, mirror: async () => session })({ ...args, effort: 'max' })
  }

  compactMemory(chatId) {
    if (this.#disposePromise) throw new Error('微信机器人正在关闭')
    if (!this.setup?.completedAt) throw new Error('请先完成微信机器人初始化')
    const chat = this.bot.chat
    if (!chat || chat.id !== chatId) throw new Error('服务的群已改变，请刷新控制台后再整理')
    return this.memoryMaintenance.start({ ...chat })
  }

  // ── operations ──────────────────────────────────────────────────────────

  state() {
    const view = this.bot.view()
    return {
      ...view,
      setup: this.setup,
      model: this.route(),
      memoryMaintenance: this.memoryMaintenance.view(view.chat?.id),
      chats: this.bot.chats,
      log: this.bot.log.slice(-100),
    }
  }

  chatLog() {
    return this.bot.chatLog()
  }

  // First-run flow, driven by `/wechat` or the agent tool from a DSH session.
  // Binds the workspace, asks for the bot account login, then completes.
  async setupFrom({ workspace, sessionId }) {
    if (!workspace || !isAbsolute(workspace)) throw new Error('setup needs the absolute workspace path of the DSH session')
    if (this.setup?.workspace !== workspace) {
      this.setup = { workspace, sessionId, completedAt: null }
      await this.store.updateBot({ setup: this.setup })
    }
    let account = this.bot.account
    if (account.state !== 'ready') account = await this.bot.login()
    if (account.state !== 'ready') {
      return { step: 'login', instructions: account.instructions ?? '请登录微信小号。', qrCode: account.qrCode }
    }
    if (!this.setup.completedAt) {
      this.setup = { ...this.setup, sessionId, self: account.self, completedAt: Date.now(), openConsoleIn: sessionId }
      await this.store.updateBot({ setup: this.setup })
    }
    if (this.bot.chat) {
      await this.#mirror(this.bot.chat)
      this.#observeMemory(this.bot.chat)
    }
    return { step: 'ready', account: account.self, chat: this.bot.chat }
  }

  async consoleOpened() {
    if (!this.setup?.openConsoleIn) return
    this.setup = { ...this.setup, openConsoleIn: null }
    await this.store.updateBot({ setup: this.setup })
  }

  login() {
    return this.bot.login()
  }

  listChats(query) {
    return this.bot.listChats(query)
  }

  async watch(chatId) {
    const chat = await this.bot.setChat(chatId)
    if (chat) {
      await this.#mirror(chat)
      this.#observeMemory(chat)
    }
    return chat
  }

  setMode(mode) {
    return this.bot.setMode(mode)
  }

  setWindowVisible(visible) {
    return this.bot.setWindowVisible(visible)
  }

  // Runs the built-in decision suite against the real model, once per effort level.
  async evaluate(efforts = [this.config.model.reasoningEffort]) {
    const think = createThink({ llm: this.ctx.llm, role: 'reply', route: () => this.route() })
    const settings = { ...this.bot.settings, typingDelay: false }
    return formatEval(await runEval({ think, persona: await this.personas.text(), settings, efforts }))
  }

  windowState() {
    return this.bot.windowState()
  }

  simulate(params) {
    return this.bot.simulate(params)
  }
}
