import assert from 'node:assert/strict'
import test from 'node:test'
import { SCENARIOS, formatEval, runEval } from '../lib/eval.js'

const inputOf = messages => JSON.parse(messages[0].text)

// Answers exactly what the deterministic addressing signals suggest.
const oracle = async ({ messages }) => {
  const input = inputOf(messages)
  const target = input.new.findLast(m => m.addressed === 'you' || m.addressed === 'maybe')
  return JSON.stringify(target ? { to: target.id, reply: ['嗯'] } : { reply: [] })
}

test('the suite rewards a model that follows the addressing signals', async () => {
  const [report] = await runEval({ think: oracle, persona: '', settings: { typingDelay: false } })
  const failed = report.results.filter(r => !r.ok)
  assert.deepEqual(failed.map(r => `${r.name}: ${r.problems}`), [])
  assert.equal(report.valid, SCENARIOS.length)
})

test('the suite catches a model that answers everything, and invalid output', async () => {
  const chatty = async ({ messages }) => JSON.stringify({ to: inputOf(messages).new[0].id, reply: ['我来了'] })
  const [report] = await runEval({ think: chatty, persona: '', settings: { typingDelay: false } })
  const names = report.results.filter(r => !r.ok).map(r => r.name)
  assert.ok(names.includes('两个群友互相 @'))
  assert.ok(names.includes('一批里只有最后一条在找它'), 'wrong target is detected')

  const broken = await runEval({ think: async () => '不是 JSON', persona: '', efforts: ['off', 'high'] })
  assert.equal(broken.length, 2)
  assert.equal(broken[0].valid, 0)
  assert.match(formatEval(broken), /思考强度 high：通过 0\//)
})

test('each effort level is passed through to the model', async () => {
  const seen = new Set()
  await runEval({ think: async args => { seen.add(args.effort); return '{"reply":["好"]}' }, persona: '', efforts: ['off', 'high'], scenarios: SCENARIOS.slice(0, 1) })
  assert.deepEqual([...seen], ['off', 'high'])
})
