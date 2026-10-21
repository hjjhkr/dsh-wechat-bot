// Which model the bot uses and how hard it thinks, switchable at runtime by
// /model and /think. Every change is validated against the model catalog of
// the host's `llm` service before it takes effect, so the bot can never be
// switched into a configuration whose calls are bound to fail.

export const EFFORTS = Object.freeze(['off', 'low', 'high', 'max'])

export class ModelError extends Error {}

/**
 * @param {object} o
 * @param {object} o.llm            { listProviders(), listModels(provider), resolveModelInfo(provider, model) }
 * @param {() => {provider, model, reasoningEffort}} o.base   the configured default
 * @param {object} [o.override]     a persisted override ({ provider?, model?, reasoningEffort? })
 * @param {(override) => Promise} [o.save]
 */
export class ModelControl {
  constructor({ llm, base, override = {}, save = async () => {} }) {
    Object.assign(this, { llm, base, save })
    this.override = { ...override }
  }

  current() {
    const base = this.base()
    const model = this.override.model ? { provider: this.override.provider, model: this.override.model } : { provider: base.provider, model: base.model }
    return { ...model, reasoningEffort: this.override.reasoningEffort ?? base.reasoningEffort, overridden: Object.keys(this.override).length > 0 }
  }

  async catalog() {
    const models = []
    for (const { id } of this.llm.listProviders()) {
      try {
        for (const model of await this.llm.listModels(id)) models.push({ provider: id, id: model.id, name: model.name })
      } catch {
        // A provider without credentials simply contributes no models.
      }
    }
    return models
  }

  // Reasoning efforts the model accepts; ['off'] when it has no reasoning control.
  async efforts(provider, model) {
    let info
    try {
      info = await this.llm.resolveModelInfo(provider, model)
    } catch (error) {
      throw new ModelError(`用不了 ${provider}/${model}：${error.message}`)
    }
    const ids = info.reasoning?.efforts?.map(e => e.id) ?? []
    return ids.length ? ids : ['off']
  }

  // `ref`: "provider/model", a model id, or a model name (case-insensitive).
  async resolve(ref) {
    const catalog = await this.catalog()
    const lower = ref.toLowerCase()
    const slash = ref.indexOf('/')
    const matches = slash > 0
      ? catalog.filter(m => m.provider === ref.slice(0, slash) && m.id.toLowerCase() === lower.slice(slash + 1))
      : catalog.filter(m => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new ModelError(`「${ref}」有多个：${matches.map(m => `${m.provider}/${m.id}`).join('、')}，请写成 provider/模型`)
    throw new ModelError(`没有模型「${ref}」，可用：${catalog.map(m => m.id).join('、') || '（没有可用模型）'}`)
  }

  // Switches model; keeps the current effort if the new model supports it, else turns thinking off.
  async useModel(ref) {
    const target = await this.resolve(ref)
    const efforts = await this.efforts(target.provider, target.id)
    const wanted = this.current().reasoningEffort
    const reasoningEffort = efforts.includes(wanted) ? wanted : efforts.includes('off') ? 'off' : efforts[0]
    await this.#apply({ provider: target.provider, model: target.id, reasoningEffort })
    return { ...this.current(), adjusted: reasoningEffort !== wanted ? wanted : undefined }
  }

  // Whether the current model accepts `effort` (used to soften /ask's "high" on models without it).
  async supports(effort) {
    const { provider, model } = this.current()
    const key = `${provider}/${model}`
    if (this.supported?.key !== key) this.supported = { key, efforts: await this.efforts(provider, model).catch(() => []) }
    return this.supported.efforts.includes(effort)
  }

  async setEffort(effort) {
    if (!EFFORTS.includes(effort)) throw new ModelError(`思考强度只能是 ${EFFORTS.join(' / ')}`)
    const { provider, model } = this.current()
    const efforts = await this.efforts(provider, model)
    if (!efforts.includes(effort)) throw new ModelError(`${model} 不支持思考强度 ${effort}，可选：${efforts.join(' / ')}`)
    await this.#apply({ ...this.override, reasoningEffort: effort })
    return this.current()
  }

  async reset() {
    await this.#apply({})
    return this.current()
  }

  async #apply(override) {
    this.override = override
    await this.save(override)
  }
}
