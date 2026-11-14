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

/** Attachment object names are lowercase SHA-256 digests. */
const OBJECT_NAME_PATTERN = /^[a-f0-9]{64}$/

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
 * Index durable attachment objects by content hash. `files/<hash>/<name>` is a
 * display alias for `file-objects/<hash>`, so both roots map to the same hash
 * and one size. Files that do not follow the known layout are counted as
 * unclassified disk usage instead of being silently dropped.
 *
 * @param {string} home absolute harness home.
 * @param {{ logger: { warn: Function } }} deps diagnostics.
 * @returns {Promise<{ files: number, bytes: number, objects: Map<string, number>, unclassifiedFiles: number, unclassifiedBytes: number, complete: boolean }>} attachment index.
 */
async function indexAttachments(home, { logger }) {
  /** @type {Map<string, number>} */
  const objects = new Map()
  let unclassifiedFiles = 0
  let unclassifiedBytes = 0
  let complete = true

  /**
   * @param {string} directory store root.
   * @param {(file: string) => string | undefined} hashOf derive a content hash from one file.
   * @param {number} depth current depth.
   * @returns {Promise<void>} resolution after the walk.
   */
  async function walk(directory, hashOf, depth = 0) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error === null || error === undefined || error.code !== 'ENOENT') {
        complete = false
        logger.warn(`cannot index ${directory}: ${messageOf(error)}`)
      }
      return
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(child, hashOf, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      let stats
      try {
        stats = await fs.lstat(child)
      } catch (error) {
        if (error !== null && error !== undefined && error.code === 'ENOENT') continue
        complete = false
        logger.warn(`cannot index ${child}: ${messageOf(error)}`)
        continue
      }
      if (!stats.isFile()) continue
      const hash = hashOf(child)
      if (hash !== undefined && OBJECT_NAME_PATTERN.test(hash)) {
        if (!objects.has(hash)) objects.set(hash, stats.size)
      } else {
        unclassifiedFiles += 1
        unclassifiedBytes += stats.size
      }
    }
  }

  for (const store of ATTACHMENT_STORES) {
    const root = homePath(home, ['attachments', 'v1', store])
    const hashOf = store === 'files'
      ? (file) => path.basename(path.dirname(file))
      : (file) => path.basename(file)
    await walk(root, hashOf)
  }

  let bytes = unclassifiedBytes
  for (const size of objects.values()) bytes += size
  return {
    files: objects.size + unclassifiedFiles,
    bytes,
    objects,
    unclassifiedFiles,
    unclassifiedBytes,
    complete,
  }
}

/**
 * Measure the session-related bytes the Trash page can explain: stored session
 * logs, trashed logs, durable attachments, regenerable attachment cache, and
 * the derived projection cache.
 *
 * When a reference scanner is available, the attachment total is split into
 * referenced and unreferenced bytes. The split is only published when the scan
 * is complete; a partial scan leaves both fields null instead of guessing.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   home?: string,
 *   logger: { warn: Function },
 *   references?: { scan: () => Promise<object> },
 * }} deps host services, harness home, diagnostics, and optional reference scanner.
 * @returns {{ snapshot: (options?: { entries?: readonly any[] }) => Promise<object> }} the storage projector.
 */
export function createStorageStats({ ctx, home, logger, references }) {
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
    const attachmentIndex = hasHome
      ? await indexAttachments(home, { logger })
      : { files: 0, bytes: 0, objects: new Map(), unclassifiedFiles: 0, unclassifiedBytes: 0, complete: false }
    const attachmentCache = hasHome
      ? await measureTree(homePath(home, ['cache', 'attachments']), { logger })
      : { files: 0, bytes: 0 }

    /** @type {{ files: number, bytes: number, complete: boolean, referencedBytes: number | null, orphanBytes: number | null, unclassifiedBytes: number, scan: { status: string, reason?: string, at?: number, scannedFiles?: number, failedFiles?: number, failedDirs?: number, tornFiles?: number } }} */
    const attachments = {
      files: attachmentIndex.files,
      bytes: attachmentIndex.bytes,
      complete: attachmentIndex.complete,
      referencedBytes: null,
      orphanBytes: null,
      unclassifiedBytes: attachmentIndex.unclassifiedBytes,
      scan: {
        status: 'unavailable',
        reason: hasHome ? 'no-scanner' : 'no-home',
      },
    }
    if (references !== undefined && typeof references.scan === 'function') {
      let referenceScan
      try {
        referenceScan = await references.scan()
      } catch (error) {
        referenceScan = { status: 'unavailable', reason: messageOf(error), refs: new Set() }
      }
      if (referenceScan !== null && typeof referenceScan === 'object' && referenceScan.refs instanceof Set) {
        attachments.scan = {
          status: referenceScan.status,
          at: referenceScan.at,
          scannedFiles: referenceScan.scannedFiles,
          failedFiles: referenceScan.failedFiles,
          failedDirs: referenceScan.failedDirs,
          tornFiles: referenceScan.tornFiles,
          ...(typeof referenceScan.reason === 'string' ? { reason: referenceScan.reason } : {}),
        }
        if (referenceScan.status === 'complete' && attachmentIndex.complete) {
          let referencedBytes = 0
          for (const [hash, size] of attachmentIndex.objects) {
            if (referenceScan.refs.has(hash)) referencedBytes += size
          }
          attachments.referencedBytes = referencedBytes
          attachments.orphanBytes = attachmentIndex.bytes - attachmentIndex.unclassifiedBytes - referencedBytes
        }
      }
    }

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
