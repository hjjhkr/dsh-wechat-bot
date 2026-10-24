import assert from 'node:assert/strict'
import test from 'node:test'
import { PageLifetime } from '../lib/page-lifetime.js'

const GRACE = 40
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function lifetime(options = {}) {
  const calls = []
  const life = new PageLifetime({
    enabled: true, graceMs: GRACE,
    exit: code => calls.push(`exit:${code}`),
    shutdown: async () => { calls.push('shutdown') },
    ...options,
  })
  // A page: an open event stream, closed by aborting its request.
  const open = () => {
    const controller = new AbortController()
    const response = life.handle(new Request('http://dsh/api/wechat-bot.page-lifetime', { signal: controller.signal }))
    return { response, close: () => controller.abort() }
  }
  return { life, calls, open }
}

test('the page stream is an uncached event stream', async () => {
  const { life, open } = lifetime()
  const page = open()
  assert.equal(page.response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(page.response.headers.get('cache-control'), 'no-store')
  assert.match(new TextDecoder().decode((await page.response.body.getReader().read()).value), /^retry: 1000/)
  life.dispose()
})

test('after the last page closes and the grace passes, the bot is stopped and then DSH exits', async () => {
  const { life, calls, open } = lifetime()
  const a = open(), b = open()
  a.close()
  await sleep(GRACE * 2)
  assert.deepEqual(calls, [], 'another page is still open')
  b.close()
  await sleep(GRACE * 2)
  assert.deepEqual(calls, ['shutdown', 'exit:0'])
  life.dispose()
})

test('a page coming back within the grace (a refresh) cancels the exit', async () => {
  const { life, calls, open } = lifetime()
  open().close()
  await sleep(GRACE / 2)
  const again = open()
  await sleep(GRACE * 2)
  assert.deepEqual(calls, [])
  again.close()
  await sleep(GRACE * 2)
  assert.deepEqual(calls, ['shutdown', 'exit:0'])
  life.dispose()
})

test('a failed shutdown is reported and DSH still exits', async () => {
  const errors = []
  const { life, calls, open } = lifetime({ shutdown: async () => { throw new Error('flush failed') }, onError: error => errors.push(error.message) })
  open().close()
  await sleep(GRACE * 2)
  assert.deepEqual(errors, ['flush failed'])
  assert.deepEqual(calls, ['exit:0'])
  life.dispose()
})

test('never exits when disabled, without appExit, before any page, or after dispose', async () => {
  for (const options of [{ enabled: false }, { exit: undefined }]) {
    const { life, calls, open } = lifetime(options)
    open().close()
    await sleep(GRACE * 2)
    assert.deepEqual(calls, [], JSON.stringify(Object.keys(options)))
    life.dispose()
  }
  const { life, calls, open } = lifetime()
  await sleep(GRACE * 2)
  assert.deepEqual(calls, [], 'no page has ever been open')
  open()
  life.dispose() // the host unloads the plugin: streams end, nobody exits
  await sleep(GRACE * 2)
  assert.deepEqual(calls, [])
})
