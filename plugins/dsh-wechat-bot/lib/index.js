import z from '@deepseek-ai/schemastery'
import { WeChatBotApp } from './app.js'
import { registerCommand, registerRoutes, registerTool } from './surface.js'

export const name = 'dsh-wechat-bot'
export const inject = ['llm', 'connection', 'commands', 'tools', 'sessions', 'agents', 'sessionPersistence', 'sessionTitle', 'workspaceRegistry']

export const Config = z.object({
  adapter: z.object({
    command: z.string().default('').description('Adapter executable speaking protocol v1 over stdio. Empty = built-in simulator.'),
    args: z.array(z.string()).default([]),
    cwd: z.string().default(''),
    env: z.dict(z.string()).default({}),
  }).default({}),
  dataDir: z.string().default('').description('State directory. Empty = <DSH_HOME>/wechat-bot.'),
  personaPath: z.string().default('').description('Persona markdown. Empty = bundled persona.'),
  commandsDir: z.string().default('').description('Directory of custom chat command scripts (*.js).'),
  model: z.object({
    provider: z.string().default('').description('Empty = the DSH default model.'),
    model: z.string().default(''),
    reasoningEffort: z.union(['off', 'low', 'high', 'max']).default('off'),
    maxTokens: z.natural().min(64).default(600),
  }).default({}),
  aliases: z.array(z.string()).default(['小鲸鱼', 'DeepSeek']).description('Names people call the bot besides its WeChat name.'),
  stickers: z.dict(z.string()).default({}).description('Sticker name → image path the model may send.'),
  behavior: z.object({
    mode: z.union(['free', 'mention', 'silent']).default('free'),
    quietMs: z.natural().default(2000),
    maxWaitMs: z.natural().default(8000),
    maxMessages: z.natural().min(1).default(20),
    recentLimit: z.natural().min(1).default(30),
    maxParts: z.natural().min(1).default(3),
    idleMinutes: z.natural().default(0).description('Quiet minutes before the bot may speak first in a group; 0 = never.'),
    staleMinutes: z.natural().min(1).default(10),
    typingDelay: z.boolean().default(true),
  }).default({}),
  guard: z.object({
    maxTurnsPerMinute: z.natural().min(1).default(8).description('Model calls per minute; extra batches wait and merge.'),
    modelTimeoutSeconds: z.natural().min(5).default(90),
    maxTextChars: z.natural().min(100).default(2000).description('Longer incoming messages are truncated.'),
    breakerThreshold: z.natural().min(1).default(3).description('Consecutive model failures before pausing.'),
    breakerBaseSeconds: z.natural().min(1).default(30).description('First pause; doubles per repeated trip.'),
    stuckMinutes: z.natural().min(1).default(5).description('Watchdog rebuilds the chat runner if busy longer.'),
  }).default({}),
})

export function apply(ctx, config) {
  ctx.effect(async () => {
    const app = await WeChatBotApp.create(ctx, config)
    registerRoutes(ctx, app)
    registerCommand(ctx, app)
    registerTool(ctx, app)
    return () => app.dispose()
  }, 'wechat-bot')
}
