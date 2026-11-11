import fs from 'node:fs/promises'
import path from 'node:path'
import { mapLimit } from './concurrency.js'
import { entryKind, isSafeDirectoryPath, isSafeMemberId, isSafeTrashId, samePath } from './fsops.js'
import { memberList } from './members.js'

/** Maximum concurrent object directories inspected during a scan. */
const SCAN_CONCURRENCY = 4

/** Every state the durable index understands. */
export const ENTRY_STATES = new Set(['trashing', 'trashed', 'restoring', 'purging', 'missing'])

/** Sidecar schema version understood by this release. */
const META_VERSION = 2

/** Maximum directories one trashed item may own. */
const MAX_MEMBERS = 64

/**
 * @param {unknown} value candidate timestamp.
 * @returns {boolean} whether the value is a finite number.
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * @param {unknown} value candidate metric.
 * @returns {boolean} whether the value is a usable number or absent.
 */
function isMetric(value) {
  return value === undefined || value === null || isFiniteNumber(value)
}

/**
 * Validate one v2 member's absolute paths. The parent's sidecar is validated
 * field by field so a hand-edited file is rejected instead of guessed at.
 *
 * @param {unknown} member candidate member.
 * @returns {boolean} whether the member names safe, coherent paths.
 */
function isValidMemberPaths(member) {
  if (member === null || typeof member !== 'object' || Array.isArray(member)) return false
  if (!isSafeMemberId(member.sessionId)) return false
  if (member.origin !== undefined && member.origin !== null && member.origin !== 'subagent') return false
  if (member.title !== undefined && typeof member.title !== 'string') return false
  if (
    member.formatStatus !== undefined &&
    member.formatStatus !== 'current' &&
    member.formatStatus !== 'migration-required'
  ) {
    return false
  }
  if (!isMetric(member.sizeBytes) || !isMetric(member.fileCount)) return false
  if (!isSafeDirectoryPath(member.originalSessionDir)) return false
  if (typeof member.originalLogPath !== 'string' || !path.isAbsolute(member.originalLogPath)) return false
  if (
    typeof member.persistenceProjectDirHint !== 'string' ||
    !path.isAbsolute(member.persistenceProjectDirHint)
  ) {
    return false
  }
  if (!samePath(path.dirname(path.resolve(member.originalSessionDir)), path.resolve(member.persistenceProjectDirHint))) {
    return false
  }
  if (!samePath(path.dirname(path.resolve(member.originalLogPath)), path.resolve(member.originalSessionDir))) {
    return false
  }
  return true
}

/**
 * Validate the v2 member list of one sidecar.
 *
 * @param {object} meta candidate sidecar.
 * @returns {boolean} whether the list is coherent with its parent fields.
 */
function isValidMetaMembers(meta) {
  if (!Array.isArray(meta.members) || meta.members.length === 0 || meta.members.length > MAX_MEMBERS) return false
  if (!meta.members.every((member) => isValidMemberPaths(member))) return false
  const seen = new Set()
  for (const member of meta.members) {
    if (seen.has(member.sessionId)) return false
    seen.add(member.sessionId)
  }
  const parent = meta.members[0]
  if (parent.sessionId !== meta.sessionId) return false
  if (!samePath(path.resolve(parent.originalSessionDir), path.resolve(meta.originalSessionDir))) return false
  if (!samePath(path.resolve(parent.originalLogPath), path.resolve(meta.originalLogPath))) return false
  if (
    !samePath(path.resolve(parent.persistenceProjectDirHint), path.resolve(meta.persistenceProjectDirHint))
  ) {
    return false
  }
  return true
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
  if (meta.version !== undefined && meta.version !== META_VERSION && meta.version !== 1) return false
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
  if (meta.version === META_VERSION) return isValidMetaMembers(meta)
  return true
}

/**
 * @param {Record<string, unknown>} member raw member fields.
 * @param {string} fallbackTitle title used when the member carries none.
 * @returns {object} one normalized v2 member.
 */
