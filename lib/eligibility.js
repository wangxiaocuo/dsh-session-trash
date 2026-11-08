import fs from 'node:fs/promises'
import path from 'node:path'
import { isSafeDirectoryPath } from './fsops.js'

/** How long a successful preflight answer is reused by the menu. */
export const PREFLIGHT_TTL_MS = 2000

/**
 * @typedef {{ eligible: true } | { eligible: false, code: string, message: string, details?: object }} PreflightResult
 */

/**
 * @param {string} code refusal code.
 * @param {string} message owner-facing explanation.
 * @param {object} [details] optional structured context.
 * @returns {{ eligible: false, code: string, message: string, details?: object }} a refusal.
 */
function refuse(code, message, details) {
  return details === undefined ? { eligible: false, code, message } : { eligible: false, code, message, details }
}

/**
 * Collect the ids of every stored session whose lineage descends from `sessionId`.
 *
 * @param {import('@deepseek-ai/dsh-session-persistence').SessionPersistence} persistence persistence service.
 * @param {string} sessionId root session.
 * @returns {Promise<string[]>} descendant ids.
 */
async function descendantsFromListing(persistence, sessionId) {
  const snapshots = await persistence.list()
  const childrenByParent = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot?.header?.parentSession
    if (typeof parent !== 'string') continue
    const bucket = childrenByParent.get(parent)
    if (bucket === undefined) childrenByParent.set(parent, [snapshot.header.id])
    else bucket.push(snapshot.header.id)
  }
  const found = []
  const queue = [sessionId]
  const visited = new Set([sessionId])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of childrenByParent.get(current) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * Flatten the nested descendant tree returned by `sessionQuery.traceSession`.
 * A grandchild whose direct parent is no longer stored still proves that the
 * root session owns a lineage the trash must not split.
 *
 * @param {readonly object[]} nodes descendant nodes from the trace.
 * @returns {string[]} every descendant session id.
 */
function collectTraceDescendants(nodes) {
  const ids = []
  const visit = (list) => {
    for (const node of list) {
      const id = node?.session?.header?.id ?? node?.session?.id
      if (typeof id === 'string' && id !== '') ids.push(id)
      if (Array.isArray(node?.descendants)) visit(node.descendants)
    }
  }
  visit(Array.isArray(nodes) ? nodes : [])
  return ids
}

/**
 * Decide whether one session may move into the trash. The same predicate backs
 * both the menu preflight and (from Phase 2) the write path.
 *
 * @param {{ ctx: import('@deepseek-ai/cordis').Context, store: import('./store.js').TrashStore, logger: object }} deps host services.
 * @returns {{ evaluate: (sessionId: string) => Promise<PreflightResult>, invalidate: (sessionId?: string) => void }} the cached evaluator.
 */
export function createEligibility({ ctx, store, logger }) {
  /** @type {Map<string, { expires: number, value: PreflightResult }>} */
  const cache = new Map()

  /**
   * @param {string} sessionId session to inspect.
   * @returns {Promise<PreflightResult>} the uncached verdict.
   */
  async function evaluateUncached(sessionId) {
    let snapshot
    try {
      snapshot = await ctx.sessionPersistence.stat(sessionId)
    } catch (error) {
      logger.warn(`preflight stat failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return refuse('IO_ERROR', 'The session storage could not be read.')
    }
    if (snapshot === undefined || snapshot === null) {
      return refuse('SESSION_NOT_FOUND', 'This session is not in session storage.')
    }

    const existing = store.findEntry(sessionId)
    if (
      existing !== undefined &&
      (existing.state === 'trashed' ||
        existing.state === 'trashing' ||
        existing.state === 'restoring' ||
        existing.state === 'purging')
    ) {
      return refuse('ALREADY_TRASHED', 'This session is already recorded in the trash.')
    }

    const location = snapshot.location
    if (location === undefined || location === null || typeof location.path !== 'string') {
      return refuse('SESSION_NOT_MATERIALIZED', 'This session has no stored log yet, so it has nothing to remove.')
    }
    if (location.kind !== 'jsonl') {
      return refuse('STORAGE_UNSUPPORTED', `The "${String(location.kind)}" session storage backend is not supported.`)
    }
    if (!path.isAbsolute(location.path)) {
      return refuse('STORAGE_UNSUPPORTED', 'The session log path is not absolute.')
    }

    if (snapshot.header?.origin === 'subagent') {
      return refuse('SESSION_SUBAGENT', 'Subagent sessions cannot be moved to the trash on their own.')
    }

    let descendants
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery !== undefined && typeof sessionQuery.traceSession === 'function') {
      try {
        const trace = await sessionQuery.traceSession(sessionId)
        descendants = collectTraceDescendants(trace?.descendants ?? [])
      } catch (error) {
        logger.warn(`preflight lineage failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return refuse('SESSION_LINEAGE_UNRESOLVED', 'The session lineage could not be resolved, so the session is left untouched.')
      }
    } else {
      try {
        descendants = await descendantsFromListing(ctx.sessionPersistence, sessionId)
      } catch (error) {
        logger.warn(`preflight lineage listing failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return refuse('SESSION_LINEAGE_UNRESOLVED', 'The session lineage could not be resolved, so the session is left untouched.')
      }
    }
    const childCount = descendants.filter((id) => typeof id === 'string' && id !== '').length
    if (childCount > 0) {
      return refuse('SESSION_HAS_DESCENDANTS', 'This session still has child sessions; archive the tree instead.', {
        descendants: childCount,
      })
    }

    const liveSession = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
    const liveAgent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined
    if (liveSession !== undefined || liveAgent !== undefined) {
      return refuse('SESSION_LIVE', 'This session is open right now. Close it before moving it to the trash.')
    }

    let activity
    try {
      activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    } catch (error) {
      logger.warn(`preflight activity failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return refuse('SESSION_ACTIVE', 'Session activity could not be checked, so the session is left untouched.')
    }
    if (Array.isArray(activity) && activity.length > 0) {
      return refuse('SESSION_ACTIVE', 'This session still has running work.', {
        activity: activity.map((item) => item?.kind ?? 'unknown'),
      })
    }

    const sessionDir = path.dirname(location.path)
    let stats
    try {
      stats = await fs.lstat(sessionDir)
    } catch (error) {
      logger.warn(`preflight cannot stat ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`)
      return refuse('IO_ERROR', 'The session directory could not be read.')
    }
    if (!stats.isDirectory() || !isSafeDirectoryPath(sessionDir)) {
      return refuse('UNSAFE_SESSION_DIR', 'The session directory is not a plain directory this plugin can move.')
    }

    return { eligible: true }
  }

  return {
    /**
     * @param {string} sessionId session to inspect.
     * @returns {Promise<PreflightResult>} the cached verdict.
     */
    async evaluate(sessionId) {
      if (store.isProtected()) {
        return refuse('INDEX_CORRUPT', 'The trash index is unreadable, so protection mode refuses new entries.')
      }
      const now = Date.now()
      const hit = cache.get(sessionId)
      if (hit !== undefined && hit.expires > now) return hit.value
      const value = await evaluateUncached(sessionId)
      cache.set(sessionId, { expires: now + PREFLIGHT_TTL_MS, value })
      return value
    },
    /**
     * @param {string} [sessionId] session whose cached verdict is stale, or every session.
     * @returns {void}
     */
    invalidate(sessionId) {
      if (sessionId === undefined) cache.clear()
      else cache.delete(sessionId)
    },
  }
}
