import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { AdapterClient } from '../lib/adapter.js'
import { Bot } from '../lib/bot.js'
import { flattenInput } from '../lib/prompt.js'
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

// The model input in a flat, chronological shape that is easy to assert on:
// `new` = this turn's messages (each with `from`), `recent` = earlier ones, `memory` = all members'.
export function testView(raw) {
  const flat = flattenInput(raw)
  const memory = {}
  for (const member of [...raw.recent.members, ...raw.new.members]) if (member.memory) memory[member.id] = member.memory
  return { ...raw, new: flat.messages, recent: flat.recent, memory }
}

// A fake model. `reply(input, call)` receives the turn input (see testView; the exact
// JSON the model got is `call.raw`) and returns the raw model output (a string, or an
// object that is JSON-encoded).
export function scriptedModel(reply) {
  const calls = []
  const think = async ({ system, messages, signal }) => {
    const raw = JSON.parse(messages[0].text)
    const call = { system, messages, raw, input: testView(raw), signal }
    calls.push(call)
    const output = await reply(call.input, call, calls.length)
    return typeof output === 'string' ? output : JSON.stringify(output)
  }
  return { think, calls }
}

export const FAST = { mode: 'free', quietMs: 40, maxWaitMs: 300, typingDelay: false, retryDelayMs: 10, idleMinutes: 0, maxTurnsPerMinute: 10_000 }

export async function startBot(t, { reply, learn, settings = {}, simulator: simOptions, dir, persona = '你是小鲸鱼。', models } = {}) {
  const dataDir = dir ?? await mkdtemp(join(tmpdir(), 'wechat-bot-test-'))
  const sims = []
  const model = scriptedModel(reply ?? (() => ({ to: null, reply: [], memory: [] })))
  const bot = new Bot({
    dataDir, persona, store: new Store(dataDir, { delayMs: 5 }), think: model.think, learn, models,
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
