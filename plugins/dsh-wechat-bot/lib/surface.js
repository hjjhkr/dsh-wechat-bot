import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODES } from './commands.js'
import { STYLES } from './engagement.js'

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
    fetch: async () => json({ entries: app.chatLog().map(entry => ({ ...entry, text: formatEntry(entry) })) }),
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
    case 'watch': return app.watch(args.chatId ?? null)
    case 'mode': return app.setMode(args.mode)
    case 'window': return app.setWindowVisible(args.visible === true)
    case 'windowState': return app.windowState()
    case 'simulate': return app.simulate(args)
    case 'consoleOpened': return app.consoleOpened()
    default: throw new Error(`unknown action ${action}`)
  }
}

// ── text summaries shared by the command and the tool ─────────────────────

const CONNECTION = { connected: '已连接', degraded: '连接不稳定', disconnected: '未连接', adapter_down: '适配器未运行', starting: '启动中' }
const STATUS = { idle: '空闲', thinking: '思考中', sending: '发送中', waiting: '等待可发送', throttled: '限速/熔断等待中', stopped: '未运行' }

export function describeState(state) {
  const lines = []
  const adapter = state.adapter ? `${state.adapter.name} ${state.adapter.version}` : '未连接'
  lines.push(`适配器：${adapter}${state.capabilities?.simulator ? '（模拟器，不连真实微信）' : ''}`)
  lines.push(`连接：${CONNECTION[state.connection.state] ?? state.connection.state}${state.connection.canSend ? '' : '，暂时不能发送'}${state.connection.reason ? `（${state.connection.reason}）` : ''}`)
  lines.push(`小号：${state.account.state === 'ready' ? state.account.self.name : '未登录'}`)
  lines.push(`模型：${state.model.provider} / ${state.model.model}，思考 ${state.model.reasoningEffort}`)
  const chat = state.chat
  if (!chat) return [...lines, '群聊：还没有选择'].join('\n')
  lines.push(`群聊：${chat.name}，${chat.mode ?? '-'}，${STATUS[chat.status] ?? chat.status}`)
  if (chat.counters) {
    const c = chat.counters
    lines.push(`健康：收到 ${c.received}，积压 ${chat.backlog}，溢出转上下文 ${c.overflow}，限速延后 ${c.deferred}，模型失败 ${c.modelErrors}，熔断 ${c.breakerTrips} 次，发送失败 ${c.sendErrors}，自动恢复 ${state.recoveries}`)
    if (chat.engagement) lines.push(`正在${STYLES[chat.engagement.style]} ${chat.engagement.target.name}：只回 TA，/un${chat.engagement.style} 停止`)
    if (chat.breaker.open) lines.push(`模型熔断中，${new Date(chat.breaker.until).toLocaleTimeString('zh-CN', { hour12: false })} 后重试`)
  }
  return lines.join('\n')
}

function describeSetup(result) {
  if (result.step === 'login') {
    return `第一步：登录微信小号。\n${result.instructions}\n登录好以后回到这里，再输入 /wechat（或告诉我"好了"）完成初始化。`
  }
  const watching = result.chat ? `正在服务的群：${result.chat.name}` : '下一步在右侧栏「微信机器人」控制台里选择要服务的群。'
  return `初始化完成，小号「${result.account.name}」已连接。控制台在右侧栏「微信机器人」。\n${watching}\n这个工作区里会生成「微信 · 群名」会话，可以随时打开看模型在想什么。`
}

const EFFORTS = ['off', 'low', 'high', 'max']
const efforts = list => {
  const chosen = list.filter(e => EFFORTS.includes(e))
  return chosen.length ? chosen : undefined
}

const where = agent => ({ workspace: agent?.session?.header?.cwd, sessionId: agent?.id })

export function registerCommand(ctx, app) {
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-wechat-bot'),
    name: 'wechat',
    description: '微信机器人：首次初始化，之后查看状态',
    input: { hint: '[status | eval [off|low|high|max ...]]' },
    handler: async invocation => {
      const [sub, ...rest] = invocation.rawInput.trim().split(/\s+/)
      try {
        if (sub === 'status' && app.setup?.completedAt) return { kind: 'success', text: describeState(app.state()) }
        if (sub === 'eval') return { kind: 'success', text: await app.evaluate(efforts(rest)) }
        return { kind: 'success', text: describeSetup(await app.setupFrom(where(invocation.agent))) }
      } catch (error) {
        return { kind: 'error', text: `微信机器人：${error.message}` }
      }
    },
  }), 'wechat-bot: /wechat command')
}

