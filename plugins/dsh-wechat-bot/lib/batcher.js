// Collects a burst of incoming messages into one batch.
// A batch closes after `quietMs` without new messages, or `maxWaitMs` after its
// first message, or immediately once it reaches `maxMessages` / `maxChars`.
// While the consumer is busy, messages keep accumulating and are delivered
// together once it calls `release()`.
//
// At most `maxMessages` messages ever wait: under a flood the oldest are
// handed to `onOverflow` (they stay in the conversation as context) so the
// bot always answers the newest messages and memory stays bounded.
//
// Urgent messages (commands handed to the model) skip the line: they form
// their own batch as soon as the consumer is free, and cut short any defer.
const URGENT_LIMIT = 5

export class Batcher {
  #pending = []
  #urgent = []
  #deferred = false
  #arrived = 0
  #firstAt = 0
  #quietTimer
  #maxTimer
  #deferTimer
  #busy = false

  constructor({ quietMs = 2000, maxWaitMs = 8000, maxMessages = 20, maxChars = 6000 }, onBatch, onOverflow = () => {}) {
    Object.assign(this, { quietMs, maxWaitMs, maxMessages, maxChars })
    this.onBatch = onBatch
    this.onOverflow = onOverflow
  }

  get size() {
    return this.#pending.length
  }

  get busy() {
    return this.#busy
  }

  get urgentSize() {
    return this.#urgent.length
  }

  // Messages pushed since the consumer last took a batch or was held (excludes leftover backlog).
  get arrived() {
    return this.#arrived
  }

  push(message) {
    if (!this.#pending.length) this.#firstAt = Date.now()
    this.#pending.push(message)
    this.#arrived++
    this.#cap()
    if (this.#busy) return
    if (this.#full()) return this.#flush()
    this.#arm()
  }

  pushUrgent(message, { front = false } = {}) {
    if (front) this.#urgent.unshift(message)
    else this.#urgent.push(message)
    while (this.#urgent.length > URGENT_LIMIT) this.onOverflow(this.#urgent.shift())
    if (this.#deferred) return this.release()
    if (!this.#busy) this.#flush()
  }

  // Put an unprocessed batch back in front (e.g. it has to wait for the rate limit).
  requeue(messages) {
    if (!this.#pending.length) this.#firstAt = Date.now()
    this.#pending.unshift(...messages)
    this.#cap()
  }

  // Mark the consumer busy with work that did not come from a batch (e.g. an idle check).
  hold() {
    this.#disarm()
    this.#arrived = 0
    this.#busy = true
  }

  // Called by the consumer when it can accept the next batch.
  release() {
    clearTimeout(this.#deferTimer)
    this.#busy = false
    this.#deferred = false
    if (this.#urgent.length) return this.#flush()
    if (!this.#pending.length) return
    if (this.#full()) return this.#flush()
    this.#arm()
  }

  // Stay busy for `ms`, then release (messages keep accumulating meanwhile).
  defer(ms) {
    clearTimeout(this.#deferTimer)
    this.#busy = true
    this.#deferred = true
    this.#deferTimer = setTimeout(() => this.release(), ms)
    this.#deferTimer.unref?.()
  }

  clear() {
    this.#disarm()
    clearTimeout(this.#deferTimer)
    this.#pending = []
    this.#urgent = []
  }

  #cap() {
    while (this.#pending.length > this.maxMessages) this.onOverflow(this.#pending.shift())
  }

  #full() {
    let chars = 0
    for (const message of this.#pending) chars += message.text.length
    return this.#pending.length >= this.maxMessages || chars >= this.maxChars
  }

  #arm() {
    clearTimeout(this.#quietTimer)
    this.#quietTimer = setTimeout(() => this.#flush(), this.quietMs)
    if (!this.#maxTimer) {
      const remaining = Math.max(0, this.#firstAt + this.maxWaitMs - Date.now())
      this.#maxTimer = setTimeout(() => this.#flush(), remaining)
    }
  }

  #disarm() {
    clearTimeout(this.#quietTimer)
    clearTimeout(this.#maxTimer)
    this.#quietTimer = this.#maxTimer = undefined
  }

  #take() {
    const batch = []
    let chars = 0
    while (this.#pending.length && batch.length < this.maxMessages) {
      const next = this.#pending[0]
      if (batch.length && chars + next.text.length > this.maxChars) break
      batch.push(this.#pending.shift())
      chars += next.text.length
    }
    this.#firstAt = Date.now()
    this.#arrived = 0
    return batch
  }

  #flush() {
    if (this.#busy) return
    if (this.#urgent.length) {
      this.#busy = true
      return this.onBatch(this.#urgent.splice(0))
    }
    this.#disarm()
    if (!this.#pending.length) return
    this.#busy = true
    this.onBatch(this.#take())
  }
}
