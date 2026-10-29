const allowedHosts = new Set(['hltv.org', 'www.hltv.org', 'apexlegendsstatus.com', 'csqaq.com', 'www.csqaq.com'])
const MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 4

function checkedUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('不允许的站点地址') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHosts.has(url.hostname)) {
    throw new Error('不允许的站点地址：' + url.hostname)
  }
  return url
}

function siteGroup(host) {
  return host.replace(/^www\./, '')
}

export async function fetchAllowedSite(value, { signal } = {}) {
  let url = checkedUrl(value)
  const initialSite = siteGroup(url.hostname)
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    requestSignal.throwIfAborted()
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: requestSignal, headers: { accept: 'text/html, application/rss+xml, application/xml;q=0.9, text/plain;q=0.8' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || redirects === MAX_REDIRECTS) throw new Error('站点重定向无效或次数过多')
      url = checkedUrl(new URL(location, url))
      if (siteGroup(url.hostname) !== initialSite) throw new Error('不允许跨站点重定向')
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('站点请求失败：HTTP ' + response.status)
    }
    const length = response.headers.get('content-length')
    if (length && Number(length) > MAX_BYTES) {
      await response.body?.cancel()
      throw new Error('站点响应过大')
    }
    if (!response.body) throw new Error('站点响应没有内容')
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        total += chunk.byteLength
        if (total > MAX_BYTES) throw new Error('站点响应过大')
        chunks.push(chunk)
      }
    } finally { await reader.cancel() }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }
}

function decodeText(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_, code, name) => {
    if (code) {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
      if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('站点内容包含无效字符')
      return String.fromCodePoint(n)
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()]
  }).replace(/\s+/g, ' ').trim()
}

function formatChinaTime(at) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}

export async function getApexBriefing({ at, signal }) {
  if (!Number.isFinite(at)) throw new Error('排位地图目标时间无效')
  const html = await fetchAllowedSite('https://apexlegendsstatus.com/current-map', { signal })
  const ranked = html.split(/<h2[^>]*>BR Ranked<\/h2>/i)[1]
  const nextCard = ranked?.search(/<div\s+class="[^"]*\bcurmap-overview-card\b/i) ?? -1
  if (nextCard < 0) throw new Error('Apex 排位地图页面结构无法识别')
  const block = ranked.slice(0, nextCard)
  const current = /class="container brranked"[\s\S]*?<h2[^>]*>([^<]+)<\/h2>[\s\S]*?data-start="(\d+)"\s+data-end="(\d+)"/i.exec(block)
  if (!current) throw new Error('Apex 当前排位地图无法识别')
  const intervals = [{ name: decodeText(current[1]), start: Number(current[2]) * 1000, end: Number(current[3]) * 1000 }]
  const future = block.split('class="curmap-next-maps"')[1]
  if (future) {
    const cards = future.matchAll(/class="curmap-next-map"[^>]*>([\s\S]*?)<\/div>/gi)
    for (const card of cards) {
      const name = /<h4[^>]*>([^<]+)<\/h4>/i.exec(card[1])?.[1]
      const times = [...card[1].matchAll(/data-tz="(\d+)"/gi)]
      if (!name || times.length !== 2) throw new Error('Apex 未来排位地图无法识别')
      const next = { name: decodeText(name), start: Number(times[0][1]) * 1000, end: Number(times[1][1]) * 1000 }
      if (next.start !== intervals.at(-1).end || next.end <= next.start) throw new Error('Apex 排位轮换时间无法识别')
      intervals.push(next)
    }
  }
  const item = intervals.find(x => x.start <= at && at < x.end && x.end > x.start)
  if (!item) throw new Error('Apex 页面排位轮换未覆盖目标时间')
  return 'Apex 排位地图：' + item.name + '（北京时间 ' + formatChinaTime(item.start) + ' 至 ' + formatChinaTime(item.end) + '）\n来源：https://apexlegendsstatus.com/current-map'
}

export async function getHltvBriefing({ signal } = {}) {
  const xml = await fetchAllowedSite('https://www.hltv.org/rss/news', { signal })
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = match[1]
    const rawTitle = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(item)?.[1]
    if (!rawTitle) throw new Error('HLTV RSS 没有可用新闻')
    const title = decodeText(rawTitle)
    if (/^Short news:\s*Week\s+\d+$/i.test(title)) continue
    const rawDescription = /<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i.exec(item)?.[1]
    const rawLink = /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i.exec(item)?.[1]
    if (!rawDescription || !rawLink) throw new Error('HLTV RSS 没有可用新闻')
    const description = decodeText(rawDescription)
    const link = checkedUrl(decodeText(rawLink))
    if (!title || title.length > 500 || !description || siteGroup(link.hostname) !== 'hltv.org' || !/^\/news\/\d+\//.test(link.pathname)) throw new Error('HLTV RSS 新闻格式无效')
    return 'HLTV 最新新闻：' + title + '\n摘要：' + description + '\n' + link.href
  }
  throw new Error('HLTV RSS 没有可用新闻')
}