async function findChat(app, ref) {
  const match = list => list.find(c => c.id === ref) ?? list.find(c => c.name === ref) ?? list.find(c => c.name.includes(ref))
  return match(app.bot.chats) ?? match(await app.listChats())
}

export function registerTool(ctx, app) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wechat_bot',
    description: '操作微信群聊机器人插件（只服务一个群）。setup：在当前工作区初始化（用户第一次提到微信机器人、或说已登录小号时调用）；status：查看连接、群、模式和健康状况；chats：列出小号的聊天；watch：选择要服务的群（chat 为空表示停止）；mode：切换发言模式；log：看最近的处理日志；eval：用内置群聊场景评测模型判断"该不该说话、在跟谁说"的准确率，可比较不同思考强度。',
    parameters: {
      action: { type: 'string', required: true, enum: ['setup', 'status', 'chats', 'watch', 'mode', 'log', 'eval'] },
      chat: { type: 'string', description: 'watch：群名称或 id' },
      mode: { type: 'string', enum: Object.keys(MODES), description: 'mode：free 每批都给模型 / infer 像是在跟它说话才给模型 / at 只回@ / silent 不说话' },
      query: { type: 'string', description: 'chats：按名称过滤' },
      efforts: { type: 'array', items: { type: 'string', enum: EFFORTS }, description: 'eval：要比较的思考强度，默认用当前配置' },
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
          if (!args.chat) return (await app.watch(null), '已停止服务')
          const chat = await findChat(app, args.chat)
          if (!chat) return `找不到聊天「${args.chat}」`
          await app.watch(chat.id)
          return `开始服务「${chat.name}」`
        }
        case 'mode':
          app.setMode(args.mode)
          return `已切换为 ${args.mode}：${MODES[args.mode]}`
        case 'log': return app.chatLog().slice(-30).map(formatEntry).join('\n') || '还没有日志'
        case 'eval': return app.evaluate(efforts(args.efforts ?? []))
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
    skipped: () => entry.reason === 'engaged' ? `跳过 ${entry.count} 条（正在专门回应某人）` : `跳过（${entry.reason}）`,
    engagement_start: () => `开始${STYLES[entry.style]} ${entry.target}`,
    engagement_end: () => `结束${STYLES[entry.style]} ${entry.target}${entry.reason === 'idle' ? '（TA 太久没说话）' : ''}`,
    idle_dropped: () => '有人开始说话了，主动发言作废',
    interrupted: () => `被 ${entry.reason} 打断，按新状态重新处理`,
    memory: () => `记忆：+${entry.applied.length}${entry.rejected.length ? `，拒绝 ${entry.rejected.length}` : ''}`,
    command: () => `${entry.from} 使用 /${entry.name} ${entry.text}`,
    mode: () => `模式切换为 ${entry.mode}`,
    mute: () => entry.until ? `禁言到 ${new Date(entry.until).toLocaleTimeString('zh-CN', { hour12: false })}` : '解除禁言',
    waiting: () => '等待可以发送（可能锁屏/断线）',
    dropped: () => entry.reason === 'stale' ? '回复过时，已放弃' : '已禁言，剩下的不发了',
    overflow: () => `消息太多，较早的只作为上下文（累计 ${entry.total} 条）`,
    deferred: () => entry.reason === 'breaker_open' ? `模型熔断中，${Math.ceil(entry.waitMs / 1000)} 秒后再试` : `说话太频繁，${Math.ceil(entry.waitMs / 1000)} 秒后再处理`,
    breaker_open: () => `模型连续失败，暂停 ${Math.round(entry.coolDownMs / 1000)} 秒（${entry.reason}）`,
    invalid_output: () => `模型输出不合格（${entry.code}）`,
    send_error: () => `发送失败（${entry.code}${entry.uncertain ? '，可能已送达，不重试' : ''}）`,
    error: () => `错误：${entry.message}`,
  }[entry.type]
  return `${time} ${body ? body() : entry.type}`
}
