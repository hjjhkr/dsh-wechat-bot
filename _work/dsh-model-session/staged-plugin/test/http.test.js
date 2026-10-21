import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createSessionRegistry, installHttp, SESSION_TTL_MS } from '../lib/http.js'

const ORIGIN = 'http://127.0.0.1:5310'

test('conversation switch requires same-origin permission and rejects arbitrary config fields', async () => {
  let calls = 0
  const { handlers, token } = installTestHttp({ async selectConversation() { calls++; return { phase: 'paused' } } }, () => {})
  const body = { targetId: 'friend', currentId: '123@chatroom', selectionConfirmed: true }
  const cross = new FakeResponse()
  await handlers.get('/wechat-bot/api/conversations/select')(makeRequest('POST', 'https://other.example', token, 'cross-site', body), cross)
  assert.equal(cross.statusCode, 403)
  const arbitrary = new FakeResponse()
  await handlers.get('/wechat-bot/api/conversations/select')(makeRequest('POST', ORIGIN, token, 'same-origin', { ...body, stateRoot: 'E:/other' }), arbitrary)
  assert.equal(arbitrary.statusCode, 409)
  assert.equal(calls, 0)
  const allowed = new FakeResponse()
  await handlers.get('/wechat-bot/api/conversations/select')(makeRequest('POST', ORIGIN, token, 'same-origin', body), allowed)
  assert.equal(allowed.statusCode, 200)
  assert.equal(calls, 1)
})

class FakeResponse extends EventEmitter {
  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers
  }

  end(body) {
    this.body = body
  }
}

function makeRequest(method, origin, token, secFetchSite = 'same-origin', body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.headers = {
    host: '127.0.0.1:5310',
    origin,
    cookie: `dsh_wechat_session=${token}`,
    'sec-fetch-site': secFetchSite,
  }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function installTestHttp(manager, appExit) {
  const handlers = new Map()
  const webServer = {
    host: '127.0.0.1',
    getOrigin: () => ORIGIN,
    register({ path, handler }) {
      handlers.set(path, handler)
      return () => handlers.delete(path)
    },
  }
  const sessions = createSessionRegistry()
  const token = sessions.create()
  installHttp(webServer, manager, sessions, appExit)
  return { handlers, token }
}

test('control session stays valid during long polling via clock-based idle refreshes', () => {
  let now = 1_000_000
  const sessions = createSessionRegistry(() => now)
  const token = sessions.create()

  // Model a page status poll every five seconds across a multi-hour session without sleeping.
  for (let elapsed = 0; elapsed < 4 * 60 * 60 * 1000; elapsed += 5_000) {
    now += 5_000
    assert.equal(sessions.validate(token, true), true)
  }
  now += SESSION_TTL_MS + 1
  assert.equal(sessions.validate(token, true), false)
})

test('control session expires if page polling stops beyond the server-side TTL', () => {
  let now = 10
  const sessions = createSessionRegistry(() => now)
  const token = sessions.create()
  now += SESSION_TTL_MS + 1
  assert.equal(sessions.validate(token, true), false)
})

test('shutdown waits for manager cleanup and response finish before requesting app exit', async () => {
  let releaseDispose
  let markDisposeStarted
  const disposePending = new Promise((resolve) => { releaseDispose = resolve })
  const disposeStarted = new Promise((resolve) => { markDisposeStarted = resolve })
  const sequence = []
  const manager = {
    async dispose() {
      sequence.push('dispose-start')
      markDisposeStarted()
      await disposePending
      sequence.push('dispose-finish')
    },
    status() { return { workerClosed: true, gateActive: false } },
  }
  const appExit = (code) => sequence.push(`exit-${code}`)
  const { handlers, token } = installTestHttp(manager, appExit)
  const response = new FakeResponse()

  const requestPending = handlers.get('/wechat-bot/api/shutdown')(
    makeRequest('POST', ORIGIN, token),
    response,
  )
  await disposeStarted
  assert.deepEqual(sequence, ['dispose-start'])
  assert.equal(response.statusCode, undefined)

  releaseDispose()
  await requestPending
  assert.deepEqual(sequence, ['dispose-start', 'dispose-finish'])
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { success: true, workerClosed: true, gateActive: false })

  response.emit('finish')
  assert.deepEqual(sequence, ['dispose-start', 'dispose-finish', 'exit-0'])
})

