import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelControl, ModelError } from '../lib/models.js'
import { startBot, until } from './helpers.js'

// A host model catalog: two providers, models with different reasoning support.
const CATALOG = {
  'deepseek-account': [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['off', 'high'] },
    { id: 'deepseek-pro', name: 'DeepSeek Pro', efforts: ['off', 'low', 'high', 'max'] },
  ],
  other: [
    { id: 'deepseek-flash', name: 'Mirror Flash', efforts: [] },
    { id: 'tiny', name: 'Tiny', efforts: [] },
  ],
  broken: null,
}

const fakeLlm = {
  listProviders: () => Object.keys(CATALOG).map(id => ({ id })),
  async listModels(provider) {
    if (!CATALOG[provider]) throw new Error('no credentials')
    return CATALOG[provider].map(m => ({ provider, id: m.id, name: m.name }))
  },
  async resolveModelInfo(provider, model) {
    const found = CATALOG[provider]?.find(m => m.id === model)
    if (!found) throw new Error('unknown model')
    return { provider, id: model, name: found.name, ...(found.efforts.length ? { reasoning: { efforts: found.efforts.map(id => ({ id })) } } : {}) }
  },
}

function control(override) {
  const saved = []
  const models = new ModelControl({
    llm: fakeLlm, base: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' }),
    override, save: async value => saved.push(value),
  })
  return { models, saved }
}

test('switching models and thinking is validated against the host catalog', async () => {
  const { models, saved } = control()
  assert.deepEqual(models.current(), { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off', overridden: false })
  assert.deepEqual((await models.catalog()).map(m => m.id), ['deepseek-flash', 'deepseek-pro', 'deepseek-flash', 'tiny'], 'a provider that fails contributes nothing')

  await models.setEffort('high')
  assert.equal(models.current().reasoningEffort, 'high')
  await assert.rejects(models.setEffort('max'), e => e instanceof ModelError && /不支持思考强度 max/.test(e.message))
  await assert.rejects(models.setEffort('extreme'), /只能是/)

  const pro = await models.useModel('deepseek pro')
  assert.equal(pro.model, 'deepseek-pro', 'names match case-insensitively')
  assert.equal(pro.reasoningEffort, 'high', 'the effort carries over when supported')

  await assert.rejects(models.useModel('deepseek-flash'), /有多个/, 'ambiguous ids need a provider')
  const tiny = await models.useModel('other/tiny')
  assert.equal(tiny.reasoningEffort, 'off')
  assert.equal(tiny.adjusted, 'high', 'reports that thinking had to be turned off')
  await assert.rejects(models.useModel('gpt-9'), /没有模型「gpt-9」/)

  assert.deepEqual(await models.reset(), { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off', overridden: false })
  assert.equal(saved.length, 4, 'every successful change is persisted, failed ones are not')
})

test('a persisted override is restored, and /ask efforts degrade on models without them', async () => {
  const { models } = control({ provider: 'other', model: 'tiny', reasoningEffort: 'off' })
  assert.equal(models.current().model, 'tiny')
  assert.equal(await models.supports('high'), false)
  await models.reset()
  assert.equal(await models.supports('high'), true)
})

test('/model and /think from the chat', async t => {
  const { models } = control()
  const env = await startBot(t, { models })
  await until(() => env.bot.ready)
  await env.bot.setChat('demo@chatroom')
  const sent = () => env.simulator.messages.get('demo@chatroom').filter(m => m.fromSelf).map(m => m.text)
  const say = text => env.simulator.inject({ chatId: 'demo@chatroom', from: 'wxid_alice', text })

  say('/model')
  await until(() => sent().length === 1)
  assert.match(sent()[0], /当前：deepseek-account\/deepseek-flash，思考 off（配置默认）\n可用：\[deepseek-flash\]、deepseek-pro/)
  say('/model deepseek-pro')
  await until(() => sent().length === 2)
  assert.equal(sent()[1], '已执行：切换为 deepseek-account/deepseek-pro，思考 off')
  say('/think max')
  await until(() => sent().length === 3)
  assert.equal(sent()[2], '已执行：思考强度 max')
  say('/思考 关')
  await until(() => sent().length === 4)
  assert.equal(sent()[3], '已执行：思考强度 off')
  say('/model gpt-9')
  await until(() => sent().length === 5)
  assert.match(sent()[4], /^没改成：没有模型「gpt-9」/)
  say('/model reset')
  await until(() => sent().length === 6)
  assert.match(sent()[5], /^已执行：恢复配置默认 deepseek-account\/deepseek-flash/)
})
