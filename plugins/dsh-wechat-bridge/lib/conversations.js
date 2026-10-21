import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BridgeError, BridgeManager } from './bridge.js'
import { readRuntimeConfig } from './config.js'
import { atomicWrite } from './store.js'

export function validateCatalog(value, botId) {
  if (value?.selfId !== botId || !Array.isArray(value.conversations) || value.conversations.length > 5000) {
    throw new BridgeError('conversation_catalog_invalid')
  }
  const ids = new Set()
  return value.conversations.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}(@chatroom)?$/.test(item.id) ||
        item.id === botId || ids.has(item.id) || typeof item.name !== 'string' || !item.name ||
        item.name.length > 512 || !['direct', 'group'].includes(item.type) ||
        (item.type === 'group') !== item.id.endsWith('@chatroom')) throw new BridgeError('conversation_catalog_invalid')
    ids.add(item.id)
    return { id: item.id, name: item.name, type: item.type }
  })
}

export function selectedConfig(raw, target) {
  const states = { ...raw.conversationStateRoots, [raw.worker.targetWxid]: raw.stateRoot }
  const conversationStateBaseRoot = raw.conversationStateBaseRoot ?? join(dirname(raw.stateRoot), 'wechat-conversations')
  const stateRoot = states[target.id] ?? join(conversationStateBaseRoot,
    createHash('sha256').update(raw.worker.botWxid + '\0' + target.id).digest('hex'))
  const next = { ...raw, stateRoot, conversationStateBaseRoot, autoStart: true, autoSend: false,
    conversationStateRoots: { ...states, [target.id]: stateRoot },
    worker: { ...raw.worker, targetWxid: target.id, targetName: target.name, conversationType: target.type } }
  if (target.type === 'group') {
    next.memoryEnabled = true
    next.worker.groupReplyPolicy = 'model'
    next.worker.proactiveEnabled = true
  } else {
    delete next.worker.groupReplyPolicy
    delete next.worker.proactiveEnabled
  }
  return next
}

export class ConversationManager {
  constructor({ runtime, manager, llm, sessionValid, createWorker, createManager = args => BridgeManager.create(args),
    readConfig = path => readFile(path, 'utf8'), writeConfig = atomicWrite }) {
    Object.assign(this, { runtime, manager, llm, sessionValid, createWorker, createManager, readConfig, writeConfig })
    this.tail = Promise.resolve()
    this.switching = false
  }

  serial(action) {
    const next = this.tail.then(action, action)
    this.tail = next.catch(() => {})
    return next
  }
  status() { return { ...this.manager.status(), switching: this.switching } }
  latestDraft() { return this.manager.latestDraft() }
  logs() { return this.manager.logs() }
  get sendConfigured() { return this.manager.sendConfigured }
  start(args) { return this.serial(() => this.manager.start(args)) }
  pause() { return this.serial(() => this.manager.pause()) }
  revokeSendGrant() { return this.serial(() => this.manager.revokeSendGrant()) }
  acknowledgeNoRetry(args) { return this.serial(() => this.manager.acknowledgeNoRetry(args)) }
  testModel(args) { return this.serial(() => this.manager.testModel(args)) }
  dispose() { return this.serial(() => this.manager.dispose()) }

  listConversations(args) {
    return this.serial(async () => ({ currentId: this.runtime.worker.targetWxid,
      conversations: validateCatalog(await this.manager.conversationOperation('conversations', args), this.runtime.worker.botWxid) }))
  }

  selectConversation({ targetId, currentId, selectionConfirmed, sessionToken }) {
    return this.serial(async () => {
      if (!this.sessionValid(sessionToken) || selectionConfirmed !== true) throw new BridgeError('selection_consent_required')
      if (currentId !== this.runtime.worker.targetWxid) throw new BridgeError('conversation_selection_stale')
      if (this.manager.status().uncertainSend) throw new BridgeError('send_recovery_required')
      if (targetId === currentId) return this.status()
      this.switching = true
      let candidate, oldDisposed = false, committed = false
      const previous = this.runtime
      const autoSend = this.manager.status().autoSendEnabled && this.manager.status().sendGrantValid
      try {
        const catalog = validateCatalog(await this.manager.conversationOperation('conversations', { sessionToken }), previous.worker.botWxid)
        const target = catalog.find(item => item.id === targetId)
        if (!target) throw new BridgeError('conversation_not_found')
        await this.manager.pause()
        if (this.manager.status().uncertainSend) throw new BridgeError('send_recovery_required')
        const raw = JSON.parse(await this.readConfig(previous.configPath))
        if (raw.worker.botWxid !== previous.worker.botWxid || raw.worker.targetWxid !== currentId ||
            raw.stateRoot !== previous.stateRoot) throw new BridgeError('conversation_config_changed')
        const next = selectedConfig(raw, target)
        const runtime = await readRuntimeConfig(previous.configPath, async () => JSON.stringify(next))
        candidate = await this.createManager({ runtime, llm: this.llm, sessionValid: this.sessionValid,
          createWorker: this.createWorker, resume: false })
        await candidate.pause()
        if (candidate.status().uncertainSend) throw new BridgeError('send_recovery_required')
        await candidate.revokeSendGrant()
        await candidate.conversationOperation('select', { sessionToken, selectionConfirmed: true })
        await this.manager.dispose()
        oldDisposed = true
        await this.writeConfig(previous.configPath, next)
        this.runtime = runtime
        this.manager = candidate
        candidate = null
        committed = true
        this.switching = false
        await this.manager.start({ autoSend: Boolean(autoSend), allowTemporaryGate: Boolean(autoSend), sessionToken })
        return this.status()
      } catch (error) {
        if (oldDisposed && !committed) {
          this.manager = await this.createManager({ runtime: previous, llm: this.llm, sessionValid: this.sessionValid,
            createWorker: this.createWorker, resume: false })
          await this.manager.pause()
        }
        throw error
      } finally {
        try {
          if (candidate) await candidate.dispose()
        } finally {
          this.switching = false
        }
      }
    })
  }
}

export async function createConversationBridge(options) {
  const runtime = await readRuntimeConfig(options.configPath, readFile)
  const manager = await BridgeManager.create({ ...options, runtime })
  return new ConversationManager({ ...options, runtime, manager })
}
