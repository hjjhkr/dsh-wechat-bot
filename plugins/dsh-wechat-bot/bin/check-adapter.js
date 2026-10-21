#!/usr/bin/env node
// Protocol conformance check for an adapter executable.
//
//   node bin/check-adapter.js [--watch <chatId>] [--send <chatId>] [--wait <seconds>] -- <command> [args...]
//
// Read-only by default. --watch prints incoming messages for --wait seconds;
// --send posts one test message ("adapter check") to that chat.
import { spawnAdapter } from '../lib/adapter.js'
import { PROTOCOL_VERSION } from '../lib/protocol.js'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
if (split < 0 || split === argv.length - 1) {
  console.error('usage: check-adapter [--watch <chatId>] [--send <chatId>] [--wait <seconds>] -- <command> [args...]')
  process.exit(2)
}
const flags = argv.slice(0, split)
const option = name => flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined
const [command, ...args] = argv.slice(split + 1)

let failures = 0
const pass = what => console.log(`  ✓ ${what}`)
const fail = (what, error) => { failures++; console.log(`  ✗ ${what}: ${error?.message ?? error}`) }
async function step(what, run) {
  try {
    const detail = await run()
    pass(detail ? `${what} — ${detail}` : what)
    return true
  } catch (error) {
    fail(what, error)
    return false
  }
}

const client = spawnAdapter({ command, args })
client.on('log', ({ level, message }) => console.log(`    [adapter ${level}] ${message}`))
client.on('status', status => console.log(`    [status] ${JSON.stringify(status)}`))
client.on('account', account => console.log(`    [account] ${account.state}`))
client.on('message', message => console.log(`    [message] ${message.chatId} ${message.sender.name}: ${message.kind} ${message.text}`))

console.log(`checking ${command} ${args.join(' ')}`)
try {
  const ok = await step(`initialize (protocol ${PROTOCOL_VERSION})`, async () => {
    const info = await client.initialize({ dataDir: process.cwd(), client: { name: 'check-adapter', version: '1' } })
    return `${info.name} ${info.version}, capabilities ${JSON.stringify(client.capabilities)}`
  })
  if (!ok) throw new Error('handshake failed')
  let account
  await step('account/status', async () => {
    account = await client.accountStatus()
    return account.state === 'ready' ? `ready as ${account.self.name} (${account.self.id})` : account.state
  })
  if (account?.state === 'ready') {
    let chats = []
    await step('chats/list', async () => {
      chats = await client.listChats()
      if (new Set(chats.map(c => c.id)).size !== chats.length) throw new Error('chat ids are not unique')
      return `${chats.length} chats`
    })
    const group = chats.find(c => c.kind === 'group')
    if (group) await step(`chats/members ${group.name}`, async () => `${(await client.members(group.id)).length} members`)
    if (client.capabilities.history && chats[0]) {
      await step(`chats/history ${chats[0].name}`, async () => `${(await client.history(chats[0].id, 5)).length} messages`)
    }
    if (client.capabilities.window) await step('window/get', async () => JSON.stringify(await client.windowState()))
    await step('message/send rejects an unknown chat with not_found', async () => {
      try {
        await client.send('\u0000no-such-chat', 'check-unknown', { kind: 'text', text: 'x' })
      } catch (error) {
        if (error.code === 'not_found' || error.code === 'invalid_params') return error.code
        throw new Error(`expected not_found, got ${error.code}`)
      }
      throw new Error('send to an unknown chat succeeded')
    })
    const watch = option('--watch')
    if (watch) {
      await step(`watch/set ${watch}`, async () => JSON.stringify(await client.watch([watch])))
      const seconds = Number(option('--wait') ?? 30)
      console.log(`  … printing messages for ${seconds}s`)
      await new Promise(resolve => setTimeout(resolve, seconds * 1000))
    }
    const target = option('--send')
    if (target) {
      await step(`message/send to ${target}`, async () => {
        const id = `check-${Date.now()}`
        const first = await client.send(target, id, { kind: 'text', text: 'adapter check' })
        const again = await client.send(target, id, { kind: 'text', text: 'adapter check' })
        if (first.messageId !== again.messageId) throw new Error('the same clientId was sent twice')
        return `messageId ${first.messageId}, idempotent`
      })
    }
  } else {
    console.log('  (log in the account and rerun for the remaining checks; account/login is not called by this tool)')
  }
} catch {}
await client.shutdown()
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
