import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TrashStore } from '../lib/store.js'
import { createEligibility } from '../lib/eligibility.js'
import { createTrashService } from '../lib/trash-service.js'
import { createStateService } from '../lib/state.js'

/**
 * @param {string} [prefix] temp-directory prefix.
 * @returns {Promise<string>} a fresh empty directory.
 */
export async function createTempDir(prefix = 'dsh-session-trash-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * @param {object} t node:test context.
 * @param {string} reason why this platform cannot exercise the case.
 * @returns {boolean} whether the test was skipped.
 */
export function skipOnWindows(t, reason) {
  if (process.platform !== 'win32') return false
  t.skip(reason)
  return true
}

/**
 * @param {object} t node:test context.
 * @param {string} reason why root cannot exercise the case.
 * @returns {boolean} whether the test was skipped.
 */
export function skipAsRoot(t, reason) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false
  t.skip(reason)
  return true
}

/**
 * Windows needs developer mode or an elevated process for file symbolic links;
 * directory links use a junction, which needs no extra privilege.
 *
 * @returns {'junction' | undefined} the link type for a directory target.
 */
export function directoryLinkType() {
  return process.platform === 'win32' ? 'junction' : undefined
}

/**
 * Create a symbolic link, or skip the test when the platform forbids it.
 *
 * @param {object} t node:test context.
 * @param {string} target link target.
 * @param {string} linkPath new link path.
 * @param {'file' | 'dir' | 'junction' | undefined} [type] Windows link type.
 * @returns {Promise<boolean>} whether the link exists.
 */
export async function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type)
    return true
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
      t.skip(`symbolic links are not permitted here (${code})`)
      return false
    }
    throw error
  }
}

/**
 * @returns {{ level: string, args: unknown[] }[]} logger records, plus no-op methods.
 */
export function createLogger() {
  const lines = []
  const push = (level) => (...args) => {
    lines.push({ level, args })
  }
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}

/**
 * @param {string} cwd project directory.
 * @returns {string} a JSONL-style project directory name.
 */
export function projectName(cwd) {
  const readable = cwd.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '') || 'root'
  return `--${readable.slice(0, 251)}--`
}

/**
 * In-memory persistence harness backed by real directories so the trash
 * service moves real files and `stat` really reflects visibility.
 *
 * @param {string} sessionsRoot root that holds per-project session directories.
 * @returns {object} the fake service plus test helpers.
 */
export function createFakePersistence(sessionsRoot) {
  const records = new Map()
  const snapshot = async (record) => {
    let stats
    try {
      stats = await fs.stat(record.logPath)
    } catch {
      return undefined
    }
    if (!stats.isFile()) return undefined
    return {
      header: record.header,
      formatStatus: 'current',
      revision: 'rev',
      sizeBytes: stats.size,
      location: { kind: 'jsonl', path: record.logPath },
    }
  }
  const persistence = {
    records,
    sessionsRoot,
    /**
     * @param {string} id session id.
     * @returns {Promise<object | undefined>} the current snapshot.
     */
    async stat(id) {
      const record = records.get(id)
      if (record === undefined) return undefined
      return snapshot(record)
    },
    /**
     * @returns {Promise<object[]>} every visible snapshot.
     */
    async list() {
      const items = []
      for (const record of records.values()) {
        const current = await snapshot(record)
        if (current !== undefined) items.push(current)
      }
      return items
    },
    /**
     * @param {{ id: string, cwd?: string, origin?: 'subagent', parentSession?: string, createdAt?: number, content?: string }} input session to materialize.
     * @returns {Promise<object>} the record.
     */
    async add({ id, cwd, origin, parentSession, createdAt = Date.now(), content = '{"type":"session/start"}\n' }) {
      const projectDir = path.join(sessionsRoot, cwd === undefined ? '_no-cwd' : projectName(cwd))
      const dir = path.join(projectDir, id)
      const logPath = path.join(dir, 'session.v4.jsonl')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(logPath, content)
      await fs.writeFile(path.join(dir, 'session.lock'), '')
      const header = {
        version: 4,
        id,
        createdAt,
        isSeeded: false,
        ...(cwd === undefined ? {} : { cwd }),
        ...(origin === undefined ? {} : { origin }),
        ...(parentSession === undefined ? {} : { parentSession }),
      }
      const record = { header, dir, logPath }
      records.set(id, record)
      return record
    },
  }
  return persistence
}

