import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TrashError } from './errors.js'
import { isInside, removePathWithRetry, renameWithRetry, samePath } from './fsops.js'

/** On-disk index schema version understood by this release. */
export const INDEX_VERSION = 1

/** A lock older than this is assumed abandoned and may be taken over. */
export const LOCK_STALE_MS = 10 * 60 * 1000

/** How often a long-running operation refreshes its lock heartbeat. */
export const LOCK_REFRESH_MS = 60 * 1000

/**
 * @param {number} [now] timestamp for the new index.
 * @returns {{ version: number, updatedAt: number, entries: never[] }} an empty index document.
 */
export function emptyIndex(now = Date.now()) {
  return { version: INDEX_VERSION, updatedAt: now, entries: [] }
}

/**
 * Validate the persisted index shape strictly enough that a truncated or
 * hand-edited file enters protection mode instead of silently vanishing.
 *
 * @param {unknown} value parsed JSON document.
 * @returns {boolean} whether the document is a supported index.
 */
export function isValidIndex(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.version !== INDEX_VERSION) return false
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false
  if (!Array.isArray(value.entries)) return false
  const seen = new Set()
  for (const entry of value.entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return false
    if (typeof entry.trashId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.trashId)) return false
    if (typeof entry.state !== 'string') return false
    if (typeof entry.trashedAt !== 'number' || !Number.isFinite(entry.trashedAt)) return false
    if (seen.has(entry.sessionId)) return false
    seen.add(entry.sessionId)
  }
  return true
}

/**
 * @param {string} file path whose permissions should be tightened.
 * @param {number} mode desired permission bits.
 * @param {{ warn: Function }} logger diagnostics sink.
 * @returns {Promise<void>} resolution once the attempt completes.
 */
async function tighten(file, mode, logger) {
  try {
    await fs.chmod(file, mode)
  } catch (error) {
    logger.warn(`cannot tighten permissions on ${file}: ${error.message}`)
  }
}

/**
 * @param {string} dir path whose permissions should be tightened.
 * @param {{ warn: Function }} logger diagnostics sink.
 * @returns {Promise<void>} resolution once the attempt completes.
 */
async function ensurePrivateDir(dir, logger) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await tighten(dir, 0o700, logger)
}

/** Single-writer index, layout, and cross-process lock for one trash root. */
export class TrashStore {
  /**
   * @param {{ root: string, logger: { info: Function, warn: Function, error: Function, debug: Function } }} options trash root and diagnostics sink.
   */
  constructor({ root, logger }) {
    this.root = root
    this.logger = logger
    this.indexPath = path.join(root, 'trash-index.json')
    this.bakPath = path.join(root, 'trash-index.json.bak')
    this.tmpPath = path.join(root, 'trash-index.json.tmp')
    this.lockPath = path.join(root, '.lock')
    this.objectsDir = path.join(root, 'objects')
    this.index = emptyIndex()
    this.status = 'missing'
    this.error = null
    this.unindexed = 0
    this.lockOwned = false
    this.lockTimer = null
    this.queue = Promise.resolve()
  }

  /**
   * Create the trash layout and load the durable index.
   *
   * @returns {Promise<{ status: string, updatedAt: number, error: string | null }>} the index status summary.
   */
  async init() {
    await ensurePrivateDir(this.root, this.logger)
    await ensurePrivateDir(this.objectsDir, this.logger)
    await this.load()
    if (this.status === 'missing') {
      await this.writeIndex(this.index.entries)
    } else if (this.status === 'corrupt') {
      this.logger.error(`trash index is unreadable and no usable backup exists: ${this.error}`)
    } else if (this.status === 'recovered') {
      this.logger.warn(`trash index recovered from backup: ${this.error}`)
    }
    return this.describe()
  }

  /**
   * @returns {{ status: string, updatedAt: number, error: string | null, unindexed: number }} the committed index summary.
   */
  describe() {
    return { status: this.status, updatedAt: this.index.updatedAt, error: this.error, unindexed: this.unindexed }
  }

  /**
   * @returns {readonly object[]} the committed entries.
   */
  entries() {
    return this.index.entries
  }

  /**
   * @param {string} sessionId session to look up.
   * @returns {object | undefined} the index entry for this session.
   */
  findEntry(sessionId) {
    return this.index.entries.find((entry) => entry.sessionId === sessionId)
  }

  /**
   * @returns {boolean} whether writes are refused because the index is unreadable.
   */
  isProtected() {
    return this.status === 'corrupt'
  }

  /**
   * @param {string} trashId object identity.
   * @returns {string} the object directory inside `objects/`.
   */
  objectDir(trashId) {
    return path.join(this.objectsDir, trashId)
  }

  /**
   * @param {string} trashId object identity.
   * @returns {string} the moved session directory inside the object directory.
   */
  sessionPath(trashId) {
    return path.join(this.objectDir(trashId), 'session')
  }

  /**
   * @param {string} trashId object identity.
   * @returns {string} the self-describing metadata path inside the object directory.
   */
  metaPath(trashId) {
    return path.join(this.objectDir(trashId), 'meta.json')
  }