function toMember(member, fallbackTitle) {
  return {
    sessionId: member.sessionId,
    origin: member.origin === 'subagent' ? 'subagent' : null,
    title: typeof member.title === 'string' && member.title !== '' ? member.title : fallbackTitle,
    originalSessionDir: path.resolve(member.originalSessionDir),
    originalLogPath: path.resolve(member.originalLogPath),
    persistenceProjectDirHint: path.resolve(member.persistenceProjectDirHint),
    formatStatus: member.formatStatus === 'migration-required' ? 'migration-required' : 'current',
    sizeBytes: isFiniteNumber(member.sizeBytes) ? member.sizeBytes : null,
    fileCount: isFiniteNumber(member.fileCount) ? member.fileCount : null,
  }
}

/**
 * @param {Record<string, unknown>} meta valid sidecar.
 * @returns {object} a clean index entry with defaulted optional fields.
 */
export function toEntry(meta) {
  const originalCwd = typeof meta.originalCwd === 'string' && meta.originalCwd !== '' ? meta.originalCwd : null
  const title = typeof meta.title === 'string' && meta.title !== '' ? meta.title : meta.sessionId
  const members =
    Array.isArray(meta.members) && meta.members.length > 0
      ? meta.members.map((member) => toMember(member, title))
      : [
          toMember(
            {
              sessionId: meta.sessionId,
              originalSessionDir: meta.originalSessionDir,
              originalLogPath: meta.originalLogPath,
              persistenceProjectDirHint: meta.persistenceProjectDirHint,
              formatStatus: meta.formatStatus,
              sizeBytes: meta.sizeBytes,
              fileCount: meta.fileCount,
            },
            title,
          ),
        ]
  return {
    sessionId: meta.sessionId,
    trashId: meta.trashId,
    state: meta.state,
    title,
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
    members,
    lastError: typeof meta.lastError === 'string' && meta.lastError !== '' ? meta.lastError : null,
  }
}

/**
 * Which of one entry's member directories currently exist inside its object.
 *
 * @param {import('./store.js').TrashStore} store trash store owning `objects/`.
 * @param {object} entry index entry, v1 or v2 shaped.
 * @returns {Promise<{ total: number, present: number, missing: string[] }>} presence summary.
 */
export async function memberPresence(store, entry) {
  const members =
    Array.isArray(entry.members) && entry.members.length > 0
      ? entry.members
      : [{ sessionId: entry.sessionId, originalSessionDir: entry.originalSessionDir }]
  const missing = []
  let present = 0
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]
    let kind = 'missing'
    try {
      kind = await entryKind(store.memberPath(entry.trashId, index, member.sessionId))
    } catch {
      kind = 'missing'
    }
    if (kind === 'directory') present += 1
    else missing.push(typeof member.sessionId === 'string' ? member.sessionId : entry.sessionId)
  }
  return { total: members.length, present, missing }
}

/**
 * Whether two member lists name the same directories in the same order, so a
 * presence probe taken for one can be reused for the other.
 *
 * @param {readonly object[]} left first member list.
 * @param {readonly object[]} right second member list.
 * @returns {boolean} whether both lists describe the same members.
 */
function sameMembers(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.sessionId !== right[index]?.sessionId) return false
  }
  return true
}

/**
 * Reconcile a rebuilt entry with the object directory observed on disk.
 *
 * @param {object} entry index-shaped entry.
 * @param {{ total: number, present: number, missing: string[] }} presence member presence.
 * @param {number} now current timestamp.
 * @returns {object} the entry whose state matches the filesystem.
 */
