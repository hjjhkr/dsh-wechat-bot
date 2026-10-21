import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODES } from './commands.js'

// The DSH-facing surface of WeChatBotApp: console HTTP routes, the `/wechat`
// command and the `wechat_bot` agent tool. Each is a thin adapter over the
// same operations so that the UI and the agent can never drift apart.

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export function registerRoutes(ctx, app) {
  ctx.connection.fetch.register({
    path: '/api/wechat-bot.state', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      const session = new URL(request.url).searchParams.get('session')
      const workspace = session && ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(session))?.path
      return json({ ...app.state(), here: { session, workspace } })
    },
  })
  ctx.connection.fetch.register({
    path: '/api/wechat-bot.log', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      const entries = app.chatLog(new URL(request.url).searchParams.get('chat') ?? '')
      return json({ entries: entries.map(entry => ({ ...entry, text: formatEntry(entry) })) })
    },
  })
  ctx.connection.fetch.register({
    path: '/api/wechat-bot.action', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: 'invalid_json' }, 400)
      }
      try {
        return json({ ok: true, result: await runAction(app, body) ?? null })
      } catch (error) {
        return json({ ok: false, error: error.message, code: error.code }, 400)
      }
    },
  })
}

function runAction(app, { action, ...args }) {
  switch (action) {
    case 'login': return app.login()
    case 'listChats': return app.listChats(args.query)
    case 'watch': return app.watch(args.chatIds)
    case 'mode': return app.setMode(args.chatId, args.mode)
    case 'window': return app.setWindowVisible(args.visible === true)
    case 'windowState': return app.windowState()
    case 'simulate': return app.simulate(args)
    case 'consoleOpened': return app.consoleOpened()
    default: throw new Error(`unknown action ${action}`)
  }
}

// ── text summaries shared by the command and the tool ─────────────────────

const CONNECTION = { connected: '已连接', degraded: '连接不稳定', disconnected: '未连接', adapter_down: '适配器未运行', starting: '启动中' }

export function describeState(state) {
  const lines = []
  const adapter = state.adapter ? `${state.adapter.name} ${state.adapter.version}` : '未连接'
  lines.push(`适配器：${adapter}${state.capabilities?.simulator ? '（模拟器，不连真实微信）' : ''}`)
  lines.push(`连接：${CONNECTION[state.connection.state] ?? state.connection.state}${state.connection.canSend ? '' : '，暂时不能发送'}${state.connection.reason ? `（${state.connection.reason}）` : ''}`)
  lines.push(`小号：${state.account.state === 'ready' ? state.account.self.name : '未登录'}`)
  lines.push(`模型：${state.model.provider} / ${state.model.model}，思考 ${state.model.reasoningEffort}`)
  if (!state.watched.length) lines.push('监听：还没有选择聊天')
  for (const chat of state.watched) lines.push(`· ${chat.name}（${chat.kind === 'group' ? '群' : '私聊'}）：${chat.mode ?? '-'}，${chat.status}`)
  return lines.join('\n')
}

function describeSetup(result) {
  if (result.step === 'login') {
    return `第一步：登录微信小号。\n${result.instructions}\n登录好以后回到这里，再输入 /wechat（或告诉我"好了"）完成初始化。`
  }
  const watching = result.watched.length ? `正在监听：${result.watched.map(c => c.name).join('、')}` : '下一步在右侧栏「微信机器人」控制台里选择要监听的聊天。'
  return `初始化完成，小号「${result.account.name}」已连接。控制台在右侧栏「微信机器人」。\n${watching}\n这个工作区里会为每个监听的聊天生成「微信 · 聊天名」会话，可以随时打开看模型在想什么。`
}

const where = agent => ({ workspace: agent?.session?.header?.cwd, sessionId: agent?.id })

export function registerCommand(ctx, app) {
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-wechat-bot'),
    name: 'wechat',
    description: '微信机器人：首次初始化，之后查看状态',
    input: { hint: '[status]' },
    handler: async invocation => {
      try {
        if (invocation.rawInput.trim() === 'status' && app.setup?.completedAt) {
          return { kind: 'success', text: describeState(app.state()) }
        }
        return { kind: 'success', text: describeSetup(await app.setupFrom(where(invocation.agent))) }
      } catch (error) {
        return { kind: 'error', text: `微信机器人：${error.message}` }
      }
    },
  }), 'wechat-bot: /wechat command')
}

