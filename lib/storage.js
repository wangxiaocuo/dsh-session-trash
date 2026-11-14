import fs from 'node:fs/promises'
import path from 'node:path'
import { PROJECTION_SWEEP_MIN_AGE_MS } from './artifacts.js'
import { isSafeMemberId } from './fsops.js'
import { memberList } from './members.js'

/** Attachment stores below `<DSH_HOME>/attachments/v1` that hold durable bytes. */
const ATTACHMENT_STORES = ['objects', 'file-objects', 'files', 'request-images']

/** Projection-cache directory below the harness home. */
const PROJECTION_CACHE_SEGMENTS = ['storages', 'session_projcache', 'sessions']

/** Maximum directory depth measured under one artifact root. */
const MAX_DEPTH = 4

/**
 * @param {unknown} error arbitrary failure.
 * @returns {string} a user-facing message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sum the regular files below one directory without following symlinks.
 *
 * A missing root is normal (the feature was never used) and measures zero. An
 * unreadable child is reported and skipped so `/state` never fails because one
 * attachment directory is damaged.
 *
 * @param {string} root absolute directory.
 * @param {{ depth?: number, logger: { warn: Function }, seenInodes?: Set<string> }} options current depth, diagnostics, and hard-link identity set.
 * @returns {Promise<{ files: number, bytes: number }>} unique regular-file count and total bytes.
 */
async function measureTree(root, { depth = 0, logger, seenInodes }) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error !== null && error !== undefined && error.code === 'ENOENT') return { files: 0, bytes: 0 }
    logger.warn(`cannot measure ${root}: ${messageOf(error)}`)
    return { files: 0, bytes: 0 }
  }

  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    const child = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth >= MAX_DEPTH) continue
      const nested = await measureTree(child, {
        depth: depth + 1,
        logger,
        ...(seenInodes === undefined ? {} : { seenInodes }),
      })
      files += nested.files
      bytes += nested.bytes
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stats = await fs.lstat(child)
      if (!stats.isFile()) continue
      if (seenInodes !== undefined && stats.ino > 0) {
        const identity = `${stats.dev}:${stats.ino}`
        if (seenInodes.has(identity)) continue
        seenInodes.add(identity)
      }
      files += 1
      bytes += stats.size
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') continue
      logger.warn(`cannot measure ${child}: ${messageOf(error)}`)
    }
  }
  return { files, bytes }
}

/**
 * @param {string} home harness home.
 * @param {readonly string[]} segments path below the home.
 * @returns {string} the joined absolute path.
 */
function homePath(home, segments) {
  return path.join(home, ...segments)
}

/**
 * Measure the session-related bytes the Trash page can explain: stored session
 * logs, trashed logs, durable attachments, regenerable attachment cache, and
 * the derived projection cache.
 *
 * Attachments are reported as a total. This cut does not claim to know which
 * objects are unreferenced; that reachability analysis belongs to the later
 * reclamation feature, and presenting a guessed number here would be worse
 * than no number.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   home?: string,
 *   logger: { warn: Function },
 * }} deps host services, harness home, and diagnostics.
 * @returns {{ snapshot: (options?: { entries?: readonly any[] }) => Promise<object> }} the storage projector.
 */
export function createStorageStats({ ctx, home, logger }) {
  /**
   * @param {{ entries?: readonly any[] }} [options] raw trash entries whose logs are on disk.
   * @returns {Promise<object>} the `storage` block of `/state`.
   */
  async function snapshot({ entries = [] } = {}) {
    const keep = new Set()
    let keepComplete = true
    let sessionLogs = { count: 0, bytes: 0 }

    const persistence = ctx.sessionPersistence
    if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
      try {
        for (const stored of await persistence.list()) {
          const id = stored?.header?.id
          if (isSafeMemberId(id)) keep.add(id)
          sessionLogs = {
            count: sessionLogs.count + 1,
            bytes: sessionLogs.bytes + (typeof stored?.sizeBytes === 'number' ? stored.sizeBytes : 0),
          }
        }
      } catch (error) {
        keepComplete = false
        logger.warn(`cannot list stored sessions for storage stats: ${messageOf(error)}`)
      }
    }
    try {
      const live = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
      for (const session of live) {
        if (isSafeMemberId(session?.id)) keep.add(session.id)
      }
    } catch (error) {
      keepComplete = false
      logger.warn(`cannot list live sessions for storage stats: ${messageOf(error)}`)
    }

    let trashLogs = { count: 0, bytes: 0 }
    for (const entry of entries) {
      trashLogs = {
        count: trashLogs.count + 1,
        bytes: trashLogs.bytes + (typeof entry?.sizeBytes === 'number' ? entry.sizeBytes : 0),
      }
      for (const member of memberList(entry)) {
        if (isSafeMemberId(member?.sessionId)) keep.add(member.sessionId)
      }
    }

    const hasHome = typeof home === 'string' && home !== '' && path.isAbsolute(home)
    const attachmentInodes = new Set()
    const attachmentParts = hasHome
      ? await Promise.all(
        ATTACHMENT_STORES.map((store) =>
          measureTree(homePath(home, ['attachments', 'v1', store]), { logger, seenInodes: attachmentInodes }),
        ),
      )
      : []
    const attachments = attachmentParts.reduce(
      (total, part) => ({ files: total.files + part.files, bytes: total.bytes + part.bytes }),
      { files: 0, bytes: 0 },
    )
    const attachmentCache = hasHome
      ? await measureTree(homePath(home, ['cache', 'attachments']), { logger })
      : { files: 0, bytes: 0 }

    let projectionCache = { records: 0, bytes: 0, sweepableRecords: 0, sweepableBytes: 0 }
    if (hasHome) {
      const directory = homePath(home, PROJECTION_CACHE_SEGMENTS)
      let names
      try {
        names = await fs.readdir(directory)
      } catch (error) {
        if (error === null || error === undefined || error.code !== 'ENOENT') {
          logger.warn(`cannot list the projection cache for storage stats: ${messageOf(error)}`)
        }
        names = []
      }
      const now = Date.now()
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const sessionId = name.slice(0, -'.json'.length)
        if (!isSafeMemberId(sessionId)) continue
        const target = path.join(directory, name)
        let stats
        try {
          stats = await fs.lstat(target)
        } catch (error) {
          if (error !== null && error !== undefined && error.code === 'ENOENT') continue
          logger.warn(`cannot inspect the projection cache record ${name}: ${messageOf(error)}`)
          continue
        }
        if (!stats.isFile()) continue
        projectionCache.records += 1
        projectionCache.bytes += stats.size
        if (
          keepComplete &&
          !keep.has(sessionId) &&
          now - stats.mtimeMs >= PROJECTION_SWEEP_MIN_AGE_MS
        ) {
          projectionCache.sweepableRecords += 1
          projectionCache.sweepableBytes += stats.size
        }
      }
    }

    return {
      measuredAt: Date.now(),
      totalBytes:
        sessionLogs.bytes + trashLogs.bytes + attachments.bytes + attachmentCache.bytes + projectionCache.bytes,
      sessionLogs,
      trashLogs,
      attachments,
      attachmentCache,
      projectionCache,
    }
  }

  return { snapshot }
}
