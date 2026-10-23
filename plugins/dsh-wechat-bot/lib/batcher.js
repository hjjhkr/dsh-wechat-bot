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

  constructor({ quietMs = 3000, maxWaitMs = 8000, maxMessages = 20, maxChars = 6000 }, onBatch, onOverflow = () => {}) {
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

  // The messages waiting for the next batch (a copy).
  peek() {
    return [...this.#pending]
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
  // Requeued messages were already due; under a flood the newer waiting ones overflow instead.
  requeue(messages) {
    if (!this.#pending.length) this.#firstAt = Date.now()
    this.#pending.unshift(...messages)
    this.#cap(messages.length)
  }

  // Whether these messages would make up a single batch (count and size limits).
  fits(messages) {
    let chars = 0
    for (const message of messages) chars += message.text.length
    return messages.length <= this.maxMessages && chars <= this.maxChars
  }

  // Changes the timing; a batch already collecting is re-timed (its max wait still counts from its first message).
  retime({ quietMs, maxWaitMs }) {
    Object.assign(this, { quietMs, maxWaitMs })
    if (this.#quietTimer || this.#maxTimer) {
      this.#disarm()
      if (this.#pending.length && !this.#busy) this.#full() ? this.#flush() : this.#arm()
    }
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

  // Keeps at most maxMessages waiting; the oldest go to onOverflow, except the first `keep`.
  #cap(keep = 0) {
    while (this.#pending.length > this.maxMessages) {
      const index = this.#pending.length > keep ? Math.min(keep, this.#pending.length - 1) : 0
      this.onOverflow(this.#pending.splice(index, 1)[0])
    }
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
      this.#disarm() // re-armed on release; #firstAt keeps the pending batch's max wait honest
      this.#busy = true
      return this.onBatch(this.#urgent.splice(0))
    }
    this.#disarm()
    if (!this.#pending.length) return
    this.#busy = true
    this.onBatch(this.#take())
  }
}
