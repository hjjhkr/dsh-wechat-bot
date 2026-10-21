// Collects a burst of incoming messages into one batch.
// A batch closes after `quietMs` without new messages, or `maxWaitMs` after its
// first message, or immediately once it reaches `maxMessages` / `maxChars`.
// While the consumer is busy, messages keep accumulating and are delivered
// together once it calls `release()`.
export class Batcher {
  #pending = []
  #firstAt = 0
  #quietTimer
  #maxTimer
  #busy = false

  constructor({ quietMs = 2000, maxWaitMs = 8000, maxMessages = 20, maxChars = 6000 }, onBatch) {
    Object.assign(this, { quietMs, maxWaitMs, maxMessages, maxChars })
    this.onBatch = onBatch
  }

  get size() {
    return this.#pending.length
  }

  get busy() {
    return this.#busy
  }

  push(message) {
    if (!this.#pending.length) this.#firstAt = Date.now()
    this.#pending.push(message)
    if (this.#busy) return
    if (this.#full()) return this.#flush()
    this.#arm()
  }

  // Put an unprocessed batch back in front (e.g. superseded by newer messages).
  requeue(messages) {
    if (!this.#pending.length) this.#firstAt = Date.now()
    this.#pending.unshift(...messages)
  }

  // Mark the consumer busy with work that did not come from a batch (e.g. an idle check).
  hold() {
    this.#disarm()
    this.#busy = true
  }

  // Called by the consumer when it can accept the next batch.
  release() {
    this.#busy = false
    if (!this.#pending.length) return
    if (this.#full()) return this.#flush()
    this.#arm()
  }

  clear() {
    this.#disarm()
    this.#pending = []
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
    return batch
  }

  #flush() {
    this.#disarm()
    if (this.#busy || !this.#pending.length) return
    this.#busy = true
    this.onBatch(this.#take())
  }
}
