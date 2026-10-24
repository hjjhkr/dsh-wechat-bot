// The persona library: a folder of Markdown files, one persona each, named by its file
// name ("大肥鱼.md" is the persona 大肥鱼). People maintain the files by hand; the
// current one is read again before every reply, so an edit takes effect at once.
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const EXT = '.md'

export class PersonaLibrary {
  /**
   * @param {object} o
   * @param {string} o.dir        the library folder
   * @param {string} o.fallback   the persona used when none was chosen (config `persona`)
   * @param {string} [o.current]  the persona chosen with /persona (saved by the caller)
   * @param {(name: string | undefined) => Promise<void>} [o.save]  remembers a choice
   */
  constructor({ dir, fallback, current, save = async () => {} }) {
    Object.assign(this, { dir, fallback, chosen: current, save })
  }

  // Copies the bundled personas into the library; files that already exist are left alone.
  async seed(bundledDir) {
    await mkdir(this.dir, { recursive: true })
    const existing = new Set(await this.list())
    for (const file of await readdir(bundledDir)) {
      if (file.endsWith(EXT) && !existing.has(file.slice(0, -EXT.length))) {
        await copyFile(join(bundledDir, file), join(this.dir, file))
      }
    }
  }

  get name() {
    return this.chosen ?? this.fallback
  }

  async list() {
    const files = await readdir(this.dir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
    return files.filter(file => file.endsWith(EXT)).map(file => file.slice(0, -EXT.length)).sort()
  }

  // The current persona's text.
  text() {
    return readFile(this.#path(this.name), 'utf8')
  }

  // Switches to `name`, or back to the configured default when `name` is undefined.
  async use(name) {
    if (name !== undefined && !(await this.list()).includes(name)) return false
    this.chosen = name
    await this.save(name)
    return true
  }

  #path(name) {
    return join(this.dir, name + EXT)
  }
}