export function deriveEntry(entry, presence, now) {
  const complete = presence.total > 0 && presence.present === presence.total
  if (!complete) {
    if (entry.state === 'purging' || entry.state === 'missing') return { ...entry }
    const lastError =
      presence.present === 0
        ? 'The trash copy of this session is missing.'
        : `The trash copy is missing these member sessions: ${presence.missing.join(', ')}.`
    return {
      ...entry,
      state: 'missing',
      lastError,
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
 * @returns {Promise<{ objects: { trashId: string, sessionExists: boolean, meta: object | undefined, metaValid: boolean, entry?: object, presence?: object }[], unindexed: number }>} the inventory.
 */
export async function scanObjects(store, logger) {
  let entries
  try {
    entries = await fs.readdir(store.objectsDir, { withFileTypes: true })
  } catch (error) {
    if (error !== null && error !== undefined && error.code === 'ENOENT') return { objects: [], unindexed: 0 }
    throw error
  }
  const scanned = await mapLimit(entries, SCAN_CONCURRENCY, async (entry) => {
    if (!entry.isDirectory() || !isSafeTrashId(entry.name)) return { unindexed: 1 }
    const trashId = entry.name
    let meta
    try {
      meta = await store.readMeta(trashId)
    } catch (error) {
      logger.warn(`cannot read the trash metadata for ${trashId}: ${error instanceof Error ? error.message : String(error)}`)
      // Keep the directory in the inventory so reconcile never mistakes an
      // unreadable sidecar for a vanished object directory.
      return { object: { trashId, sessionExists: false, meta: undefined, metaValid: false }, unindexed: 1 }
    }
    const metaValid = meta !== undefined && isValidMeta(meta, trashId)
    if (!metaValid) {
      return { object: { trashId, sessionExists: false, meta, metaValid: false }, unindexed: 1 }
    }
    let presence
    try {
      presence = await memberPresence(store, toEntry(meta))
    } catch (error) {
      logger.warn(`cannot inspect the trash copy ${trashId}: ${error instanceof Error ? error.message : String(error)}`)
      presence = { total: 0, present: 0, missing: [] }
    }
    return {
      object: {
        trashId,
        sessionExists: presence.total > 0 && presence.present === presence.total,
        meta,
        metaValid,
        entry: toEntry(meta),
        presence,
      },
      unindexed: 0,
    }
  })
  const objects = []
  let unindexed = 0
  for (const result of scanned) {
    unindexed += result.unindexed
    if (result.object !== undefined) objects.push(result.object)
  }
  return { objects, unindexed }
}

/**
 * Import object directories the index does not know about and mark entries
 * whose object directory vanished. Never deletes a session file or an object
 * directory.
 *
 * @param {{ store: import('./store.js').TrashStore, logger: { warn: Function }, now?: number }} input trash store and diagnostics.
 * @returns {Promise<{ imported: number, markedMissing: number, unindexed: number, changed: number, presence: Map<string, object> }>} reconcile summary plus the presence probe per object.
 */
export async function reconcileIndex({ store, logger, now = Date.now() }) {
  if (store.isProtected()) {
    return { imported: 0, markedMissing: 0, unindexed: store.unindexed, changed: 0, presence: new Map() }
  }
  const { objects, unindexed: invalidObjects } = await scanObjects(store, logger)
  const byTrashId = new Map(objects.map((object) => [object.trashId, object]))
  const presenceByTrashId = new Map()
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
    // The scan already probed every member directory of this object. Reuse that
    // answer when the sidecar and the index entry describe the same members;
    // otherwise probe again rather than trust a mismatched snapshot.
    const presence =
      object.presence !== undefined &&
      object.entry !== undefined &&
      sameMembers(memberList(object.entry), memberList(entry))
        ? object.presence
        : await memberPresence(store, entry)
    presenceByTrashId.set(object.trashId, presence)
    if (entry.state === 'missing' && presence.total > 0 && presence.present === presence.total) {
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
    if (!object.metaValid || object.meta === undefined || object.entry === undefined || object.presence === undefined) continue
    const entry = object.entry
    if (sessionIds.has(entry.sessionId)) {
      // Two object directories claim the same session: keep the indexed one.
      unindexed += 1
      logger.warn(`the trash object ${object.trashId} duplicates the indexed session ${entry.sessionId}`)
      continue
    }
    const derived = deriveEntry(entry, object.presence, now)
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
  return { imported, markedMissing, unindexed, changed: changed ? 1 : 0, presence: presenceByTrashId }
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
    if (!object.metaValid || object.meta === undefined || object.entry === undefined || object.presence === undefined) continue
    const entry = object.entry
    if (seen.has(entry.sessionId)) {
      unindexed += 1
      logger.warn(`the trash object ${object.trashId} duplicates the rebuilt session ${entry.sessionId}`)
      continue
    }
    seen.add(entry.sessionId)
    entries.push(deriveEntry(entry, object.presence, now))
  }
  entries.sort((left, right) => left.startedAt - right.startedAt || left.trashId.localeCompare(right.trashId))
  await store.commit(entries)
  store.unindexed = unindexed
  return { entries: entries.length, unindexed }
}
