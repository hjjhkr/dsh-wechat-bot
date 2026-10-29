import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchAllowedSite, getApexBriefing, getHltvBriefing } from '../lib/site-access.js'

const apex = '<h2>BR Ranked</h2><div class="container brranked"><h2>Olympus</h2><div id="timer" data-start="1000" data-end="2000"></div></div><div class="curmap-next-maps"><div class="curmap-next-map"><h4>Broken Moon</h4><p><span data-tz="2000">x</span><span data-tz="3000">y</span></p></div></div><div class="row curmap-overview-card"><h2>Mixtape</h2></div>'
const rss = '<rss><channel><item><title>Short news: Week 42</title><description>A weekly roundup</description><link>https://www.hltv.org/news/122/short-news-week-42</link></item><item><title>Team A &amp; Team B</title><description><![CDATA[Team A wins &amp; advances.]]></description><link>https://www.hltv.org/news/123/example</link></item></channel></rss>'
const originalFetch = globalThis.fetch

test('only approved HTTPS hosts are fetched, each redirect is checked', async () => {
  let calls = []
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(null, {status: 302, headers: {location: 'https://example.com/'}}) }
  try {
    for (const url of ['http://www.hltv.org/', 'https://evil-hltv.org/', 'https://www.hltv.org:444/', 'https://user@www.hltv.org/', 'https://127.0.0.1/']) {
      await assert.rejects(fetchAllowedSite(url), /不允许/)
    }
    assert.equal(calls.length, 0)
    await assert.rejects(fetchAllowedSite('https://www.hltv.org/'), /不允许/)
    assert.equal(calls.length, 1)
  } finally { globalThis.fetch = originalFetch }
})

test('successful fetch enforces body limit and cancellation', async () => {
  try {
    globalThis.fetch = async () => new Response('ok')
    assert.equal(await fetchAllowedSite('https://csqaq.com/'), 'ok')
    globalThis.fetch = async () => new Response('x'.repeat(2_000_000))
    await assert.rejects(fetchAllowedSite('https://csqaq.com/'), /过大/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(fetchAllowedSite('https://csqaq.com/', {signal: controller.signal}))
  } finally { globalThis.fetch = originalFetch }
})

test('Apex uses only the ranked interval covering the requested instant', async () => {
  globalThis.fetch = async () => new Response(apex)
  try {
    assert.match(await getApexBriefing({at: 2_000_000}), /Broken Moon/)
    assert.match(await getApexBriefing({at: 1_999_000}), /Olympus/)
    await assert.rejects(getApexBriefing({at: 3_000_000}), /覆盖/)
  } finally { globalThis.fetch = originalFetch }
})

test('HLTV selects a concrete article after a weekly roundup and includes its RSS summary', async () => {
  globalThis.fetch = async () => new Response(rss)
  try {
    const result = await getHltvBriefing({})
    assert.match(result, /Team A & Team B/)
    assert.match(result, /Team A wins & advances\./)
    assert.match(result, /https:\/\/www\.hltv\.org\/news\/123\/example/)
    assert.doesNotMatch(result, /Short news: Week 42/)
  } finally { globalThis.fetch = originalFetch }
})

test('HLTV fails when only weekly roundups or a missing summary are available', async () => {
  try {
    globalThis.fetch = async () => new Response('<rss><item><title>Short news: Week 42</title><description>A weekly roundup</description><link>https://www.hltv.org/news/122/short-news-week-42</link></item></rss>')
    await assert.rejects(getHltvBriefing({}), /没有可用新闻/)
    globalThis.fetch = async () => new Response('<rss><item><title>Team A wins</title><link>https://www.hltv.org/news/123/example</link></item></rss>')
    await assert.rejects(getHltvBriefing({}), /没有可用新闻/)
  } finally { globalThis.fetch = originalFetch }
})

test('redirects may remain within one approved site but cannot switch sites', async () => {
  let calls = []
  try {
    globalThis.fetch = async url => { calls.push(String(url)); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://hltv.org/rss/news' } }) : new Response('feed') }
    assert.equal(await fetchAllowedSite('https://www.hltv.org/rss/news'), 'feed')
    assert.deepEqual(calls, ['https://www.hltv.org/rss/news', 'https://hltv.org/rss/news'])
    globalThis.fetch = async () => new Response(null, { status: 301, headers: { location: 'https://csqaq.com/' } })
    await assert.rejects(fetchAllowedSite('https://www.hltv.org/'), /不允许跨站点/)
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await assert.rejects(fetchAllowedSite('https://www.hltv.org/'), /HTTP 503/)
  } finally { globalThis.fetch = originalFetch }
})

test('unrecognized RSS and map data fail without inventing an answer', async () => {
  try {
    globalThis.fetch = async () => new Response('<rss><channel></channel></rss>')
    await assert.rejects(getHltvBriefing({}), /没有可用新闻/)
    globalThis.fetch = async () => new Response('<h2>Mixtape</h2>')
    await assert.rejects(getApexBriefing({at: 1}), /无法识别/)
  } finally { globalThis.fetch = originalFetch }
})

test('Apex never treats a later mode as ranked when its heading changes', async () => {
  const html = '<h2>BR Ranked</h2><div class="container brranked"><h2>Olympus</h2><div data-start="1000" data-end="2000"></div></div><div class="curmap-next-maps"></div><div class="row curmap-overview-card"><h2>Mixtape (rotation)</h2><div><div class="curmap-next-map"><h4>Other mode</h4><span data-tz="2000"></span><span data-tz="3000"></span></div></div></div>'
  globalThis.fetch = async () => new Response(html)
  try { await assert.rejects(getApexBriefing({at: 2_500_000}), /覆盖/) } finally { globalThis.fetch = originalFetch }
})

test('Apex rejects a broken future card rather than borrowing timestamps from another', async () => {
  const html = '<h2>BR Ranked</h2><div class="container brranked"><h2>Olympus</h2><div data-start="1000" data-end="2000"></div></div><div class="curmap-next-maps"><div class="curmap-next-map"><h4>Broken Moon</h4><span data-tz="2000"></span></div><div class="curmap-next-map"><h4>Worlds Edge</h4><span data-tz="3000"></span><span data-tz="4000"></span></div></div><div class="row curmap-overview-card"><h2>Mixtape</h2></div>'
  globalThis.fetch = async () => new Response(html)
  try { await assert.rejects(getApexBriefing({at: 2_500_000}), /无法识别/) } finally { globalThis.fetch = originalFetch }
})
