import { randomUUID } from 'node:crypto'
import { JsonRpcPeer } from './rpc.js'
import { ErrorCode, PROTOCOL_VERSION, ProtocolError, parseMessage, parseOutgoing } from './protocol.js'

const SELF = { id: 'wxid_bot', name: '小鲸鱼' }

export const DEMO_CHATS = [
  { id: 'demo@chatroom', name: '测试群', kind: 'group', members: [
    { id: 'wxid_carol', name: '小卡' }, { id: 'wxid_alice', name: '阿离' }, { id: 'wxid_bob', name: '老鲍' }, SELF,
  ] },
  { id: 'wxid_wuti', name: '无题', kind: 'direct', members: [{ id: 'wxid_wuti', name: '无题' }, SELF] },
]

// A protocol-complete fake WeChat. Besides the standard methods it exposes
// `sim/*` methods so tests and the console can play the other chat members.
export class Simulator {
  #seq = 0
  #prefix = `sim-${randomUUID().slice(0, 8)}-`
  #watching = new Set()
  #sent = new Map()

  constructor({ input, output, chats = DEMO_CHATS, loggedIn = false, loginDelayMs = 1500, self = SELF } = {}) {
    this.self = self
    this.chats = new Map(chats.map(c => [c.id, structuredClone(c)]))
    this.messages = new Map(chats.map(c => [c.id, []]))
    this.account = loggedIn ? 'ready' : 'login_required'
    this.loginDelayMs = loginDelayMs
    this.canSend = true
    this.visible = false
    this.failNext = []
    this.output = output
    this.peer = new JsonRpcPeer({ input, output })
    for (const [method, handler] of Object.entries(this.handlers())) this.peer.handle(method, handler)
  }

  handlers() {
    return {
      initialize: () => ({
        protocolVersion: PROTOCOL_VERSION,
        adapter: { name: 'simulator', version: '1.0.0' },
        capabilities: { receive: ['text', 'image', 'sticker', 'system'], send: ['text', 'sticker', 'image'],
          window: true, history: true, simulator: true },
      }),
      'account/status': () => this.#accountView(),
      'account/login': () => {
        if (this.account !== 'ready') {
          clearTimeout(this.loginTimer)
          this.loginTimer = setTimeout(() => this.login(), this.loginDelayMs)
          this.loginTimer.unref?.()
        }
        return { ...this.#accountView(), instructions: '模拟器：几秒后自动完成登录。真实适配器会在这里提示你在手机上确认登录小号。' }
      },
      'chats/list': ({ query }) => {
        this.#requireReady()
        return { chats: [...this.chats.values()]
          .filter(c => !query || c.name.includes(query))
          .map(({ id, name, kind, members }) => ({ id, name, kind, memberCount: members.length })) }
      },
      'chats/members': ({ chatId }) => ({ members: this.#chat(chatId).members }),
      'chats/history': ({ chatId, limit = 20 }) => ({ messages: this.messages.get(this.#chat(chatId).id).slice(-limit) }),
      'watch/set': ({ chatIds }) => {
        this.#requireReady()
        for (const id of chatIds) this.#chat(id)
        this.#watching = new Set(chatIds)
        return { watching: [...this.#watching] }
      },
      'message/send': ({ chatId, clientId, content }) => this.#send(chatId, clientId, parseOutgoing(content)),
      'window/get': () => ({ visible: this.visible }),
      'window/set': ({ visible }) => ({ visible: this.visible = visible === true }),
      'sim/inject': params => ({ message: this.inject(params) }),
      'sim/status': params => {
        if (typeof params.canSend === 'boolean') this.canSend = params.canSend
        this.#status(params.reason)
        return { canSend: this.canSend }
      },
      'sim/fail': ({ code }) => {
        this.failNext.push(code)
        return {}
      },
      'sim/sent': ({ chatId }) => ({ messages: this.messages.get(chatId)?.filter(m => m.fromSelf) ?? [] }),
      shutdown: () => {
        setImmediate(() => this.close())
        return {}
      },
    }
  }

  // Ends the connection the way a crashed or exiting adapter process would.
  close() {
    clearTimeout(this.loginTimer)
    this.peer.close()
    if (this.output !== process.stdout) this.output.end()
  }

  login() {
    this.account = 'ready'
    this.peer.notify('event/account', this.#accountView())
    this.#status()
  }

  // Play a chat member. `params`: { chatId, from?, text?, kind?, mentions?, quote?, media? }
  inject({ chatId, from, text = '', kind = 'text', mentions = [], quote, media, time = Date.now() }) {
    const chat = this.#chat(chatId)
    const sender = chat.members.find(m => m.id === from || m.name === from) ?? chat.members.find(m => m.id !== this.self.id)
    const message = parseMessage({
      id: this.#prefix + ++this.#seq, chatId: chat.id, time, kind, text, sender, mentions, media,
      fromSelf: sender.id === this.self.id,
      ...(quote ? { quote: this.#quote(chat.id, quote) } : {}),
    })
    this.#deliver(message)
    return message
  }

  #quote(chatId, quote) {
    const original = this.messages.get(chatId).find(m => m.id === quote.messageId)
    if (!original) return quote
    return { messageId: original.id, senderId: original.sender.id, senderName: original.sender.name, text: original.text }
  }

  #deliver(message) {
    this.messages.get(message.chatId).push(message)
    if (this.#watching.has(message.chatId)) this.peer.notify('event/message', { message })
  }

  #send(chatId, clientId, content) {
    this.#requireReady()
    this.#chat(chatId)
    if (this.#sent.has(clientId)) return this.#sent.get(clientId)
    if (!this.canSend) throw new ProtocolError(ErrorCode.Unavailable, 'screen locked')
    const failure = this.failNext.shift()
    if (failure) throw new ProtocolError(failure, `simulated ${failure}`)
    const text = content.kind === 'text' ? content.text : content.kind === 'sticker' ? `[表情] ${content.path ?? content.stickerId}` : '[图片]'
    const message = parseMessage({ id: this.#prefix + ++this.#seq, chatId, time: Date.now(), kind: content.kind, text, sender: this.self, fromSelf: true })
    const result = { messageId: message.id }
    this.#sent.set(clientId, result)
    this.#deliver(message)
    return result
  }

  #status(reason) {
    this.peer.notify('event/status', {
      connection: this.account === 'ready' ? 'connected' : 'disconnected', canSend: this.canSend && this.account === 'ready',
      ...(reason ? { reason } : {}),
    })
  }

  #accountView() {
    return { state: this.account, ...(this.account === 'ready' ? { self: this.self } : {}) }
  }

  #requireReady() {
    if (this.account !== 'ready') throw new ProtocolError(ErrorCode.NotReady, 'not logged in')
  }

  #chat(chatId) {
    const chat = this.chats.get(chatId)
    if (!chat) throw new ProtocolError(ErrorCode.NotFound, `unknown chat ${chatId}`)
    return chat
  }
}
