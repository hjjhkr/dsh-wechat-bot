import assert from 'node:assert/strict'
import test from 'node:test'
import { searchCsqaq, getCsqaqGood } from '../lib/csqaq.js'
const oldFetch = globalThis.fetch

test('CSQAQ search posts keyword and returns named platform price with source', async () => {
  let request
  globalThis.fetch = async (url, options) => { request = {url: String(url), options}; return Response.json({code: 200, data: {current_page: 1, data: [{id: 6798, name: '蝴蝶刀', yyyp_sell_price: 14300}]}}) }
  try {
    const result = await searchCsqaq({query: '蝴蝶', token: 'example-token'})
    assert.equal(request.url, 'https://api.csqaq.com/api/v1/info/get_page_list')
    assert.equal(request.options.headers.ApiToken, 'example-token')
    assert.equal(request.options.redirect, 'manual')
    assert.equal(JSON.parse(request.options.body).search, '蝴蝶')
    assert.equal(result.items[0].prices['悠悠有品'].sell, 14300)
    assert.equal(result.items[0].url, 'https://csqaq.com/goods/6798')
    assert.doesNotMatch(JSON.stringify(result), /example-token/)
  } finally { globalThis.fetch = oldFetch }
})

test('CSQAQ detail returns only data with platform names and timestamp', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.csqaq.com/api/v1/info/good?id=7310')
    assert.equal(options.method, 'GET')
    return Response.json({code: 200, data: {goods_info: {id: 7310, name: '饰品', buff_sell_price: 6750, buff_buy_price: 6550, steam_sell_price: 10436.62, updated_at: '2026-04-23T16:04:06'}}})
  }
  try {
    const result = await getCsqaqGood({id: 7310, token: 'example-token'})
    assert.deepEqual(result.prices['BUFF'], {sell: 6750, buy: 6550})
    assert.equal(result.prices.Steam.sell, 10436.62)
    assert.equal(result.updatedAt, '2026-04-23T16:04:06')
    assert.equal(result.url, 'https://csqaq.com/goods/7310')
  } finally { globalThis.fetch = oldFetch }
})

test('CSQAQ authentication, application errors and redirects fail without exposing token', async () => {
  try {
    for (const response of [new Response('denied', {status: 403}), Response.json({code: 401, msg: 'example-token'}), new Response(null, {status: 302, headers:{location:'https://evil.test/'}})]) {
      globalThis.fetch = async () => response
      await assert.rejects(searchCsqaq({query: '刀', token: 'example-token'}), error => !error.message.includes('example-token'))
    }
  } finally { globalThis.fetch = oldFetch }
})

test('CSQAQ consecutive calls respect its per-IP rate limit within this process', async () => {
  const times = []
  globalThis.fetch = async () => { times.push(Date.now()); return Response.json({code: 200, data: {current_page: 1, data: []}}) }
  try {
    await Promise.all([searchCsqaq({query: '刀', token: 'example-token'}), searchCsqaq({query: '枪', token: 'example-token'})])
    assert.ok(times[1] - times[0] >= 1000, 'requests must be at least one second apart')
  } finally { globalThis.fetch = oldFetch }
})

test('CSQAQ detail rejects a response for a different item ID', async () => {
  globalThis.fetch = async () => Response.json({code: 200, data: {goods_info: {id: 2, name: '另一件饰品'}}})
  try { await assert.rejects(getCsqaqGood({id: 1, token: 'example-token'}), /ID/) } finally { globalThis.fetch = oldFetch }
})
