// The group's member list as the adapter reports it right now (ids with their
// current names), cached for a few seconds. One lookup runs at a time; a reply
// waits for it only when there is no list yet (bounded by a deadline), otherwise
// a stale list is refreshed in the background and the last complete one is used.
import { withDeadline } from './guard.js'

export class MemberRoster {
  #pending
  #timedOut

  /**
   * @param {object} o
   * @param {() => Promise<{id, name, aliases?}[]>} o.fetch  the adapter's chats/members
   * @param {number} o.ttlMs       how long a list counts as current
   * @param {number} o.timeoutMs   how long a caller waits for a missing list
   * @param {AbortSignal} o.signal  ends waiting when the chat is disposed
   * @param {() => void} o.onChange
   * @param {(type: string, payload: object) => void} o.onNotice
   * @param {{members?, at?}} [o.state]  a list saved by an earlier run
   */
  constructor({ fetch, ttlMs, timeoutMs, signal, onChange = () => {}, onNotice = () => {}, state = {} }) {
    Object.assign(this, { fetch, ttlMs, timeoutMs, signal, onChange, onNotice })
    this.members = Array.isArray(state.members) ? state.members : undefined
    this.at = state.at ?? 0
  }

  get refreshing() {
    return Boolean(this.#pending)
  }

  view() {
    return { count: this.members?.length ?? 0, refreshedAt: this.at, refreshing: this.refreshing }
  }

  toJSON() {
    return { members: this.members, at: this.at }
  }

  // `fresh`: the caller needs the latest names now (e.g. /attack looking someone up).
  async list({ fresh = false } = {}) {
    const stale = !this.members || Date.now() - this.at >= this.ttlMs
    if (!this.#pending && (fresh || stale)) this.#start()
    const pending = this.#pending
    // Wait only when there is nothing to show (or freshness was asked for), and never
    // again for a request that already missed one deadline: it may never return.
    if (pending && (fresh || !this.members) && this.#timedOut !== pending) {
      try {
        await withDeadline(() => pending, this.timeoutMs, this.signal)
      } catch {
        if (this.#pending === pending) {
          this.#timedOut = pending
          if (!this.members && !this.signal.aborted) this.onNotice('members_pending', {})
        }
      }
    }
    return this.members ?? []
  }

  #start() {
    const pending = this.#pending = Promise.resolve()
      .then(() => this.fetch())
      .then(members => {
        if (this.signal.aborted) return
        this.members = members
        this.at = Date.now()
        this.onChange()
      }, error => {
        if (!this.signal.aborted) this.onNotice('members_unavailable', { code: error.code ?? error.name })
      })
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined
        if (this.#timedOut === pending) this.#timedOut = undefined
      })
  }
}
