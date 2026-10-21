import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { AdapterClient } from '../lib/adapter.js'
import { Bot } from '../lib/bot.js'
import { Simulator } from '../lib/simulator.js'
import { Store } from '../lib/store.js'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function until(predicate, { timeoutMs = 3000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

// An in-process adapter pair: the Simulator plays WeChat, the client is what the plugin uses.
export function linkedSimulator(options = {}) {
  const toAdapter = new PassThrough()
  const toPlugin = new PassThrough()
  const simulator = new Simulator({ input: toAdapter, output: toPlugin, loggedIn: true, loginDelayMs: 10, ...options })
  const client = new AdapterClient({ input: toPlugin, output: toAdapter })
  return { simulator, client }
}

// A fake model. `reply(input, call)` receives the parsed turn input and returns
// the raw model output (a string, or an object that is JSON-encoded).
export function scriptedModel(reply) {
  const calls = []
  const think = async ({ system, messages, signal }) => {
    const call = { system, messages, input: JSON.parse(messages[0].text), signal }
    calls.push(call)
    const output = await reply(call.input, call, calls.length)
    return typeof output === 'string' ? output : JSON.stringify(output)
  }
  return { think, calls }
}

export const FAST = { quietMs: 40, maxWaitMs: 300, typingDelay: false, retryDelayMs: 10, idleMinutes: 0, maxTurnsPerMinute: 10_000 }

export async function startBot(t, { reply, settings = {}, simulator: simOptions, dir, persona = '你是小鲸鱼。' } = {}) {
  const dataDir = dir ?? await mkdtemp(join(tmpdir(), 'wechat-bot-test-'))
  const sims = []
  const model = scriptedModel(reply ?? (() => ({ to: null, reply: [], memory: [] })))
  const bot = new Bot({
    dataDir, persona, store: new Store(dataDir, { delayMs: 5 }), think: model.think,
    settings: { ...FAST, aliases: ['小鲸鱼', 'DeepSeek'], ...settings },
    createAdapter: () => {
      const pair = linkedSimulator(simOptions)
      sims.push(pair.simulator)
      return pair.client
    },
  })
  t.after(async () => {
    await bot.dispose()
    if (!dir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  await bot.start()
  return { bot, model, dataDir, get simulator() { return sims.at(-1) } }
}
