import path from 'node:path'
import { TrashError } from './errors.js'
import {
  createTrashId,
  directoryExists,
  entryKind,
  isInside,
  isSafeDirectoryPath,
  isSafeTrashId,
  measureDirectory,
  metricsMatch,
  moveDirectory,
  samePath,
} from './fsops.js'
import { reconcileIndex, rebuildIndex } from './inventory.js'

/** How many short retries confirm a moved or restored session is visible. */
const VISIBILITY_RETRIES = 5

/** Delay between visibility probes. */
const VISIBILITY_DELAY_MS = 100

/**
 * @param {number} milliseconds delay length.
 * @returns {Promise<void>} resolution after the delay.
 */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/**
 * @param {string} message diagnostic text.
 * @returns {string} the same text, trimmed for a wire `lastError`.
 */
function errorText(message) {
  return message.length > 500 ? `${message.slice(0, 497)}...` : message
}

/**
 * @param {unknown} error arbitrary failure.
 * @returns {string} a user-facing error message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {readonly object[]} entries current index entries.
 * @param {object} next replacement entry.
 * @returns {object[]} a new list with the entry replaced or appended.
 */
function upsertEntry(entries, next) {
  const copy = [...entries]
  const index = copy.findIndex((entry) => entry.sessionId === next.sessionId)
  if (index === -1) copy.push(next)
  else copy[index] = next
  return copy
}

/**
 * @param {readonly object[]} entries current index entries.
 * @param {string} sessionId session to drop.
 * @returns {object[]} a new list without that session.
 */
function dropEntry(entries, sessionId) {
  return entries.filter((entry) => entry.sessionId !== sessionId)
}

/**
 * Implement trash, restore (normal and orphan), permanent deletion, index
 * maintenance, and the retention sweep for cold JSONL sessions.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   store: import('./store.js').TrashStore,
 *   eligibility: { evaluate: (sessionId: string) => Promise<object>, invalidate: (sessionId?: string) => void },
 *   config: { retentionDays: number, sweepIntervalHours: number, enableAutoCleanup: boolean },
 *   logger: { info: Function, warn: Function, error: Function, debug: Function },
 *   paths: { root: string, display: string },
 * }} deps host services and resolved paths.
 * @returns {object} the operation surface.
 */