  /**
   * Create one private object directory.
   *
   * @param {string} trashId object identity.
   * @returns {Promise<void>} resolution once the directory exists.
   */
  async createObjectDir(trashId) {
    await ensurePrivateDir(this.objectDir(trashId), this.logger)
  }

  /**
   * Remove one object directory after proving it stays inside `objects/`.
   *
   * @param {string} trashId object identity.
   * @returns {Promise<void>} resolution once the directory is gone.
   */
  async removeObjectDir(trashId) {
    const target = path.resolve(this.objectDir(trashId))
    const objects = path.resolve(this.objectsDir)
    if (samePath(objects, target) || !isInside(objects, target)) {
      throw new TrashError('IO_ERROR', 'Refusing to remove a trash object outside the trash root.')
    }
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  /**
   * @param {string} trashId object identity.
   * @returns {Promise<object | undefined>} the parsed sidecar metadata, when present.
   */
  async readMeta(trashId) {
    try {
      return await this.readJson(this.metaPath(trashId))
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Remove the plugin-owned metadata of one forgotten object. Session files and
   * any other unexpected entry are preserved; the object directory itself is
   * removed only once it is empty.
   *
   * @param {string} trashId object identity.
   * @returns {Promise<void>} resolution once the best-effort cleanup ends.
   */
  async removeObjectRemnants(trashId) {
    const directory = this.objectDir(trashId)
    let names
    try {
      names = await fs.readdir(directory)
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      if (name !== 'meta.json' && name !== 'meta.json.tmp') continue
      await fs.rm(path.join(directory, name), { force: true })
    }
    try {
      await fs.rmdir(directory)
    } catch (error) {
      const code = error !== null && error !== undefined ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
    }
  }

  /**
   * Atomically write one object sidecar. Metadata is written before the session
   * directory moves, so a damaged index can rebuild from it later.
   *
   * @param {object} entry index-shaped entry carrying `trashId`.
   * @returns {Promise<void>} resolution once the sidecar is durable.
   */
  async writeMeta(entry) {
    const target = this.metaPath(entry.trashId)
    try {
      const parent = await fs.stat(path.dirname(target))
      if (!parent.isDirectory()) return
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return
      throw error
    }
    const temporary = `${target}.tmp`
    const json = `${JSON.stringify({ version: INDEX_VERSION, ...entry }, null, 2)}\n`
    try {
      const handle = await fs.open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(json, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await renameWithRetry(temporary, target)
    } catch (error) {
      await removePathWithRetry(temporary, { recursive: false, force: true }).catch(() => {})
      throw error
    }
    await tighten(target, 0o600, this.logger)
  }

  /**
   * Remove one original session directory after confirming it is a plain
   * directory outside the trash root. Used only after a verified copy exists.
   *
   * @param {string} sessionDir original session-owned directory.
   * @returns {Promise<void>} resolution once the directory is gone.
   */
  async removeSessionSource(sessionDir) {
    const target = path.resolve(sessionDir)
    if (isInside(this.root, target)) {
      throw new TrashError('IO_ERROR', 'Refusing to remove a session directory inside the trash root.')
    }
    const stats = await fs.lstat(target)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new TrashError('UNSAFE_SESSION_DIR', 'Refusing to remove a session directory that is not a plain directory.')
    }
    await fs.rm(target, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
  }

  /**
   * Commit a complete entry list and refresh the in-memory projection.
   *
   * @param {readonly object[]} entries complete new entry list.
   * @returns {Promise<void>} resolution once committed.
   */
  async commit(entries) {
    await this.writeIndex(entries)
  }

  /** Reload the committed index from disk. Callers serializing writes use this
   * after taking the lock so another process's commit is never clobbered. */
  async refresh() {
    await this.load()
  }

  /**
   * @param {string} file index file to read.
   * @returns {Promise<unknown>} parsed JSON.
   */
  async readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  }

  /**
   * Load the index, falling back to the previous committed backup.
   *
   * @returns {Promise<void>} resolution once `index` and `status` are set.
   */
  async load() {
    try {
      const data = await this.readJson(this.indexPath)
      if (!isValidIndex(data)) throw new Error('unsupported index shape or version')
      this.index = data
      this.status = 'ok'
      this.error = null
      return
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.index = emptyIndex()
        this.status = 'missing'
        this.error = null
        return
      }
      const primary = error instanceof Error ? error.message : String(error)
      try {
        const backup = await this.readJson(this.bakPath)
        if (!isValidIndex(backup)) throw new Error('unsupported backup shape or version')
        this.index = backup
        this.status = 'recovered'
        this.error = primary
        return
      } catch (backupError) {
        const secondary = backupError instanceof Error ? backupError.message : String(backupError)
        this.index = emptyIndex()
        this.status = 'corrupt'
        this.error = `${primary}; backup unavailable: ${secondary}`
      }
    }
  }

  /**
   * Atomically commit the index: write a temporary file, preserve the previous
   * commit as `.bak`, then rename over the live index.
   *
   * @param {readonly object[]} entries the complete entry list to persist.
   * @returns {Promise<{ version: number, updatedAt: number, entries: readonly object[] }>} the committed document.
   */
  async writeIndex(entries) {
    const data = { version: INDEX_VERSION, updatedAt: Date.now(), entries }
    const json = `${JSON.stringify(data, null, 2)}\n`
    try {
      const handle = await fs.open(this.tmpPath, 'w', 0o600)
      try {
        await handle.writeFile(json, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await fs.copyFile(this.indexPath, this.bakPath)
        await tighten(this.bakPath, 0o600, this.logger)
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          this.logger.warn(`cannot preserve the previous trash index: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await renameWithRetry(this.tmpPath, this.indexPath)
    } catch (error) {
      await removePathWithRetry(this.tmpPath, { recursive: false, force: true }).catch(() => {})
      throw error
    }
    this.index = data
    this.status = 'ok'
    this.error = null
    return data
  }

  /**
   * Serialize mutations inside this process.
   *
   * @param {() => Promise<T>} operation critical section.
   * @returns {Promise<T>} the operation result.
   * @template T
   */
  runExclusive(operation) {
    const run = this.queue.then(() => operation())
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Run one operation under both the in-process queue and the cross-process lock.
   *
   * @param {() => Promise<T>} operation critical section.
   * @returns {Promise<T>} the operation result.
   * @template T
   */
  withLock(operation) {
    return this.runExclusive(async () => {
      await this.acquireLock()
      this.startLockHeartbeat()
      try {
        await this.refresh()
        return await operation()
      } finally {
        this.stopLockHeartbeat()
        await this.releaseLock()
      }
    })
  }

  /**
   * Rewrite the lock timestamp while an operation outlives the stale window.
   * A lock now owned by a different process is abandoned instead of stolen
   * back.
   *
   * @returns {Promise<void>} resolution once the heartbeat attempt ends.
   */
  async refreshLock() {
    if (!this.lockOwned) return
    let current
    try {
      current = JSON.parse(await fs.readFile(this.lockPath, 'utf8'))
    } catch {
      this.stopLockHeartbeat()
      this.lockOwned = false
      return
    }
    if (current?.pid !== process.pid || current?.host !== os.hostname()) {
      this.stopLockHeartbeat()
      this.lockOwned = false
      return
    }
    try {
      await fs.writeFile(
        this.lockPath,
        JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }),
      )
    } catch (error) {
      this.logger.warn(`cannot refresh the trash lock: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * @returns {void}
   */
  startLockHeartbeat() {
    this.stopLockHeartbeat()
    const timer = setInterval(() => {
      this.refreshLock().catch(() => {})
    }, LOCK_REFRESH_MS)
    timer.unref?.()
    this.lockTimer = timer
  }

  /**
   * @returns {void}
   */
  stopLockHeartbeat() {
    if (this.lockTimer === null) return
    clearInterval(this.lockTimer)
    this.lockTimer = null
  }

  /**
   * A lock is abandoned only when its recorded start time (or, for a partially
   * written file, its mtime) is older than {@link LOCK_STALE_MS}.
   *
   * @returns {Promise<boolean>} whether an existing lock may be taken over.
   */
  async lockIsStale() {
    let stats
    try {
      stats = await fs.stat(this.lockPath)
    } catch (error) {
      return error !== null && error !== undefined && error.code === 'ENOENT'
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.lockPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.startedAt === 'number') {
        return Date.now() - parsed.startedAt > LOCK_STALE_MS
      }
    } catch {
      // A partially written lock falls through to the mtime check.
    }
    return Date.now() - stats.mtimeMs > LOCK_STALE_MS
  }

  /**
   * @returns {Promise<void>} resolution once this process owns the lock.
   */
  async acquireLock() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }))
        } finally {
          await handle.close()
        }
        this.lockOwned = true
        return
      } catch (error) {
        if (!error || error.code !== 'EEXIST') {
          throw new TrashError('IO_ERROR', `Cannot create the trash lock: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!(await this.lockIsStale())) {
          throw new TrashError('LOCKED', 'Another trash operation is in progress. Try again in a moment.')
        }
        try {
          await removePathWithRetry(this.lockPath, { recursive: false, force: true, attempts: 5, delayMs: 20 })
        } catch (removeError) {
          throw new TrashError('LOCKED', 'A stale trash lock could not be removed. Try again in a moment.', {
            code: removeError instanceof Error && typeof removeError.code === 'string' ? removeError.code : null,
          })
        }
      }
    }
    throw new TrashError('LOCKED', 'Another trash operation is in progress. Try again in a moment.')
  }

  /**
   * @returns {Promise<void>} resolution once this process no longer holds the lock.
   */
  async releaseLock() {
    this.stopLockHeartbeat()
    if (!this.lockOwned) return
    this.lockOwned = false
    try {
      await removePathWithRetry(this.lockPath, { recursive: false, force: true, attempts: 5, delayMs: 20 })
    } catch (error) {
      this.logger.warn(`cannot release the trash lock: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
