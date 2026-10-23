import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryMaintenance, parseCompactionProposal } from '../lib/memory-maintenance.js'

const chat = id => ({ id, name: id, kind: 'group' })

function record(who, automatic = [], manual = '') {
  return { who, version: `${who}-v1`, automatic: automatic.map(([topic, note]) => ({ topic, note })), manual }
}

function createStore(records) {
  const data = new Map(records.map(item => [item.who, structuredClone(item)]))
  return {
    data,
    async listMembers() {
      return [...data.values()].map(item => ({ who: item.who, count: item.automatic.length, version: item.version }))
    },
    async snapshot(who) {
      const item = data.get(who)
      if (!item) return { who, version: null, automatic: [], manual: '' }
      return structuredClone(item)
    },
    async compact(who, proposal, expectedVersion) {
      const item = data.get(who)
      if (!item || item.version !== expectedVersion) {
        const error = new Error('version conflict')
        error.code = 'version_conflict'
        throw error
      }
      const before = item.automatic.length
      item.automatic = proposal.notes.map(({ topic, note }) => ({ topic, note }))
      item.version = `${who}-v${Number(item.version.slice(-1)) + 1}`
      return { who, before, after: item.automatic.length, changed: true, version: item.version }
    },
  }
}

function proposalFor(input) {
  return JSON.stringify({
    who: input.who,
    notes: input.automatic.map(({ topic, note }) => ({ topic, note, sourceTopics: [topic] })),
    discard: [],
  })
}

function modelFromInput(onCall = () => {}) {
  return async request => {
    const text = request.messages.at(-1)?.text
    onCall(request, text)
    return proposalFor(JSON.parse(text))
  }
}

test('automatic compaction fires at 30 once, stays latched at 30, and rearms below threshold', async () => {
  const topics = Array.from({ length: 30 }, (_, index) => [`主题${index}`, `长期事实${index}`])
  const store = createStore([record('alice', topics)])
  let calls = 0
  const maintenance = new MemoryMaintenance({ memoryFor: () => store, think: modelFromInput(() => calls++) })

  await maintenance.observe(chat('room'))
  await maintenance.flush()
  assert.equal(calls, 1)
  assert.equal(maintenance.view('room').results[0].status, 'completed')

  await maintenance.observe(chat('room'))
  await maintenance.flush()
  assert.equal(calls, 1)

  store.data.get('alice').automatic.pop()
  await maintenance.observe(chat('room'))
  await maintenance.flush()
  assert.equal(calls, 1)
  store.data.get('alice').automatic.push({ topic: '新主题', note: '稳定事实' })
  await maintenance.observe(chat('room'))
  await maintenance.flush()
  assert.equal(calls, 2)
  await maintenance.dispose()
})

test('successful automatic compaction below 30 rearms immediately for the next threshold crossing', async () => {
  const topics = Array.from({ length: 30 }, (_, index) => [`主题${index}`, `长期事实${index}`])
  const store = createStore([record('alice', topics)])
  let calls = 0
  const maintenance = new MemoryMaintenance({
    memoryFor: () => store,
    think: async request => {
      const input = JSON.parse(request.messages.at(-1).text)
      calls++
      if (calls === 1) {
        return JSON.stringify({
          who: input.who,
          notes: input.automatic.slice(0, 29).map(({ topic, note }) => ({ topic, note, sourceTopics: [topic] })),
          discard: [{ topic: input.automatic[29].topic, reason: 'duplicate' }],
        })
      }
      return proposalFor(input)
    },
  })

  await maintenance.observe(chat('room'))
  await maintenance.whenIdle()
  assert.equal(store.data.get('alice').automatic.length, 29)
  assert.equal(calls, 1)
  await maintenance.observe(chat('room'))
  await maintenance.whenIdle()
  assert.equal(calls, 1)
  store.data.get('alice').automatic.push({ topic: '新主题', note: '新增的稳定事实' })
  await maintenance.observe(chat('room'))
  await maintenance.whenIdle()
  assert.equal(calls, 2)
  await maintenance.dispose()
})

