import z from '@deepseek-ai/schemastery'
import { WeChatBotApp } from './app.js'
import { createHostDisposer, PageLifetime } from './page-lifetime.js'
import { registerCommand, registerRoutes, registerTool } from './surface.js'

export const name = 'dsh-wechat-bot'
export const inject = ['llm', 'connection', 'commands', 'tools', 'sessions', 'agents', 'sessionPersistence', 'sessionTitle', 'workspaceRegistry', 'appExit']

export const Config = z.object({
  exitWithPage: z.boolean().default(false).description('Exit this DSH process after the last authenticated browser page closes.'),
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
    mode: z.union(['free', 'infer', 'at', 'silent']).default('infer').description('free: model sees every batch; infer: only batches that seem addressed to the bot; at: only @/quote; silent: never speaks.'),
    quietMs: z.natural().default(3000).description('Close a batch after this long without new messages.'),
    maxWaitMs: z.natural().default(8000).description('Never hold a batch longer than this after its first message.'),
    maxMessages: z.natural().min(1).default(20),
    recentLimit: z.natural().min(1).default(30),
    maxParts: z.natural().min(1).default(3),
    idleMinutes: z.natural().default(0).description('Quiet minutes before the bot may speak first in a group; 0 = never.'),
    staleMinutes: z.natural().min(1).default(10),
    typingDelay: z.boolean().default(true),
    memoryLearning: z.boolean().default(true).description('Learn evidenced member notes in the background even when no reply is needed.'),
    memoryCallsPerMinute: z.natural().min(1).max(2).default(2).description('Separate per-chat limit for background memory calls; these never block replies.'),
    cronZone: z.string().default('+08:00').description('Default time zone of /cron, e.g. +08:00, UTC-5 or Asia/Tokyo.'),
  }).default({}),
  guard: z.object({
    maxTurnsPerMinute: z.natural().min(1).default(8).description('Model calls per minute; extra batches wait and merge.'),
    commandsPerMinute: z.natural().min(1).default(6).description('Chat commands per member per minute.'),
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
    const pageLifetime = new PageLifetime({
      enabled: config.exitWithPage,
      exit: ctx.appExit,
      shutdown: () => app.dispose(),
      onError: error => app.bot.note('error', `页面关闭安全关停失败，DSH保持运行：${error.message}`),
    })
    const disposeRoutes = registerRoutes(ctx, app, pageLifetime)
    registerCommand(ctx, app)
    registerTool(ctx, app)
    return createHostDisposer({ disposeRoutes, pageLifetime, app })
  }, 'wechat-bot')
}
