import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnAdapter } from '../lib/adapter.js'

// A fake adapter: answers message/send after 180 ms, and shutdown with {} (then exits) unless told to hang.
const script = hang => String.raw`
const input = require('node:readline').createInterface({ input: process.stdin })
let pending = 0
const respond = (request, frame, after) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...frame }) + '\n', after)
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'message/send') {
    pending++
    setTimeout(() => { pending--; respond(request, { result: { messageId: request.params.clientId } }) }, 180)
  } else if (request.method === 'shutdown' && !${hang}) {
    process.stderr.write(pending ? 'shutdown-before-send\n' : 'shutdown-after-send\n')
    respond(request, { result: {} }, () => setImmediate(() => process.exit(0)))
  }
})
// A hung adapter ignores the closed pipe as well.
${hang} && process.stdin.on('end', () => setInterval(() => {}, 1000))
`

function fake(hang = false, options = {}) {
  const client = spawnAdapter({ command: process.execPath, args: ['-e', script(hang)] }, options)
  const logs = []
  client.on('log', entry => logs.push(entry.message))
  return { client, logs }
}

test('shutdown lets a send in flight finish, refuses new ones as not sent, then the adapter exits', async () => {
  const { client, logs } = fake()
  const send = client.send('g@chatroom', 'c1', { kind: 'text', text: 'hi' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const stopping = client.shutdown()
  await assert.rejects(client.send('g@chatroom', 'c2', { kind: 'text', text: 'late' }), error => error.code === 'closed')
  assert.deepEqual(await send, { messageId: 'c1' }, 'the send in flight got its answer')
  await stopping
  assert.equal(await client.exited, 0)
  assert.ok(logs.includes('shutdown-after-send'), 'shutdown was asked only after the send was answered')
})

test('an adapter that does not answer shutdown and does not exit is killed', async () => {
  const { client } = fake(true, { timeoutMs: 200, stopGraceMs: 200 })
  const started = Date.now()
  await client.shutdown()
  assert.notEqual(await client.exited, 0)
  assert.ok(Date.now() - started < 3000, 'bounded')
})
