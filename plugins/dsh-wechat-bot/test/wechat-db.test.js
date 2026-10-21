// End to end with the real database adapter (adapters/wechat-db): a message row
// written into a WeChat-shaped database comes out as a reply in the outbox JSON.
// Needs Python with `zstandard`: WECHAT_DB_PYTHON=path/to/python node --test test/wechat-db.test.js
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnAdapter } from '../lib/adapter.js'
import { Bot } from '../lib/bot.js'
import { Store } from '../lib/store.js'
import { scriptedModel, until } from './helpers.js'

const python = process.env.WECHAT_DB_PYTHON
const adapterDir = fileURLToPath(new URL('../../../adapters/wechat-db/', import.meta.url))
const GROUP = '12345678@chatroom'

// Runs a snippet against tests/fixtures.py to create or extend the fake account.
function fixture(root, code) {
  execFileSync(python, ['-c', `import sys; sys.path.insert(0, 'tests')\nfrom fixtures import *\nfrom pathlib import Path\n${code}`], {
    cwd: adapterDir, env: { ...process.env, ROOT: root, PYTHONIOENCODING: 'utf-8' },
  })
}

test('a message in the database becomes a reply in the outbox', { skip: !python && 'set WECHAT_DB_PYTHON to run' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-db-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  const root = join(dir, 'db_storage')
  const outbox = join(dir, 'outbox.jsonl')
  fixture(root, `a = Account(Path(__import__('os').environ['ROOT'])); a.add(GROUP, 'wxid_alice', '旧消息')`)

  const model = scriptedModel(input => {
    const target = input.new.findLast(m => m.addressed === 'you')
    return target ? { to: target.id, reply: [`收到：${target.text}`] } : { reply: [] }
  })
  const bot = new Bot({
    dataDir: dir, persona: '你是小鲸鱼。', store: new Store(dir, { delayMs: 5 }), think: model.think,
    settings: { mode: 'infer', quietMs: 50, maxWaitMs: 200, typingDelay: false, aliases: ['小鲸鱼'] },
    createAdapter: () => spawnAdapter({
      command: python, args: ['-u', join(adapterDir, 'main.py'), '--plain', root, '--self', 'wxid_bot', '--poll-ms', '100', '--outbox', outbox],
    }),
  })
  t.after(() => bot.dispose())
  await bot.start()
  await until(() => bot.ready, { timeoutMs: 10_000, what: 'adapter ready' })
  await bot.setChat(GROUP)
  assert.ok(bot.runner.transcript.some(m => m.text === '旧消息'), 'history primes the context')

  fixture(root, `
a = Account.__new__(Account); a.root = Path(__import__('os').environ['ROOT']); a.seq = 5000; a.server_id = 9_500_000
a.shards = [a.root / 'message' / 'message_0.db', a.root / 'message' / 'message_1.db']
a.add(GROUP, 'wxid_bob', '今天好热')
a.add(GROUP, 'wxid_alice', '@小鲸鱼 你热吗', source=at_source(BOT))`)

  await until(async () => (await readFile(outbox, 'utf8').catch(() => '')).includes('收到'), { timeoutMs: 10_000, what: 'reply in outbox' })
  const [entry] = (await readFile(outbox, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(entry.chatId, GROUP)
  assert.deepEqual(entry.content, { kind: 'text', text: '收到：@小鲸鱼 你热吗', mentions: [] })
  // Under load the two rows may arrive in one batch or two; either way each is judged correctly.
  const judged = Object.fromEntries(model.calls.flatMap(c => c.input.new.map(m => [m.text, m.addressed])))
  assert.equal(judged['@小鲸鱼 你热吗'], 'you')
  if (judged['今天好热']) assert.equal(judged['今天好热'], 'none')
})