async function findChat(app, ref) {
  const match = list => list.find(c => c.id === ref) ?? list.find(c => c.name === ref) ?? list.find(c => c.name.includes(ref))
  return match(app.bot.watched) ?? match(app.bot.chats) ?? match(await app.listChats())
}

export function registerTool(ctx, app) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wechat_bot',
    description: '操作微信群聊机器人插件。setup：在当前工作区初始化（用户第一次提到微信机器人、或说已登录小号时调用）；status：查看连接、监听和模式；chats：列出小号的聊天；watch：设置要监听的聊天（会替换原列表）；mode：切换某个聊天的发言模式；log：看某个聊天最近的处理日志。',
    parameters: {
      action: { type: 'string', required: true, enum: ['setup', 'status', 'chats', 'watch', 'mode', 'log'] },
      chats: { type: 'array', items: { type: 'string' }, description: 'watch：聊天名称或 id 列表' },
      chat: { type: 'string', description: 'mode / log：聊天名称或 id' },
      mode: { type: 'string', enum: Object.keys(MODES), description: 'mode：free 自由发言 / mention 只回复@和点名 / silent 不说话' },
      query: { type: 'string', description: 'chats：按名称过滤' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      switch (args.action) {
        case 'setup': return describeSetup(await app.setupFrom(where(exec.agent)))
        case 'status': return describeState(app.state())
        case 'chats': {
          const chats = await app.listChats(args.query)
          return chats.map(c => `${c.name}（${c.kind === 'group' ? '群' : '私聊'}，id ${c.id}）`).join('\n') || '没有聊天'
        }
        case 'watch': {
          const ids = []
          for (const ref of args.chats ?? []) {
            const chat = await findChat(app, ref)
            if (!chat) return `找不到聊天「${ref}」`
            ids.push(chat.id)
          }
          const watched = await app.watch(ids)
          return watched.length ? `开始监听：${watched.map(c => c.name).join('、')}` : '已停止监听所有聊天'
        }
        case 'mode': {
          const chat = args.chat && await findChat(app, args.chat)
          if (!chat) return `找不到聊天「${args.chat ?? ''}」`
          app.setMode(chat.id, args.mode)
          return `「${chat.name}」已切换为 ${args.mode}：${MODES[args.mode]}`
        }
        case 'log': {
          const chat = args.chat && await findChat(app, args.chat)
          if (!chat) return `找不到聊天「${args.chat ?? ''}」`
          return app.chatLog(chat.id).slice(-30).map(formatEntry).join('\n') || '还没有日志'
        }
        default: return `未知操作 ${args.action}`
      }
    },
  })), 'wechat-bot: wechat_bot tool')
}

export function formatEntry(entry) {
  const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })
  const body = {
    message: () => `${entry.from}：${entry.text}`,
    batch: () => `处理 ${entry.count} 条新消息`,
    decision: () => entry.reply.length ? `决定回复：${entry.reply.map(p => p.text ?? `[${p.name}]`).join(' / ')}` : '决定不说话',
    sent: () => `已发送：${entry.part.text ?? `[${entry.part.name}]`}`,
    silent: () => '保持沉默',
    skipped: () => `跳过（${entry.reason}）`,
    superseded: () => `有 ${entry.newer} 条新消息，重新考虑`,
    memory: () => `记忆：+${entry.applied.length}${entry.rejected.length ? `，拒绝 ${entry.rejected.length}` : ''}`,
    command: () => `${entry.from} 使用 /${entry.name} ${entry.text}`,
    mode: () => `模式切换为 ${entry.mode}`,
    mute: () => entry.until ? `禁言到 ${new Date(entry.until).toLocaleTimeString('zh-CN', { hour12: false })}` : '解除禁言',
    waiting: () => '等待可以发送（可能锁屏/断线）',
    dropped: () => '回复过时，已放弃',
    invalid_output: () => `模型输出不合格（${entry.code}）`,
    send_error: () => `发送失败（${entry.code}${entry.uncertain ? '，可能已送达，不重试' : ''}）`,
    error: () => `错误：${entry.message}`,
  }[entry.type]
  return `${time} ${body ? body() : entry.type}`
}
