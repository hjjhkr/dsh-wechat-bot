import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHistory, generateReply, ModelError } from '../lib/model.js'

const config = { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 512 }

test('generateReply sends persona and bounded request with reasoning off, and accepts only stop', async () => {
  let request
  const llm = {
    async *stream(options) {
      request = options
      yield { type: 'text-delta', text: '我是小鲸鱼。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const result = await generateReply(llm, { persona: 'persona', incoming: '你好', history: [], config })
  assert.equal(result.reply, '我是小鲸鱼。')
  assert.equal(result.finish, 'stop')
  assert.equal(request.provider, 'deepseek-official')
  assert.equal(request.model, 'deepseek-flash')
  assert.equal(request.reasoningEffort, 'off')
  assert.equal(request.maxTokens, 512)
  assert.equal(request.system, 'persona')
  assert.deepEqual(request.messages.at(-1), { role: 'user', content: [{ type: 'text', text: '你好' }] })
})

test('generateReply rejects truncated, failed, and empty completions', async () => {
  for (const reason of [{ kind: 'max-tokens' }, { kind: 'error' }, { kind: 'aborted' }]) {
    const llm = { async *stream() { yield { type: 'text-delta', text: 'partial' }; yield { type: 'finish', reason } } }
    await assert.rejects(generateReply(llm, { persona: 'p', incoming: 'x', config }), ModelError)
  }
  const empty = { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } }
  await assert.rejects(generateReply(empty, { persona: 'p', incoming: 'x', config }), /model_reply_empty/)
})

test('buildHistory excludes the current and future messages and reconstructs only delivered assistant replies', () => {
  const state = {
    inbox: [
      { key: 'a', sortSeq: 1, text: 'first' },
      { key: 'b', sortSeq: 2, text: 'second' },
      { key: 'c', sortSeq: 3, text: 'current' },
    ],
    outbox: [
      { attemptId: 'stable-attempt-a', incomingKey: 'a', status: 'delivered', text: 'answer one' },
      { incomingKey: 'b', status: 'attempted', text: 'uncertain answer' },
    ],
  }
  const history = buildHistory(state, 4, 'c', config)
  assert.deepEqual(history.map((item) => item.role), ['user', 'assistant', 'user'])
  assert.equal(history[0].content[0].text, 'first')
  assert.deepEqual(history[1], {
    id: 'stable-attempt-a',
    role: 'assistant',
    content: [{ type: 'text', text: 'answer one' }],
    source: { kind: 'model', provider: config.provider, model: config.model },
  })
  assert.equal(history[2].content[0].text, 'second')
  assert.deepEqual(buildHistory(state, 4, 'c', config), history)
})

test('buildHistory excludes a permanently skipped incoming message', () => {
  const state = {
    inbox: [
      { key: 'skipped', sortSeq: 1, text: 'do not retry this' , status: 'skipped' },
      { key: 'current', sortSeq: 2, text: 'new message', status: 'received' },
    ],
    outbox: [{ attemptId: 'old-attempt', incomingKey: 'skipped', status: 'abandoned', text: 'old draft' }],
  }
  assert.deepEqual(buildHistory(state, 4, 'current', config), [])
})

test('memory-enabled history replays JSON envelopes without replaying memory mutations', () => {
  const state = {
    inbox: [{ key: 'a', sortSeq: 1, text: '你好' }, { key: 'b', sortSeq: 2, text: '[动画表情]' }],
    outbox: [{ attemptId: 'attempt-a', incomingKey: 'a', status: 'delivered', text: '？' }],
  }
  const history = buildHistory(state, 4, 'b', { ...config, memoryEnabled: true })
  assert.deepEqual(JSON.parse(history[1].content[0].text), { reply: '？', memory: [] })
  assert.equal(history[1].id, 'attempt-a')
  assert.deepEqual(history[1].source, { kind: 'model', provider: config.provider, model: config.model })
  assert.equal(buildHistory(state, 4, 'b', config)[1].content[0].text, '？')
})

test('buildHistory refuses a delivered reply without its stable attempt id', () => {
  const state = {
    inbox: [
      { key: 'a', sortSeq: 1, text: 'first' },
      { key: 'current', sortSeq: 2, text: 'current' },
    ],
    outbox: [{ incomingKey: 'a', status: 'delivered', text: 'answer one' }],
  }
  assert.throws(
    () => buildHistory(state, 4, 'current', config),
    (error) => error instanceof ModelError && error.code === 'history_reply_missing_attempt_id',
  )
})

test('buildHistory refuses a delivered reply without explicit provider and model identity', () => {
  const state = {
    inbox: [
      { key: 'a', sortSeq: 1, text: 'first' },
      { key: 'current', sortSeq: 2, text: 'current' },
    ],
    outbox: [{ attemptId: 'stable-attempt-a', incomingKey: 'a', status: 'delivered', text: 'answer one' }],
  }
  assert.throws(
    () => buildHistory(state, 4, 'current'),
    (error) => error instanceof ModelError && error.code === 'history_model_route_missing',
  )
})

