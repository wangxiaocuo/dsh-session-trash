import fs from 'node:fs/promises'
import path from 'node:path'
import { isSafeDirectoryPath } from './fsops.js'

/** How long a successful preflight answer is reused by the menu. */
export const PREFLIGHT_TTL_MS = 2000

/**
 * @typedef {{ sessionId: string, header: object }} DescendantRef
 * @typedef {{ sessionId: string, header: object, location: { path: string }, formatStatus?: string }} PlannedMember
 * @typedef {{ eligible: true, members: PlannedMember[] } | { eligible: false, code: string, message: string, details?: object }} PreflightResult
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
 * Collect every stored session whose lineage descends from `sessionId`.
 *
 * @param {import('@deepseek-ai/dsh-session-persistence').SessionPersistence} persistence persistence service.
 * @param {string} sessionId root session.
 * @returns {Promise<DescendantRef[]>} descendant identity and stored header.
 */
async function descendantsFromListing(persistence, sessionId) {
  const snapshots = await persistence.list()
  const childrenByParent = new Map()
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    const parent = header?.parentSession
    if (typeof parent !== 'string' || typeof header?.id !== 'string') continue
    const bucket = childrenByParent.get(parent)
    if (bucket === undefined) childrenByParent.set(parent, [header])
    else bucket.push(header)
  }
  const found = []
  const queue = [sessionId]
  const visited = new Set([sessionId])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const header of childrenByParent.get(current) ?? []) {
      if (visited.has(header.id)) continue
      visited.add(header.id)
      found.push({ sessionId: header.id, header })
      queue.push(header.id)
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
 * @returns {DescendantRef[]} every descendant session identity and header.
 */
function collectTraceDescendants(nodes) {
  const found = []
  const visit = (list) => {
    for (const node of list) {
      const header = node?.session?.header
      const id = header?.id ?? node?.session?.id
      if (typeof id === 'string' && id !== '') found.push({ sessionId: id, header: header ?? {} })
      if (Array.isArray(node?.descendants)) visit(node.descendants)
    }
  }
  visit(Array.isArray(nodes) ? nodes : [])
  return found
}

/**
 * Decide whether one session may move into the trash. A session that owns only
 * hidden `origin: 'subagent'` descendants may move together with them; any
 * other descendant keeps the historical refusal.
 *
 * @param {{ ctx: import('@deepseek-ai/cordis').Context, store: import('./store.js').TrashStore, logger: object }} deps host services.
 * @returns {{ evaluate: (sessionId: string) => Promise<PreflightResult>, invalidate: (sessionId?: string) => void }} the cached evaluator.
 */
export function createEligibility({ ctx, store, logger }) {
  /** @type {Map<string, { expires: number, value: PreflightResult }>} */
  const cache = new Map()

  /**
   * @param {string} sessionId session to inspect.
   * @returns {boolean} whether the session is live in this host process.
   */
  function isLive(sessionId) {
    const liveSession = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
    const liveAgent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined
    return liveSession !== undefined || liveAgent !== undefined
  }

  /**
   * @param {string} sessionId session to inspect.
   * @returns {Promise<DescendantRef[] | { error: true }>} the complete descendant list, or a refusal marker.
   */
  async function collectDescendants(sessionId) {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery !== undefined && sessionQuery !== null && typeof sessionQuery.traceSession === 'function') {
      try {
        const trace = await sessionQuery.traceSession(sessionId)
        return collectTraceDescendants(trace?.descendants ?? [])
      } catch (error) {
        logger.warn(`preflight lineage failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return { error: true }
      }
    }
    try {
      return await descendantsFromListing(ctx.sessionPersistence, sessionId)
    } catch (error) {
      logger.warn(`preflight lineage listing failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return { error: true }
    }
  }

  /**
   * @param {string} sessionId descendant session to validate.
   * @returns {Promise<object>} either `{ member }` with the planned member or `{ refusal }`.
   */
  async function planDescendant(sessionId) {
    let snapshot
    try {
      snapshot = await ctx.sessionPersistence.stat(sessionId)
    } catch (error) {
      logger.warn(`preflight stat failed for child session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return { refusal: refuse('IO_ERROR', 'A child session in this lineage could not be read.', { sessionId }) }
    }
    if (snapshot === undefined || snapshot === null) {
      return {
        refusal: refuse('SESSION_NOT_MATERIALIZED', 'A child session has no stored log yet.', { sessionId }),
      }
    }
    const location = snapshot.location
    if (location === undefined || location === null || typeof location.path !== 'string') {
      return {
        refusal: refuse('SESSION_NOT_MATERIALIZED', 'A child session has no stored log yet.', { sessionId }),
      }
    }
    if (location.kind !== 'jsonl') {
      return {
        refusal: refuse('STORAGE_UNSUPPORTED', `A child session uses the "${String(location.kind)}" storage backend, which is not supported.`, {
          sessionId,
        }),
      }
    }
    if (!path.isAbsolute(location.path)) {
      return { refusal: refuse('STORAGE_UNSUPPORTED', 'A child session log path is not absolute.', { sessionId }) }
    }
    return {
      member: {
        sessionId,
        header: snapshot.header,
        location: { path: location.path },
        formatStatus: snapshot.formatStatus,
      },
    }
  }

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

    const descendants = await collectDescendants(sessionId)
    if (!Array.isArray(descendants)) {
      return refuse('SESSION_LINEAGE_UNRESOLVED', 'The session lineage could not be resolved, so the session is left untouched.')
    }
    const visible = descendants.filter((child) => child.header?.origin !== 'subagent')
    if (visible.length > 0) {
      return refuse('SESSION_HAS_DESCENDANTS', 'This session still has child sessions; archive the tree instead.', {
        descendants: visible.length,
        sessions: visible.map((child) => child.sessionId),
      })
    }

    const planned = []
    for (const child of descendants) {
      const plannedChild = await planDescendant(child.sessionId)
      if (plannedChild.refusal !== undefined) return plannedChild.refusal
      planned.push(plannedChild.member)
    }

    const members = [
      {
        sessionId,
        header: snapshot.header,
        location: { path: location.path },
        formatStatus: snapshot.formatStatus,
      },
      ...planned,
    ]

    if (isLive(sessionId)) {
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

    // Running descendants are already reported by the subagent activity
    // provider; a live-but-idle child is the remaining unsafe case.
    const liveChild = members.slice(1).find((member) => isLive(member.sessionId))
    if (liveChild !== undefined) {
      return refuse('SESSION_LIVE', 'A child session is still live in this host.', {
        sessionId: liveChild.sessionId,
      })
    }

    for (const member of members) {
      const sessionDir = path.dirname(member.location.path)
      let stats
      try {
        stats = await fs.lstat(sessionDir)
      } catch (error) {
        logger.warn(`preflight cannot stat ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`)
        return refuse('IO_ERROR', 'A session directory could not be read.', {
          ...(member.sessionId === sessionId ? {} : { sessionId: member.sessionId }),
        })
      }
      if (!stats.isDirectory() || !isSafeDirectoryPath(sessionDir)) {
        return refuse('UNSAFE_SESSION_DIR', 'A session directory is not a plain directory this plugin can move.', {
          ...(member.sessionId === sessionId ? {} : { sessionId: member.sessionId }),
        })
      }
    }

    return { eligible: true, members }
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
