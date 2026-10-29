import { setTimeout as sleep } from 'node:timers/promises'

const BASE = 'https://api.csqaq.com/api/v1/info/'
const MAX_BYTES = 1024 * 1024
let lastRequestAt = 0
let requestQueue = Promise.resolve()

async function requestCsqaq(path, { token, method, body, signal }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('CSQAQ 未配置 API Token')
  const timeout = AbortSignal.timeout(15_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const turn = requestQueue.then(async () => {
    await sleep(Math.max(0, 1100 - (Date.now() - lastRequestAt)), undefined, { signal: requestSignal })
    requestSignal.throwIfAborted()
    lastRequestAt = Date.now()
  })
  requestQueue = turn.catch(() => {})
  await turn
  const response = await fetch(BASE + path, {
    method, redirect: 'manual', signal: requestSignal,
    headers: { ApiToken: token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('CSQAQ 请求失败：HTTP ' + response.status + ([400, 401, 403].includes(response.status) ? '（请核对令牌和出口 IP 白名单）' : ''))
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel()
    throw new Error('CSQAQ 响应过大')
  }
  if (!response.body) throw new Error('CSQAQ 响应没有内容')
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) throw new Error('CSQAQ 响应过大')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  let result
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new Error('CSQAQ 响应格式无效') }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('CSQAQ 响应格式无效')
  if (result.code !== 200) {
    const code = Number.isSafeInteger(result.code) ? String(result.code) : '未知'
    throw new Error('CSQAQ 接口返回错误：状态码 ' + code + ([400, 401, 403].includes(result.code) ? '（请核对令牌和出口 IP 白名单）' : ''))
  }
  return result.data
}

function itemInfo(item) {
  if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.name !== 'string' || !item.name.trim()) {
    throw new Error('CSQAQ 饰品数据格式无效')
  }
  if (item.updated_at != null && typeof item.updated_at !== 'string') throw new Error('CSQAQ 更新时间格式无效')
  const prices = {}
  for (const [key, name] of [['buff', 'BUFF'], ['yyyp', '悠悠有品'], ['steam', 'Steam'], ['c5', 'C5GAME'], ['igxe', 'IGXE'], ['eco', 'ECOSteam'], ['r8', 'R8GAME']]) {
    const sell = item[key + '_sell_price']
    const buy = item[key + '_buy_price']
    for (const price of [sell, buy]) {
      if (price != null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) throw new Error('CSQAQ 饰品价格格式无效')
    }
    if (sell != null || buy != null) prices[name] = { ...(sell != null ? { sell } : {}), ...(buy != null ? { buy } : {}) }
  }
  return { id: item.id, name: item.name, url: 'https://csqaq.com/goods/' + item.id, currency: 'CNY', prices, ...(item.updated_at ? { updatedAt: item.updated_at } : {}) }
}

export async function searchCsqaq({ query, token, signal }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('CSQAQ 搜索词无效')
  const data = await requestCsqaq('get_page_list', {
    token, signal, method: 'POST', body: { page_index: 1, page_size: 18, search: query.trim(), filter: {} },
  })
  if (!Array.isArray(data?.data)) throw new Error('CSQAQ 搜索结果格式无效')
  return { source: 'CSQAQ', items: data.data.map(itemInfo) }
}

export async function getCsqaqGood({ id, token, signal }) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('CSQAQ 饰品 ID 无效')
  const data = await requestCsqaq('good?id=' + id, { token, signal, method: 'GET' })
  const item = itemInfo(data?.goods_info)
  if (item.id !== id) throw new Error('CSQAQ 返回的饰品 ID 与请求不一致')
  return { source: 'CSQAQ', ...item }
}
