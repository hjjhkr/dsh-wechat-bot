import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchDefaults } from './batch.js'

const requiredTopLevel = [
  'stateRoot', 'personaPath', 'pythonExe', 'provider', 'model',
  'maxTokens', 'pollIntervalMs', 'historyTurns', 'autoStart', 'autoSend', 'worker',
]
const requiredWorker = [
  'dbRoot', 'stateRoot', 'botWxid', 'botName', 'targetWxid', 'targetName',
  'expectedExe', 'expectedVersion', 'gateTimeoutSeconds', 'keyCacheFile',
  'mainWindowClass', 'mainWindowTitle',
]

function assertAbsolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || !(isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))) {
    throw new Error(`config_${name}_must_be_absolute`)
  }
}

function rejectSecrets(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/api.?key|secret|password|credential|authorization/i.test(key)) throw new Error('config_must_not_contain_credentials')
    rejectSecrets(child)
  }
}

export async function readRuntimeConfig(configPath, readFile) {
  assertAbsolutePath(configPath, 'path')
  let raw
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    throw new Error('runtime_config_unreadable')
  }
  rejectSecrets(raw)
  for (const key of requiredTopLevel) {
    if (raw?.[key] === undefined || raw?.[key] === null) throw new Error(`runtime_config_missing_${key}`)
  }
  for (const key of requiredWorker) {
    if (raw.worker?.[key] === undefined || raw.worker?.[key] === null) throw new Error(`runtime_config_missing_worker_${key}`)
  }
  assertAbsolutePath(raw.stateRoot, 'stateRoot')
  assertAbsolutePath(raw.personaPath, 'personaPath')
  assertAbsolutePath(raw.pythonExe, 'pythonExe')
  if (raw.conversationStateBaseRoot !== undefined) assertAbsolutePath(raw.conversationStateBaseRoot, 'conversation_state_base')
  if (raw.conversationStateRoots !== undefined) {
    if (!raw.conversationStateRoots || typeof raw.conversationStateRoots !== 'object' ||
        Array.isArray(raw.conversationStateRoots)) throw new Error('conversation_state_roots_invalid')
    for (const [id, root] of Object.entries(raw.conversationStateRoots)) {
      if (!/^[A-Za-z0-9_-]{1,128}(@chatroom)?$/.test(id)) throw new Error('conversation_state_roots_invalid')
      assertAbsolutePath(root, 'conversation_state_root')
    }
    const roots = Object.values(raw.conversationStateRoots).map(p => p.replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''))
    if (new Set(roots).size !== roots.length) throw new Error('conversation_state_roots_collide')
  }
  const bundledWorkerScript = fileURLToPath(new URL('../python/worker.py', import.meta.url))
  const workerScript = raw.workerScript ?? bundledWorkerScript
  assertAbsolutePath(workerScript, 'workerScript')
  assertAbsolutePath(raw.worker.dbRoot, 'worker_dbRoot')
  assertAbsolutePath(raw.worker.stateRoot, 'worker_stateRoot')
  assertAbsolutePath(raw.worker.expectedExe, 'worker_expectedExe')
  assertAbsolutePath(raw.worker.keyCacheFile, 'worker_keyCacheFile')
  if (raw.provider !== 'deepseek-official' || raw.model !== 'deepseek-flash') throw new Error('runtime_model_must_be_deepseek_flash')
  if (!Number.isInteger(raw.maxTokens) || raw.maxTokens < 1 || raw.maxTokens > 512) throw new Error('runtime_max_tokens_out_of_range')
  if (!Number.isInteger(raw.pollIntervalMs) || raw.pollIntervalMs < 500 || raw.pollIntervalMs > 30000) throw new Error('runtime_poll_interval_out_of_range')
  if (!Number.isInteger(raw.historyTurns) || raw.historyTurns < 1 || raw.historyTurns > 20) throw new Error('runtime_history_turns_out_of_range')
  if (typeof raw.autoStart !== 'boolean' || typeof raw.autoSend !== 'boolean') throw new Error('runtime_auto_flags_invalid')
  if (raw.autoSend !== false) throw new Error('runtime_auto_send_must_be_false_page_grant_only')
  if (typeof raw.worker.expectedVersion !== 'string' || typeof raw.worker.botWxid !== 'string' || typeof raw.worker.targetWxid !== 'string') {
    throw new Error('runtime_worker_identity_invalid')
  }
  const conversationType = raw.worker.conversationType ?? 'direct'
  if (!['direct', 'group'].includes(conversationType) ||
      (conversationType === 'group') !== raw.worker.targetWxid.endsWith('@chatroom')) {
    throw new Error('runtime_conversation_type_invalid')
  }
  if (conversationType === 'group' && (
    !/^[A-Za-z0-9_-]{1,128}@chatroom$/.test(raw.worker.targetWxid) ||
    raw.worker.groupReplyPolicy !== 'model'
  )) throw new Error('runtime_group_reply_policy_invalid')
  if (typeof raw.worker.mainWindowClass !== 'string' || raw.worker.mainWindowClass.trim().length === 0 ||
    typeof raw.worker.mainWindowTitle !== 'string' || raw.worker.mainWindowTitle.trim().length === 0) {
    throw new Error('runtime_worker_window_identity_invalid')
  }
  if (!Number.isInteger(raw.worker.gateTimeoutSeconds) || raw.worker.gateTimeoutSeconds < 1 || raw.worker.gateTimeoutSeconds > 30) {
    throw new Error('runtime_gate_timeout_out_of_range')
  }
  if (raw.worker.desktopName !== undefined &&
    (typeof raw.worker.desktopName !== 'string' || !/^DshWeChatBot_[A-Za-z0-9_-]{1,64}$/.test(raw.worker.desktopName))) {
    throw new Error('runtime_isolated_desktop_invalid')
  }
  if (raw.worker.gateRva !== undefined && (!Number.isSafeInteger(raw.worker.gateRva) || raw.worker.gateRva < 0)) throw new Error('runtime_gate_rva_invalid')
  if (raw.worker.gateExpectedOriginalByte !== undefined && (!Number.isInteger(raw.worker.gateExpectedOriginalByte) || raw.worker.gateExpectedOriginalByte < 0 || raw.worker.gateExpectedOriginalByte > 255)) {
    throw new Error('runtime_gate_byte_invalid')
  }
  if (raw.worker.gateEnabledByte !== undefined && (!Number.isInteger(raw.worker.gateEnabledByte) || raw.worker.gateEnabledByte < 0 || raw.worker.gateEnabledByte > 255)) {
    throw new Error('runtime_gate_enabled_byte_invalid')
  }
  if (raw.worker.gateModule !== undefined) assertAbsolutePath(raw.worker.gateModule, 'worker_gateModule')
  if (raw.worker.gateModule !== undefined && !/\\Weixin\.dll$/i.test(raw.worker.gateModule.replaceAll('/', '\\'))) {
    throw new Error('runtime_gate_module_invalid')
  }
  const batching = { ...batchDefaults, ...raw }
  for (const [field, min, max] of [
    ['batchQuietMs', 0, 30000], ['batchMaxWaitMs', 0, 60000],
    ['batchMaxMessages', 1, 100], ['batchMaxChars', 100, 32000], ['retentionMs', 60000, 86400000],
  ]) {
    if (!Number.isInteger(batching[field]) || batching[field] < min || batching[field] > max) throw new Error(`runtime_${field}_invalid`)
  }
  if (batching.batchMaxWaitMs < batching.batchQuietMs) throw new Error('runtime_batch_wait_invalid')
  if (typeof batching.memoryEnabled !== 'boolean') throw new Error('runtime_memory_enabled_invalid')
  if (conversationType === 'group' && (!batching.memoryEnabled || typeof raw.worker.proactiveEnabled !== 'boolean')) {
    throw new Error('runtime_group_decision_config_invalid')
  }
  return {
    ...batchDefaults,
    ...raw,
    configPath,
    workerScript,
    overlapSeq: Number.isInteger(raw.overlapSeq) && raw.overlapSeq >= 0 ? raw.overlapSeq : 128,
    maxItems: Number.isInteger(raw.maxItems) && raw.maxItems > 0 ? raw.maxItems : 1000,
    rpcTimeoutMs: Number.isInteger(raw.rpcTimeoutMs) && raw.rpcTimeoutMs >= 1000 ? raw.rpcTimeoutMs : 30000,
  }
}
