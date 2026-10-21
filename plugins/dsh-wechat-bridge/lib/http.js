import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { renderPage } from './ui.js'

const SESSION_COOKIE = 'dsh_wechat_session'
export const SESSION_TTL_MS = 5 * 60 * 1000
const SESSION_COOKIE_MAX_AGE_SECONDS = 31536000
const BODY_LIMIT = 4096

function isLoopback(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  return normalized === '::1'
}

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendHeaders(res, status, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...headers,
  })
}

function sendJson(res, status, body) {
  sendHeaders(res, status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function requestCode(error) {
  const code = error?.code
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(code) ? code : 'request_failed'
}

async function readBody(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > BODY_LIMIT) throw Object.assign(new Error('body_too_large'), { code: 'body_too_large' })
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json')
    return parsed
  } catch {
    throw Object.assign(new Error('invalid_json'), { code: 'invalid_json' })
  }
}

class Sessions {
  #entries = new Map()
  #clock

  constructor(clock = () => Date.now()) {
    this.#clock = clock
  }

  create() {
    const token = randomBytes(32).toString('hex')
    this.#entries.set(token, this.#clock() + SESSION_TTL_MS)
    return token
  }

  validate(token, refresh = false) {
    if (typeof token !== 'string') return false
    let stored
    const now = this.#clock()
    for (const [candidate, expiry] of this.#entries) {
      if (expiry <= now) {
        this.#entries.delete(candidate)
        continue
      }
      if (equalSecret(candidate, token)) stored = candidate
    }
    if (!stored) return false
    if (refresh) this.#entries.set(stored, now + SESSION_TTL_MS)
    return true
  }

  clear() { this.#entries.clear() }
}

export function createSessionRegistry(clock = () => Date.now()) {
  return new Sessions(clock)
}

export function assertLoopbackWebServer(webServer) {
  if (!isLoopback(webServer.host)) throw new Error('wechat_bridge_requires_loopback_webserver')
}

export function installHttp(webServer, manager, sessions = new Sessions(), appExit) {
  assertLoopbackWebServer(webServer)
  if (typeof appExit !== 'function') throw new Error('wechat_bridge_app_exit_missing')
  const expectedOrigin = webServer.getOrigin()
  const expectedUrl = new URL(expectedOrigin)

  const guardHost = (req) => {
    if (req.headers.host?.toLowerCase() !== expectedUrl.host.toLowerCase()) return false
    if (!isLoopback(req.socket?.remoteAddress)) return false
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== expectedOrigin) return false
    return true
  }

