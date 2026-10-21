import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, BlockAssembler, LlmAttemptId, createUserMessage } from '@deepseek-ai/dsh-llm'

const viewOnly = () => { throw new Error('此会话仅显示微信模型处理。请在微信中发送消息，或使用微信控制页的模型测试。') }

export function modelSessionId(config) {
  return SessionId('wechat-model-' + createHash('sha256')
    .update(config.worker.botWxid + '\0' + config.worker.targetWxid).digest('hex').slice(0, 32))
}

// A native DSH Agent driver for the existing single LLM call. It does not run
// an AgentLoop, admit composer input, assemble prompts, or execute tools.
export class ModelSessionActivity {
  constructor(ctx, config, session, handle) {
    this.owner = ctx
    this.id = session.id
    this.session = session
    this.handle = handle
    this.options = Object.freeze({ provider: config.provider, model: config.model,
      reasoningEffort: 'off', maxTokens: config.maxTokens })
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx
    this.dispatch = agentEvents(ctx, this)
    this.status = 'idle'
    this.turn = session.snapshotEvents().reduce((max, e) => e.type === 'turn/start' ? Math.max(max, e.data.turn) : max, 0)
    this.revision = 0
    this.disposed = false
    this.inbox = Object.freeze({ nextTurn: Object.freeze([]), nextStep: Object.freeze([]),
      clear() {}, append: viewOnly, prepend: viewOnly, replace: viewOnly, remove: viewOnly, splice: viewOnly })
  }

  static async create(ctx, config) {
    if (typeof config.dshWorkspace !== 'string' || !isAbsolute(config.dshWorkspace)) {
      throw new Error('model_session_workspace_missing')
    }
    const id = modelSessionId(config)
    let handle, activity
    try {
      const existing = await ctx.sessionPersistence.stat(id)
      let session
      if (existing) {
        handle = await ctx.sessionPersistence.open(id, 'write')
        if (handle.header.cwd !== config.dshWorkspace) throw new Error('model_session_workspace_changed')
        const read = await handle.read()
        const closers = interruptedTurnClosers(read.events)
        if (closers.length) await handle.append(closers)
        session = ctx.sessions.prepare(id, { seed: [...read.events, ...closers],
          meta: structuredClone(handle.header), inheritedEventCount: handle.inheritedEventCount,
          eventState: read.eventState })
        const suffix = session.snapshotEvents(SessionLogOffset(read.events.length + closers.length))
        if (suffix.length) await handle.append(suffix)
      } else {
        session = ctx.sessions.prepare(id, { meta: { cwd: config.dshWorkspace } })
        handle = await ctx.sessionPersistence.create(session.header)
        const seed = session.snapshotEvents()
        if (seed.length) await handle.append(seed)
      }
      activity = new ModelSessionActivity(ctx, config, session, handle)
      activity.detachSession = activity.ctx.sessions.enter(session)
      activity.detachAgent = ctx.agents.enter(activity, undefined)
      activity.ctx.sessions.announce(session)
      // Pin the title before any user/message, avoiding a second model request
      // from the deployment's automatic session-title provider.
      if (!ctx.sessionTitle.get(session)) ctx.sessionTitle.rename(session, '微信模型 · ' + config.worker.targetName)
      await ctx.agents.announce(activity, existing ? 'resume' : 'startup')
      await ctx.sessions.flush(session)
      return activity
    } catch (error) {
      try {
        if (activity) await activity.dispose()
        else if (handle) await handle.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'model_session_open_cleanup_failed')
      }
      throw error
    }
  }

  send() { return viewOnly() }
  followup() { return viewOnly() }
  steer() { return viewOnly() }
  inject() { return viewOnly() }
  runMaintenance() { return viewOnly() }
  cancel(cause) { this.controller?.abort(cause) }
  whenIdle() { return this.pending ?? Promise.resolve() }

  emitStream(frame) {
    this.dispatch.emit('agent/assistant-stream', { frame: { ...frame, revision: ++this.revision } })
  }

  async run({ incoming, signal }, operation) {
    if (this.disposed) throw new Error('model_session_disposed')
    if (this.status !== 'idle') throw new Error('model_session_busy')
    signal?.throwIfAborted()
    const controller = new AbortController()
    const forwardAbort = () => controller.abort({ kind: 'user' })
    signal?.addEventListener('abort', forwardAbort, { once: true })
    const idle = Promise.withResolvers()
    this.pending = idle.promise
    this.controller = controller
    this.status = 'running'
    const turn = ++this.turn
    const step = 1
    const attemptId = LlmAttemptId(`${this.id}:${turn}`)
    const accumulator = new AssistantStreamAccumulator()
    const assembler = new BlockAssembler()
    let index = 0, turnOpened = false, stepOpened = false, started = false, settled = false, result, failure
    try {
      this.session.append('turn/start', { turn })
      turnOpened = true
      this.session.append('step/start', { turn, step })
      stepOpened = true
      this.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: incoming }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      started = true
      this.dispatch.emit('agent/status', { status: 'running' })
      this.emitStream({ type: 'start', attemptId, turn, step })
      await this.owner.sessions.flush(this.session)
      result = await operation({ signal: controller.signal, onChunk: chunk => {
        const timed = accumulator.push({ time: Date.now(), chunk })
        assembler.push(timed.chunk)
        this.emitStream({ type: 'chunk', attemptId, index: index++, ...timed })
      } })
      controller.signal.throwIfAborted()
      const event = this.session.append('assistant/message', {
        turn, step, message: assembler.message({ provider: this.options.provider, model: this.options.model }),
        stream: [...accumulator.snapshot()],
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      }, { surfaceOp: 'append' })
      settled = true
      this.emitStream({ type: 'end', attemptId, index,
        outcome: { kind: 'committed', eventType: event.type, seq: event.seq } })
    } catch (error) {
      failure = error
      if (started && !settled) {
        try {
          const event = this.session.append('assistant/attempt', { turn, step, stream: [...accumulator.snapshot()] })
          settled = true
          this.emitStream({ type: 'end', attemptId, index,
            outcome: { kind: 'committed', eventType: event.type, seq: event.seq } })
        } catch (settlementError) {
          this.emitStream({ type: 'end', attemptId, index, outcome: { kind: 'abandoned' } })
          failure = new AggregateError([error, settlementError], 'model_session_settlement_failed')
        }
      }
    } finally {
      try {
        if (stepOpened) this.session.append('step/end', { turn, step })
        if (turnOpened) {
          this.session.append('turn/end', { turn, reason: controller.signal.aborted
            ? { kind: 'aborted', reason: controller.signal.reason }
            : failure ? { kind: 'error', error: { code: 'WECHAT_MODEL_ERROR',
              message: failure.code ?? failure.message ?? 'model_request_failed' } }
              : { kind: 'completed' } })
          await this.owner.sessions.flush(this.session)
        }
      } catch (closeError) {
        failure = failure ? new AggregateError([failure, closeError], 'model_session_close_failed') : closeError
      } finally {
        signal?.removeEventListener('abort', forwardAbort)
        this.controller = undefined
        this.status = 'idle'
        this.dispatch.emit('agent/status', { status: 'idle' })
        this.pending = undefined
        idle.resolve()
      }
    }
    if (failure) throw failure
    return result
  }

  dispose() {
    return this.disposal ??= (async () => {
      this.disposed = true
      this.cancel({ kind: 'disposed' })
      await this.whenIdle()
      try {
        await this.handle.close()
      } finally {
        this.detachAgent?.()
        this.detachSession?.()
        await this.scope.dispose()
      }
    })()
  }
}
