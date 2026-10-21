import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { JsonlWorkerClient } from '../lib/worker-client.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => true
  return child
}

test('unexpected worker exit is never reported as a confirmed clean close', async () => {
  const child = fakeChild()
  const client = new JsonlWorkerClient(child)
  child.exitCode = 17
  child.emit('exit', 17, null)
  await assert.rejects(client.close(), (error) => error.code === 'worker_close_unconfirmed')
  child.stdin.end()
  child.stdout.end()
  child.stderr.end()
})

test('worker close requires an explicit restored-gate readback', async (t) => {
  for (const gateRestored of [false, true]) {
    await t.test(String(gateRestored), async () => {
      const child = fakeChild()
      child.stdin.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString().trim())
        child.stdout.write(JSON.stringify({
          id: request.id,
          result: { closed: true, gateActive: false, gateRestored },
        }) + '\n')
      })
      child.stdin.once('finish', () => {
        child.exitCode = 0
        child.emit('exit', 0, null)
        child.stdout.end()
        child.stderr.end()
      })
      const client = new JsonlWorkerClient(child)
      if (gateRestored) {
        const result = await client.close()
        assert.equal(result.gateRestored, true)
      } else {
        await assert.rejects(client.close(), (error) => error.code === 'worker_close_unconfirmed')
        child.stdin.end()
        child.stdout.end()
        child.stderr.end()
      }
    })
  }
})

