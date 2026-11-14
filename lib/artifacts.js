import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside, isSafeMemberId } from './fsops.js'

/**
 * Projection-cache segments below the harness home. The durable cache stores
 * one document per session id, so a purged session's record can be removed
 * without touching any other session.
 */
const PROJECTION_CACHE_SEGMENTS = ['storages', 'session_projcache', 'sessions']

/**
 * Records younger than this are never swept at startup: a live Session may
 * have created its first checkpoint without a durable log yet, and another
 * DSH process may be writing the record right now.
 */
export const PROJECTION_SWEEP_MIN_AGE_MS = 7 * 86_400_000

/**
 * @param {unknown} error arbitrary failure.
 * @returns {string} a user-facing message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {any} entry trash index entry.
 * @returns {string[]} safe member session ids, parent first.
 */
function entrySessionIds(entry) {
  const ids = []
  const members = Array.isArray(entry?.members) ? entry.members : []
  for (const member of members) {
    if (isSafeMemberId(member?.sessionId) && !ids.includes(member.sessionId)) ids.push(member.sessionId)
  }
  if (isSafeMemberId(entry?.sessionId) && !ids.includes(entry.sessionId)) ids.push(entry.sessionId)
  return ids
}

/**
 * Remove per-session derived records and workspace accounting that outlive a
 * deleted session log.
 *
 * Only plugin-owned bookkeeping and DSH's derived projection-cache records are
 * touched. Attachments and images are content-addressed and may be shared by
 * several sessions, so they are deliberately out of scope: deleting them here
 * would either leak shared objects or break another session.
 *
 * Every operation is best-effort. A failure is returned as a warning and must
 * never turn a successful log deletion into an error, because the log is
 * already gone.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   home?: string,
 *   logger: { debug: Function, warn: Function },
 * }} deps host services, harness home, and diagnostics.
 * @returns {{ release: (entry: any) => Promise<{ warnings: string[] }>, sweepProjectionCache: (options?: { keepSessionIds?: string[], minAgeMs?: number, now?: number }) => Promise<{ removed: number }> }} the cleaner surface.
 */
export function createArtifactCleaner({ ctx, home, logger }) {
  const projectionDirectory =
    typeof home === 'string' && home !== '' && path.isAbsolute(home)
      ? path.join(home, ...PROJECTION_CACHE_SEGMENTS)
      : undefined

  /**
   * @returns {any | undefined} the optional workspace registry.
   */
  function workspaceRegistry() {
    const registry = ctx.get('workspaceRegistry')
    return registry === null || registry === undefined ? undefined : registry
  }

  /**
   * Drop one session id from every workspace that still accounts for it and
   * clear the registry-global archive and pin markers.
   *
   * `detachSession` needs the live workspace entity; `unarchiveSession` and
   * `unpinSession` are intentionally safe for ids whose session no longer
   * exists, which is exactly the purge case.
   *
   * @param {string} sessionId session to release.
   * @returns {Promise<string[]>} warnings for failed steps.
   */
  async function releaseWorkspace(sessionId) {
    const warnings = []
    const registry = workspaceRegistry()
    if (registry === undefined) return warnings

    if (typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) {
          if (!Array.isArray(workspace?.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue
          if (typeof workspace.detachSession !== 'function') continue
          try {
            await workspace.detachSession(sessionId)
          } catch (error) {
            warnings.push(
              `cannot detach ${sessionId} from workspace ${String(workspace?.id ?? 'unknown')}: ${messageOf(error)}`,
            )
          }
        }
      } catch (error) {
        warnings.push(`cannot scan workspaces for ${sessionId}: ${messageOf(error)}`)
      }
    }

    for (const [method, label] of [
      ['unarchiveSession', 'archive'],
      ['unpinSession', 'pin'],
    ]) {
      if (typeof registry[method] !== 'function') continue
      try {
        await registry[method](sessionId)
      } catch (error) {
        warnings.push(`cannot clear the ${label} record for ${sessionId}: ${messageOf(error)}`)
      }
    }
    return warnings
  }

  /**
   * Delete one session's projection-cache document. Missing records are not an
   * error; a directory, symlink, or foreign type is skipped rather than
   * followed.
   *
   * @param {string} sessionId session whose record to remove.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  async function forgetProjection(sessionId) {
    if (projectionDirectory === undefined || !isSafeMemberId(sessionId)) return false
    const target = path.join(projectionDirectory, `${sessionId}.json`)
    if (!isInside(projectionDirectory, target)) return false
    let stats
    try {
      stats = await fs.lstat(target)
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return false
      throw error
    }
    if (!stats.isFile()) return false
    await fs.unlink(target)
    return true
  }

  /**
   * Release every derived record of one purged trash entry.
   *
   * @param {any} entry trash index entry whose session logs are gone.
   * @returns {Promise<{ warnings: string[] }>} best-effort failures.
   */
  async function release(entry) {
    const warnings = []
    for (const sessionId of entrySessionIds(entry)) {
      warnings.push(...(await releaseWorkspace(sessionId)))
      try {
        await forgetProjection(sessionId)
      } catch (error) {
        warnings.push(`cannot remove the projection-cache record for ${sessionId}: ${messageOf(error)}`)
      }
    }
    for (const warning of warnings) logger.warn(warning)
    return { warnings }
  }

  /**
   * Sweep projection-cache documents that no current, trashed, or missing
   * session can use. The caller supplies every session id this process knows
   * about, including `sessionPersistence` listings and live sessions.
   *
   * The age floor is the safety valve: a record written for a live Session in
   * another process stays until it is old enough to be provably abandoned.
   *
   * @param {{ keepSessionIds?: string[], minAgeMs?: number, now?: number }} [options] known ids, age floor, and clock.
   * @returns {Promise<{ removed: number }>} how many records were removed.
   */
  async function sweepProjectionCache(options = {}) {
    if (projectionDirectory === undefined) return { removed: 0 }
    const keep = new Set(Array.isArray(options.keepSessionIds) ? options.keepSessionIds : [])
    const minAgeMs = typeof options.minAgeMs === 'number' && options.minAgeMs >= 0
      ? options.minAgeMs
      : PROJECTION_SWEEP_MIN_AGE_MS
    const now = typeof options.now === 'number' ? options.now : Date.now()

    let names
    try {
      names = await fs.readdir(projectionDirectory)
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return { removed: 0 }
      logger.warn(`cannot list the projection cache at ${projectionDirectory}: ${messageOf(error)}`)
      return { removed: 0 }
    }

    let removed = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const sessionId = name.slice(0, -'.json'.length)
      if (!isSafeMemberId(sessionId) || keep.has(sessionId)) continue
      const target = path.join(projectionDirectory, name)
      if (!isInside(projectionDirectory, target)) continue
      let stats
      try {
        stats = await fs.lstat(target)
      } catch (error) {
        if (error !== null && error !== undefined && error.code === 'ENOENT') continue
        logger.warn(`cannot inspect the projection cache record ${name}: ${messageOf(error)}`)
        continue
      }
      if (!stats.isFile() || now - stats.mtimeMs < minAgeMs) continue
      try {
        await fs.unlink(target)
        removed += 1
      } catch (error) {
        if (error !== null && error !== undefined && error.code === 'ENOENT') continue
        logger.warn(`cannot remove the projection cache record ${name}: ${messageOf(error)}`)
      }
    }
    if (removed > 0) logger.debug(`swept ${removed} stale projection-cache records`)
    return { removed }
  }

  return { release, sweepProjectionCache }
}