/**
 * Fake Workspace registry recording attach/detach/reorder calls.
 *
 * @returns {object} the registry.
 */
export function createFakeWorkspaceRegistry() {
  const items = []
  const registryCalls = []
  const registry = {
    items,
    calls: registryCalls,
    /**
     * @param {{ id: string, path: string, title?: string, sessionIds?: string[] }} input workspace.
     * @returns {object} the fake workspace.
     */
    add({ id, path: workspacePath, title = path.basename(workspacePath), sessionIds = [] }) {
      const workspace = {
        id,
        path: workspacePath,
        title,
        sessionIds: [...sessionIds],
        calls: [],
        async detachSession(sessionId) {
          this.calls.push(['detach', sessionId])
          this.sessionIds = this.sessionIds.filter((value) => value !== sessionId)
        },
        async attachSession(sessionId) {
          this.calls.push(['attach', sessionId])
          if (!this.sessionIds.includes(sessionId)) this.sessionIds = [sessionId, ...this.sessionIds]
        },
        async insertSessionBefore(sessionId, beforeSessionId) {
          this.calls.push(['insertBefore', sessionId, beforeSessionId])
          const without = this.sessionIds.filter((value) => value !== sessionId)
          const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
          this.sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
        },
      }
      items.push(workspace)
      return workspace
    },
    /**
     * @param {string} id workspace id.
     * @returns {object | undefined} the matching workspace.
     */
    get(id) {
      return items.find((item) => item.id === id)
    },
    /**
     * @returns {object[]} the registry order.
     */
    list() {
      return items
    },
    /**
     * @param {string} sessionId session to drop from the archive set.
     * @returns {Promise<void>} resolution after the fake write.
     */
    async unarchiveSession(sessionId) {
      registryCalls.push(['unarchive', sessionId])
    },
    /**
     * @param {string} sessionId session to drop from the pin set.
     * @returns {Promise<void>} resolution after the fake write.
     */
    async unpinSession(sessionId) {
      registryCalls.push(['unpin', sessionId])
    },
  }
  return registry
}

/**
 * Build a coherent Phase 2/3 harness: real trash store and directories, fake
 * persistence, workspace, title, projection-cache, and native-open services.
 *
 * `titleApi` selects the shape the fake `sessionQuery` exposes:
 * `snapshot` (DSH 0.2.2 `readTitle` returns a TitleSnapshot object), `string`
 * (older query services), `snapshots` (only the documented batch face),
 * `throwing` (the log fold fails), or `none` (no title service).
 *
 * @param {{
 *   config?: object,
 *   titles?: Map<string, string>,
 *   titleApi?: 'snapshot' | 'string' | 'snapshots' | 'throwing' | 'none',
 *   cachedTitles?: Map<string, string>,
 *   projectionCache?: boolean,
 *   canOpenPath?: boolean,
 *   revealError?: Error,
 *   sessionController?: boolean,
 * }} [options] overrides.
 * @returns {Promise<object>} the harness handle.
 */
