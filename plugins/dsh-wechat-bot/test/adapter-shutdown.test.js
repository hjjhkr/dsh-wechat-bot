import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnAdapter } from '../lib/adapter.js'

const sendAndShutdownScript = String.raw`
const { createInterface } = require('node:readline')
const input = createInterface({ input: process.stdin })
let sendsPending = 0
function respond(request, frame, afterWrite) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...frame }) + '\n', afterWrite)
}
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'message/send') {
    sendsPending++
    process.stderr.write('send-received\n')
    setTimeout(() => {
      sendsPending--
      respond(request, { result: { messageId: request.params.clientId } })
      process.stderr.write('send-replied\n')
    }, 180)
    return
  }
  if (request.method === 'shutdown') {
    process.stderr.write(sendsPending ? 'shutdown-before-send\n' : 'shutdown-after-send\n')
    respond(request, { result: {} }, () => setImmediate(() => process.exit(0)))
  }
})
`

const shutdownErrorScript = String.raw`
const { createInterface } = require('node:readline')
const input = createInterface({ input: process.stdin })
let shutdownCount = 0
function respond(request, frame, afterWrite) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...frame }) + '\n', afterWrite)
}
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'shutdown') {
    shutdownCount++
    if (shutdownCount === 1) {
      respond(request, { error: { code: -32000, message: 'shutdown refused', data: { code: 'shutdown_refused' } } })
    } else {
      respond(request, { result: {} }, () => setImmediate(() => process.exit(0)))
    }
    return
  }
  if (request.method === 'diagnostic') respond(request, { result: { alive: true } })
})
`

const shutdownTimeoutScript = String.raw`
const { createInterface } = require('node:readline')
const input = createInterface({ input: process.stdin })
let shutdownCount = 0
function respond(request, frame, afterWrite) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...frame }) + '\n', afterWrite)
}
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'shutdown') {
    shutdownCount++
    if (shutdownCount === 1) respond(request, { result: {} })
    else respond(request, { result: {} }, () => setImmediate(() => process.exit(0)))
    return
  }
  if (request.method === 'diagnostic') respond(request, { result: { alive: true } })
})
`

function spawnFakeAdapter(script) {
  const client = spawnAdapter({ command: process.execPath, args: ['-e', script] })
  const logs = []
  client.on('log', entry => logs.push(entry.message))
  let exited = false
  client.exited.then(() => { exited = true })
  return { client, logs, hasExited: () => exited }
}

async function until(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fake adapter event')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('strict shutdown drains sends, rejects later sends, and waits for child exit', async t => {
  const { client, logs, hasExited } = spawnFakeAdapter(sendAndShutdownScript)
  t.after(async () => {
    if (!hasExited()) await client.shutdown()
  })

  let sendSettled = false
  const sending = client.send('room-1', 'send-1', { kind: 'text', text: 'hello' })
    .then(result => { sendSettled = true; return result })
  const draining = client.waitForSends()
  await until(() => logs.includes('send-received'))
  assert.equal(sendSettled, false, 'waitForSends must stay pending while the send RPC is in flight')
  await draining
  assert.equal(sendSettled, true)

  const secondSending = client.send('room-1', 'send-2', { kind: 'text', text: 'still in flight' })
  await until(() => logs.filter(entry => entry === 'send-received').length === 2)
  const stopping = client.shutdown({ strict: true, timeoutMs: 2_000 })
  const pendingSend = client.send('room-1', 'send-3', { kind: 'text', text: 'later' })
  await assert.rejects(pendingSend, { code: 'closed' })
  assert.deepEqual(await sending, { messageId: 'send-1' })
  assert.deepEqual(await secondSending, { messageId: 'send-2' })
  await stopping
  assert.equal(await client.exited, 0)
  assert.ok(logs.includes('shutdown-after-send'), `shutdown order was ${logs.join(', ')}`)
  assert.equal(logs.includes('shutdown-before-send'), false)
})

test('strict shutdown surfaces RPC failure and leaves peer and child available for diagnosis', async t => {
  const { client, hasExited } = spawnFakeAdapter(shutdownErrorScript)
  t.after(async () => {
    if (!hasExited()) await client.shutdown()
  })

  await assert.rejects(client.shutdown({ strict: true, timeoutMs: 2_000 }), { code: 'shutdown_refused' })
  await new Promise(resolve => setTimeout(resolve, 1_200))
  assert.deepEqual(await client.peer.request('diagnostic'), { alive: true })
  assert.equal(hasExited(), false, 'strict RPC failure must not close or kill the child')
  await client.shutdown()
  assert.equal(await client.exited, 0)
})

test('strict child-exit timeout does not force-kill the adapter', async t => {
  const { client, hasExited } = spawnFakeAdapter(shutdownTimeoutScript)
  t.after(async () => {
    if (!hasExited()) await client.shutdown()
  })

  await assert.rejects(client.shutdown({ strict: true, timeoutMs: 80 }), /exit|timed out/i)
  await new Promise(resolve => setTimeout(resolve, 3_100))
  assert.deepEqual(await client.peer.request('diagnostic'), { alive: true })
  assert.equal(hasExited(), false, 'a strict timeout must leave the child alive')
  await client.shutdown()
  assert.equal(await client.exited, 0)
})
