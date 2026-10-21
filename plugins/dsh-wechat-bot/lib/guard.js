// Guardrails that keep one chat healthy under load and through failures.

// At most `limit` events in any sliding `windowMs`.
export class RateWindow {
  #times = []

  constructor(limit, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
  }

  #prune(now) {
    while (this.#times.length && now - this.#times[0] >= this.windowMs) this.#times.shift()
  }

  // Milliseconds until another event is allowed (0 = now).
  wait(now = Date.now()) {
    this.#prune(now)
    return this.#times.length < this.limit ? 0 : this.#times[0] + this.windowMs - now
  }

  record(now = Date.now()) {
    this.#times.push(now)
  }

  get used() {
    this.#prune(Date.now())
    return this.#times.length
  }
}

// Opens after `threshold` consecutive failures and stays open for a cool-down
// that doubles on every trip (up to `maxMs`). The first call after the
// cool-down is a trial: success closes it, failure re-opens it for longer.
export class CircuitBreaker {
  failures = 0
  trips = 0
  openUntil = 0

  constructor({ threshold = 3, baseMs = 30_000, maxMs = 10 * 60_000 } = {}) {
    Object.assign(this, { threshold, baseMs, maxMs })
  }

  // Milliseconds until calls are allowed again (0 = closed or ready for a trial).
  wait(now = Date.now()) {
    return Math.max(0, this.openUntil - now)
  }

  success() {
    this.failures = 0
    this.trips = 0
  }

  // Returns the cool-down in ms when this failure opened the breaker.
  failure(now = Date.now()) {
    this.failures++
    if (this.failures < this.threshold && !(this.trips && this.openUntil)) return 0
    const coolDown = Math.min(this.baseMs * 2 ** this.trips, this.maxMs)
    this.openUntil = now + coolDown
    this.trips++
    this.failures = 0
    return coolDown
  }

  view(now = Date.now()) {
    return { open: this.wait(now) > 0, until: this.openUntil, trips: this.trips, failures: this.failures }
  }
}

export class TimeoutError extends Error {
  constructor(ms) {
    super(`timed out after ${ms}ms`)
    this.name = 'TimeoutError'
    this.code = 'timeout'
  }
}

// Runs `call(signal)` with a deadline. The signal is aborted on timeout and the
// returned promise rejects even if `call` ignores the signal and never settles.
export async function withDeadline(call, ms, parent) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  parent?.addEventListener('abort', abort, { once: true })
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(ms)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  try {
    return await Promise.race([call(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
  }
}
