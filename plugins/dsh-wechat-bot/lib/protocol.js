// Adapter protocol v1: shared constants and validators. See docs/protocol.md.

export const PROTOCOL_VERSION = 1

export const MESSAGE_KINDS = Object.freeze(['text', 'image', 'sticker', 'voice', 'video', 'file', 'link', 'system', 'other'])
export const OUTGOING_KINDS = Object.freeze(['text', 'image', 'sticker'])
export const ACCOUNT_STATES = Object.freeze(['offline', 'login_required', 'ready'])

export const ErrorCode = Object.freeze({
  InvalidParams: 'invalid_params',
  NotReady: 'not_ready',
  NotFound: 'not_found',
  Unsupported: 'unsupported',
  // The adapter is certain nothing reached WeChat; the caller may retry.
  SendFailed: 'send_failed',
  // Delivery state is unknown; the caller must never retry automatically.
  SendUncertain: 'send_uncertain',
  // Sending is temporarily impossible (e.g. client busy); nothing was attempted.
  Unavailable: 'unavailable',
})

export class ProtocolError extends Error {
  constructor(code, message = code, data) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

const fail = (what) => { throw new ProtocolError(ErrorCode.InvalidParams, what) }
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.length > 0

function optionalString(value, what) {
  if (value !== undefined && typeof value !== 'string') fail(what)
  return value
}

function stringList(value, what) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(nonEmpty)) fail(what)
  return [...new Set(value)]
}

function person(value, what) {
  if (!isObject(value) || !nonEmpty(value.id)) fail(what)
  return { id: value.id, name: typeof value.name === 'string' && value.name ? value.name : value.id }
}

export function parseChat(value) {
  if (!isObject(value) || !nonEmpty(value.id) || !['group', 'direct'].includes(value.kind)) fail('chat')
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name ? value.name : value.id,
    kind: value.kind,
    ...(Number.isInteger(value.memberCount) ? { memberCount: value.memberCount } : {}),
  }
}

export function parseMessage(value) {
  if (!isObject(value)) fail('message')
  const { id, chatId, time, kind } = value
  if (!nonEmpty(id)) fail('message.id')
  if (!nonEmpty(chatId)) fail('message.chatId')
  if (!Number.isFinite(time)) fail('message.time')
  if (!MESSAGE_KINDS.includes(kind)) fail('message.kind')
  const text = optionalString(value.text, 'message.text') ?? ''
  if (kind === 'text' && !text) fail('message.text')
  const message = {
    id, chatId, time, kind, text,
    sender: person(value.sender, 'message.sender'),
    fromSelf: value.fromSelf === true,
    mentions: stringList(value.mentions, 'message.mentions'),
  }
  if (value.quote !== undefined) {
    if (!isObject(value.quote)) fail('message.quote')
    message.quote = {
      messageId: optionalString(value.quote.messageId, 'message.quote.messageId'),
      senderId: optionalString(value.quote.senderId, 'message.quote.senderId'),
      senderName: optionalString(value.quote.senderName, 'message.quote.senderName'),
      text: optionalString(value.quote.text, 'message.quote.text') ?? '',
    }
  }
  if (value.media !== undefined) {
    if (!isObject(value.media)) fail('message.media')
    message.media = {
      mime: optionalString(value.media.mime, 'message.media.mime'),
      description: optionalString(value.media.description, 'message.media.description'),
    }
  }
  return message
}

export function parseOutgoing(value) {
  if (!isObject(value) || !OUTGOING_KINDS.includes(value.kind)) fail('content.kind')
  if (value.kind === 'text') {
    if (!nonEmpty(value.text)) fail('content.text')
    return { kind: 'text', text: value.text, mentions: stringList(value.mentions, 'content.mentions') }
  }
  if (value.kind === 'image') {
    if (!nonEmpty(value.path)) fail('content.path')
    return { kind: 'image', path: value.path }
  }
  if (!nonEmpty(value.path) && !nonEmpty(value.stickerId)) fail('content.sticker')
  return { kind: 'sticker', ...(value.path ? { path: value.path } : { stickerId: value.stickerId }) }
}

export function parseStatus(value) {
  if (!isObject(value) || !['connected', 'degraded', 'disconnected'].includes(value.connection)) fail('status')
  return {
    connection: value.connection,
    canSend: value.canSend === true,
    reason: optionalString(value.reason, 'status.reason'),
    detail: optionalString(value.detail, 'status.detail'),
  }
}

export function parseAccount(value) {
  if (!isObject(value) || !ACCOUNT_STATES.includes(value.state)) fail('account')
  if (value.state === 'ready' && value.self === undefined) fail('account.self')
  return {
    state: value.state,
    ...(value.self !== undefined ? { self: person(value.self, 'account.self') } : {}),
    ...(typeof value.instructions === 'string' ? { instructions: value.instructions } : {}),
    ...(typeof value.qrCode === 'string' ? { qrCode: value.qrCode } : {}),
  }
}

export function parseCapabilities(value = {}) {
  if (!isObject(value)) fail('capabilities')
  const kinds = (list, allowed) => Array.isArray(list) ? list.filter(k => allowed.includes(k)) : ['text']
  return {
    receive: kinds(value.receive, MESSAGE_KINDS),
    send: kinds(value.send, OUTGOING_KINDS),
    window: value.window === true,
    mediaFetch: value.mediaFetch === true,
    history: value.history === true,
    simulator: value.simulator === true,
  }
}
