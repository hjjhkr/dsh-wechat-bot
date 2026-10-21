import assert from 'node:assert/strict'
import test from 'node:test'
import { readRuntimeConfig } from '../lib/config.js'

function validConfig() {
  return {
    stateRoot: 'C:/ExampleProject/state',
    personaPath: 'C:/ExampleProject/persona.md',
    pythonExe: 'C:/ExampleProject/python.exe',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    maxTokens: 512,
    pollIntervalMs: 2000,
    historyTurns: 8,
    autoStart: false,
    autoSend: false,
    worker: {
      dbRoot: 'E:/xwechat_files',
      stateRoot: 'C:/ExampleProject/reader',
      keyCacheFile: 'C:/ExampleProject/reader/keys/bot.json',
      botWxid: 'wxid_bot',
      botName: 'BOT_ACCOUNT',
      targetWxid: 'wxid_target',
      targetName: 'USER_OWNER',
      expectedExe: 'D:/Weixin/Weixin.exe',
      expectedVersion: '4.1.15.13',
      gateTimeoutSeconds: 30,
      mainWindowClass: 'Qt51514QWindowIcon',
      mainWindowTitle: '微信',
    },
  }
}

const configPath = 'C:/ExampleProject/config.json'

test('group mode explicitly enables model decisions, memory and proactive selection', async () => {
  const raw = validConfig()
  raw.worker.targetWxid = '123@chatroom'
  await assert.rejects(readRuntimeConfig(configPath, async () => JSON.stringify(raw)), /conversation_type_invalid/)
  raw.worker.conversationType = 'group'
  raw.worker.groupReplyPolicy = 'model'
  raw.worker.proactiveEnabled = true
  raw.memoryEnabled = true
  const loaded = await readRuntimeConfig(configPath, async () => JSON.stringify(raw))
  assert.equal(loaded.worker.groupReplyPolicy, 'model')
  raw.worker.groupReplyPolicy = 'prefix'
  await assert.rejects(readRuntimeConfig(configPath, async () => JSON.stringify(raw)), /group_reply_policy_invalid/)
})

test('isolated desktop is explicit and cannot target Default or a desktop path', async () => {
  for (const name of ['Default', '', null, 'WinSta0\\Default', '../Default', 'DshWeChatBot_']) {
    const raw = validConfig()
    raw.worker.desktopName = name
    await assert.rejects(readRuntimeConfig(configPath, async () => JSON.stringify(raw)),
      { message: 'runtime_isolated_desktop_invalid' })
  }
  const raw = validConfig()
  raw.worker.desktopName = 'DshWeChatBot_test'
  const checked = await readRuntimeConfig(configPath, async () => JSON.stringify(raw))
  assert.equal(checked.worker.desktopName, raw.worker.desktopName)
})

test('runtime requires main-window identity for process binding', async () => {
  for (const field of ['mainWindowClass', 'mainWindowTitle']) {
    for (const value of ['   ', undefined]) {
      const raw = validConfig()
      raw.worker[field] = value
      const expected = value === undefined ? `runtime_config_missing_worker_${field}` : 'runtime_worker_window_identity_invalid'
      await assert.rejects(
        readRuntimeConfig(configPath, async () => JSON.stringify(raw)),
        { message: expected },
      )
    }
  }
})