test('manual compaction visits every member sequentially and skips manual-only ids without a model call', async () => {
  const store = createStore([
    record('alice', [['偏好', '喜欢简洁回答']]),
    record('manual-only', [], '始终保留的人工说明'),
    record('bob', [['兴趣', '长期喜欢骑行']]),
  ])
  let inFlight = 0
  let maxInFlight = 0
  const seen = []
  const events = []
  const maintenance = new MemoryMaintenance({
    memoryFor: () => store,
    think: async request => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const text = request.messages.at(-1)?.text
      const input = JSON.parse(text)
      seen.push({ input, request })
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return proposalFor(input)
    },
    onEvent: event => events.push(event),
  })

  await maintenance.start(chat('room'))
  await maintenance.flush()
  assert.deepEqual(seen.map(item => item.input.who), ['alice', 'bob'])
  assert.equal(seen[0].input.automatic[0].topic, '偏好')
  assert.equal(seen[0].input.manual, '')
  assert.equal(seen[0].request.effort, 'max')
  assert.equal(maxInFlight, 1)
  assert.equal(maintenance.view('room').completed, 3)
  assert.deepEqual(maintenance.view('room').results.map(item => item.status), ['completed', 'skipped', 'completed'])
  assert.equal(events.length, 3)
  assert.ok(events.every(event => event.type === 'result' && event.chatId === 'room' && event.trigger === 'manual'))
  assert.equal(events[1].result.who, 'manual-only')
  assert.equal(events[1].result.status, 'skipped')
  await maintenance.dispose()
})

test('a successful manual pass at 30 latches automatic compaction for that member', async () => {
  const topics = Array.from({ length: 30 }, (_, index) => [`主题${index}`, `长期事实${index}`])
  const store = createStore([record('alice', topics)])
  let calls = 0
  const maintenance = new MemoryMaintenance({ memoryFor: () => store, think: modelFromInput(() => calls++) })

  await maintenance.start(chat('room'))
  await maintenance.whenIdle()
  assert.equal(calls, 1)
  await maintenance.observe(chat('room'))
  await maintenance.whenIdle()
  assert.equal(calls, 1)
  await maintenance.dispose()
})

test('CAS conflict is reported without retry and does not block the next member', async () => {
  const store = createStore([
    record('alice', [['偏好', '喜欢简洁回答']]),
    record('bob', [['兴趣', '喜欢骑行']]),
  ])
  const compact = store.compact.bind(store)
  store.compact = async (who, proposal, version) => {
    if (who === 'alice') {
      const error = new Error('version conflict')
      error.code = 'version_conflict'
      throw error
    }
    return compact(who, proposal, version)
  }
  const calls = []
  const maintenance = new MemoryMaintenance({
    memoryFor: () => store,
    think: async request => {
      const input = JSON.parse(request.messages.at(-1).text)
      calls.push(input.who)
      return proposalFor(input)
    },
  })

  await maintenance.start(chat('room'))
  await maintenance.flush()
  assert.deepEqual(calls, ['alice', 'bob'])
  assert.deepEqual(maintenance.view('room').results.map(item => item.status), ['failed', 'completed'])
  assert.equal(maintenance.view('room').results[0].error, 'version_conflict')
  await maintenance.dispose()
})

test('uncoded model/configuration failures retain a bounded human-readable error', async () => {
  const store = createStore([record('alice', [['偏好', '喜欢简洁回答']])])
  const message = '模型不支持 max：' + 'x'.repeat(600)
  const maintenance = new MemoryMaintenance({
    memoryFor: () => store,
    think: async () => { throw new Error(message) },
  })

  await maintenance.start(chat('room'))
  await maintenance.whenIdle()
  const result = maintenance.view('room').results[0]
  assert.equal(result.error, message.slice(0, 500))
  assert.equal(result.errorCode, 'compaction_failed')
  await maintenance.dispose()
})

