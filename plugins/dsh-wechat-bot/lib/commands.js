import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CronError, describeTime } from './cron.js'
import { EngagementError, STYLES, openingInstruction, resolveMember } from './engagement.js'
import { EFFORTS, ModelError } from './models.js'

// Chat commands: a WeChat message that starts with "/" (or a full-width "／",
// optionally after @-mentions) is routed here before it can reach the model.
// Commands never wait in line: they run the moment they arrive, their reply is
// sent ahead of any queued reply parts, and `interrupts: true` commands abort an
// answer that is still being thought out (it is reconsidered under the new state).
//
// A command's `run(call)` returns one of:
//   string | { reply: string }          answer directly, the model is not involved
//   { forward: { instruction, text?, effort? } }
//                                       hand the message to the model ahead of everything
//                                       else, with an extra instruction (and optionally a
//                                       reasoning effort); `ack` is sent immediately
//   undefined                           do nothing visible
// See docs/commands.md for the full contract and how to add your own.

// When the model is asked at all. All modes answer commands.
export const MODES = Object.freeze({
  free: '自由：每批消息都给模型，它自己决定要不要接话',
  infer: '推断：判断是否有人找我，主动插话有间隔',
  at: '只回@：只有被 @ 或被引用回复时才说话',
  silent: '静音：不说话（命令仍然可用）',
})

export const MODE_ALIASES = Object.freeze({
  'at-only': 'at', at_only: 'at', mention: 'at', '@': 'at',
  auto: 'infer', smart: 'infer',
  quiet: 'silent', off: 'silent', mute: 'silent',
})

export const resolveMode = name => MODES[name] ? name : MODE_ALIASES[name]

const COMMAND = /^(?:@\S+[\s ]+)*[/／]([A-Za-z][\w-]{0,31}|[一-鿿]{1,8})(?:[\s ]+([\s\S]*))?$/

export function parseCommand(text) {
  const match = COMMAND.exec(text.trim())
  if (!match) return null
  const rest = (match[2] ?? '').trim()
  return { name: match[1].toLowerCase(), text: rest, args: rest ? rest.split(/[\s ]+/) : [] }
}

const minutes = ms => Math.max(1, Math.round(ms / 60_000))

const CRON_USAGE = [
  '/cron 10m 内容　　　　　10 分钟后（也可 1h30m、90s、2小时）',
  '/cron 10:00 内容　　　　下一个 10 点（也可 10点半、9点15分）',
  '/cron 明天 8:00 内容　　 也可 后天 / 10-22 / 2026-10-22',
  '/cron 每天 10:00 内容　　每天重复',
  '/cron 10:00 UTC-5 内容　时区写在时间后面（默认东八区，也可 +09:00、Asia/Tokyo）',
  '/cron list　　　　　　　看所有定时',
  '/cron cancel 编号　　　 取消自己设的定时',
].join('\n')

const describeModel = m => `${m.provider}/${m.model}，思考 ${m.reasoningEffort}${m.overridden ? '' : '（配置默认）'}`

// Runs a model-control action and turns validation failures into a reply.
async function modelAction(models, action) {
  if (!models) return '这里不能切换模型'
  try {
    return await action()
  } catch (error) {
    if (!(error instanceof ModelError)) throw error
    return `没改成：${error.message}`
  }
}

// /attack and /comfort: start keeping on at one member (resolved by @ or nickname, never by the model).
const engageCommand = (style, aliases) => ({
  name: style,
  aliases,
  usage: `/${style} <昵称或 @TA>`,
  summary: `持续${STYLES[style]}某人：TA 说一句我回一句，不理其他人，/un${style} 停止`,
  interrupts: true,
  run: async ({ text, message, members, selfId, engagement }) => {
    let target
    try {
      target = resolveMember(text, { mentions: message.mentions, members: await members(), selfId })
    } catch (error) {
      if (!(error instanceof EngagementError)) throw error
      return `没开始：${error.message}`
    }
    const previous = engagement.start(style, target)
    const replaced = previous && (previous.target.id !== target.id || previous.style !== style)
      ? `（原来的${STYLES[previous.style]} ${previous.target.name} 已结束）` : ''
    return { forward: {
      engagement: engagement.current().id, // the opening is dropped if this engagement ends first
      text: `${STYLES[style]} ${target.name}`,
      instruction: openingInstruction(style, target),
      ack: `已执行：开始${STYLES[style]} ${target.name}${replaced}。TA 说一句我回一句，/un${style} 停止`,
    } }
  },
})

