import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CronError, describeTime } from './cron.js'

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
  infer: '推断：程序先判断是不是在跟我说话（@、引用、叫名字、接话），像是才交给模型',
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

const shortText = text => (text.length > 30 ? text.slice(0, 30) + '…' : text).replace(/\s+/g, ' ')

export const builtinCommands = [
  {
    name: 'help',
    aliases: ['帮助'],
    summary: '列出所有命令',
    run: ({ commands, mode }) => [
      '可用命令（直接执行，不排队）：',
      ...commands.map(c => `${c.usage ?? '/' + c.name}${c.aliases?.length ? `（/${c.aliases[0]}）` : ''}  ${c.summary}`),
      '',
      `发言模式（当前 ${mode}）：`,
      ...Object.entries(MODES).map(([name, text]) => `${name}  ${text}`),
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
    run: ({ status }) => {
      const s = status()
      const muted = s.mutedUntil > Date.now() ? `，禁言中还剩 ${minutes(s.mutedUntil - Date.now())} 分钟` : ''
      return `模式 ${s.mode}${muted}\n今天处理 ${s.today.batches} 批消息，发言 ${s.today.sent} 条\n上下文 ${s.context} 条，记住了 ${s.members} 位成员`
    },
  },
  {
    name: 'memory',
    aliases: ['记忆'],
    summary: '看看我记住了你什么',
    run: ({ sender, memory }) => {
      const notes = memory.recall(sender.id)
      const lines = Object.entries(notes).map(([topic, note]) => `· ${topic}：${note}`)
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
    run: ({ sender, text, memory }) => {
      if (!text) return '要忘掉什么？/forget 主题，或者 /forget all'
      const removed = memory.forget(sender.id, text === 'all' || text === '全部' ? undefined : text)
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
