import { ChatRunner } from './chat.js'
import { parseMessage } from './protocol.js'

// A small, fixed suite of group-chat situations used to measure how well the
// configured model decides *whether* to speak and *to whom*, per reasoning effort.
// `expect.reply`: true = must answer, false = must stay out, undefined = either is fine.
// `expect.to`: index into `batch` of the message the answer should address.

const SELF = { id: 'wxid_bot', name: '小鲸鱼' }
const PEOPLE = {
  阿离: { id: 'wxid_alice', name: '阿离' },
  老鲍: { id: 'wxid_bob', name: '老鲍' },
  路人: { id: 'wxid_carol', name: '路人甲' },
}

export const SCENARIOS = [
  { name: '被 @ 直接提问', batch: [['阿离', '周末去哪玩比较好', { at: 'bot' }]], expect: { reply: true, to: 0 } },
  { name: '叫名字提问', batch: [['老鲍', '小鲸鱼，你会写诗吗']], expect: { reply: true, to: 0 } },
  { name: '两个群友互相 @', batch: [['阿离', '明天几点出发', { at: '老鲍' }], ['老鲍', '八点吧', { at: '阿离' }]], expect: { reply: false } },
  { name: '引用别人的话接梗', history: [['老鲍', '我今天把咖啡洒键盘上了']], batch: [['阿离', '哈哈哈哈你也太惨了', { quote: 0 }]], expect: { reply: false } },
  { name: '引用机器人的话追问', history: [['阿离', '推荐个电影'], ['bot', '看星际穿越']], batch: [['阿离', '看过了，换一个', { quote: 1 }]], expect: { reply: true, to: 0 } },
  { name: '刚聊完的人接着说', history: [['阿离', '小鲸鱼你喜欢吃什么'], ['bot', '鱼。开玩笑的，喜欢吃token']], batch: [['阿离', '那你一天吃多少']], expect: { reply: true, to: 0 } },
  { name: '把问题拆成几条发', batch: [['老鲍', '小鲸鱼'], ['老鲍', '问你个事'], ['老鲍', '猫能吃葡萄吗']], expect: { reply: true } },
  { name: '一批里只有最后一条在找它', batch: [['阿离', '今天加班到九点', { at: '老鲍' }], ['老鲍', '辛苦了'], ['路人', '小鲸鱼你说加班有意义吗']], expect: { reply: true, to: 2 } },
  { name: '第三人称提到它', batch: [['阿离', '我觉得 deepseek 写代码比我强', { at: '老鲍' }]], expect: {} },
  { name: '群里随口闲聊', batch: [['阿离', '今天好冷'], ['老鲍', '是啊，我都穿羽绒服了']], expect: {} },
  { name: '私聊', chat: 'direct', batch: [['阿离', '在吗']], expect: { reply: true, to: 0 } },
]

function buildMessages(rows, chatId, start, offset = 0) {
  return rows.map(([who, text, extra = {}], index) => {
    const sender = who === 'bot' ? SELF : PEOPLE[who]
    return {
      id: `m${offset + index}`, chatId, time: start + (offset + index) * 20_000, kind: 'text', text, sender,
      fromSelf: who === 'bot',
      mentions: extra.at ? [extra.at === 'bot' ? SELF.id : PEOPLE[extra.at].id] : [],
    }
  })
}

async function runScenario(scenario, { think, persona, settings, effort }) {
  const direct = scenario.chat === 'direct'
  const chat = direct ? { id: 'wxid_alice', name: '阿离', kind: 'direct' } : { id: 'eval@chatroom', name: '评测群', kind: 'group' }
  const start = Date.now() - 10 * 60_000
  const history = buildMessages(scenario.history ?? [], chat.id, start)
  const batch = buildMessages(scenario.batch, chat.id, start, history.length).map((message, index) => {
    const quote = scenario.batch[index][2]?.quote
    if (quote === undefined) return parseMessage(message)
    const original = history[quote]
    return parseMessage({ ...message, quote: { messageId: original.id, senderId: original.sender.id, senderName: original.sender.name, text: original.text } })
  })
  const runner = new ChatRunner({
    chat, persona, settings: { ...settings, correctionRetries: 0, idleMinutes: 0 },
    account: () => SELF,
    link: { send: async () => ({}), canSend: () => true, whenCanSend: async () => {} },
    think: args => think({ ...args, effort }),
  })
  runner.prime(history.map(parseMessage))
  const lastBot = history.findLast(m => m.fromSelf)
  const answered = lastBot && history.findLast(m => !m.fromSelf && m.time < lastBot.time)
  if (answered) runner.lastBotTurns = [{ time: lastBot.time, toSenderId: answered.sender.id }]
  const started = Date.now()
  try {
    const decision = await runner.decide(batch)
    const replied = decision.reply.length > 0
    const problems = []
    if (scenario.expect.reply !== undefined && replied !== scenario.expect.reply) problems.push(replied ? '不该插话却回复了' : '该回复却沉默了')
    if (replied && scenario.expect.to !== undefined && decision.to !== batch[scenario.expect.to].id) problems.push(`回应对象错了（${decision.to ?? '未指明'}）`)
    return { name: scenario.name, ok: !problems.length, problems, reply: decision.reply.map(p => p.text ?? `[${p.name}]`), ms: Date.now() - started, valid: true }
  } catch (error) {
    return { name: scenario.name, ok: false, problems: [`输出无效：${error.code ?? error.message}`], reply: [], ms: Date.now() - started, valid: false }
  } finally {
    runner.dispose()
  }
}

async function pool(items, size, work) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  }))
  return results
}

export async function runEval({ think, persona, settings = {}, efforts = ['off'], scenarios = SCENARIOS, concurrency = 4 }) {
  const reports = []
  for (const effort of efforts) {
    const results = await pool(scenarios, concurrency, scenario => runScenario(scenario, { think, persona, settings, effort }))
    reports.push({
      effort, results,
      passed: results.filter(r => r.ok).length,
      valid: results.filter(r => r.valid).length,
      averageMs: Math.round(results.reduce((sum, r) => sum + r.ms, 0) / results.length),
    })
  }
  return reports
}

export function formatEval(reports) {
  const lines = []
  for (const report of reports) {
    lines.push(`思考强度 ${report.effort}：通过 ${report.passed}/${report.results.length}，JSON 有效 ${report.valid}/${report.results.length}，平均 ${(report.averageMs / 1000).toFixed(1)} 秒`)
    for (const r of report.results) {
      lines.push(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.problems.length ? `：${r.problems.join('；')}` : ''}${r.reply.length ? ` → ${r.reply.join(' / ')}` : ' → （沉默）'}`)
    }
  }
  return lines.join('\n')
}
