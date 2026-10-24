// Exits DSH after the last browser page closes (config exitWithPage).
// Every open page holds an event stream on /api/wechat-bot.page-lifetime. When the last one
// ends and none comes back within `graceMs`, the bot is shut down first — work in progress,
// such as a reply part being typed into WeChat, finishes — and then the host is asked to exit.
// (The host gives plugins only a few seconds to clean up, too little for a send in progress.)
// A failed shutdown is logged; the exit happens anyway, since the page is gone.
const encode = text => new TextEncoder().encode(text)

export class PageLifetime {
  #pages = new Set()
  #timer
  #exiting = false

  /**
   * @param {object} o
   * @param {boolean} o.enabled
   * @param {(code: number) => void} [o.exit]      the host's appExit
   * @param {() => Promise<void>} [o.shutdown]     stops the bot
   * @param {(error: Error) => void} [o.onError]
   */
  constructor({ enabled = false, exit, shutdown, onError = () => {}, graceMs = 5000, heartbeatMs = 15_000 }) {
    Object.assign(this, { enabled: enabled && typeof exit === 'function', exit, shutdown, onError, graceMs, heartbeatMs })
  }

  view() {
    return { enabled: this.enabled, pages: this.#pages.size, exiting: this.#exiting }
  }

  // An event stream that stays open while the page does.
  handle(request) {
    let page
    const body = new ReadableStream({
      start: controller => {
        page = { controller, heartbeat: setInterval(() => controller.enqueue(encode(': keep-alive\n\n')), this.heartbeatMs) }
        this.#pages.add(page)
        clearTimeout(this.#timer)
        request.signal?.addEventListener('abort', () => this.#close(page), { once: true })
        controller.enqueue(encode('retry: 1000\n\n'))
      },
      cancel: () => this.#close(page),
    })
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    })
  }

  dispose() {
    this.enabled = false
    clearTimeout(this.#timer)
    for (const page of this.#pages) {
      clearInterval(page.heartbeat)
      page.controller.close()
    }
    this.#pages.clear()
  }

  #close(page) {
    if (!this.#pages.delete(page)) return
    clearInterval(page.heartbeat)
    if (this.enabled && !this.#pages.size) this.#timer = setTimeout(() => this.#exit(), this.graceMs)
  }

  async #exit() {
    if (this.#pages.size || this.#exiting) return
    this.#exiting = true
    try {
      await this.shutdown?.()
    } catch (error) {
      this.onError(error)
    }
    this.exit(0)
  }
}
