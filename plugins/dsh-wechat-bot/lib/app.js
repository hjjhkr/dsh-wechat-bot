import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { AdapterClient, spawnAdapter } from './adapter.js'
import { Bot } from './bot.js'
import { CommandRegistry } from './commands.js'
import { formatEval, runEval } from './eval.js'
import { createThink } from './model.js'
import { ChatSession, chatSessionId } from './session.js'
import { Simulator } from './simulator.js'
import { Store } from './store.js'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DEFAULT_PERSONA = join(PACKAGE_ROOT, 'personas', 'persona_dafeiyu.md')

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

  static async create(ctx, config) {
    const app = new WeChatBotApp(ctx, config)
    await app.#start()
    return app
  }

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.dataDir = dataDirOf(config)
    this.store = new Store(this.dataDir)
  }

  async #start() {
    const config = this.config
    const persona = await readFile(config.personaPath || DEFAULT_PERSONA, 'utf8')
    const commands = new CommandRegistry()
    if (config.commandsDir) await commands.load(config.commandsDir)
    this.setup = (await this.store.loadBot()).setup ?? null
    const { adapter } = config
    this.persona = persona
    this.bot = new Bot({
      dataDir: this.dataDir, store: this.store, persona, commands,
      settings: {
        ...config.behavior,
        staleMs: config.behavior.staleMinutes * 60_000,
        aliases: config.aliases,
        owner: config.owner.id ? config.owner : undefined,
        admins: config.admins,
        stickers: config.stickers,
      },
      think: createThink({ llm: this.ctx.llm, route: () => this.route(), mirror: chat => this.#mirror(chat) }),
      createAdapter: () => adapter.command
        ? spawnAdapter({ command: adapter.command, args: adapter.args, cwd: adapter.cwd || undefined, env: adapter.env })
        // Like a real client, the simulated account stays logged in once set up.
        : inProcessSimulator({ loggedIn: Boolean(this.setup?.completedAt) }),
    })
    // Open each chat's DSH session before the UI can, so the plugin always owns it.
    this.bot.on('watch', chat => this.#mirror(chat))
    await this.bot.start()
    for (const chat of this.bot.watched) this.#mirror(chat)
  }

  async dispose() {
    await this.bot.dispose()
    await Promise.allSettled([...this.sessions.values()].map(s => s.then(session => session?.dispose())))
  }

  route() {
    const { model } = this.config
    const fallback = !model.provider && this.ctx.get?.('agentDefaultModel')?.currentSelection()
    return {
      provider: model.provider || fallback?.provider || 'deepseek-account',
      model: model.model || fallback?.model || 'deepseek-flash',
      reasoningEffort: model.reasoningEffort,
      maxTokens: model.maxTokens,
    }
  }

  // The DSH session mirroring `chat`, in the workspace where setup ran.
  #mirror(chat) {
    const self = this.setup?.self ?? this.bot.account.self
    if (!this.setup?.completedAt || !self) return undefined
    const key = `${self.id}\0${chat.id}`
    if (!this.sessions.has(key)) {
      const opening = ChatSession.open(this.ctx, {
        id: chatSessionId(self.id, chat.id), cwd: this.setup.workspace,
        title: `微信 · ${chat.name}`, route: this.route(),
      }).catch(error => {
        this.sessions.delete(key)
        this.bot.note('warn', `无法创建 DSH 会话「${chat.name}」：${error.message}`)
        return undefined
      })
      this.sessions.set(key, opening)
    }
    return this.sessions.get(key)
  }

  // ── operations ──────────────────────────────────────────────────────────

  state() {
    const view = this.bot.view()
    return {
      ...view,
      setup: this.setup,
      model: this.route(),
      chats: this.bot.chats,
      log: this.bot.log.slice(-100),
    }
  }

  chatLog(chatId) {
    return this.bot.chatLog(chatId)
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
    return { step: 'ready', account: account.self, watched: this.bot.watched }
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

  watch(chatIds) {
    return this.bot.setWatched(chatIds)
  }

  setMode(chatId, mode) {
    return this.bot.setMode(chatId, mode)
  }

  setWindowVisible(visible) {
    return this.bot.setWindowVisible(visible)
  }

  // Runs the built-in decision suite against the real model, once per effort level.
  async evaluate(efforts = [this.config.model.reasoningEffort]) {
    const think = createThink({ llm: this.ctx.llm, route: () => this.route() })
    const settings = { ...this.bot.settings, typingDelay: false }
    return formatEval(await runEval({ think, persona: this.persona, settings, efforts }))
  }

  windowState() {
    return this.bot.windowState()
  }

  simulate(params) {
    return this.bot.simulate(params)
  }
}