export function createTrashService({ ctx, store, eligibility, config, logger, paths }) {
  /**
   * @returns {object | undefined} the optional title service.
   */
  function sessionQuery() {
    return ctx.get('sessionQuery')
  }

  /**
   * @returns {object | undefined} the optional workspace registry.
   */
  function workspaceRegistry() {
    return ctx.get('workspaceRegistry')
  }

  /**
   * @param {string} sessionId session whose storage snapshot to read.
   * @returns {Promise<object | undefined>} the persistence snapshot.
   */
  async function stat(sessionId) {
    return ctx.sessionPersistence.stat(sessionId)
  }

  /**
   * @param {string} sessionId session to check.
   * @returns {Promise<boolean>} whether the session is live in this process.
   */
  function isLive(sessionId) {
    const liveSession = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
    const liveAgent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined
    return liveSession !== undefined || liveAgent !== undefined
  }

  /**
   * @param {object} snapshot persistence snapshot.
   * @returns {string} the session header's cwd, or an empty string when absent.
   */
  function cwdOf(snapshot) {
    return typeof snapshot?.header?.cwd === 'string' ? snapshot.header.cwd : ''
  }

  /**
   * Resolve a human title without making the operation depend on the optional
   * query service.
   *
   * @param {string} sessionId session whose title to read.
   * @param {object} header persistence header.
   * @returns {Promise<string>} the title, then cwd basename, then session id.
   */
  async function resolveTitle(sessionId, header) {
    const query = sessionQuery()
    if (query !== undefined && query !== null && typeof query.readTitle === 'function') {
      try {
        const title = await query.readTitle(sessionId)
        if (typeof title === 'string' && title.trim() !== '') return title.trim()
      } catch (error) {
        logger.warn(`cannot read the title for ${sessionId}: ${messageOf(error)}`)
      }
    }
    if (typeof header?.cwd === 'string' && header.cwd !== '') {
      const base = path.basename(header.cwd)
      if (base !== '') return base
    }
    return sessionId
  }

  /**
   * Find the Workspace that currently accounts for a session.
   *
   * @param {string} sessionId session to locate.
   * @returns {{ workspace: object, nextSessionId: string | null } | undefined} owning workspace and following sibling.
   */
  function findOwningWorkspace(sessionId) {
    const registry = workspaceRegistry()
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return undefined
    try {
      for (const workspace of registry.list()) {
        const sessionIds = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
        const index = sessionIds.indexOf(sessionId)
        if (index === -1) continue
        return { workspace, nextSessionId: sessionIds[index + 1] ?? null }
      }
    } catch (error) {
      logger.warn(`cannot read the workspace registry while trashing ${sessionId}: ${messageOf(error)}`)
    }
    return undefined
  }

  /**
   * @param {object} entry trash index entry.
   * @returns {Promise<void>} resolution once the object directory is inside `objects/`.
   */
  async function assertSafeObject(entry) {
    if (!isSafeTrashId(entry.trashId)) {
      throw new TrashError('IO_ERROR', 'The trash entry carries an unsafe object identity.')
    }
    const objectDir = store.objectDir(entry.trashId)
    if (!isInside(store.objectsDir, objectDir)) {
      throw new TrashError('IO_ERROR', 'The trash entry names an object outside the trash root.')
    }
  }

  /**
   * @param {object} entry trash index entry.
   * @returns {Promise<boolean>} whether the moved session directory still exists.
   */
  async function trashSessionExists(entry) {
    return (await entryKind(store.sessionPath(entry.trashId))) === 'directory'
  }

  /**
   * @param {string} sessionId session to probe.
   * @param {(snapshot: object | undefined) => boolean} predicate expected visibility state.
   * @returns {Promise<boolean>} whether the persistence backend agreed within the retry budget.
   */
  async function waitForVisibility(sessionId, predicate) {
    let lastError = null
    for (let attempt = 0; attempt < VISIBILITY_RETRIES; attempt += 1) {
      try {
        const snapshot = await stat(sessionId)
        if (predicate(snapshot)) return true
      } catch (error) {
        lastError = error
        if (attempt === VISIBILITY_RETRIES - 1) {
          logger.warn(`session storage visibility probe for ${sessionId} failed: ${messageOf(error)}`)
        }
      }
      if (attempt < VISIBILITY_RETRIES - 1) await sleep(VISIBILITY_DELAY_MS)
    }
    if (lastError !== null) logger.warn(`session storage never reported the expected visibility for ${sessionId}`)
    return false
  }

  /**
   * @param {string} event forwarded host event name.
   * @param {...unknown} args event payload.
   * @returns {void}
   */
  function emit(event, ...args) {
    try {
      ctx.emit(event, ...args)
    } catch (error) {
      logger.warn(`cannot emit ${event}: ${messageOf(error)}`)
    }
  }

  /**
   * Build the cold-session summary consumed by the client SessionManager.
   *
   * @param {string} sessionId restored session identity.
   * @param {string} title restored display title.
   * @param {object | undefined} snapshot persistence snapshot.
   * @returns {object} a `SessionSummary`.
   */
  function buildSummary(sessionId, title, snapshot) {
    const header = snapshot?.header ?? {}
    return {
      sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: false,
      agentAvailable: false,
      ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
      formatStatus: snapshot?.formatStatus ?? 'current',
      ...(typeof title === 'string' && title !== ''
        ? { projections: { kind: 'cached', asOfSeq: 0, values: { title } } }
        : {}),
    }
  }

  /**
   * Record a failure summary on one entry and commit it, best effort.
   *
   * @param {object} entry entry to annotate.
   * @param {string} message failure summary.
   * @returns {Promise<object>} the annotated entry.
   */
  async function markFailure(entry, message) {
    const next = { ...entry, lastError: errorText(message) }
    try {
      await store.commit(upsertEntry(store.entries(), next))
      await store.writeMeta(next).catch((error) => {
        logger.warn(`cannot rewrite trash metadata for ${next.trashId}: ${messageOf(error)}`)
      })
    } catch (error) {
      logger.error(`cannot record a trash failure for ${entry.sessionId}: ${messageOf(error)}`)
    }
    return next
  }

  /**
   * Restore the workspace accounting after a normal restore.
   *
   * @param {object} entry restored index entry.
   * @returns {Promise<{ reattached: boolean, warning?: string }>} reattachment outcome.
   */
  async function reattachWorkspace(entry) {
    const registry = workspaceRegistry()
    if (registry === undefined || registry === null || typeof registry.list !== 'function') {
      return { reattached: false, warning: 'The workspace registry is unavailable.' }
    }
    let workspace
    if (typeof entry.originalWorkspaceId === 'string' && entry.originalWorkspaceId !== '') {
      try {
        if (typeof registry.get === 'function') workspace = registry.get(entry.originalWorkspaceId)
      } catch (error) {
        logger.warn(`cannot read the original workspace for ${entry.sessionId}: ${messageOf(error)}`)
      }
    }
    if (workspace === undefined) {
      try {
        workspace = registry
          .list()
          .find((candidate) => Array.isArray(candidate?.sessionIds) && candidate.sessionIds.includes(entry.sessionId))
      } catch (error) {
        logger.warn(`cannot scan workspaces for ${entry.sessionId}: ${messageOf(error)}`)
      }
    }
    if (workspace === undefined) return { reattached: false, warning: 'The original workspace no longer exists.' }
    if (entry.originalCwd === null) return { reattached: false }
    if (!(await directoryExists(entry.originalCwd))) {
      return { reattached: false, warning: 'The original workspace directory no longer exists.' }
    }
    try {
      // Detach first so attach validates the freshly restored header and
      // rebuilds the registry's session-path index in this process.
      await workspace.detachSession(entry.sessionId)
      await workspace.attachSession(entry.sessionId)
    } catch (error) {
      logger.warn(`cannot reattach ${entry.sessionId} to its workspace: ${messageOf(error)}`)
      return { reattached: false, warning: messageOf(error) }
    }
    try {
      const nextId = entry.originalNextSessionId
      if (
        typeof nextId === 'string' &&
        nextId !== '' &&
        nextId !== entry.sessionId &&
        Array.isArray(workspace.sessionIds) &&
        workspace.sessionIds.includes(nextId)
      ) {
        await workspace.insertSessionBefore(entry.sessionId, nextId)
      } else if (typeof workspace.insertSessionBefore === 'function') {
        await workspace.insertSessionBefore(entry.sessionId)
      }
    } catch (error) {
      // The session is attached; only the exact sibling position was lost.
      logger.warn(`cannot restore the workspace position of ${entry.sessionId}: ${messageOf(error)}`)
    }
    return { reattached: true }
  }

  /**
   * Remove a session from every workspace that still accounts for it. Used by
   * orphan restore so the restored log appears under “Ungrouped”.
   *
   * @param {object} entry restored index entry.
   * @returns {Promise<{ detached: boolean, warning?: string }>} detach outcome.
   */
  async function detachWorkspace(entry) {
    const registry = workspaceRegistry()
    if (registry === undefined || registry === null || typeof registry.list !== 'function') {
      return { detached: false, warning: 'The workspace registry is unavailable, so the session could not be ungrouped.' }
    }
    let workspace
    if (typeof entry.originalWorkspaceId === 'string' && entry.originalWorkspaceId !== '') {
      try {
        if (typeof registry.get === 'function') workspace = registry.get(entry.originalWorkspaceId)
      } catch (error) {
        logger.warn(`cannot read the original workspace for ${entry.sessionId}: ${messageOf(error)}`)
      }
    }
    if (workspace === undefined) {
      try {
        workspace = registry
          .list()
          .find((candidate) => Array.isArray(candidate?.sessionIds) && candidate.sessionIds.includes(entry.sessionId))
      } catch (error) {
        logger.warn(`cannot scan workspaces for ${entry.sessionId}: ${messageOf(error)}`)
      }
    }
    if (workspace === undefined) return { detached: false }
    try {
      await workspace.detachSession(entry.sessionId)
      return { detached: true }
    } catch (error) {
      logger.warn(`cannot detach ${entry.sessionId} from its workspace: ${messageOf(error)}`)
      return { detached: false, warning: messageOf(error) }
    }
  }

  /**
   * Move one directory back and report whether the rollback physically
   * succeeded. Never throws.
   *
   * @param {string} from current path.
   * @param {string} to previous path.
   * @param {object | null | undefined} expected metrics for a cross-device copy.
   * @returns {Promise<boolean>} whether the directory now lives at `to`.
   */
  async function moveBack(from, to, expected) {
    if ((await entryKind(to)) !== 'missing') {
      logger.error(`cannot roll back a session move because ${to} already exists`)
      return false
    }
    try {
      await moveDirectory(from, to, expected, { logger })
      return true
    } catch (error) {
      logger.error(`cannot roll back a session move to ${to}: ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Drop one trash entry and its object directory after a rollback.
   *
   * @param {string} sessionId index identity.
   * @param {string | undefined} trashId optional object identity.
   * @returns {Promise<void>} resolution once the best-effort cleanup ends.
   */
  async function rollbackTrash(sessionId, trashId) {
    try {
      await store.commit(dropEntry(store.entries(), sessionId))
    } catch (error) {
      logger.error(`cannot remove the rollback trash entry for ${sessionId}: ${messageOf(error)}`)
    }
    if (typeof trashId === 'string' && isSafeTrashId(trashId)) {
      try {
        await store.removeObjectDir(trashId)
      } catch (error) {
        logger.warn(`cannot remove the rollback trash object ${trashId}: ${messageOf(error)}`)
      }
    }
  }

  /**
   * Settle a failed move by applying the `trashing` crash matrix to the live
   * filesystem. Returns a committed `trashed` entry when the data landed in the
   * trash, or `undefined` when the operation rolled back.
   *
   * @param {object} entry current `trashing` entry.
   * @param {unknown} cause failure that triggered recovery.
   * @returns {Promise<object | undefined>} the completed entry, or undefined after rollback.
   */
  async function settleFailedTrashMove(entry, cause) {
    const sourceExists = (await entryKind(entry.originalSessionDir)) === 'directory'
    const targetExists = await trashSessionExists(entry)
    const failure = messageOf(cause)
    if (sourceExists && !targetExists) {
      await rollbackTrash(entry.sessionId, entry.trashId)
      return undefined
    }
    if (!sourceExists && targetExists) {
      const measured = await measureDirectory(store.sessionPath(entry.trashId))
      if (!metricsMatch(entry, measured)) {
        await markFailure(entry, `The moved session does not match its recorded size (${failure}).`)
        throw new TrashError('MOVE_CONFLICT', 'The moved session does not match its recorded size.', { measured })
      }
      const next = { ...entry, state: 'trashed', trashedAt: Date.now(), lastError: null }
      await store.commit(upsertEntry(store.entries(), next))
      await store.writeMeta(next).catch(() => {})
      eligibility.invalidate(entry.sessionId)
      emit('api-session/removed', entry.sessionId)
      return next
    }
    if (sourceExists && targetExists) {
      const measured = await measureDirectory(store.sessionPath(entry.trashId))
      if (metricsMatch(entry, measured)) {
        try {
          await store.removeSessionSource(entry.originalSessionDir)
          const next = { ...entry, state: 'trashed', trashedAt: Date.now(), lastError: null }
          await store.commit(upsertEntry(store.entries(), next))
          await store.writeMeta(next).catch(() => {})
          eligibility.invalidate(entry.sessionId)
          emit('api-session/removed', entry.sessionId)
          return next
        } catch (error) {
          logger.warn(`cannot remove the source after copying session ${entry.sessionId}: ${messageOf(error)}`)
        }
      } else {
        // The source is authoritative: remove the unusable copy and roll back.
        await rollbackTrash(entry.sessionId, entry.trashId)
        return undefined
      }
      await markFailure(entry, failure)
      throw new TrashError('MOVE_CONFLICT', 'The session move could not be completed; both copies were kept.', {
        source: entry.originalSessionDir,
      })
    }
    await markFailure(entry, `The session log disappeared during the move (${failure}).`)
    throw new TrashError('MOVE_CONFLICT', 'The session log disappeared during the move.', {})
  }

  /**
   * Settle a failed restore move. Returns `true` when the session directory is
   * at its original location and the operation may continue.
   *
   * @param {object} entry `restoring` entry.
   * @param {unknown} cause failure that triggered recovery.
   * @returns {Promise<boolean>} whether the target now contains the restored session.
   */
  async function settleFailedRestoreMove(entry, cause) {
    const targetExists = (await entryKind(entry.originalSessionDir)) === 'directory'
    const trashExists = await trashSessionExists(entry)
    const failure = messageOf(cause)
    if (targetExists) {
      const measured = await measureDirectory(entry.originalSessionDir)
      if (metricsMatch(entry, measured)) {
        if (trashExists) {
          try {
            await store.removeObjectDir(entry.trashId)
          } catch (error) {
            logger.warn(`cannot remove the leftover trash copy for ${entry.sessionId}: ${messageOf(error)}`)
          }
        }
        return true
      }
      await markFailure(entry, `The restored session does not match its recorded size (${failure}).`)
      return false
    }
    if (trashExists) {
      const next = { ...entry, state: 'trashed', lastError: errorText(failure) }
      await store.commit(upsertEntry(store.entries(), next))
      await store.writeMeta(next).catch(() => {})
      return false
    }
    await markFailure(entry, `Both the trash copy and the restore target are missing (${failure}).`)
    return false
  }

  /**
   * @param {object} entry index entry.
   * @param {number} now current timestamp.
   * @returns {boolean} whether the retention window has elapsed.
   */
  function isExpired(entry, now) {
    if (entry.state !== 'trashed') return false
    if (typeof entry.trashedAt !== 'number' || entry.trashedAt <= 0) return false
    return entry.trashedAt + config.retentionDays * 86_400_000 <= now
  }

  /**
   * Permanently remove one object directory and its index entry. The caller
   * owns the trash lock.
   *
   * @param {object} entry `trashed` index entry to purge.
   * @returns {Promise<void>} resolution once the object and entry are gone.
   */
  async function purgeInsideLock(entry) {
    await assertSafeObject(entry)
    const purging = { ...entry, state: 'purging', lastError: null }
    await store.commit(upsertEntry(store.entries(), purging))
    await store.writeMeta(purging).catch((error) => {
      logger.warn(`cannot rewrite trash metadata for ${entry.trashId}: ${messageOf(error)}`)
    })
    try {
      await store.removeObjectDir(entry.trashId)
    } catch (error) {
      await markFailure(purging, `The session log could not be deleted: ${messageOf(error)}`)
      throw new TrashError('IO_ERROR', 'The session log could not be deleted.', { trashId: entry.trashId })
    }
    try {
      await store.commit(dropEntry(store.entries(), entry.sessionId))
    } catch (error) {
      throw new TrashError('INDEX_WRITE_FAILED', 'The session log was deleted, but the trash index could not be updated.', {
        code: error instanceof TrashError ? error.code : null,
      })
    }
    logger.info(`permanently deleted ${entry.sessionId} (${entry.trashId})`)
  }

  /**
   * Drop one `missing` entry from the index and remove its plugin-owned
   * remnants. No session file is deleted. The caller owns the trash lock.
   *
   * @param {object} entry `missing` index entry to forget.
   * @returns {Promise<{ sessionId: string, title: string }>} the removed identity.
   */
  async function forgetInsideLock(entry) {
    try {
      await store.commit(dropEntry(store.entries(), entry.sessionId))
    } catch (error) {
      throw new TrashError('INDEX_WRITE_FAILED', 'The trash index could not be updated.', {
        code: error instanceof TrashError ? error.code : null,
      })
    }
    await store.removeObjectRemnants(entry.trashId).catch((error) => {
      logger.warn(`cannot remove the remnants of ${entry.trashId}: ${messageOf(error)}`)
    })
    return { sessionId: entry.sessionId, title: entry.title }
  }

  /**
   * Move one cold session into the trash.
   *
   * @param {string} sessionId session to trash.
   * @returns {Promise<object>} the committed `trashed` entry.
   */
  async function trash(sessionId) {
    const startedAt = Date.now()
    const result = await store.withLock(async () => {
      if (store.isProtected()) {
        throw new TrashError('INDEX_CORRUPT', 'The trash index is unreadable, so protection mode refuses new entries.')
      }
      eligibility.invalidate(sessionId)
      const verdict = await eligibility.evaluate(sessionId)
      if (verdict.eligible !== true) {
        throw new TrashError(verdict.code, verdict.message, verdict.details)
      }
      const existing = store.findEntry(sessionId)
      if (existing !== undefined) {
        if (existing.state === 'missing') {
          await store.commit(dropEntry(store.entries(), sessionId))
          await store.removeObjectRemnants(existing.trashId).catch((error) => {
            logger.warn(`cannot remove the stale trash object ${existing.trashId}: ${messageOf(error)}`)
          })
        } else {
          throw new TrashError('ALREADY_TRASHED', 'This session is already recorded in the trash.')
        }
      }
      const snapshot = await stat(sessionId)
      if (snapshot === undefined) throw new TrashError('SESSION_NOT_FOUND', 'This session is not in session storage.')
      if (isLive(sessionId)) throw new TrashError('SESSION_LIVE', 'This session is open right now.')
      const location = snapshot.location
      if (location === undefined || location === null || location.kind !== 'jsonl' || typeof location.path !== 'string') {
        throw new TrashError('SESSION_NOT_MATERIALIZED', 'This session has no movable JSONL log.')
      }
      const resolvedLogPath = path.resolve(location.path)
      if (!path.isAbsolute(location.path)) {
        throw new TrashError('STORAGE_UNSUPPORTED', 'The session log path is not absolute.')
      }
      const sessionDir = path.dirname(resolvedLogPath)
      const projectDir = path.dirname(sessionDir)
      if (!isSafeDirectoryPath(sessionDir) || (await entryKind(sessionDir)) !== 'directory') {
        throw new TrashError('UNSAFE_SESSION_DIR', 'The session directory is not a plain directory this plugin can move.')
      }

      let trashId
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = createTrashId()
        const indexed = store.entries().some((entry) => entry.trashId === candidate)
        if (!indexed && (await entryKind(store.objectDir(candidate))) === 'missing') {
          trashId = candidate
          break
        }
      }
      if (trashId === undefined) throw new TrashError('IO_ERROR', 'Cannot allocate a unique trash identity.')

      try {
        await store.createObjectDir(trashId)
      } catch (error) {
        throw new TrashError('IO_ERROR', `Cannot create the trash object directory: ${messageOf(error)}`, {
          code: error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null,
          phase: 'create-object',
        })
      }
      let entry
      try {
        const measured = await measureDirectory(sessionDir)
        const title = await resolveTitle(sessionId, snapshot.header)
        const originalCwd = cwdOf(snapshot) === '' ? null : cwdOf(snapshot)
        const workspaceInfo = findOwningWorkspace(sessionId)
        entry = {
          sessionId,
          trashId,
          state: 'trashing',
          title,
          trashedAt: 0,
          startedAt,
          originalCwd,
          workspaceExistsAtDeletion: originalCwd === null ? null : await directoryExists(originalCwd),
          originalWorkspaceId: workspaceInfo?.workspace?.id ?? null,
          originalWorkspaceTitle: workspaceInfo?.workspace?.title ?? null,
          originalNextSessionId: workspaceInfo?.nextSessionId ?? null,
          originalSessionDir: sessionDir,
          originalLogPath: resolvedLogPath,
          persistenceProjectDirHint: projectDir,
          formatStatus: snapshot.formatStatus ?? 'current',
          sizeBytes: measured.sizeBytes,
          fileCount: measured.fileCount,
          lastError: null,
        }
        await store.writeMeta(entry)
        await store.commit(upsertEntry(store.entries(), entry))
      } catch (error) {
        await rollbackTrash(sessionId, trashId)
        throw error instanceof TrashError
          ? error
          : new TrashError('IO_ERROR', `Cannot prepare the trash entry: ${messageOf(error)}`)
      }

      // Another process may have opened or resumed the session between the
      // preflight and the move. Re-check live state while the trash lock is
      // held; the source is still untouched at this point.
      if (isLive(sessionId)) {
        await rollbackTrash(sessionId, trashId)
        throw new TrashError('SESSION_LIVE', 'This session became live before it could be moved.')
      }

      try {
        await moveDirectory(sessionDir, store.sessionPath(trashId), entry, { logger })
      } catch (error) {
        let settled
        try {
          settled = await settleFailedTrashMove(entry, error)
        } catch (settleError) {
          await markFailure(entry, messageOf(settleError))
          throw settleError
        }
        if (settled !== undefined) return settled
        throw error instanceof TrashError
          ? error
          : new TrashError('IO_ERROR', `Cannot move the session into the trash: ${messageOf(error)}`)
      }

      let measured
      try {
        measured = await measureDirectory(store.sessionPath(trashId))
      } catch (error) {
        let settled
        try {
          settled = await settleFailedTrashMove(entry, error)
        } catch (settleError) {
          await markFailure(entry, messageOf(settleError))
          throw settleError
        }
        if (settled !== undefined) return settled
        throw new TrashError('MOVE_VERIFY_FAILED', `Cannot verify the moved session: ${messageOf(error)}`)
      }
      if (!metricsMatch(entry, measured)) {
        const movedBack = await moveBack(store.sessionPath(trashId), sessionDir, entry)
        if (!movedBack) {
          await markFailure(entry, 'The moved session does not match its recorded size, and moving it back failed.')
          throw new TrashError('MOVE_CONFLICT', 'The session was moved but could not be verified or rolled back.')
        }
        await rollbackTrash(sessionId, trashId)
        throw new TrashError('MOVE_VERIFY_FAILED', 'The moved session does not match its recorded size.', {
          expected: { sizeBytes: entry.sizeBytes, fileCount: entry.fileCount },
          measured,
        })
      }
      const hidden = await waitForVisibility(sessionId, (current) => current === undefined)
      if (!hidden) {
        const movedBack = await moveBack(store.sessionPath(trashId), sessionDir, entry)
        if (!movedBack) {
          await markFailure(entry, 'Session storage still reports the moved session, and moving it back failed.')
          throw new TrashError('MOVE_CONFLICT', 'The session was moved but session storage still reports it.')
        }
        await rollbackTrash(sessionId, trashId)
        throw new TrashError('MOVE_VERIFY_FAILED', 'Session storage still reports the session after the move.')
      }

      const next = { ...entry, state: 'trashed', trashedAt: Date.now(), lastError: null }
      try {
        await store.commit(upsertEntry(store.entries(), next))
      } catch (error) {
        await markFailure(entry, `The trash index could not be committed: ${messageOf(error)}`)
        throw new TrashError('INDEX_WRITE_FAILED', 'The session moved, but the trash index could not be updated.')
      }
      await store.writeMeta(next).catch((error) => {
        logger.warn(`cannot rewrite trash metadata for ${trashId}: ${messageOf(error)}`)
      })
      eligibility.invalidate(sessionId)
      emit('api-session/removed', sessionId)
      logger.info(`trashed ${sessionId} as ${trashId} in ${Date.now() - startedAt}ms`)
      return next
    })
    return result
  }

  /**
   * Restore one trashed session to its original directory. Phase 2 supports
   * `normal` only; orphan restore arrives later.
   *
   * @param {string} sessionId session to restore.
   * @param {'normal' | 'orphan'} [mode] restore mode; orphan restores the log and detaches the Workspace.
   * @returns {Promise<object>} the restore result.
   */
  async function restore(sessionId, mode = 'normal') {
    if (mode !== 'normal' && mode !== 'orphan') {
      throw new TrashError('INVALID_REQUEST', 'mode must be "normal" or "orphan".')
    }
    const startedAt = Date.now()
    return store.withLock(async () => {
      if (store.isProtected()) {
        throw new TrashError('INDEX_CORRUPT', 'The trash index is unreadable, so protection mode refuses restores.')
      }
      const entry = store.findEntry(sessionId)
      if (entry === undefined) throw new TrashError('TRASH_ENTRY_NOT_FOUND', 'This session is not in the trash.')
      if (entry.state !== 'trashed') {
        throw new TrashError('TRASH_STATE_INVALID', `The trash entry is in state "${entry.state}" and cannot be restored.`)
      }
      await assertSafeObject(entry)
      const target = path.resolve(String(entry.originalSessionDir))
      const projectDirHint = path.resolve(String(entry.persistenceProjectDirHint))
      if (
        !isSafeDirectoryPath(target) ||
        !samePath(path.dirname(target), projectDirHint) ||
        isInside(paths.root, target) ||
        !isInside(paths.root, store.objectDir(entry.trashId)) ||
        typeof entry.originalLogPath !== 'string' ||
        !samePath(path.dirname(path.resolve(entry.originalLogPath)), target)
      ) {
        throw new TrashError('UNSAFE_RESTORE_PATH', 'The restore target failed the path safety check.')
      }
      const projectDirKind = await entryKind(projectDirHint)
      if (projectDirKind !== 'missing' && projectDirKind !== 'directory') {
        throw new TrashError('UNSAFE_RESTORE_PATH', 'The restore target parent is not a plain directory.')
      }
      const targetKind = await entryKind(target)
      if (targetKind !== 'missing') {
        throw new TrashError('RESTORE_TARGET_EXISTS', 'A directory already exists at the restore target.')
      }
      if (!(await trashSessionExists(entry))) {
        const missing = { ...entry, state: 'missing', lastError: 'The trash object directory is missing.' }
        await store.commit(upsertEntry(store.entries(), missing))
        await store.writeMeta(missing).catch(() => {})
        throw new TrashError('TRASH_DIR_MISSING', 'The trash copy of this session is missing.')
      }
      if (entry.originalCwd !== null && !(await directoryExists(entry.originalCwd))) {
        if (mode === 'normal') {
          throw new TrashError('WORKSPACE_MISSING', 'The original workspace directory no longer exists.')
        }
      }

      const restoring = { ...entry, state: 'restoring', lastError: null }
      await store.commit(upsertEntry(store.entries(), restoring))
      await store.writeMeta(restoring).catch((error) => {
        logger.warn(`cannot rewrite trash metadata for ${entry.trashId}: ${messageOf(error)}`)
      })

      try {
        await moveDirectory(store.sessionPath(entry.trashId), target, entry, { logger })
      } catch (error) {
        // A target created between the pre-check and the move belongs to
        // someone else: never treat it as the restored copy.
        if (error instanceof TrashError && error.code === 'RESTORE_TARGET_EXISTS') throw error
        let completed
        try {
          completed = await settleFailedRestoreMove(restoring, error)
        } catch (settleError) {
          await markFailure(restoring, messageOf(settleError))
          throw settleError
        }
        if (!completed) {
          throw error instanceof TrashError
            ? error
            : new TrashError('IO_ERROR', `Cannot move the session back: ${messageOf(error)}`)
        }
      }

      let measured
      try {
        measured = await measureDirectory(target)
      } catch (error) {
        throw new TrashError('RESTORE_VERIFY_FAILED', `Cannot verify the restored session: ${messageOf(error)}`)
      }
      if (!metricsMatch(entry, measured)) {
        const rolledBack = await moveBack(target, store.sessionPath(entry.trashId), measured)
        if (!rolledBack) {
          await markFailure(restoring, 'The restored session does not match its recorded size, and moving it back failed.')
          throw new TrashError('MOVE_CONFLICT', 'The restored session does not match its recorded size.')
        }
        const next = { ...restoring, state: 'trashed', lastError: 'The restored session did not match its recorded size.' }
        await store.commit(upsertEntry(store.entries(), next))
        await store.writeMeta(next).catch(() => {})
        throw new TrashError('RESTORE_VERIFY_FAILED', 'The restored session does not match its recorded size.', {
          expected: { sizeBytes: entry.sizeBytes, fileCount: entry.fileCount },
          measured,
        })
      }
      const visible = await waitForVisibility(
        sessionId,
        (current) => current !== undefined && current !== null && current.location !== undefined,
      )
      if (!visible) {
        const rolledBack = await moveBack(target, store.sessionPath(entry.trashId), measured)
        if (!rolledBack) {
          await markFailure(restoring, 'Session storage cannot see the restored session, and moving it back failed.')
          throw new TrashError('MOVE_CONFLICT', 'Session storage cannot see the restored session.')
        }
        const next = { ...restoring, state: 'trashed', lastError: 'The restored session was not visible to session storage.' }
        await store.commit(upsertEntry(store.entries(), next))
        await store.writeMeta(next).catch(() => {})
        throw new TrashError('RESTORE_VERIFY_FAILED', 'The restored session was not visible to session storage.')
      }

      const attachment = mode === 'orphan' ? await detachWorkspace(entry) : await reattachWorkspace(entry)
      const restoredSnapshot = await stat(sessionId).catch(() => undefined)

      try {
        await store.commit(dropEntry(store.entries(), sessionId))
      } catch (error) {
        await markFailure(restoring, `The trash index could not be committed after restore: ${messageOf(error)}`)
        throw new TrashError('INDEX_WRITE_FAILED', 'The session was restored, but the trash index could not be updated.')
      }
      await store.removeObjectDir(entry.trashId).catch((error) => {
        logger.warn(`cannot remove the restored trash object ${entry.trashId}: ${messageOf(error)}`)
      })
      eligibility.invalidate(sessionId)
      emit('api-session/added', buildSummary(sessionId, entry.title, restoredSnapshot))
      logger.info(`restored ${sessionId} from ${entry.trashId} (${mode}) in ${Date.now() - startedAt}ms`)
      return {
        sessionId,
        title: entry.title,
        orphan: mode === 'orphan',
        workspaceReattached: mode === 'orphan' ? false : attachment.reattached === true,
        ...(attachment.warning === undefined ? {} : { warning: attachment.warning }),
      }
    })
  }

  /**
   * Apply the crash matrix to every index entry. The caller must hold the trash
   * lock. It never deletes an unindexed object and never removes a `missing`
   * entry on its own.
   *
   * @returns {Promise<{ changed: number, completed: number, rolledBack: number, missing: number }>} recovery summary.
   */
  async function recoverInsideLock() {
    let entries = [...store.entries()]
    let changed = 0
    let completed = 0
    let rolledBack = 0
    let missing = 0
    const commit = (next) => {
      if (next === undefined) return
      entries = upsertEntry(entries, next)
    }
    const drop = (sessionId) => {
      entries = dropEntry(entries, sessionId)
    }
    const fail = (entry, message) => ({ ...entry, lastError: errorText(message) })

    for (const original of store.entries()) {
      try {
        if (original.state === 'purging') {
          await assertSafeObject(original)
          await store.removeObjectDir(original.trashId)
          drop(original.sessionId)
          completed += 1
          changed += 1
          continue
        }

        if (original.state === 'trashing') {
          await assertSafeObject(original)
          const sourceExists = (await entryKind(original.originalSessionDir)) === 'directory'
          const targetExists = await trashSessionExists(original)
          if (!sourceExists && !targetExists) {
            commit({ ...original, state: 'missing', lastError: 'Both the session source and the trash copy are missing.' })
            missing += 1
          } else if (!sourceExists && targetExists) {
            const measured = await measureDirectory(store.sessionPath(original.trashId))
            if (!metricsMatch(original, measured)) {
              commit(fail({ ...original, state: 'trashing' }, 'The trash copy does not match the recorded size.'))
            } else {
              commit({ ...original, state: 'trashed', trashedAt: original.startedAt || Date.now(), lastError: null })
              completed += 1
            }
          } else if (sourceExists && !targetExists) {
            await store.removeObjectDir(original.trashId).catch((error) => {
              logger.warn(`cannot remove the rolled-back trash object ${original.trashId}: ${messageOf(error)}`)
            })
            drop(original.sessionId)
            rolledBack += 1
          } else {
            const measured = await measureDirectory(store.sessionPath(original.trashId))
            if (!metricsMatch(original, measured)) {
              await store.removeObjectDir(original.trashId)
              drop(original.sessionId)
              rolledBack += 1
            } else {
              try {
                await store.removeSessionSource(original.originalSessionDir)
                commit({ ...original, state: 'trashed', trashedAt: original.startedAt || Date.now(), lastError: null })
                completed += 1
              } catch (error) {
                commit(fail(original, `Cannot remove the source after completing the move: ${messageOf(error)}`))
              }
            }
          }
          changed += 1
          continue
        }

        if (original.state === 'restoring') {
          await assertSafeObject(original)
          const sourceExists = (await entryKind(original.originalSessionDir)) === 'directory'
          const targetExists = await trashSessionExists(original)
          if (sourceExists) {
            const measured = await measureDirectory(original.originalSessionDir)
            const visible = metricsMatch(original, measured)
              ? await waitForVisibility(original.sessionId, (current) => current !== undefined && current !== null && current.location !== undefined)
              : false
            if (!visible) {
              commit(fail(original, 'The restored session is not visible to session storage.'))
              changed += 1
              continue
            }
            await store.removeObjectDir(original.trashId).catch((error) => {
              logger.warn(`cannot remove the trash object ${original.trashId}: ${messageOf(error)}`)
            })
            drop(original.sessionId)
            completed += 1
            changed += 1
            continue
          }
          if (targetExists) {
            commit({ ...original, state: 'trashed', lastError: 'Recovered the trash copy after an interrupted restore.' })
            rolledBack += 1
          } else {
            commit({ ...original, state: 'missing', lastError: 'Both the trash copy and the restore target are missing.' })
            missing += 1
          }
          changed += 1
          continue
        }

        if (original.state === 'trashed') {
          await assertSafeObject(original)
          const sourceExists = (await entryKind(original.originalSessionDir)) === 'directory'
          const targetExists = await trashSessionExists(original)
          if (!targetExists) {
            commit({
              ...original,
              state: 'missing',
              lastError: sourceExists
                ? 'The trash copy is missing; the original session directory is still present.'
                : 'The trash copy is missing.',
            })
            missing += 1
            changed += 1
            continue
          }
          if (sourceExists) {
            commit(fail(original, 'The original session directory unexpectedly exists alongside the trash copy; both were kept.'))
            changed += 1
          }
        }
      } catch (error) {
        logger.warn(`cannot reconcile trash entry ${original.sessionId}: ${messageOf(error)}`)
        commit(fail(original, messageOf(error)))
      }
    }

    if (changed > 0) {
      await store.commit(entries)
      for (const entry of entries) {
        await store.writeMeta(entry).catch((error) => {
          logger.warn(`cannot refresh trash metadata for ${entry.trashId}: ${messageOf(error)}`)
        })
      }
    }
    return { changed, completed, rolledBack, missing }
  }

  /**
   * Import object directories missing from the index and flag entries whose
   * object directory vanished. The caller must hold the trash lock.
   *
   * @param {number} now current timestamp.
   * @returns {Promise<object>} reconcile summary.
   */
  async function reconcileInsideLock(now) {
    try {
      const summary = await reconcileIndex({ store, logger, now })
      if (summary.imported > 0 || summary.markedMissing > 0 || summary.unindexed > 0) {
        logger.info(
          `trash index reconciled: imported ${summary.imported}, marked ${summary.markedMissing} missing, ${summary.unindexed} unindexed objects`,
        )
      }
      return summary
    } catch (error) {
      logger.warn(`trash index reconciliation failed: ${messageOf(error)}`)
      return { imported: 0, markedMissing: 0, unindexed: store.unindexed, changed: 0 }
    }
  }

  /**
   * Reconcile, settle unfinished operations, and optionally purge expired
   * entries. Used by startup recovery, the scheduled sweep, and manual cleanup.
   *
   * @param {{ allowPurge?: boolean, now?: number, reason?: string }} [options] sweep policy.
   * @returns {Promise<object>} the sweep summary.
   */
  async function sweep({ allowPurge = true, now = Date.now(), reason = 'scheduled' } = {}) {
    return store.withLock(async () => {
      if (store.isProtected()) {
        throw new TrashError('INDEX_CORRUPT', 'The trash index is unreadable, so protection mode refuses cleanup.')
      }
      const reconcile = await reconcileInsideLock(now)
      const recovery = await recoverInsideLock()
      let purged = 0
      let failed = 0
      if (allowPurge) {
        for (const entry of [...store.entries()]) {
          if (!isExpired(entry, now)) continue
          try {
            await purgeInsideLock(entry)
            purged += 1
          } catch (error) {
            failed += 1
            logger.warn(`cannot purge the expired session ${entry.sessionId}: ${messageOf(error)}`)
          }
        }
      }
      return { ...recovery, reconcile, purged, failed, allowPurge, reason }
    })
  }

  /**
   * Restore the index from object sidecars after the primary index and its
   * backup were both rejected.
   *
   * @returns {Promise<{ entries: number, unindexed: number }>} rebuild summary.
   */
  async function rebuild() {
    return store.withLock(async () => {
      if (!store.isProtected()) {
        throw new TrashError('INDEX_NOT_CORRUPT', 'The trash index is readable, so it does not need a rebuild.')
      }
      const summary = await rebuildIndex({ store, logger, now: Date.now() })
      const recovery = await recoverInsideLock()
      logger.info(
        `rebuilt the trash index from object metadata: ${store.entries().length} entries, ${store.unindexed} unindexed, ${recovery.changed} settled`,
      )
      return { entries: store.entries().length, unindexed: store.unindexed, recovery }
    })
  }

  /**
   * Permanently delete one trashed session log.
   *
   * @param {string} sessionId session to purge.
   * @returns {Promise<{ sessionId: string, title: string }>} the removed identity.
   */
  async function purge(sessionId) {
    return store.withLock(async () => {
      if (store.isProtected()) {
        throw new TrashError('INDEX_CORRUPT', 'The trash index is unreadable, so protection mode refuses deletion.')
      }
      const entry = store.findEntry(sessionId)
      if (entry === undefined) throw new TrashError('TRASH_ENTRY_NOT_FOUND', 'This session is not in the trash.')
      if (entry.state !== 'trashed') {
        throw new TrashError('TRASH_STATE_INVALID', `The trash entry is in state "${entry.state}" and cannot be deleted.`)
      }
      await purgeInsideLock(entry)
      return { sessionId, title: entry.title }
    })
  }

  /**
   * Permanently delete every trashed session and forget every `missing` index
   * entry. Interrupted moves are settled first; each entry is then attempted
   * independently so one failure never aborts the rest. Protection mode refuses
   * the whole operation before anything is mutated.
   *
   * @returns {Promise<{
   *   purged: number,
   *   forgotten: number,
   *   failed: number,
   *   failures: { sessionId: string, title: string, message: string }[],
   *   changed: number,
   * }>} the bulk summary; `changed` is non-zero whenever this call settled or
   * removed entries.
   */
  async function purgeAll() {
    return store.withLock(async () => {
      if (store.isProtected()) {
        throw new TrashError('INDEX_CORRUPT', 'The trash index is unreadable, so protection mode refuses deletion.')
      }
      const reconcile = await reconcileInsideLock(Date.now())
      const recovery = await recoverInsideLock()
      let purged = 0
      let forgotten = 0
      let failed = 0
      const failures = []
      for (const entry of [...store.entries()]) {
        const title = typeof entry.title === 'string' ? entry.title : ''
        try {
          if (entry.state === 'trashed') {
            await purgeInsideLock(entry)
            purged += 1
            continue
          }
          if (entry.state === 'missing') {
            await forgetInsideLock(entry)
            forgotten += 1
            continue
          }
          failed += 1
          const message = `The trash entry is in state "${entry.state}" and cannot be cleaned up.`
          failures.push({ sessionId: entry.sessionId, title, message })
          logger.warn(`cannot purge the session ${entry.sessionId}: ${message}`)
        } catch (error) {
          failed += 1
          failures.push({ sessionId: entry.sessionId, title, message: messageOf(error) })
          logger.warn(`cannot purge the trashed session ${entry.sessionId}: ${messageOf(error)}`)
        }
      }
      logger.info(`bulk purge finished: purged ${purged}, forgotten ${forgotten}, failed ${failed}`)
      return {
        purged,
        forgotten,
        failed,
        failures,
        changed: reconcile.changed + recovery.changed + purged + forgotten,
      }
    })
  }

  /**
   * Remove one `missing` entry from the index without deleting any session
   * file. Used when the object directory vanished outside this plugin.
   *
   * @param {string} sessionId missing entry to forget.
   * @returns {Promise<{ sessionId: string, title: string }>} the removed identity.
   */
  async function forget(sessionId) {
    return store.withLock(async () => {
      if (store.isProtected()) {
        throw new TrashError('INDEX_CORRUPT', 'The trash index is unreadable, so protection mode refuses changes.')
      }
      const entry = store.findEntry(sessionId)
      if (entry === undefined) throw new TrashError('TRASH_ENTRY_NOT_FOUND', 'This session is not in the trash.')
      if (entry.state !== 'missing') {
        throw new TrashError('FORGET_NOT_ALLOWED', 'Only an entry whose session log is missing may be removed from the index.')
      }
      return forgetInsideLock(entry)
    })
  }

  /**
   * Reveal the original workspace of one trashed session in the desktop file
   * manager.
   *
   * @param {string} sessionId session whose workspace to reveal.
   * @param {AbortSignal} [signal] caller lifetime.
   * @returns {Promise<{ path: string }>} the revealed directory.
   */
  async function reveal(sessionId, signal) {
    const entry = store.findEntry(sessionId)
    if (entry === undefined) throw new TrashError('TRASH_ENTRY_NOT_FOUND', 'This session is not in the trash.')
    const target = typeof entry.originalCwd === 'string' && entry.originalCwd !== '' ? entry.originalCwd : null
    if (target === null) throw new TrashError('REVEAL_UNAVAILABLE', 'This session has no original workspace to reveal.')
    if (!(await directoryExists(target))) {
      throw new TrashError('WORKSPACE_MISSING', 'The original workspace directory no longer exists.')
    }
    const controller = ctx.get('sessionController')
    if (controller === null || controller === undefined || typeof controller.openWorkspacePath !== 'function') {
      throw new TrashError('REVEAL_UNAVAILABLE', 'This desktop cannot open the original workspace.')
    }
    let canOpen = true
    try {
      if (typeof controller.canOpenWorkspacePath === 'function') canOpen = controller.canOpenWorkspacePath() !== false
    } catch (error) {
      logger.warn(`cannot probe native path opening: ${messageOf(error)}`)
      canOpen = false
    }
    if (!canOpen) throw new TrashError('REVEAL_UNAVAILABLE', 'This desktop cannot open the original workspace.')
    try {
      signal?.throwIfAborted?.()
      await controller.openWorkspacePath({ path: target, action: 'reveal' }, signal)
    } catch (error) {
      if (error instanceof TrashError) throw error
      if (error !== null && error !== undefined && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
        throw new TrashError('IO_ERROR', 'The reveal request was cancelled.')
      }
      throw new TrashError('REVEAL_FAILED', `The original workspace could not be opened: ${messageOf(error)}`)
    }
    return { path: target }
  }

  /**
   * Apply the crash matrix to every index entry. Startup calls this once; it
   * never deletes an unindexed object and never touches `missing` entries.
   *
   * @returns {Promise<{ changed: number, completed: number, rolledBack: number, missing: number }>} recovery summary.
   */
  async function recover() {
    if (store.isProtected()) {
      logger.warn('trash recovery skipped because the index is in protection mode')
      return { changed: 0, completed: 0, rolledBack: 0, missing: 0 }
    }
    let summary
    try {
      summary = await store.withLock(async () => {
        if (store.isProtected()) return { changed: 0, completed: 0, rolledBack: 0, missing: 0 }
        await reconcileInsideLock(Date.now())
        return await recoverInsideLock()
      })
    } catch (error) {
      if (error instanceof TrashError && error.code === 'LOCKED') {
        logger.warn('trash recovery skipped because another instance holds the trash lock')
        return { changed: 0, completed: 0, rolledBack: 0, missing: 0 }
      }
      throw error
    }
    if (summary.changed > 0) {
      logger.info(
        `trash recovery reconciled ${summary.changed} entries (${summary.completed} completed, ${summary.rolledBack} rolled back, ${summary.missing} missing)`,
      )
    }
    return summary
  }

  return { trash, restore, recover, purge, purgeAll, forget, sweep, rebuild, reveal }
}
