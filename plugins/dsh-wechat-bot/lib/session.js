import { createHash } from 'node:crypto'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, BlockAssembler, LlmAttemptId, createUserMessage } from '@deepseek-ai/dsh-llm'

const READ_ONLY = '这个会话只展示微信机器人的模型工作过程。要和群聊互动，请在微信里发消息，或在控制台/用 / 命令操作。'
const readOnly = () => { throw new Error(READ_ONLY) }

export const chatSessionId = (selfId, chatId) =>
  SessionId('wechat-' + createHash('sha256').update(`${selfId}\0${chatId}`).digest('hex').slice(0, 32))

// A native DSH session that mirrors one WeChat chat's model calls: every turn
// shows the batch the bot saw and the model's raw decision, streamed live.
// It is a minimal Agent driver: no agent loop, no tools, no composer input.
export class ChatSession {
  constructor(ctx, session, handle, route) {
    this.owner = ctx
    this.id = session.id
    this.session = session
    this.handle = handle
    this.options = Object.freeze({ ...route })
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx
    this.dispatch = agentEvents(ctx, this)
    this.status = 'idle'
    this.turn = session.snapshotEvents().reduce((max, e) => e.type === 'turn/start' ? Math.max(max, e.data.turn) : max, 0)
    this.revision = 0
    this.inbox = Object.freeze({ nextTurn: Object.freeze([]), nextStep: Object.freeze([]),
      clear() {}, append: readOnly, prepend: readOnly, replace: readOnly, remove: readOnly, splice: readOnly })
  }

  // Opens (or creates) the session `id` in workspace `cwd` and registers it with DSH.
  static async open(ctx, { id, cwd, title, route }) {
    let handle, activity
    try {
      const existing = await ctx.sessionPersistence.stat(id)
      let session
      if (existing) {
        handle = await ctx.sessionPersistence.open(id, 'write')
        const read = await handle.read()
        const closers = interruptedTurnClosers(read.events)
        if (closers.length) await handle.append(closers)
        session = ctx.sessions.prepare(id, { seed: [...read.events, ...closers],
          meta: structuredClone(handle.header), inheritedEventCount: handle.inheritedEventCount, eventState: read.eventState })
        const suffix = session.snapshotEvents(SessionLogOffset(read.events.length + closers.length))
        if (suffix.length) await handle.append(suffix)
      } else {
        session = ctx.sessions.prepare(id, { meta: { cwd } })
        handle = await ctx.sessionPersistence.create(session.header)
        const seed = session.snapshotEvents()
        if (seed.length) await handle.append(seed)
      }
      activity = new ChatSession(ctx, session, handle, route)
      activity.detachSession = activity.ctx.sessions.enter(session)
      activity.detachAgent = ctx.agents.enter(activity, undefined)
      activity.ctx.sessions.announce(session)
      // Naming it up front also keeps the automatic title generator from spending a model call.
      if (!ctx.sessionTitle.get(session)) ctx.sessionTitle.rename(session, title)
      await ctx.agents.announce(activity, existing ? 'resume' : 'startup')
      await ctx.sessions.flush(session)
      await (await ctx.workspaceRegistry.create(cwd)).attachSession(id)
      return activity
    } catch (error) {
      if (activity) await activity.dispose().catch(() => {})
      else await handle?.close().catch(() => {})
      throw error
    }
  }

  send() { return readOnly() }
  followup() { return readOnly() }
  steer() { return readOnly() }
  inject() { return readOnly() }
  runMaintenance() { return readOnly() }
  cancel(cause) { this.controller?.abort(cause) }
  whenIdle() { return this.pending ?? Promise.resolve() }

  #stream(frame) {
    this.dispatch.emit('agent/assistant-stream', { frame: { ...frame, revision: ++this.revision } })
  }

  // Runs one model call as a visible turn. `call({ signal, onChunk })` performs
  // the request; its chunks are mirrored live and its text becomes the reply.
  // Calls are serialized; a DSH "stop" aborts the in-flight request.
  async run(shown, call, signal) {
    const previous = this.queue ?? Promise.resolve()
    const mine = previous.then(() => this.#run(shown, call, signal))
    this.queue = mine.catch(() => {})
    return mine
  }

  async #run(shown, call, signal) {
    if (this.disposed) throw new Error('chat_session_disposed')
    signal?.throwIfAborted()
    const controller = new AbortController()
    const forward = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', forward, { once: true })
    const idle = Promise.withResolvers()
    this.pending = idle.promise
    this.controller = controller
    this.status = 'running'
    const turn = ++this.turn
    const step = 1
    const attemptId = LlmAttemptId(`${this.id}:${turn}`)
    const accumulator = new AssistantStreamAccumulator()
    const assembler = new BlockAssembler()
    let index = 0, opened = false, settled = false, result, failure
    try {
      this.session.append('turn/start', { turn })
      this.session.append('step/start', { turn, step })
      opened = true
      this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: shown }], source: { kind: 'user' } }),
        { surfaceOp: 'append' })
      this.dispatch.emit('agent/status', { status: 'running' })
      this.#stream({ type: 'start', attemptId, turn, step })
      await this.owner.sessions.flush(this.session)
      result = await call({ signal: controller.signal, onChunk: chunk => {
        const timed = accumulator.push({ time: Date.now(), chunk })
        assembler.push(timed.chunk)
        this.#stream({ type: 'chunk', attemptId, index: index++, ...timed })
      } })
      controller.signal.throwIfAborted()
      const event = this.session.append('assistant/message', {
        turn, step, message: assembler.message({ provider: this.options.provider, model: this.options.model }),
        stream: [...accumulator.snapshot()],
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      }, { surfaceOp: 'append' })
      settled = true
      this.#stream({ type: 'end', attemptId, index, outcome: { kind: 'committed', eventType: event.type, seq: event.seq } })
    } catch (error) {
      failure = error
      if (opened && !settled) {
        try {
          const event = this.session.append('assistant/attempt', { turn, step, stream: [...accumulator.snapshot()] })
          this.#stream({ type: 'end', attemptId, index, outcome: { kind: 'committed', eventType: event.type, seq: event.seq } })
        } catch {
          this.#stream({ type: 'end', attemptId, index, outcome: { kind: 'abandoned' } })
        }
      }
    } finally {
      try {
        if (opened) {
          this.session.append('step/end', { turn, step })
          this.session.append('turn/end', { turn, reason: controller.signal.aborted
            ? { kind: 'aborted', reason: controller.signal.reason ?? { kind: 'user' } }
            : failure ? { kind: 'error', error: { code: 'WECHAT_MODEL_ERROR', message: failure.message ?? failure.code } }
              : { kind: 'completed' } })
          await this.owner.sessions.flush(this.session)
        }
      } catch (closeError) {
        failure ??= closeError
      } finally {
        signal?.removeEventListener('abort', forward)
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