export async function createHarness(options = {}) {
  const root = await createTempDir()
  const sessionsRoot = path.join(root, 'sessions')
  const trashRoot = path.join(root, '.session-trash')
  const storagesRoot = path.join(root, 'storages')
  await fs.mkdir(sessionsRoot, { recursive: true })
  const persistence = createFakePersistence(sessionsRoot)
  const workspaces = createFakeWorkspaceRegistry()
  const titles = options.titles ?? new Map()
  const cachedTitles = options.cachedTitles ?? new Map()
  const logger = createLogger()
  const config = { retentionDays: 30, sweepIntervalHours: 6, enableAutoCleanup: true, ...(options.config ?? {}) }
  const emissions = []
  const liveSessions = new Map()
  const liveAgents = new Map()
  let activity = () => Promise.resolve([])
  const titleApi = options.titleApi ?? 'snapshot'
  /** @type {Record<string, any>} */
  const sessionQuery = {}
  /**
   * @param {string} sessionId session identity.
   * @returns {object | undefined} the folded title snapshot DSH returns.
   */
  const titleSnapshot = (sessionId) => {
    const title = titles.get(sessionId)
    if (title === undefined) return undefined
    return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0, updatedAt: Date.now() }
  }
  if (titleApi === 'snapshot') {
    sessionQuery.readTitle = async (sessionId) => titleSnapshot(sessionId)
  } else if (titleApi === 'string') {
    sessionQuery.readTitle = async (sessionId) => titles.get(sessionId)
  } else if (titleApi === 'throwing') {
    sessionQuery.readTitle = async (sessionId) => {
      throw new Error(`cannot fold the title for ${sessionId}`)
    }
  } else if (titleApi === 'snapshots') {
    sessionQuery.readTitleSnapshots = async (sessionIds) =>
      sessionIds.map((sessionId) => {
        const snapshot = titleSnapshot(sessionId)
        return {
          sessionId,
          status: 'fulfilled',
          value: snapshot === undefined ? { session: {} } : { session: {}, title: snapshot },
        }
      })
  }
  const projectionCache = {
    /**
     * @param {any} header session header.
     * @param {string[]} keys requested projection keys.
     * @returns {object | undefined} the cached block.
     */
    cachedSnapshot(header, keys) {
      if (!Array.isArray(keys) || !keys.includes('title')) return undefined
      const title = cachedTitles.get(header?.id)
      return typeof title === 'string' && title !== '' ? { asOfSeq: 0, values: { title } } : undefined
    },
  }
  const revealed = []
  const sessionController = {
    canOpenWorkspacePath() {
      return options.canOpenPath ?? true
    },
    async openWorkspacePath(request, signal) {
      signal?.throwIfAborted?.()
      if (options.revealError !== undefined) throw options.revealError
      revealed.push(request)
      return { opened: true }
    },
  }
  const services = new Map([
    ['sessionQuery', sessionQuery],
    ['workspaceRegistry', workspaces],
    ...(options.sessionController === false ? [] : [['sessionController', sessionController]]),
    ...(options.projectionCache === false ? [] : [['sessionProjectionCache', projectionCache]]),
  ])
  const ctx = {
    sessionPersistence: persistence,
    sessions: { get: (id) => liveSessions.get(id) },
    agents: { get: (id) => liveAgents.get(id) },
    get: (name) => services.get(name),
    async waterfall() {
      return activity()
    },
    emit(event, ...args) {
      emissions.push({ event, args })
    },
  }
  const store = new TrashStore({ root: trashRoot, logger })
  await store.init()
  const eligibility = createEligibility({ ctx, store, logger })
  const stateService = createStateService({
    store,
    config,
    trashRootDisplay: '$DSH_HOME/.session-trash',
    ...(options.cleanup === undefined ? {} : { cleanup: options.cleanup }),
  })
  const service = createTrashService({
    ctx,
    store,
    eligibility,
    config,
    logger,
    paths: { home: root, root: trashRoot, display: '$DSH_HOME/.session-trash' },
  })
  return {
    root,
    sessionsRoot,
    storagesRoot,
    trashRoot,
    persistence,
    workspaces,
    titles,
    logger,
    config,
    emissions,
    liveSessions,
    liveAgents,
    revealed,
    sessionController,
    setActivity(fn) {
      activity = fn
    },
    ctx,
    store,
    eligibility,
    stateService,
    service,
    /**
     * @param {Parameters<typeof persistence.add>[0]} input session.
     * @returns {Promise<object>} the persistence record.
     */
    async addSession(input) {
      const record = await persistence.add(input)
      if (input.title !== undefined) titles.set(input.id, input.title)
      return record
    },
    /**
     * Write one durable session-projection-cache record, the DSH layout the
     * startup title repair reads.
     *
     * @param {string} sessionId session identity.
     * @param {string} title cached conversation title.
     * @param {{ cwd?: string, createdAt?: number, formatVersion?: number, rowVersion?: number }} [identity] lifecycle fields.
     * @returns {Promise<string>} the written cache file.
     */
    async writeCachedTitle(sessionId, title, identity = {}) {
      const directory = path.join(storagesRoot, 'session_projcache', 'sessions')
      await fs.mkdir(directory, { recursive: true })
      const file = path.join(directory, `${sessionId}.json`)
      const document = {
        version: 7,
        record: {
          identity: {
            formatVersion: identity.formatVersion ?? 4,
            createdAt: identity.createdAt ?? Date.now(),
            ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
            isSeeded: false,
          },
          rows: { title: { ver: identity.rowVersion ?? 1, seq: 0, val: title } },
        },
      }
      await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`)
      return file
    },
    /**
     * @returns {Promise<void>} cleanup.
     */
    async dispose() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
