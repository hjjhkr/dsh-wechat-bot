import z from '@deepseek-ai/schemastery'
import { createConversationBridge as createBridge } from './conversations.js'
import { createSessionRegistry, installHttp } from './http.js'
import { ModelSessionActivity } from './model-session.js'

export const name = 'dsh-wechat-bridge'
export const inject = ['webServer', 'llm', 'appExit', 'sessions', 'agents', 'sessionPersistence', 'sessionTitle']
export const Config = z.object({
  configPath: z.string().default(''),
})

export function apply(ctx, config) {
  ctx.effect(async () => {
    const sessions = createSessionRegistry()
    const manager = await createBridge({
      configPath: config.configPath,
      llm: ctx.llm,
      createModelActivity: runtime => ModelSessionActivity.create(ctx, runtime),
      sessionValid: (token) => sessions.validate(token, false),
    })
    let http
    try {
      http = installHttp(ctx.webServer, manager, sessions, ctx.appExit)
    } catch (error) {
      sessions.clear()
      try {
        await manager.dispose()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'wechat_bridge_http_install_cleanup_failed')
      }
      throw error
    }
    return async () => {
      http.dispose()
      sessions.clear()
      await manager.dispose()
    }
  }, 'wechat-bridge-host')
}
