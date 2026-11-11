import fs from 'node:fs/promises'
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
import { mapLimit } from './concurrency.js'
import { reconcileIndex, rebuildIndex, memberPresence } from './inventory.js'
import { aggregateMetrics, memberList } from './members.js'

/** How many short retries confirm a moved or restored session is visible. */
const VISIBILITY_RETRIES = 5

/** Delay between visibility probes. */
const VISIBILITY_DELAY_MS = 100

/** Maximum concurrent object deletions and sidecar rewrites during a purge. */
const PURGE_CONCURRENCY = 4

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
   * @param {unknown} target path to probe.
   * @returns {Promise<string>} the entry kind, treating an absent path as missing.
   */
  async function kindOf(target) {
    return typeof target === 'string' && target !== '' ? entryKind(target) : 'missing'
  }

  /**
   * @param {object} entry index entry.
   * @returns {object[]} every owned directory, parent first.
   */
  function membersOf(entry) {
    return memberList(entry)
  }

  /**
   * @param {object} entry index entry.
   * @param {number} index member position.
   * @returns {string} this member's directory inside the trash object.
   */
  function memberTrashPath(entry, index) {
    return store.memberPath(entry.trashId, index, membersOf(entry)[index].sessionId)
  }

  /**
   * @param {object} entry trash index entry.
   * @returns {Promise<void>} resolution once every member path stays inside `objects/`.
   */
  async function assertSafeObject(entry) {
    if (!isSafeTrashId(entry.trashId)) {
      throw new TrashError('IO_ERROR', 'The trash entry carries an unsafe object identity.')
    }
    const objectDir = store.objectDir(entry.trashId)
    if (!isInside(store.objectsDir, objectDir)) {
      throw new TrashError('IO_ERROR', 'The trash entry names an object outside the trash root.')
    }
    const members = membersOf(entry)
    for (let index = 0; index < members.length; index += 1) {
      const memberPath = path.resolve(memberTrashPath(entry, index))
      if (!isInside(objectDir, memberPath)) {
        throw new TrashError('IO_ERROR', 'The trash entry names a member outside its object.')
      }
    }
  }

  /**
   * Probe every member directory in parallel: where the source copy and the
   * trash copy currently live.
   *
   * @param {object} entry index entry.
   * @returns {Promise<{ index: number, member: object, source: boolean, trash: boolean }[]>} member positions.
   */
  async function memberRows(entry) {
    const members = membersOf(entry)
    return Promise.all(
      members.map(async (member, index) => {
        const [sourceKind, trashKind] = await Promise.all([
          kindOf(member.originalSessionDir),
          kindOf(memberTrashPath(entry, index)),
        ])
        return {
          index,
          member,
          source: sourceKind === 'directory',
          trash: trashKind === 'directory',
        }
      }),
    )
  }

  /**
   * Probe only the original session directories of every member, in parallel.
   * Used by recovery after the trash copies were already proven present.
   *
   * @param {object} entry index entry.
   * @returns {Promise<{ index: number, member: object, source: boolean }[]>} member source positions.
   */
  async function sourceRows(entry) {
    const members = membersOf(entry)
    return Promise.all(
      members.map(async (member, index) => ({
        index,
        member,
        source: (await kindOf(member.originalSessionDir)) === 'directory',
      })),
    )
  }

  /**
   * @param {object} entry index entry.
   * @param {number} index member position.
   * @returns {Promise<void>} resolution once the member directory moved into its object.
   */
  async function moveMemberToTrash(entry, index) {
    const member = membersOf(entry)[index]
    await moveDirectory(member.originalSessionDir, memberTrashPath(entry, index), member, { logger })
  }

  /**
   * @param {object} entry index entry.
   * @param {number} index member position.
   * @returns {Promise<void>} resolution once the member directory moved back to its original location.
   */
  async function moveMemberBack(entry, index) {
    const member = membersOf(entry)[index]
    await moveDirectory(memberTrashPath(entry, index), member.originalSessionDir, member, { logger })
  }

  /**
   * @param {object} entry index entry.
   * @param {readonly { index: number }[]} rows members to move into the object.
   * @returns {Promise<{ index: number, error: unknown }[]>} per-member failures.
   */
  async function moveMembersIntoTrash(entry, rows) {
    const failures = []
    for (const row of [...rows].sort((left, right) => right.index - left.index)) {
      try {
        await moveMemberToTrash(entry, row.index)
      } catch (error) {
        failures.push({ index: row.index, error })
      }
    }
    return failures
  }

  /**
   * @param {object} entry index entry.
   * @param {readonly { index: number }[]} rows members to move back to their original locations.
   * @returns {Promise<{ index: number, error: unknown }[]>} per-member failures.
   */
  async function moveMembersBackFromTrash(entry, rows) {
    const failures = []
    for (const row of [...rows].sort((left, right) => left.index - right.index)) {
      try {
        await moveMemberBack(entry, row.index)
      } catch (error) {
        failures.push({ index: row.index, error })
      }
    }
    return failures
  }

  /**
   * Move every member directory into the trash object, children first and the
   * visible parent last so the sidebar keeps the row until the move settles.
   *
   * @param {object} entry index entry.
   * @returns {Promise<void>} resolution once every member directory moved.
   */
  async function moveMembersToTrash(entry) {
    const rows = membersOf(entry).map((_, index) => ({ index }))
    const failures = await moveMembersIntoTrash(entry, rows)
    if (failures.length === 0) return
    const failure = failures[0]
    throw failure.error instanceof TrashError
      ? failure.error
      : new TrashError('IO_ERROR', `Cannot move a session directory into the trash: ${messageOf(failure.error)}`)
  }

  /**
   * @param {object} entry index entry.
   * @param {number} index member position.
   * @returns {Promise<void>} resolution once the unusable trash copy is gone.
   */
  async function removeTrashMember(entry, index) {
    const target = path.resolve(memberTrashPath(entry, index))
    const objectDir = path.resolve(store.objectDir(entry.trashId))
    if (samePath(objectDir, target) || !isInside(objectDir, target)) {
      throw new TrashError('IO_ERROR', 'Refusing to remove a member directory outside its trash object.')
    }
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  /**
   * @param {object} member planned member whose restored copy failed verification.
   * @returns {Promise<void>} resolution once the unusable restored copy is gone.
   */
  async function removeRestoredMember(member) {
    const target = path.resolve(String(member.originalSessionDir))
    if (!isSafeDirectoryPath(target) || isInside(paths.root, target)) {
      throw new TrashError('IO_ERROR', 'Refusing to remove an unsafe session directory.')
    }
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  /**
   * @param {object} entry index entry.
   * @returns {Promise<{ ok: boolean, index?: number, message?: string }>} whether every member landed with its recorded metrics.
   */
  async function verifyTrashedMembers(entry) {
    const members = membersOf(entry)
    for (let index = 0; index < members.length; index += 1) {
      let measured
      try {
        measured = await measureDirectory(memberTrashPath(entry, index))
      } catch (error) {
        return { ok: false, index, message: messageOf(error) }
      }
      if (!metricsMatch(members[index], measured)) {
        return { ok: false, index, message: 'the recorded size does not match' }
      }
      if ((await kindOf(members[index].originalSessionDir)) !== 'missing') {
        return { ok: false, index, message: 'the original directory still exists' }
      }
    }
    return { ok: true }
  }

  /**
   * @param {object} entry index entry.
   * @returns {Promise<{ ok: boolean, index?: number, message?: string }>} whether every member returned with its recorded metrics.
   */
  async function verifyRestoredMembers(entry) {
    const members = membersOf(entry)
    for (let index = 0; index < members.length; index += 1) {
      let measured
      try {
        measured = await measureDirectory(members[index].originalSessionDir)
      } catch (error) {
        return { ok: false, index, message: messageOf(error) }
      }
      if (!metricsMatch(members[index], measured)) {
        return { ok: false, index, message: 'the recorded size does not match' }
      }
    }
    return { ok: true }
  }

  /**
   * @param {object} entry index entry.
   * @returns {Promise<{ hidden: boolean, sessionId?: string }>} whether session storage stopped reporting every member.
   */
  async function waitForMembersHidden(entry) {
    const results = await Promise.all(
      membersOf(entry).map(async (member) => ({
        sessionId: member.sessionId,
        hidden: await waitForVisibility(member.sessionId, (current) => current === undefined || current === null),
      })),
    )
    const failed = results.find((result) => !result.hidden)
    return failed === undefined ? { hidden: true } : { hidden: false, sessionId: failed.sessionId }
  }

  /**
   * @param {object} entry index entry.
   * @returns {Promise<{ visible: boolean, sessionId?: string }>} whether session storage reports every member again.
   */
  async function waitForMembersVisible(entry) {
    const results = await Promise.all(
      membersOf(entry).map(async (member) => ({
        sessionId: member.sessionId,
        visible: await waitForVisibility(
          member.sessionId,
          (current) => current !== undefined && current !== null && current.location !== undefined,
        ),
      })),
    )
    const failed = results.find((result) => !result.visible)
    return failed === undefined ? { visible: true } : { visible: false, sessionId: failed.sessionId }
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
   * Resolve every member directory of a `trashing` entry to either the trash
   * object or its original location. Never writes the index: the caller owns
   * the commit so startup recovery can accumulate one write.
   *
   * @param {object} entry `trashing` index entry.
   * @returns {Promise<{ kind: 'ready' } | { kind: 'rolledBack' } | { kind: 'missing', entry: object }>} the settled position.
   */
  async function resolveTrashing(entry) {
    const rows = await memberRows(entry)
    const lost = rows.filter((row) => !row.source && !row.trash)
    if (lost.length > 0) {
      return {
        kind: 'missing',
        entry: {
          ...entry,
          state: 'missing',
          lastError: errorText(`The trash copy is missing for: ${lost.map((row) => row.member.sessionId).join(', ')}`),
        },
      }
    }
    for (const row of rows) {
      if (!row.source || !row.trash) continue
      const measured = await measureDirectory(memberTrashPath(entry, row.index))
      if (metricsMatch(row.member, measured)) {
        await store.removeSessionSource(row.member.originalSessionDir)
        row.source = false
      } else {
        await removeTrashMember(entry, row.index)
        row.trash = false
      }
    }
    const inTrash = rows.filter((row) => row.trash)
    const inSource = rows.filter((row) => row.source)
    if (inTrash.length === 0) return { kind: 'rolledBack' }
    if (inSource.length > 0) {
      const failures = await moveMembersIntoTrash(entry, inSource)
      if (failures.length > 0) {
        const current = await memberRows(entry)
        const rollback = await moveMembersBackFromTrash(entry, current.filter((row) => row.trash))
        if (rollback.length === 0) return { kind: 'rolledBack' }
        await markFailure(entry, `The session tree could not be completed or rolled back: ${messageOf(failures[0].error)}`)
        throw new TrashError('MOVE_CONFLICT', 'The session tree could not be moved or rolled back; both copies were kept.')
      }
    }
    const verified = await verifyTrashedMembers(entry)
    if (!verified.ok) {
      const current = await memberRows(entry)
      const rollback = await moveMembersBackFromTrash(entry, current.filter((row) => row.trash))
      if (rollback.length === 0) return { kind: 'rolledBack' }
      await markFailure(entry, `The moved session tree does not match its recorded size (${verified.message}).`)
      throw new TrashError('MOVE_VERIFY_FAILED', 'The moved session tree does not match its recorded size.')
    }
    return { kind: 'ready' }
  }

  /**
   * Resolve every member directory of a `restoring` entry back to its original
   * location, or back into the trash object when the restore cannot complete.
   * Never writes the index: the caller owns the commit.
   *
   * @param {object} entry `restoring` index entry.
   * @returns {Promise<{ kind: 'ready' } | { kind: 'trashed', entry: object } | { kind: 'missing', entry: object }>} the settled position.
   */
  async function resolveRestoring(entry) {
    const rows = await memberRows(entry)
    const lost = rows.filter((row) => !row.source && !row.trash)
    if (lost.length > 0) {
      return {
        kind: 'missing',
        entry: {
          ...entry,
          state: 'missing',
          lastError: errorText(`Both copies are missing for: ${lost.map((row) => row.member.sessionId).join(', ')}`),
        },
      }
    }
    for (const row of rows) {
      if (!row.source || !row.trash) continue
      const measured = await measureDirectory(row.member.originalSessionDir)
      if (metricsMatch(row.member, measured)) {
        await removeTrashMember(entry, row.index)
        row.trash = false
      } else {
        await removeRestoredMember(row.member)
        row.source = false
      }
    }
    const rolledBack = () => ({
      kind: 'trashed',
      entry: {
        ...entry,
        state: 'trashed',
        trashedAt:
          typeof entry.trashedAt === 'number' && entry.trashedAt > 0 ? entry.trashedAt : entry.startedAt || Date.now(),
        lastError: 'Recovered the trash copy after an interrupted restore.',
      },
    })
    const inSource = rows.filter((row) => row.source)
    const inTrash = rows.filter((row) => row.trash)
    if (inSource.length === 0) return rolledBack()
    if (inTrash.length > 0) {
      const failures = await moveMembersBackFromTrash(entry, inTrash)
      if (failures.length > 0) {
        const current = await memberRows(entry)
        const rollback = await moveMembersIntoTrash(entry, current.filter((row) => row.source && !row.trash))
        if (rollback.length === 0) return rolledBack()
        await markFailure(entry, `The restore could not be completed or rolled back: ${messageOf(failures[0].error)}`)
        throw new TrashError('MOVE_CONFLICT', 'The restore could not be completed or rolled back; both copies were kept.')
      }
    }
    const verified = await verifyRestoredMembers(entry)
    if (!verified.ok) {
      const current = await memberRows(entry)
      const rollback = await moveMembersIntoTrash(entry, current.filter((row) => row.source))
      if (rollback.length === 0) return rolledBack()
      await markFailure(entry, `The restored session tree does not match its recorded size (${verified.message}).`)
      throw new TrashError('RESTORE_VERIFY_FAILED', 'The restored session tree does not match its recorded size.')
    }
    return { kind: 'ready' }
  }

  /**
   * @param {object} entry settled `trashing` entry.
   * @param {{ emitRemoval?: boolean }} [options] whether to announce the removal to clients.
   * @returns {Promise<object>} the committed `trashed` entry.
   */
  async function commitTrashed(entry, options = {}) {
    const next = { ...entry, state: 'trashed', trashedAt: Date.now(), lastError: null }
    try {
      await store.commit(upsertEntry(store.entries(), next))
    } catch (error) {
      await markFailure(entry, `The trash index could not be committed: ${messageOf(error)}`)
      throw new TrashError('INDEX_WRITE_FAILED', 'The session moved, but the trash index could not be updated.')
    }
    await store.writeMeta(next).catch((error) => {
      logger.warn(`cannot rewrite trash metadata for ${entry.trashId}: ${messageOf(error)}`)
    })
    eligibility.invalidate(entry.sessionId)
    if (options.emitRemoval === true) emit('api-session/removed', entry.sessionId)
    return next
  }

  /**
   * Finish a settled restore: wait for visibility, restore workspace
   * accounting, drop the entry, and optionally announce the session.
   *
   * @param {object} entry settled `restoring` entry.
   * @param {{ mode?: 'normal' | 'orphan', emitAdded?: boolean, reattach?: boolean }} [options] finishing policy.
   * @returns {Promise<object>} the workspace attachment outcome.
   */
  async function completeRestore(entry, options = {}) {
    const mode = options.mode ?? 'normal'
    const visible = await waitForMembersVisible(entry)
    if (!visible.visible) {
      throw new TrashError('RESTORE_VERIFY_FAILED', 'The restored session tree is not visible to session storage.', {
        sessionId: visible.sessionId,
      })
    }
    const attachment =
      options.reattach === false
        ? { reattached: false }
        : mode === 'orphan'
          ? await detachWorkspace(entry)
          : await reattachWorkspace(entry)
    try {
      await store.commit(dropEntry(store.entries(), entry.sessionId))
    } catch (error) {
      await markFailure(entry, `The trash index could not be committed after restore: ${messageOf(error)}`)
      throw new TrashError('INDEX_WRITE_FAILED', 'The session was restored, but the trash index could not be updated.')
    }
    await store.removeObjectDir(entry.trashId).catch((error) => {
      logger.warn(`cannot remove the restored trash object ${entry.trashId}: ${messageOf(error)}`)
    })
    eligibility.invalidate(entry.sessionId)
    if (options.emitAdded !== false) {
      const restoredSnapshot = await stat(entry.sessionId).catch(() => undefined)
      emit('api-session/added', buildSummary(entry.sessionId, entry.title, restoredSnapshot))
    }
    return attachment
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
   * Permanently remove a batch of object directories and their index entries in
   * a bounded number of index writes. Every entry is first committed as
   * `purging` in one write, so a crash still settles forward on the next
   * recovery; successes are dropped and failures annotated in one final write.
   * The caller owns the trash lock.
   *
   * @param {readonly object[]} targets `trashed` entries to purge.
   * @returns {Promise<{ purged: number, failures: { entry: object, error: unknown, phase: string }[] }>} per-entry outcome.
   */
  async function purgeManyInsideLock(targets) {
    const failures = []
    const purging = []
    for (const entry of targets) {
      try {
        await assertSafeObject(entry)
        purging.push({ ...entry, state: 'purging', lastError: null })
      } catch (error) {
        failures.push({ entry, error, phase: 'validate' })
      }
    }
    if (purging.length === 0) return { purged: 0, failures }

    let marked = store.entries()
    for (const entry of purging) marked = upsertEntry(marked, entry)
    try {
      await store.commit(marked)
    } catch (error) {
      const failure = new TrashError(
        'INDEX_WRITE_FAILED',
        'The session logs were not deleted because the trash index could not be updated.',
        { code: error instanceof TrashError ? error.code : null },
      )
      for (const entry of purging) failures.push({ entry, error: failure, phase: 'mark' })
      return { purged: 0, failures }
    }
    await mapLimit(purging, PURGE_CONCURRENCY, async (entry) => {
      await store.writeMeta(entry).catch((error) => {
        logger.warn(`cannot rewrite trash metadata for ${entry.trashId}: ${messageOf(error)}`)
      })
    })

    const deleted = await mapLimit(purging, PURGE_CONCURRENCY, async (entry) => {
      try {
        await store.removeObjectDir(entry.trashId)
        return { entry, deleted: true }
      } catch (error) {
        return { entry, deleted: false, error }
      }
    })
    const completed = []
    const annotated = []
    for (const result of deleted) {
      if (result.deleted) {
        completed.push(result.entry)
        logger.info(`permanently deleted ${result.entry.sessionId} (${result.entry.trashId})`)
        continue
      }
      annotated.push({
        ...result.entry,
        lastError: errorText(`The session log could not be deleted: ${messageOf(result.error)}`),
      })
      failures.push({
        entry: result.entry,
        error: new TrashError('IO_ERROR', 'The session log could not be deleted.', { trashId: result.entry.trashId }),
        phase: 'delete',
      })
    }

    let settled = store.entries()
    for (const entry of completed) settled = dropEntry(settled, entry.sessionId)
    for (const entry of annotated) settled = upsertEntry(settled, entry)
    try {
      await store.commit(settled)
    } catch (error) {
      const failure = new TrashError(
        'INDEX_WRITE_FAILED',
        'The session logs were deleted, but the trash index could not be updated.',
        { code: error instanceof TrashError ? error.code : null },
      )
      for (const entry of completed) failures.push({ entry, error: failure, phase: 'drop' })
      // The deleted objects no longer match the purging entries; the next
      // recovery drops them, so nothing is reported as successfully purged.
      return { purged: 0, failures }
    }
    await mapLimit(annotated, PURGE_CONCURRENCY, async (entry) => {
      await store.writeMeta(entry).catch((error) => {
        logger.warn(`cannot rewrite trash metadata for ${entry.trashId}: ${messageOf(error)}`)
      })
    })
    return { purged: completed.length, failures }
  }

  /**
   * Permanently remove one object directory and its index entry. The caller
   * owns the trash lock.
   *
   * @param {object} entry `trashed` index entry to purge.
   * @returns {Promise<void>} resolution once the object and entry are gone.
   */
  async function purgeInsideLock(entry) {
    const result = await purgeManyInsideLock([entry])
    if (result.failures.length > 0) throw result.failures[0].error
  }

  /**
   * Drop a batch of `missing` entries from the index in one write and remove
   * their plugin-owned remnants. No session file is deleted. The caller owns
   * the trash lock.
   *
   * @param {readonly object[]} entries `missing` index entries to forget.
   * @returns {Promise<number>} how many entries were removed from the index.
   */
  async function forgetManyInsideLock(entries) {
    if (entries.length === 0) return 0
    let next = store.entries()
    for (const entry of entries) next = dropEntry(next, entry.sessionId)
    try {
      await store.commit(next)
    } catch (error) {
      throw new TrashError('INDEX_WRITE_FAILED', 'The trash index could not be updated.', {
        code: error instanceof TrashError ? error.code : null,
      })
    }
    for (const entry of entries) {
      await store.removeObjectRemnants(entry.trashId).catch((error) => {
        logger.warn(`cannot remove the remnants of ${entry.trashId}: ${messageOf(error)}`)
      })
    }
    return entries.length
  }

  /**
   * Drop one `missing` entry from the index and remove its plugin-owned
   * remnants. No session file is deleted. The caller owns the trash lock.
   *
   * @param {object} entry `missing` index entry to forget.
   * @returns {Promise<{ sessionId: string, title: string }>} the removed identity.
   */
  async function forgetInsideLock(entry) {
    await forgetManyInsideLock([entry])
    return { sessionId: entry.sessionId, title: entry.title }
  }

  /**
   * Move one cold session tree into the trash. A session that owns only hidden
   * `origin: 'subagent'` descendants moves together with them.
   *
   * @param {string} sessionId session to trash.
   * @returns {Promise<object>} the committed `trashed` entry.
   */
  async function trash(sessionId) {
    const startedAt = Date.now()
    return store.withLock(async () => {
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

      const plan = Array.isArray(verdict.members) ? verdict.members : []
      if (plan.length === 0) throw new TrashError('SESSION_NOT_FOUND', 'This session is not in session storage.')
      const members = []
      let parentSnapshot
      for (let index = 0; index < plan.length; index += 1) {
        const planned = plan[index]
        const snapshot = await stat(planned.sessionId)
        if (snapshot === undefined || snapshot === null) {
          throw new TrashError('SESSION_NOT_FOUND', 'A session in this lineage is not in session storage.', {
            sessionId: planned.sessionId,
          })
        }
        if (index === 0) parentSnapshot = snapshot
        const location = snapshot.location
        if (
          location === undefined ||
          location === null ||
          typeof location.path !== 'string' ||
          location.kind !== 'jsonl' ||
          !path.isAbsolute(location.path)
        ) {
          throw new TrashError('SESSION_NOT_MATERIALIZED', 'A session in this lineage has no movable JSONL log.', {
            sessionId: planned.sessionId,
          })
        }
        const resolvedLogPath = path.resolve(location.path)
        const sessionDir = path.dirname(resolvedLogPath)
        const projectDir = path.dirname(sessionDir)
        if (!isSafeDirectoryPath(sessionDir) || (await kindOf(sessionDir)) !== 'directory') {
          throw new TrashError('UNSAFE_SESSION_DIR', 'A session directory is not a plain directory this plugin can move.', {
            sessionId: planned.sessionId,
          })
        }
        if (isLive(planned.sessionId)) {
          throw new TrashError('SESSION_LIVE', 'A session in this lineage became live before it could be moved.', {
            sessionId: planned.sessionId,
          })
        }
        const measured = await measureDirectory(sessionDir)
        const title = await resolveTitle(planned.sessionId, snapshot.header)
        members.push({
          sessionId: planned.sessionId,
          origin: index === 0 ? null : 'subagent',
          title,
          originalSessionDir: sessionDir,
          originalLogPath: resolvedLogPath,
          persistenceProjectDirHint: projectDir,
          formatStatus: snapshot.formatStatus === 'migration-required' ? 'migration-required' : 'current',
          sizeBytes: measured.sizeBytes,
          fileCount: measured.fileCount,
        })
      }

      let trashId
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = createTrashId()
        const indexed = store.entries().some((entry) => entry.trashId === candidate)
        if (!indexed && (await kindOf(store.objectDir(candidate))) === 'missing') {
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

      const totals = aggregateMetrics(members)
      const parent = members[0]
      const header = parentSnapshot?.header ?? {}
      const originalCwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
      const workspaceInfo = findOwningWorkspace(sessionId)
      const entry = {
        sessionId,
        trashId,
        state: 'trashing',
        title: parent.title,
        trashedAt: 0,
        startedAt,
        originalCwd,
        workspaceExistsAtDeletion: originalCwd === null ? null : await directoryExists(originalCwd),
        originalWorkspaceId: workspaceInfo?.workspace?.id ?? null,
        originalWorkspaceTitle: workspaceInfo?.workspace?.title ?? null,
        originalNextSessionId: workspaceInfo?.nextSessionId ?? null,
        originalSessionDir: parent.originalSessionDir,
        originalLogPath: parent.originalLogPath,
        persistenceProjectDirHint: parent.persistenceProjectDirHint,
        formatStatus: parent.formatStatus,
        sizeBytes: totals.sizeBytes,
        fileCount: totals.fileCount,
        members,
        lastError: null,
      }
      try {
        await store.writeMeta(entry)
        await store.commit(upsertEntry(store.entries(), entry))
      } catch (error) {
        await rollbackTrash(sessionId, trashId)
        throw error instanceof TrashError
          ? error
          : new TrashError('IO_ERROR', `Cannot prepare the trash entry: ${messageOf(error)}`)
      }

      // Another process may have opened or resumed a member between the
      // preflight and the move. Re-check every member while the trash lock is
      // held; the sources are still untouched at this point.
      const raced = members.find((member) => isLive(member.sessionId))
      if (raced !== undefined) {
        await rollbackTrash(sessionId, trashId)
        throw new TrashError('SESSION_LIVE', 'A session in this lineage became live before it could be moved.', {
          sessionId: raced.sessionId,
        })
      }

      let moveError
      try {
        await moveMembersToTrash(entry)
      } catch (error) {
        moveError = error
      }
      let settled
      try {
        settled = await resolveTrashing(entry)
      } catch (error) {
        throw error instanceof TrashError
          ? error
          : new TrashError('IO_ERROR', `Cannot move the session tree into the trash: ${messageOf(error)}`)
      }
      if (settled.kind === 'missing') {
        await store.commit(upsertEntry(store.entries(), settled.entry))
        await store.writeMeta(settled.entry).catch(() => {})
        throw new TrashError('MOVE_CONFLICT', 'A session directory disappeared during the move.', {
          sessionId: settled.entry.sessionId,
          lastError: settled.entry.lastError,
        })
      }
      if (settled.kind === 'rolledBack') {
        await rollbackTrash(sessionId, trashId)
        throw moveError instanceof TrashError
          ? moveError
          : new TrashError('MOVE_VERIFY_FAILED', 'The session tree could not be moved into the trash.')
      }
      const hidden = await waitForMembersHidden(entry)
      if (!hidden.hidden) {
        const rows = await memberRows(entry)
        const rollback = await moveMembersBackFromTrash(entry, rows.filter((row) => row.trash))
        if (rollback.length > 0) {
          await markFailure(entry, 'Session storage still reports the moved session tree, and moving it back failed.')
          throw new TrashError('MOVE_CONFLICT', 'The session tree was moved but session storage still reports it.')
        }
        await rollbackTrash(sessionId, trashId)
        throw new TrashError('MOVE_VERIFY_FAILED', 'Session storage still reports the session after the move.', {
          sessionId: hidden.sessionId,
        })
      }
      const next = await commitTrashed(entry, { emitRemoval: true })
      logger.info(
        `trashed ${sessionId} as ${trashId} with ${members.length - 1} child sessions in ${Date.now() - startedAt}ms`,
      )
      return next
    })
  }

  /**
   * Restore one trashed session tree to its original directories. Phase 2
   * supports `normal` only; orphan restore arrives later.
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
      const members = membersOf(entry)
      const parent = members[0]
      if (
        !samePath(path.resolve(String(entry.originalSessionDir)), path.resolve(String(parent.originalSessionDir))) ||
        !samePath(path.resolve(String(entry.originalLogPath)), path.resolve(String(parent.originalLogPath))) ||
        !samePath(
          path.resolve(String(entry.persistenceProjectDirHint)),
          path.resolve(String(parent.persistenceProjectDirHint)),
        )
      ) {
        throw new TrashError('UNSAFE_RESTORE_PATH', 'The trash entry names inconsistent restore paths.')
      }
      for (let index = 0; index < members.length; index += 1) {
        const member = members[index]
        const target = path.resolve(String(member.originalSessionDir))
        const projectDirHint = path.resolve(String(member.persistenceProjectDirHint))
        if (
          !isSafeDirectoryPath(target) ||
          !samePath(path.dirname(target), projectDirHint) ||
          isInside(paths.root, target) ||
          typeof member.originalLogPath !== 'string' ||
          !samePath(path.dirname(path.resolve(member.originalLogPath)), target)
        ) {
          throw new TrashError('UNSAFE_RESTORE_PATH', 'The restore target failed the path safety check.', {
            sessionId: member.sessionId,
          })
        }
        const projectDirKind = await kindOf(projectDirHint)
        if (projectDirKind !== 'missing' && projectDirKind !== 'directory') {
          throw new TrashError('UNSAFE_RESTORE_PATH', 'The restore target parent is not a plain directory.', {
            sessionId: member.sessionId,
          })
        }
        const targetKind = await kindOf(target)
        if (targetKind !== 'missing') {
          throw new TrashError('RESTORE_TARGET_EXISTS', 'A directory already exists at the restore target.', {
            sessionId: member.sessionId,
          })
        }
      }
      const presence = await memberPresence(store, entry)
      if (presence.present !== presence.total) {
        const missing = { ...entry, state: 'missing', lastError: 'The trash copy of this session is missing.' }
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

      let moveError
      const rows = members.map((_, index) => ({ index }))
      const moveFailures = await moveMembersBackFromTrash(restoring, rows)
      if (moveFailures.length > 0) moveError = moveFailures[0].error
      let settled
      try {
        settled = await resolveRestoring(restoring)
      } catch (error) {
        throw error instanceof TrashError
          ? error
          : new TrashError('IO_ERROR', `Cannot move the session tree back: ${messageOf(error)}`)
      }
      if (settled.kind === 'missing') {
        await store.commit(upsertEntry(store.entries(), settled.entry))
        await store.writeMeta(settled.entry).catch(() => {})
        throw new TrashError('RESTORE_VERIFY_FAILED', settled.entry.lastError ?? 'The restored session tree is missing.')
      }
      if (settled.kind === 'trashed') {
        await store.commit(upsertEntry(store.entries(), settled.entry))
        await store.writeMeta(settled.entry).catch(() => {})
        throw moveError instanceof TrashError
          ? moveError
          : new TrashError('RESTORE_VERIFY_FAILED', 'The session tree could not be restored.')
      }

      let attachment
      try {
        attachment = await completeRestore(restoring, { mode })
      } catch (error) {
        if (error instanceof TrashError && error.code === 'RESTORE_VERIFY_FAILED') {
          const current = await memberRows(restoring)
          const rollback = await moveMembersIntoTrash(
            restoring,
            current.filter((row) => row.source && !row.trash),
          )
          if (rollback.length > 0) {
            await markFailure(restoring, 'The restored session tree is not visible, and rolling it back failed.')
            throw new TrashError('MOVE_CONFLICT', 'The restored session tree is not visible, and rolling it back failed.')
          }
          const next = {
            ...restoring,
            state: 'trashed',
            trashedAt: entry.trashedAt,
            lastError: 'The restored session was not visible to session storage.',
          }
          await store.commit(upsertEntry(store.entries(), next))
          await store.writeMeta(next).catch(() => {})
        }
        throw error
      }
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
   * entry on its own. An optional presence map lets the caller reuse the probe
   * results from the preceding reconcile instead of stat-ing every member
   * directory again.
   *
   * @param {Map<string, { total: number, present: number, missing: string[] }>} [presenceByTrashId] reconcile probe results keyed by object identity.
   * @returns {Promise<{ changed: number, completed: number, rolledBack: number, missing: number }>} recovery summary.
   */
  async function recoverInsideLock(presenceByTrashId = new Map()) {
    let entries = [...store.entries()]
    const metaUpdates = []
    let changed = 0
    let completed = 0
    let rolledBack = 0
    let missing = 0
    const commit = (next) => {
      if (next === undefined) return
      entries = upsertEntry(entries, next)
      metaUpdates.push(next)
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
          const settled = await resolveTrashing(original)
          if (settled.kind === 'missing') {
            commit(settled.entry)
            missing += 1
          } else if (settled.kind === 'rolledBack') {
            await store.removeObjectDir(original.trashId).catch((error) => {
              logger.warn(`cannot remove the rolled-back trash object ${original.trashId}: ${messageOf(error)}`)
            })
            drop(original.sessionId)
            rolledBack += 1
          } else {
            commit({ ...original, state: 'trashed', trashedAt: original.startedAt || Date.now(), lastError: null })
            completed += 1
          }
          changed += 1
          continue
        }

        if (original.state === 'restoring') {
          await assertSafeObject(original)
          const settled = await resolveRestoring(original)
          if (settled.kind === 'missing') {
            commit(settled.entry)
            missing += 1
          } else if (settled.kind === 'trashed') {
            commit(settled.entry)
            rolledBack += 1
          } else {
            const visible = await waitForMembersVisible(original)
            if (!visible.visible) {
              commit(fail(original, 'The restored session tree is not visible to session storage.'))
              changed += 1
              continue
            }
            await store.removeObjectDir(original.trashId).catch((error) => {
              logger.warn(`cannot remove the trash object ${original.trashId}: ${messageOf(error)}`)
            })
            drop(original.sessionId)
            completed += 1
          }
          changed += 1
          continue
        }

        if (original.state === 'trashed') {
          await assertSafeObject(original)
          const presence = presenceByTrashId.get(original.trashId) ?? (await memberPresence(store, original))
          if (presence.present < presence.total) {
            commit({
              ...original,
              state: 'missing',
              lastError:
                presence.present === 0
                  ? 'The trash copy is missing.'
                  : `The trash copy is missing these member sessions: ${presence.missing.join(', ')}.`,
            })
            missing += 1
            changed += 1
            continue
          }
          const sources = await sourceRows(original)
          if (sources.some((row) => row.source)) {
            commit(fail(original, 'An original session directory unexpectedly exists alongside the trash copy; both were kept.'))
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
      for (const entry of metaUpdates) {
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
      return { imported: 0, markedMissing: 0, unindexed: store.unindexed, changed: 0, presence: new Map() }
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
      const recovery = await recoverInsideLock(reconcile.presence)
      let purged = 0
      let failed = 0
      if (allowPurge) {
        const expired = [...store.entries()].filter((entry) => isExpired(entry, now))
        if (expired.length > 0) {
          const result = await purgeManyInsideLock(expired)
          purged = result.purged
          failed = result.failures.length
          for (const failure of result.failures) {
            logger.warn(`cannot purge the expired session ${failure.entry.sessionId}: ${messageOf(failure.error)}`)
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
      const recovery = await recoverInsideLock(reconcile.presence)
      const failures = []
      const purgeTargets = []
      const forgetTargets = []
      let failed = 0
      for (const entry of [...store.entries()]) {
        if (entry.state === 'trashed') {
          purgeTargets.push(entry)
          continue
        }
        if (entry.state === 'missing') {
          forgetTargets.push(entry)
          continue
        }
        const title = typeof entry.title === 'string' ? entry.title : ''
        const message = `The trash entry is in state "${entry.state}" and cannot be cleaned up.`
        failed += 1
        failures.push({ sessionId: entry.sessionId, title, message })
        logger.warn(`cannot purge the session ${entry.sessionId}: ${message}`)
      }

      let purged = 0
      if (purgeTargets.length > 0) {
        const result = await purgeManyInsideLock(purgeTargets)
        purged = result.purged
        for (const failure of result.failures) {
          failed += 1
          failures.push({
            sessionId: failure.entry.sessionId,
            title: typeof failure.entry.title === 'string' ? failure.entry.title : '',
            message: messageOf(failure.error),
          })
          logger.warn(`cannot purge the trashed session ${failure.entry.sessionId}: ${messageOf(failure.error)}`)
        }
      }

      let forgotten = 0
      if (forgetTargets.length > 0) {
        try {
          forgotten = await forgetManyInsideLock(forgetTargets)
        } catch (error) {
          failed += forgetTargets.length
          for (const entry of forgetTargets) {
            failures.push({
              sessionId: entry.sessionId,
              title: typeof entry.title === 'string' ? entry.title : '',
              message: messageOf(error),
            })
            logger.warn(`cannot forget the missing session ${entry.sessionId}: ${messageOf(error)}`)
          }
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
        const reconcile = await reconcileInsideLock(Date.now())
        return await recoverInsideLock(reconcile.presence)
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
