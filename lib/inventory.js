import fs from 'node:fs/promises'
import path from 'node:path'
import { entryKind, isSafeDirectoryPath, isSafeTrashId, samePath } from './fsops.js'

/** Every state the durable index understands. */
export const ENTRY_STATES = new Set(['trashing', 'trashed', 'restoring', 'purging', 'missing'])

/** Sidecar schema version understood by this release. */
const META_VERSION = 1

/**
 * @param {unknown} value candidate timestamp.
 * @returns {boolean} whether the value is a finite number.
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate one object sidecar strictly enough to be rebuilt into an index
 * entry. A malformed sidecar is reported as an unindexed object instead of
 * being guessed at.
 *
 * @param {unknown} meta parsed `meta.json`.
 * @param {string} trashId object directory identity.
 * @returns {boolean} whether the sidecar can rebuild one entry.
 */
export function isValidMeta(meta, trashId) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false
  if (meta.version !== undefined && meta.version !== META_VERSION) return false
  if (typeof meta.sessionId !== 'string' || meta.sessionId === '' || meta.sessionId.length > 256) return false
  if (meta.trashId !== trashId) return false
  if (!ENTRY_STATES.has(meta.state)) return false
  if (!isFiniteNumber(meta.trashedAt) || !isFiniteNumber(meta.startedAt)) return false
  if (typeof meta.title !== 'string' || meta.title.trim() === '') return false
  if (!isSafeDirectoryPath(meta.originalSessionDir)) return false
  if (typeof meta.persistenceProjectDirHint !== 'string' || !path.isAbsolute(meta.persistenceProjectDirHint)) return false
  if (!samePath(path.dirname(path.resolve(meta.originalSessionDir)), path.resolve(meta.persistenceProjectDirHint))) return false
  if (typeof meta.originalLogPath !== 'string' || !path.isAbsolute(meta.originalLogPath)) return false
  if (!samePath(path.dirname(path.resolve(meta.originalLogPath)), path.resolve(meta.originalSessionDir))) return false
  if (meta.originalCwd !== null && meta.originalCwd !== undefined) {
    if (typeof meta.originalCwd !== 'string' || !path.isAbsolute(meta.originalCwd)) return false
  }
  if (
    meta.workspaceExistsAtDeletion !== null &&
    meta.workspaceExistsAtDeletion !== undefined &&
    typeof meta.workspaceExistsAtDeletion !== 'boolean'
  ) {
    return false
  }
  return true
}

/**
 * @param {Record<string, unknown>} meta valid sidecar.
 * @returns {object} a clean index entry with defaulted optional fields.
 */
function toEntry(meta) {
  const originalCwd = typeof meta.originalCwd === 'string' && meta.originalCwd !== '' ? meta.originalCwd : null
  return {
    sessionId: meta.sessionId,
    trashId: meta.trashId,
    state: meta.state,
    title: meta.title,
    trashedAt: meta.trashedAt,
    startedAt: meta.startedAt,
    originalCwd,
    workspaceExistsAtDeletion: typeof meta.workspaceExistsAtDeletion === 'boolean' ? meta.workspaceExistsAtDeletion : null,
    originalWorkspaceId: typeof meta.originalWorkspaceId === 'string' ? meta.originalWorkspaceId : null,
    originalWorkspaceTitle: typeof meta.originalWorkspaceTitle === 'string' ? meta.originalWorkspaceTitle : null,
    originalNextSessionId: typeof meta.originalNextSessionId === 'string' ? meta.originalNextSessionId : null,
    originalSessionDir: path.resolve(meta.originalSessionDir),
    originalLogPath: path.resolve(meta.originalLogPath),
    persistenceProjectDirHint: path.resolve(meta.persistenceProjectDirHint),
    formatStatus: meta.formatStatus === 'migration-required' ? 'migration-required' : 'current',
    sizeBytes: isFiniteNumber(meta.sizeBytes) ? meta.sizeBytes : null,
    fileCount: isFiniteNumber(meta.fileCount) ? meta.fileCount : null,
    lastError: typeof meta.lastError === 'string' && meta.lastError !== '' ? meta.lastError : null,
  }
}

/**
 * Reconcile a rebuilt entry with the object directory observed on disk.
 *
 * @param {object} entry index-shaped entry.
 * @param {boolean} sessionExists whether `objects/<trashId>/session` is a directory.
 * @param {number} now current timestamp.
 * @returns {object} the entry whose state matches the filesystem.
 */
export function deriveEntry(entry, sessionExists, now) {
  if (!sessionExists) {
    if (entry.state === 'purging' || entry.state === 'missing') return { ...entry }
    return {
      ...entry,
      state: 'missing',
      lastError: 'The trash copy of this session is missing.',
    }
  }
  if (entry.state === 'missing') {
    return {
      ...entry,
      state: 'trashed',
      trashedAt: isFiniteNumber(entry.trashedAt) && entry.trashedAt > 0 ? entry.trashedAt : entry.startedAt || now,
      lastError: null,
    }
  }
  if (entry.state === 'trashed' && (!isFiniteNumber(entry.trashedAt) || entry.trashedAt <= 0)) {
    return { ...entry, trashedAt: entry.startedAt || now }
  }
  return { ...entry }
}

/**
 * Read every object directory and its sidecar without following symlinks.
 *
 * @param {import('./store.js').TrashStore} store trash store owning `objects/`.
 * @param {{ warn: Function }} logger diagnostics sink.
 * @returns {Promise<{ objects: { trashId: string, sessionExists: boolean, meta: object | undefined, metaValid: boolean }[], unindexed: number }>} the inventory.
 */