test('a manual task reserves its chat immediately, while another chat remains independent', async () => {
  const stores = new Map([
    ['room-a', createStore([record('alice', [['偏好', '喜欢简洁回答']])])],
    ['room-b', createStore([record('bob', [['兴趣', '喜欢骑行']])])],
  ])
  const releases = new Map()
  const maintenance = new MemoryMaintenance({
    memoryFor: id => stores.get(id),
    think: request => new Promise(resolve => {
      const input = JSON.parse(request.messages.at(-1).text)
      releases.set(input.who, () => resolve(proposalFor(input)))
    }),
  })

  await maintenance.start(chat('room-a'))
  await assert.rejects(maintenance.start(chat('room-a')), error => error.code === 'busy')
  await maintenance.start(chat('room-b'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(releases.size, 2)
  releases.get('alice')()
  releases.get('bob')()
  await maintenance.flush()
  await maintenance.dispose()
})

test('an automatic threshold reached while a chat is busy is rechecked after the current run', async () => {
  const store = createStore([record('alice', [['偏好', '喜欢简洁回答']])])
  let releaseAlice
  const calls = []
  const maintenance = new MemoryMaintenance({
    memoryFor: () => store,
    think: async request => {
      const input = JSON.parse(request.messages.at(-1).text)
      calls.push(input.who)
      if (input.who === 'alice') await new Promise(resolve => { releaseAlice = resolve })
      return proposalFor(input)
    },
  })

  await maintenance.start(chat('room'))
  await new Promise(resolve => setImmediate(resolve))
  const bobNotes = Array.from({ length: 30 }, (_, index) => ({ topic: `B${index}`, note: `长期事实${index}` }))
  store.data.set('bob', { who: 'bob', version: 'bob-v1', automatic: bobNotes, manual: '' })
  assert.deepEqual(await maintenance.observe(chat('room')), { enqueued: false, reason: 'busy' })
  releaseAlice()
  await maintenance.whenIdle()
  assert.deepEqual(calls, ['alice', 'bob'])
  assert.equal(maintenance.view('room').trigger, 'automatic')
  await maintenance.dispose()
})

test('dispose aborts the current call, skips the rest, and waits until no model call can write', async () => {
  const store = createStore([
    record('alice', [['偏好', '喜欢简洁回答']]),
    record('bob', [['兴趣', '喜欢骑行']]),
  ])
  let receivedSignal
  let calls = 0
  const maintenance = new MemoryMaintenance({
    memoryFor: () => store,
    think: request => {
      calls++
      receivedSignal = request.signal
      return new Promise(() => {})
    },
  })

  await maintenance.start(chat('room'))
  await new Promise(resolve => setImmediate(resolve))
  await maintenance.dispose()
  assert.equal(receivedSignal.aborted, true)
  assert.equal(calls, 1)
  assert.equal(maintenance.view('room').running, false)
  assert.deepEqual(maintenance.view('room').results.map(item => item.status), ['skipped', 'skipped'])
  assert.deepEqual(maintenance.view('room').results.map(item => item.reason), ['cancelled', 'cancelled'])
})

test('timeout fails only the timed-out member and continues to the next id', async () => {
  const store = createStore([
    record('alice', [['偏好', '喜欢简洁回答']]),
    record('bob', [['兴趣', '喜欢骑行']]),
  ])
  const calls = []
  const maintenance = new MemoryMaintenance({
    memoryFor: () => store,
    timeoutMs: 10,
    think: async request => {
      const input = JSON.parse(request.messages.at(-1).text)
      calls.push(input.who)
      if (input.who === 'alice') return new Promise(() => {})
      return proposalFor(input)
    },
  })

  await maintenance.start(chat('room'))
  await maintenance.flush()
  assert.deepEqual(calls, ['alice', 'bob'])
  assert.equal(maintenance.view('room').results[0].error, 'timeout')
  assert.equal(maintenance.view('room').results[1].status, 'completed')
  await maintenance.dispose()
})

test('compaction parser requires complete source coverage while allowing a source-backed normalized title', () => {
  const snapshot = { who: 'alice', version: 'a'.repeat(64), manual: '', automatic: [
    { topic: '游戏', note: '喜欢策略游戏' },
    { topic: '工作', note: '从事设计' },
  ] }
  const valid = {
    who: 'alice',
    notes: [{ topic: '游戏', note: '喜欢策略游戏，也玩合作模式', sourceTopics: ['游戏'] }],
    discard: [{ topic: '工作', reason: 'outdated' }],
  }
  assert.deepEqual(parseCompactionProposal(JSON.stringify(valid), snapshot), valid)
  const normalized = {
    who: 'alice',
    notes: [{ topic: '策略与设计', note: '喜欢策略游戏，也从事设计', sourceTopics: ['游戏', '工作'] }],
    discard: [],
  }
  assert.deepEqual(parseCompactionProposal(JSON.stringify(normalized), snapshot), normalized)
  assert.throws(() => parseCompactionProposal(JSON.stringify({ ...valid, who: 'bob' }), snapshot), error => error.code === 'compaction_who_mismatch')
  assert.throws(() => parseCompactionProposal(JSON.stringify({ ...valid, discard: [] }), snapshot), error => error.code === 'compaction_source_coverage_incomplete')
  assert.throws(() => parseCompactionProposal(JSON.stringify({
    who: 'alice', notes: [
      { topic: '游戏', note: '喜欢策略游戏', sourceTopics: ['游戏'] },
      { topic: '工作', note: '从事设计', sourceTopics: ['游戏'] },
    ], discard: [{ topic: '工作', reason: 'outdated' }],
  }), snapshot), error => error.code === 'compaction_source_overlap')
  assert.throws(() => parseCompactionProposal(JSON.stringify({
    who: 'alice', notes: [{ topic: '策略', note: '喜欢策略游戏', sourceTopics: ['陌生来源'] }],
    discard: [{ topic: '工作', reason: 'outdated' }],
  }), snapshot), error => error.code === 'compaction_source_unknown')
  assert.throws(() => parseCompactionProposal('```json\n' + JSON.stringify(valid) + '\n```', snapshot), error => error.code === 'compaction_response_not_json')
})
