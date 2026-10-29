import assert from 'node:assert/strict'
import test from 'node:test'
import { getCloudHltvBriefing } from '../lib/hltv-cloud.js'

const now = new Date()
const iso = now.toISOString().slice(0, 10)
const [year, month, day] = iso.split('-')
const articleDate = day + '-' + month + '-' + year
const monthName = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(now)
const archiveUrl = 'https://www.hltv.org/news/archive/' + year + '/' + monthName.toLowerCase()
const title = 'Team A beats Team B to reach playoffs'
const articleUrl = 'https://www.hltv.org/news/12345/team-a-beats-team-b'
const archive = '# News from ' + monthName + ', ' + year + '\n\nShort news: Week 42\n\n' + iso + '\n\n42 comments\n\n' + title + '\n\n' + iso + '\n\n1 comments'
const article = '# ' + title + '\n\n' + articleDate + ' 02:47\n\nTeam A defeated Team B to qualify for playoffs.'
const result = (url, content, overrides = {}) => ({ url, statusCode: 200, truncated: false, body: {kind: 'text', content}, ...overrides })

function services({ archiveText = archive, sources = [{url: articleUrl, title: title + ' | HLTV.org', publishedAt: '1999-01-01'}], page = article, pageResult } = {}) {
  const calls = []
  return {
    calls,
    search: async (request, signal) => { calls.push(['search', request, signal]); return {sources, truncated: false} },
    fetch: async (request, signal) => { calls.push(['fetch', request, signal]); return request.url === archiveUrl ? result(request.url, archiveText) : (pageResult ?? result(request.url, page)) }
  }
}

test('selects the first non-roundup archive title and verifies the official article', async () => {
  const service = services()
  const controller = new AbortController()
  const text = await getCloudHltvBriefing({...service, signal: controller.signal})
  assert.match(text, /Team A beats Team B/)
  assert.match(text, /Team A defeated Team B/)
  assert.match(text, new RegExp(articleDate))
  assert.match(text, /时区/)
  assert.match(text, /https:\/\/www\.hltv\.org\/news\/12345/)
  assert.doesNotMatch(text, /1999-01-01|Short news: Week 42/)
  assert.deepEqual(service.calls.map(c => c[0]), ['fetch', 'search', 'fetch'])
  assert.equal(service.calls[0][1].url, archiveUrl)
  assert.match(service.calls[1][1].query, /site:hltv\.org\/news/)
  assert.ok(service.calls[1][1].query.includes(title))
  assert.ok(service.calls.every(c => c[2] === controller.signal))
})

test('rejects untrusted hosts, paths and non-matching search titles', async () => {
  for (const source of [
    {url: 'https://evil-hltv.org/news/12345/team-a', title},
    {url: 'https://www.hltv.org/news/archive/2026/october', title},
    {url: 'http://www.hltv.org/news/12345/team-a', title},
    {url: 'https://user@www.hltv.org/news/12345/team-a', title},
    {url: articleUrl, title: 'Different article'}
  ]) {
    const service = services({sources: [source]})
    await assert.rejects(getCloudHltvBriefing(service), /匹配/)
    assert.deepEqual(service.calls.map(c => c[0]), ['fetch', 'search'])
  }
})

test('rejects unreadable, altered or unrelated fetched pages', async () => {
  for (const pageResult of [
    result(articleUrl, article, {statusCode: 503}),
    result(articleUrl, article, {truncated: true}),
    result('https://example.com/news/12345/team-a', article),
    result(articleUrl, '# Different title\n\n' + articleDate + ' 02:47\n\nText'),
    result(articleUrl, '# ' + title + '\n\nnot a date\n\nText')
  ]) await assert.rejects(getCloudHltvBriefing(services({pageResult})))
})

test('fails on missing or stale archive and search with no exact result', async () => {
  await assert.rejects(getCloudHltvBriefing(services({archiveText: '# Archive\n\nShort news: Week 42\n\n' + iso + '\n\n2 comments'})), /没有可用新闻/)
  await assert.rejects(getCloudHltvBriefing(services({archiveText: '# Archive\n\n' + title + '\n\n2000-01-01\n\n2 comments'})), /日期/)
  await assert.rejects(getCloudHltvBriefing(services({sources: []})), /匹配/)
})

test('upstream errors propagate and are not converted to invented content', async () => {
  const error = new Error('cloud unavailable')
  const service = services()
  service.search = async () => { throw error }
  await assert.rejects(getCloudHltvBriefing(service), e => e === error)
})


test('uses the earliest archive candidate actually returned by one search', async () => {
  const earlier = 'Breaking update from a major tournament'
  const archiveText = '# News\n\n' + earlier + '\n\n' + iso + '\n\n2 comments\n\n' + title + '\n\n' + iso + '\n\n1 comments'
  const service = services({archiveText, sources: [{url: articleUrl, title}]})
  const output = await getCloudHltvBriefing(service)
  assert.match(output, /Team A beats Team B/)
  assert.doesNotMatch(output, /最新新闻/)
  assert.ok(service.calls[1][1].query.includes(earlier))
  assert.equal(service.calls.filter(c => c[0] === 'search').length, 1)
})

test('rejects a mismatched article date', async () => {
  const page = '# ' + title + '\n\n01-01-2000 00:00\n\nOld report'
  await assert.rejects(getCloudHltvBriefing(services({page})), /日期/)
})


test('normalizes the live-updates column into an event query and still checks archive titles', async () => {
  const liveTitle = 'Live updates from PGL Masters Bucharest quarter-finals'
  const indexedTitle = 'PGL Masters Bucharest bracket set'
  const archiveText = '# News\n\n' + liveTitle + '\n\n' + iso + '\n\n1 comments\n\n' + indexedTitle + '\n\n' + iso + '\n\n3 comments'
  const indexedUrl = 'https://www.hltv.org/news/12346/pgl-masters-bracket-set'
  const page = '# ' + indexedTitle + '\n\n' + articleDate + ' 02:47\n\nThe bracket has been set.'
  const service = services({archiveText, sources: [{url: indexedUrl, title: indexedTitle}], page})
  const output = await getCloudHltvBriefing(service)
  assert.equal(service.calls[1][1].query, 'site:hltv.org/news PGL Masters Bucharest ' + year + ' ' + monthName)
  assert.match(output, /PGL Masters Bucharest bracket set/)
})

test('does not treat video comments as article content', async () => {
  const service = services({page: '# Player profile\n\nComments\n\nGreat video!'})
  await assert.rejects(getCloudHltvBriefing(service), /标题|格式/)
})


test('rejects a page whose title and date are followed only by comments', async () => {
  for (const heading of ['Comments', '## Comments']) {
    const page = '# ' + title + '\n\n' + articleDate + ' 02:47\n\n' + heading + '\n\nGreat video!'
    await assert.rejects(getCloudHltvBriefing(services({page})), /正文/)
  }
})


test('excludes comments after a verified article paragraph', async () => {
  const page = article + '\n\n## Comments\n\nA reader comment that is not news.'
  const output = await getCloudHltvBriefing(services({page}))
  assert.match(output, /Team A defeated Team B/)
  assert.doesNotMatch(output, /A reader comment/)
})