export async function scanObjects(store, logger) {
  let entries
  try {
    entries = await fs.readdir(store.objectsDir, { withFileTypes: true })
  } catch (error) {
    if (error !== null && error !== undefined && error.code === 'ENOENT') return { objects: [], unindexed: 0 }
    throw error
  }
  const objects = []
  let unindexed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeTrashId(entry.name)) {
      unindexed += 1
      continue
    }
    const trashId = entry.name
    let meta
    try {
      meta = await store.readMeta(trashId)
    } catch (error) {
      logger.warn(`cannot read the trash metadata for ${trashId}: ${error instanceof Error ? error.message : String(error)}`)
      // Keep the directory in the inventory so reconcile never mistakes an
      // unreadable sidecar for a vanished object directory.
      objects.push({ trashId, sessionExists: false, meta: undefined, metaValid: false })
      unindexed += 1
      continue
    }
    const metaValid = meta !== undefined && isValidMeta(meta, trashId)
    if (!metaValid) {
      objects.push({ trashId, sessionExists: false, meta, metaValid: false })
      unindexed += 1
      continue
    }
    let sessionExists = false
    try {
      sessionExists = (await entryKind(store.sessionPath(trashId))) === 'directory'
    } catch (error) {
      logger.warn(`cannot inspect the trash copy ${trashId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    objects.push({ trashId, sessionExists, meta, metaValid })
  }
  return { objects, unindexed }
}

/**
 * Import object directories the index does not know about and mark entries
 * whose object directory vanished. Never deletes a session file or an object
 * directory.
 *
 * @param {{ store: import('./store.js').TrashStore, logger: { warn: Function }, now?: number }} input trash store and diagnostics.
 * @returns {Promise<{ imported: number, markedMissing: number, unindexed: number, changed: number }>} reconcile summary.
 */
export async function reconcileIndex({ store, logger, now = Date.now() }) {
  if (store.isProtected()) return { imported: 0, markedMissing: 0, unindexed: store.unindexed, changed: 0 }
  const { objects, unindexed: invalidObjects } = await scanObjects(store, logger)
  const byTrashId = new Map(objects.map((object) => [object.trashId, object]))
  const nextEntries = [...store.entries()]
  const indexedTrashIds = new Set(nextEntries.map((entry) => entry.trashId))
  const sessionIds = new Set(nextEntries.map((entry) => entry.sessionId))
  const metaUpdates = []
  let unindexed = invalidObjects
  let markedMissing = 0
  let imported = 0
  let changed = false

  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index]
    const object = byTrashId.get(entry.trashId)
    if (object === undefined) {
      if (entry.state !== 'trashed') continue
      nextEntries[index] = {
        ...entry,
        state: 'missing',
        lastError: entry.lastError ?? 'The trash object directory is missing.',
      }
      metaUpdates.push(nextEntries[index])
      markedMissing += 1
      changed = true
      continue
    }
    if (entry.state === 'missing' && object.sessionExists) {
      nextEntries[index] = {
        ...entry,
        state: 'trashed',
        trashedAt: entry.trashedAt > 0 ? entry.trashedAt : entry.startedAt || now,
        lastError: null,
      }
      metaUpdates.push(nextEntries[index])
      changed = true
    }
  }

  for (const object of objects) {
    if (indexedTrashIds.has(object.trashId)) continue
    if (!object.metaValid || object.meta === undefined) continue
    const entry = toEntry(object.meta)
    if (sessionIds.has(entry.sessionId)) {
      // Two object directories claim the same session: keep the indexed one.
      unindexed += 1
      logger.warn(`the trash object ${object.trashId} duplicates the indexed session ${entry.sessionId}`)
      continue
    }
    const derived = deriveEntry(entry, object.sessionExists, now)
    nextEntries.push(derived)
    indexedTrashIds.add(derived.trashId)
    sessionIds.add(derived.sessionId)
    metaUpdates.push(derived)
    imported += 1
    changed = true
  }

  if (changed) {
    await store.commit(nextEntries)
    for (const entry of metaUpdates) {
      await store.writeMeta(entry).catch((error) => {
        logger.warn(`cannot rewrite trash metadata for ${entry.trashId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
  store.unindexed = unindexed
  return { imported, markedMissing, unindexed, changed: changed ? 1 : 0 }
}

/**
 * Rebuild the complete index from one `meta.json` sidecar per object directory.
 * Used only after the primary index and its backup were both rejected;
 * unindexed directories stay untouched and are reported.
 *
 * @param {{ store: import('./store.js').TrashStore, logger: { warn: Function }, now?: number }} input trash store and diagnostics.
 * @returns {Promise<{ entries: number, unindexed: number }>} rebuild summary.
 */
export async function rebuildIndex({ store, logger, now = Date.now() }) {
  const { objects, unindexed: invalidObjects } = await scanObjects(store, logger)
  const entries = []
  const seen = new Set()
  let unindexed = invalidObjects
  for (const object of objects) {
    if (!object.metaValid || object.meta === undefined) continue
    const entry = toEntry(object.meta)
    if (seen.has(entry.sessionId)) {
      unindexed += 1
      logger.warn(`the trash object ${object.trashId} duplicates the rebuilt session ${entry.sessionId}`)
      continue
    }
    seen.add(entry.sessionId)
    entries.push(deriveEntry(entry, object.sessionExists, now))
  }
  entries.sort((left, right) => left.startedAt - right.startedAt || left.trashId.localeCompare(right.trashId))
  await store.commit(entries)
  store.unindexed = unindexed
  return { entries: entries.length, unindexed }
}
