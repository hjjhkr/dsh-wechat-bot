import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { buildHistory, generateReply } from '../lib/model.js'

test('second turn replays a stable canonical assistant message through the DSH runtime', async (t) => {
  const config = { provider: 'fake-provider', model: 'fake-model', maxTokens: 128 }
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const requests = []

  class FakeAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: 'Offline fake adapter' }
    }

    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' },
      }
    }

    async *stream(options) {
      requests.push(options)
      yield { type: 'text-delta', text: `reply-${requests.length}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  const dispose = runtime.registerAdapter([config.provider], new FakeAdapter())
  t.after(() => dispose())

  const first = await generateReply(runtime, {
    persona: 'persona',
    incoming: 'first question',
    config,
  })
  const state = {
    inbox: [
      { key: 'first', sortSeq: 1, text: 'first question' },
      { key: 'second', sortSeq: 2, text: 'second question' },
    ],
    outbox: [{ attemptId: 'stable-attempt-first', incomingKey: 'first', status: 'delivered', text: first.reply }],
  }
  const history = buildHistory(state, 4, 'second', config)
  const second = await generateReply(runtime, {
    persona: 'persona',
    incoming: 'second question',
    history,
    config,
  })

  assert.equal(second.finish, 'stop')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].messages, [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    {
      id: 'stable-attempt-first',
      role: 'assistant',
      content: [{ type: 'text', text: 'reply-1' }],
      source: { kind: 'model', provider: config.provider, model: config.model },
    },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] },
  ])
})