test('shutdown rejects cross-origin requests before disposing or exiting', async () => {
  let disposeCalls = 0
  const exits = []
  const { handlers, token } = installTestHttp({
    async dispose() { disposeCalls += 1 },
  }, (code) => exits.push(code))
  const response = new FakeResponse()

  await handlers.get('/wechat-bot/api/shutdown')(
    makeRequest('POST', 'https://attacker.example', token, 'cross-site'),
    response,
  )

  assert.equal(response.statusCode, 403)
  assert.deepEqual(JSON.parse(response.body), { error: 'not_authorized' })
  assert.equal(disposeCalls, 0)
  assert.deepEqual(exits, [])
})

test('shutdown never requests app exit when worker cleanup is not confirmed', async () => {
  const exits = []
  const { handlers, token } = installTestHttp({
    async dispose() {},
    status() { return { workerClosed: false, gateActive: null } },
  }, (code) => exits.push(code))
  const response = new FakeResponse()

  await handlers.get('/wechat-bot/api/shutdown')(
    makeRequest('POST', ORIGIN, token),
    response,
  )

  assert.equal(response.statusCode, 409)
  assert.deepEqual(JSON.parse(response.body), { error: 'worker_close_unconfirmed' })
  assert.deepEqual(exits, [])
})

test('shutdown reports manager disposal failure without requesting app exit', async () => {
  const exits = []
  const { handlers, token } = installTestHttp({
    async dispose() { throw Object.assign(new Error('worker close failed'), { code: 'worker_close_unconfirmed' }) },
    status() { throw new Error('status must not run after disposal failure') },
  }, (code) => exits.push(code))
  const response = new FakeResponse()

  await handlers.get('/wechat-bot/api/shutdown')(
    makeRequest('POST', ORIGIN, token),
    response,
  )

  assert.equal(response.statusCode, 409)
  assert.deepEqual(JSON.parse(response.body), { error: 'worker_close_unconfirmed' })
  assert.deepEqual(exits, [])
})

test('status exposes uncertain attempt metadata without message text', async () => {
  const attempt = { attemptId: 'attempt-123', status: 'ambiguous', reasonCode: 'db_verify', sendAttempted: true }
  const manager = {
    sendConfigured: true,
    status: () => ({ phase: 'error', uncertainSend: true, uncertainAttempts: [attempt] }),
  }
  const { handlers, token } = installTestHttp(manager, () => {})
  const response = new FakeResponse()

  await handlers.get('/wechat-bot/api/status')(
    makeRequest('GET', ORIGIN, token),
    response,
  )

  const body = JSON.parse(response.body)
  assert.deepEqual(body.uncertainAttempts, [attempt])
  assert.equal(Object.hasOwn(body.uncertainAttempts[0], 'text'), false)
})

test('acknowledge route requires same-origin and explicit no-retry confirmation', async () => {
  const acknowledgements = []
  const manager = {
    async acknowledgeNoRetry(body) {
      acknowledgements.push(body)
      return { phase: 'paused', acknowledgedAttemptId: body.attemptId }
    },
  }
  const { handlers, token } = installTestHttp(manager, () => {})
  const handler = handlers.get('/wechat-bot/api/acknowledge')
  const missingConfirmation = new FakeResponse()
  await handler(makeRequest('POST', ORIGIN, token, 'same-origin', {
    attemptId: 'attempt-123', confirmedNoRetry: false,
  }), missingConfirmation)
  assert.equal(missingConfirmation.statusCode, 400)
  assert.deepEqual(JSON.parse(missingConfirmation.body), { error: 'confirmation_required' })

  const crossOrigin = new FakeResponse()
  await handler(makeRequest('POST', 'https://attacker.example', token, 'cross-site', {
    attemptId: 'attempt-123', confirmedNoRetry: true,
  }), crossOrigin)
  assert.equal(crossOrigin.statusCode, 403)
  assert.deepEqual(JSON.parse(crossOrigin.body), { error: 'not_authorized' })
  assert.deepEqual(acknowledgements, [])

  const accepted = new FakeResponse()
  await handler(makeRequest('POST', ORIGIN, token, 'same-origin', {
    attemptId: 'attempt-123', confirmedNoRetry: true,
  }), accepted)
  assert.equal(accepted.statusCode, 200)
  assert.deepEqual(acknowledgements, [{ attemptId: 'attempt-123', confirmedNoRetry: true }])
})