  const authorize = (req, requireOrigin) => {
    if (!guardHost(req)) return null
    if (requireOrigin) {
      if (req.headers.origin !== expectedOrigin || req.headers['sec-fetch-site'] === 'cross-site') return null
    }
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE)
    return sessions.validate(token, true) ? token : null
  }

  const route = (path, handler) => webServer.register({ kind: 'exact', path, handler })
  const disposers = []
  let shutdownInProgress = false
  disposers.push(route('/wechat-bot/', async (req, res) => {
    if (req.method !== 'GET' || !guardHost(req)) return sendJson(res, req.method === 'GET' ? 403 : 405, { error: 'not_allowed' })
    const token = sessions.create()
    const nonce = randomBytes(18).toString('base64')
    const secure = expectedUrl.protocol === 'https:' ? '; Secure' : ''
    sendHeaders(res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/wechat-bot; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}${secure}`,
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
    })
    res.end(renderPage(nonce))
  }))
  disposers.push(route('/wechat-bot/api/status', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
    const token = authorize(req, false)
    if (!token) return sendJson(res, 403, { error: 'not_authorized' })
    sendJson(res, 200, { ...manager.status(), sendConfigured: manager.sendConfigured })
  }))
  disposers.push(route('/wechat-bot/api/logs', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req, false)) return sendJson(res, 403, { error: 'not_authorized' })
    sendJson(res, 200, manager.logs())
  }))
  disposers.push(route('/wechat-bot/api/draft', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req, false)) return sendJson(res, 403, { error: 'not_authorized' })
    sendJson(res, 200, manager.latestDraft())
  }))
  disposers.push(route('/wechat-bot/api/conversations', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
    const token = authorize(req, false)
    if (!token) return sendJson(res, 403, { error: 'not_authorized' })
    try {
      sendJson(res, 200, await manager.listConversations({ sessionToken: token }))
    } catch (error) {
      sendJson(res, 409, { error: requestCode(error) })
    }
  }))
  disposers.push(route('/wechat-bot/api/conversations/select', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    const token = authorize(req, true)
    if (!token) return sendJson(res, 403, { error: 'not_authorized' })
    try {
      const body = await readBody(req)
      if (typeof body.targetId !== 'string' || typeof body.currentId !== 'string' || body.selectionConfirmed !== true ||
          Object.keys(body).some(k => !['targetId', 'currentId', 'selectionConfirmed'].includes(k))) {
        throw Object.assign(new Error('invalid_selection'), { code: 'invalid_selection' })
      }
      sendJson(res, 200, await manager.selectConversation({ ...body, sessionToken: token }))
    } catch (error) {
      sendJson(res, 409, { error: requestCode(error) })
    }
  }))
  disposers.push(route('/wechat-bot/api/start', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    const token = authorize(req, true)
    if (!token) return sendJson(res, 403, { error: 'not_authorized' })
    try {
      const body = await readBody(req)
      if (typeof body.autoSend !== 'boolean' || typeof body.allowTemporaryGate !== 'boolean') throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' })
      const status = await manager.start({ ...body, sessionToken: token })
      sendJson(res, 200, status)
    } catch (error) {
      sendJson(res, error?.code === 'send_consent_required' ? 403 : 409, { error: requestCode(error) })
    }
  }))
  disposers.push(route('/wechat-bot/api/pause', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req, true)) return sendJson(res, 403, { error: 'not_authorized' })
    try {
      await readBody(req)
      sendJson(res, 200, await manager.pause())
    } catch (error) {
      sendJson(res, 409, { error: requestCode(error) })
    }
  }))
  disposers.push(route('/wechat-bot/api/revoke', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req, true)) return sendJson(res, 403, { error: 'not_authorized' })
    try {
      await readBody(req)
      sendJson(res, 200, await manager.revokeSendGrant())
    } catch (error) {
      sendJson(res, 409, { error: requestCode(error) })
    }
  }))
  disposers.push(route('/wechat-bot/api/test-model', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req, true)) return sendJson(res, 403, { error: 'not_authorized' })
    try {
      const body = await readBody(req)
      sendJson(res, 200, await manager.testModel(body))
    } catch (error) {
      sendJson(res, 502, { error: requestCode(error) })
    }
  }))
  disposers.push(route('/wechat-bot/api/acknowledge', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req, true)) return sendJson(res, 403, { error: 'not_authorized' })
    try {
      const body = await readBody(req)
      if (typeof body.attemptId !== 'string' || body.attemptId.length === 0 || body.attemptId.length > 128 ||
        Object.keys(body).some((key) => !['attemptId', 'confirmedNoRetry'].includes(key))) {
        throw Object.assign(new Error('invalid_attempt_id'), { code: 'invalid_attempt_id' })
      }
      if (body.confirmedNoRetry !== true) {
        throw Object.assign(new Error('confirmation_required'), { code: 'confirmation_required' })
      }
      sendJson(res, 200, await manager.acknowledgeNoRetry(body))
    } catch (error) {
      const status = error?.code === 'invalid_attempt_id' || error?.code === 'confirmation_required' ? 400 : 409
      sendJson(res, status, { error: requestCode(error) })
    }
  }))
  disposers.push(route('/wechat-bot/api/shutdown', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (!authorize(req, true)) return sendJson(res, 403, { error: 'not_authorized' })
    if (shutdownInProgress) return sendJson(res, 409, { error: 'shutdown_in_progress' })
    shutdownInProgress = true
    let status
    try {
      await readBody(req)
      await manager.dispose()
      status = manager.status()
      if (status.workerClosed !== true || status.gateActive !== false) {
        throw Object.assign(new Error('worker_close_unconfirmed'), { code: 'worker_close_unconfirmed' })
      }
    } catch (error) {
      shutdownInProgress = false
      return sendJson(res, 409, { error: requestCode(error) })
    }
    sendHeaders(res, 200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.once('finish', () => appExit(0))
    res.end(JSON.stringify({ success: true, workerClosed: status.workerClosed, gateActive: status.gateActive }))
  }))

  return {
    sessions,
    dispose: () => {
      for (const disposer of disposers.reverse()) disposer()
      sessions.clear()
    },
  }
}