const disengageCommand = (style, aliases) => ({
  name: `un${style}`,
  aliases,
  summary: `停止${STYLES[style]}`,
  interrupts: true,
  run: ({ engagement }) => {
    const current = engagement.current()
    if (!current) return `现在没有在${STYLES[style]}谁`
    if (current.style !== style) return `现在是在${STYLES[current.style]} ${current.target.name}，用 /un${current.style} 停止`
    engagement.stop()
    return `已执行：停止${STYLES[style]} ${current.target.name}`
  },
})

const shortText = text => (text.length > 30 ? text.slice(0, 30) + '…' : text).replace(/\s+/g, ' ')

export const builtinCommands = [
  {
    name: 'help',
    aliases: ['帮助'],
    summary: '列出所有命令',
    run: ({ commands, mode, wait }) => [
      '可用命令（直接执行，不排队）：',
      ...commands.map(c => `${c.usage ?? '/' + c.name}${c.aliases?.length ? `（${c.aliases.map(a => '/' + a).join(' ')}）` : ''}  ${c.summary}`),
      '',
      `发言模式（当前 ${mode}）：`,
      ...Object.entries(MODES).map(([name, text]) => `${name}  ${text}`),
      ...(wait ? ['', `合批：群里静默 ${wait.current().quietMs / 1000} 秒算一批，最多等 ${wait.current().maxWaitMs / 1000} 秒（/wait 调整）`] : []),
    ].join('\n'),
  },
  {
    name: 'mode',
    aliases: ['模式'],
    usage: '/mode [free|infer|at|silent]',
    summary: '查看或切换发言模式',
    interrupts: true,
    run: ({ args, mode, setMode }) => {
      if (!args.length) return `当前模式：${mode}（${MODES[mode]}）\n可选：${Object.keys(MODES).join(' / ')}`
      const next = resolveMode(args[0].toLowerCase())
      if (!next) return `没有「${args[0]}」模式，可选：${Object.keys(MODES).join(' / ')}`
      setMode(next)
      return `已执行：切换为 ${next}（${MODES[next]}）`
    },
  },
  {
    name: 'wait',
    aliases: ['等待', '合批'],
    usage: '/wait [静默秒数] [上限秒数] | reset',
    summary: '查看或设置合批等待：群里静默几秒算一批、一批最多等几秒',
    run: ({ args, wait }) => {
      const show = w => `静默 ${w.quietMs / 1000} 秒、最多 ${w.maxWaitMs / 1000} 秒`
      if (!args.length) return `合批等待：${show(wait.current())}
用法：/wait 3 8（静默 3 秒、最多 8 秒），/wait 3（只改静默），/wait reset（恢复默认）`
      if (['reset', '默认', '恢复'].includes(args[0].toLowerCase())) {
        wait.set(null)
        return `已执行：合批等待恢复为 ${show(wait.current())}`
      }
      const quiet = Number(args[0])
      const max = args[1] === undefined ? Math.min(Math.max(wait.current().maxWaitMs / 1000, quiet), 120) : Number(args[1])
      if (!Number.isFinite(quiet) || quiet < 0.5 || quiet > 30) return '没改成：静默秒数要在 0.5 到 30 之间'
      if (!Number.isFinite(max) || max < quiet || max > 120) return '没改成：上限秒数要不小于静默秒数，且不超过 120'
      wait.set({ quietMs: Math.round(quiet * 1000), maxWaitMs: Math.round(max * 1000) })
      return `已执行：合批等待改为 ${show(wait.current())}`
    },
  },
  {
    name: 'mute',
    aliases: ['闭嘴'],
    usage: '/mute [分钟]',
    summary: '临时禁言，默认 30 分钟',
    interrupts: true,
    run: ({ args, mute }) => {
      const value = Number(args[0] ?? 30)
      if (!Number.isFinite(value) || value <= 0 || value > 24 * 60) return '分钟数要在 1 到 1440 之间'
      mute(value * 60_000)
      return `已执行：安静 ${value} 分钟`
    },
  },
  {
    name: 'unmute',
    summary: '解除临时禁言',
    interrupts: true,
    run: ({ mute }) => {
      mute(0)
      return '已执行：解除禁言'
    },
  },
  {
    name: 'status',
    aliases: ['状态'],
    summary: '运行状态',
    run: async ({ status }) => {
      const s = await status()
      const muted = s.mutedUntil > Date.now() ? `，禁言中还剩 ${minutes(s.mutedUntil - Date.now())} 分钟` : ''
      const engaged = s.engagement ? `\n正在${STYLES[s.engagement.style]} ${s.engagement.target.name}（/un${s.engagement.style} 停止）` : ''
      return `模式 ${s.mode}${muted}${engaged}\n今天处理 ${s.today.batches} 批消息，发言 ${s.today.sent} 条\n上下文 ${s.context} 条，记住了 ${s.members} 位成员`
    },
  },
  {
    name: 'memory',
    aliases: ['记忆'],
    summary: '看看我记住了你什么',
    run: async ({ sender, memory }) => {
      const notes = await memory.recall(sender.id)
      const lines = Object.entries(notes).filter(([, note]) => note).map(([topic, note]) => `· ${topic}：${note}`)
      return lines.length ? `关于你我记得：\n${lines.join('\n')}` : '还没记住你什么'
    },
  },
  {
    name: 'forget',
    aliases: ['忘记'],
    usage: '/forget [主题|all]',
    summary: '让我忘掉关于你的某件事或全部',
    // An answer still being thought out may carry memory about this person; it must not land after the forget.
    interrupts: true,
    run: async ({ sender, text, memory }) => {
      if (!text) return '要忘掉什么？/forget 主题，或者 /forget all'
      const removed = await memory.forget(sender.id, text === 'all' || text === '全部' ? undefined : text)
      return removed ? `已执行：忘掉 ${removed} 条` : `没有叫「${text}」的记忆，/memory 看看有哪些`
    },
  },
  {
    name: 'reset',
    summary: '清空这个聊天的短期上下文（不影响长期记忆）',
    interrupts: true,
    run: ({ resetContext }) => {
      resetContext()
      return '已执行：上下文清空了'
    },
  },
  engageCommand('attack', ['嘲讽', '怼']),
  disengageCommand('attack', ['停止嘲讽']),
  engageCommand('comfort', ['安慰']),
  disengageCommand('comfort', ['停止安慰']),
  {
    name: 'persona',
    aliases: ['人设'],
    usage: '/persona [名字|reset]',
    summary: '查看或切换人设（人设库里的 Markdown 文件，可手工维护）',
    interrupts: true,
    run: async ({ args, personas }) => {
      if (!personas) return '没有配置人设库'
      const names = await personas.list()
      if (!args.length) return `当前人设：${personas.name}\n人设库：${names.join('、') || '（空）'}\n用法：/persona 名字，/persona reset 恢复默认（${personas.fallback}）`
      const reset = ['reset', '默认', '恢复'].includes(args[0].toLowerCase())
      if (!(await personas.use(reset ? undefined : args.join(' ')))) return `没改成：人设库里没有「${args.join(' ')}」，可选：${names.join('、')}`
      return `已执行：人设切换为 ${personas.name}`
    },
  },
  {
    name: 'model',
    aliases: ['模型'],
    usage: '/model [模型名 | provider/模型名 | reset]',
    summary: '查看或切换模型（只影响之后的回复）',
    run: ({ text, models }) => modelAction(models, async () => {
      if (!text) {
        const catalog = await models.catalog()
        const now = models.current()
        return `当前：${describeModel(now)}\n可用：${catalog.map(m => m.id === now.model ? `[${m.id}]` : m.id).join('、') || '（没有）'}`
      }
      if (['reset', '默认', '恢复'].includes(text.toLowerCase())) return `已执行：恢复配置默认 ${describeModel(await models.reset())}`
      const next = await models.useModel(text)
      return `已执行：切换为 ${describeModel(next)}${next.adjusted ? `（新模型不支持思考 ${next.adjusted}，已调整）` : ''}`
    }),
  },
  {
    name: 'think',
    aliases: ['思考'],
    usage: '/think [off|low|high|max|on]',
    summary: '查看或调整思考强度（off 不思考，on = high）',
    run: ({ args, models }) => modelAction(models, async () => {
      if (!args.length) return `当前：${describeModel(models.current())}\n可选：${EFFORTS.join(' / ')}`
      const effort = { on: 'high', 开: 'high', 关: 'off', 不思考: 'off' }[args[0].toLowerCase()] ?? args[0].toLowerCase()
      return `已执行：思考强度 ${(await models.setEffort(effort)).reasoningEffort}`
    }),
  },
  {
    name: 'cron',
    aliases: ['定时'],
    usage: '/cron <时间> [时区] <内容> · /cron list · /cron cancel <编号>',
    summary: '定时发一条消息（默认东八区）',
    run: ({ text, args, sender, cron }) => {
      const sub = args[0]?.toLowerCase()
      if (!args.length || sub === 'help' || sub === '帮助') return `用法：\n${CRON_USAGE}`
      try {
        if (['list', 'ls', '列表', '查看'].includes(sub)) {
          const jobs = cron.list()
          if (!jobs.length) return '没有定时'
          return jobs.map(j => `#${j.id} ${j.repeat === 'daily' ? '每天 ' : ''}${describeTime(j.at, j.zone)} 「${shortText(j.text)}」 ${j.owner.name}`).join('\n')
        }
        if (['cancel', 'rm', 'del', '取消', '删除'].includes(sub)) {
          const id = Number((args[1] ?? '').replace(/^#/, ''))
          if (!Number.isInteger(id) || id <= 0) return '要取消哪个？/cron cancel 编号（/cron list 能看到编号）'
          const job = cron.cancel(id, sender)
          return `已执行：取消 #${job.id}「${shortText(job.text)}」`
        }
        const job = cron.add(text)
        return `已执行：#${job.id} ${job.repeat === 'daily' ? '每天 ' : ''}${describeTime(job.at, job.zone)} 发「${shortText(job.text)}」`
      } catch (error) {
        if (!(error instanceof CronError)) throw error
        return `定时没设成：${error.message}\n${CRON_USAGE}`
      }
    },
  },
  {
    name: 'ask',
    aliases: ['问'],
    usage: '/ask <问题>',
    summary: '认真回答一个问题（会深度思考，插队处理，禁言/只回@时也回答）',
    interrupts: true,
    ack: '收到，想一下',
    run: ({ text }) => text
      ? { forward: { text, effort: 'high', instruction: '对方用 /ask 认真提问。这次要给出靠谱、准确的回答，可以比平时多说几句，但保持人设口吻，不要写成文章。' } }
      : '问啥？/ask 后面跟问题',
  },
  {
    name: 'tldr',
    aliases: ['总结'],
    summary: '总结一下刚才大家在聊什么',
    interrupts: true,
    ack: '收到，翻翻记录',
    run: () => ({ forward: {
      text: '刚才聊了啥',
      instruction: '对方用 /tldr 请你总结 recent 里最近的聊天。这次允许总结：用人设口吻，两三句话说清谁在聊什么、有什么结论，不要逐条复述。',
    } }),
  },
]

export class CommandRegistry {
  #byName = new Map()

  constructor(commands = builtinCommands) {
    for (const command of commands) this.define(command)
  }

  define(command) {
    if (!command?.name || typeof command.run !== 'function') throw new TypeError('a command needs a name and run()')
    const entry = { summary: '', ...command, name: command.name.toLowerCase() }
    for (const name of [entry.name, ...(entry.aliases ?? [])]) this.#byName.set(name.toLowerCase(), entry)
    return entry
  }

  get(name) {
    return this.#byName.get(name)
  }

  list() {
    return [...new Set(this.#byName.values())]
  }

  // Loads every `*.js` / `*.mjs` file in `dir` whose default export is a command.
  async load(dir) {
    const loaded = []
    for (const file of (await readdir(dir)).filter(f => /\.m?js$/.test(f)).sort()) {
      const module = await import(pathToFileURL(join(dir, file)).href)
      loaded.push(this.define(module.default).name)
    }
    return loaded
  }
}
