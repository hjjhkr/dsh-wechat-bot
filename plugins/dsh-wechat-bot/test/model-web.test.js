import assert from 'node:assert/strict'
import test from 'node:test'
import { createThink } from '../lib/model.js'

const route = () => ({ provider: 'test', model: 'test', maxTokens: 100, reasoningEffort: 'off' })
const input = JSON.stringify({ recent: { members: [], yours: [], order: [] }, new: { members: [], order: [] } })
const thinkArgs = { chat: { id: 'group' }, system: '输出 JSON', messages: [{ role: 'user', text: input }] }

test('HLTV news tool forwards cancellation and supplies the injected result as untrusted material', async () => {
  const controller = new AbortController()
  let round = 0
  const llm = { async *stream(request) {
    if (round++ === 0) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'news-1', name: 'hltv_latest_news', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const result = request.messages.at(-1)
      assert.equal(result.isError, false)
      assert.match(result.content[0].text, /不可信资料/)
      assert.match(result.content[0].text, /Team A wins/)
      yield { type: 'text-delta', index: 0, text: '{"reply":["Team A wins"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  const getHltvNews = async ({ signal }) => {
    assert.equal(signal, controller.signal)
    return 'Team A wins https://www.hltv.org/news/123/example'
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unexpected local fetch') }
  try {
    assert.equal(await createThink({ llm, route, role: 'reply', getHltvNews })({ ...thinkArgs, signal: controller.signal }), '{"reply":["Team A wins"]}')
  } finally { globalThis.fetch = originalFetch }
})

test('HLTV provider errors are reported without exposing their raw contents', async () => {
  let round = 0
  let calls = 0
  const llm = { async *stream(request) {
    if (round++ === 0) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'news-2', name: 'hltv_latest_news', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const result = request.messages.at(-1)
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /失败/)
      assert.match(result.content[0].text, /HTTP 429/)
      assert.match(result.content[0].text, /WEB_PROVIDER_ERROR/)
      assert.doesNotMatch(result.content[0].text, /private-token/)
      yield { type: 'text-delta', index: 0, text: '{"reply":["新闻查询失败"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  const getHltvNews = async () => {
    calls++
    throw Object.assign(new Error('DeepSeek API error (HTTP 429): private-token'), { code: 'WEB_PROVIDER_ERROR' })
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unexpected local fetch') }
  try {
    assert.equal(await createThink({ llm, route, role: 'reply', getHltvNews })(thinkArgs), '{"reply":["新闻查询失败"]}')
    assert.equal(calls, 1)
  } finally { globalThis.fetch = originalFetch }
})

test('HLTV news without an injected provider explicitly reports unavailability', async () => {
  let round = 0
  const llm = { async *stream(request) {
    if (round++ === 0) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'news-3', name: 'hltv_latest_news', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      assert.equal(request.messages.at(-1).isError, true)
      assert.match(request.messages.at(-1).content[0].text, /不可用/)
      yield { type: 'text-delta', index: 0, text: '{"reply":["新闻查询不可用"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unexpected local fetch') }
  try {
    assert.equal(await createThink({ llm, route, role: 'reply' })(thinkArgs), '{"reply":["新闻查询不可用"]}')
  } finally { globalThis.fetch = originalFetch }
})

test('a rejected website becomes a tool failure before the final reply', async () => {
  const requests = []
  const chunks = []
  const llm = { async *stream(request) {
    requests.push(request)
    if (requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'read_website', arguments: '{"url":"https://example.com/"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const assistant = request.messages.at(-2)
      assert.equal(assistant.role, 'assistant')
      assert.deepEqual(assistant.content, [{ type: 'tool-call', id: 'call-1', name: 'read_website', arguments: '{"url":"https://example.com/"}' }])
      yield { type: 'text-delta', index: 0, text: '{"reply":["无法查询该网站"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  const mirror = async () => ({ run: async (_shown, call, signal) => call({ signal, onChunk: chunk => chunks.push(chunk) }) })
  const result = await createThink({ llm, route, role: 'reply', mirror })(thinkArgs)
  assert.equal(result, '{"reply":["无法查询该网站"]}')
  assert.equal(requests.length, 2)
  assert.ok(requests[0].tools.some(tool => tool.name === 'read_website'))
  const resultMessage = requests[1].messages.at(-1)
  assert.equal(resultMessage.role, 'tool')
  assert.equal(resultMessage.toolCallId, 'call-1')
  assert.equal(resultMessage.isError, true)
  assert.ok(resultMessage.content[0].text.length > 0)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['text-delta', 'finish'])
})

test('memory learning does not receive website tools', async () => {
  let request
  const llm = { async *stream(value) {
    request = value
    yield { type: 'text-delta', index: 0, text: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = await createThink({ llm, route, role: 'memory' })(thinkArgs)
  assert.equal(result, '{}')
  assert.equal(request.tools, undefined)
})

test('a permitted webpage is returned to the model as untrusted source material', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://www.hltv.org/news/123/example')
    return new Response('比赛比分 2:1')
  }
  try {
    let round = 0
    const llm = { async *stream(request) {
      if (round++ === 0) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-2', name: 'read_website', arguments: '{"url":"https://www.hltv.org/news/123/example"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const result = request.messages.at(-1)
        assert.equal(result.isError, false)
        assert.match(result.content[0].text, /不可信资料/)
        assert.match(result.content[0].text, /比赛比分 2:1/)
        yield { type: 'text-delta', index: 0, text: '{"reply":["比分 2:1"]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } }
    assert.equal(await createThink({ llm, route, role: 'reply' })(thinkArgs), '{"reply":["比分 2:1"]}')
  } finally { globalThis.fetch = originalFetch }
})

test('a model requesting too many pages receives an error and cannot call again', async () => {
  let round = 0
  const llm = { async *stream(request) {
    if (round++ === 0) {
      for (let i = 0; i < 4; i++) yield { type: 'block-end', index: i, block: { type: 'tool-call', id: `call-${i}`, name: 'read_website', arguments: '{"url":"https://example.com/"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      assert.equal(request.tools, undefined)
      assert.equal(request.messages.at(-1).isError, true)
      assert.match(request.messages.at(-1).content[0].text, /次数/)
      yield { type: 'text-delta', index: 0, text: '{"reply":["查询失败"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  assert.equal(await createThink({ llm, route, role: 'reply' })(thinkArgs), '{"reply":["查询失败"]}')
  assert.equal(round, 2)
})

test('CSQAQ queries without a token report that the service is unavailable', async () => {
  let round = 0
  const llm = { async *stream(request) {
    if (round++ === 0) {
      assert.ok(request.tools.some(tool => tool.name === 'search_csqaq'))
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'price-1', name: 'search_csqaq', arguments: '{"query":"AK-47"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const result = request.messages.at(-1)
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /不可用/)
      yield { type: 'text-delta', index: 0, text: '{"reply":["价格查询暂不可用"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  } }
  assert.equal(await createThink({ llm, route, role: 'reply' })(thinkArgs), '{"reply":["价格查询暂不可用"]}')
})

test('Apex ranked lookup returns the relevant map and interval to the model', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('<h2>BR Ranked</h2><div class="container brranked"><h2>Olympus</h2><div data-start="1000" data-end="2000"></div></div><div class="curmap-next-maps"></div><div class="row curmap-overview-card"><h2>Mixtape</h2></div>')
  try {
    let round = 0
    const llm = { async *stream(request) {
      if (round++ === 0) {
        assert.ok(request.tools.some(tool => tool.name === 'apex_ranked_map'))
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'apex-1', name: 'apex_ranked_map', arguments: '{"time":"1970-01-01T08:25:00+08:00"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const result = request.messages.at(-1)
        assert.equal(result.isError, false)
        assert.match(result.content[0].text, /Olympus/)
        assert.match(result.content[0].text, /北京时间/)
        yield { type: 'text-delta', index: 0, text: '{"reply":["Olympus"]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } }
    assert.equal(await createThink({ llm, route, role: 'reply' })(thinkArgs), '{"reply":["Olympus"]}')
  } finally { globalThis.fetch = originalFetch }
})

test('CSQAQ failure does not expose a token in model-visible messages', async () => {
  const token = 'example-private-token'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error(`failed ${token}`) }
  try {
    let round = 0
    const llm = { async *stream(request) {
      if (round++ === 0) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'price-2', name: 'search_csqaq', arguments: '{"query":"AK-47"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        assert.equal(request.messages.at(-1).isError, true)
        assert.doesNotMatch(JSON.stringify(request), /example-private-token/)
        yield { type: 'text-delta', index: 0, text: '{"reply":["价格查询失败"]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } }
    assert.equal(await createThink({ llm, route, role: 'reply', getCsqaqToken: async () => token })(thinkArgs), '{"reply":["价格查询失败"]}')
  } finally { globalThis.fetch = originalFetch }
})

test('CSQAQ HTTP failure retains its status without exposing the token', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 429 })
  try {
    let round = 0
    const llm = { async *stream(request) {
      if (round++ === 0) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'price-3', name: 'search_csqaq', arguments: '{"query":"刀"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        assert.match(request.messages.at(-1).content[0].text, /HTTP 429/)
        assert.doesNotMatch(JSON.stringify(request), /example-private-token/)
        yield { type: 'text-delta', index: 0, text: '{"reply":["查询受限"]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    } }
    assert.equal(await createThink({ llm, route, role: 'reply', getCsqaqToken: async () => 'example-private-token' })(thinkArgs), '{"reply":["查询受限"]}')
  } finally { globalThis.fetch = originalFetch }
})
