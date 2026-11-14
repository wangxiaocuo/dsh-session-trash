import fs from 'node:fs/promises'
import path from 'node:path'
import { decompressZstdLog, hasZstd } from './zstd-frames.js'

/** Session-log file names used by the JSONL persistence backend. */
const LOG_FILE_PATTERN = /^session\.[^/]+\.jsonl\.zstd$/

/** Attachment references are content IDs embedded in canonical JSONL. */
const REFERENCE_PATTERN = /sha256:([a-f0-9]{64})/gi

/** Maximum directory depth under the harness home that may hold a session log. */
const MAX_DEPTH = 6

/**
 * @param {unknown} error arbitrary failure.
 * @returns {string} a user-facing message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Collect attachment references from every durable session log, including the
 * logs inside the trash. The scan is read-only and deliberately filesystem-
 * based: DSH's persistence service stops seeing a session as soon as it moves
 * into the trash, but the trash logs still own live attachment references.
 *
 * Logs are buffered in memory only for the duration of one file, and a small
 * per-file cache keyed by size and mtime makes subsequent scans cheap. A torn
 * final frame is normal for a session that is still being appended to; it is
 * reported separately, while a frame that cannot be decoded makes the scan
 * partial so callers never treat an incomplete reference set as authoritative.
 *
 * @param {{ home?: string, logger: { warn: Function } }} deps harness home and diagnostics.
 * @returns {{ scan: () => Promise<object> }} the scanner.
 */
export function createReferenceScanner({ home, logger }) {
  const cache = new Map()
  let inFlight = null

  /**
   * @returns {boolean} whether the configured home can be scanned.
   */
  function hasHome() {
    return typeof home === 'string' && home !== '' && path.isAbsolute(home)
  }

  /**
   * @param {string} directory root to walk.
   * @param {number} depth current depth.
   * @param {string[]} files collected log paths.
   * @param {string[]} failures unreadable directory diagnostics.
   * @returns {Promise<void>} resolution after the walk.
   */
  async function collectLogs(directory, depth, files, failures) {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error === null || error === undefined || error.code !== 'ENOENT') {
        failures.push(`cannot list session logs under ${directory}: ${messageOf(error)}`)
        logger.warn(`cannot list session logs under ${directory}: ${messageOf(error)}`)
      }
      return
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await collectLogs(child, depth + 1, files, failures)
      } else if (entry.isFile() && LOG_FILE_PATTERN.test(entry.name)) {
        files.push(child)
      }
    }
  }

  /**
   * @returns {Promise<{ files: string[], failures: string[] }>} every session-log file to scan and unreadable directory diagnostics.
   */
  async function listLogs() {
    if (!hasHome()) return { files: [], failures: [] }
    const files = []
    const failures = []
    await collectLogs(path.join(home, 'sessions'), 0, files, failures)
    await collectLogs(path.join(home, '.session-trash', 'objects'), 0, files, failures)
    return { files, failures }
  }

  /**
   * Decode one log, reusing its cached references when size and mtime agree.
   *
   * @param {string} file absolute log path.
   * @returns {Promise<{ refs: string[], failed: boolean, torn: boolean, reason?: string }>} per-file result.
   */
  async function scanFile(file) {
    let stats
    try {
      stats = await fs.lstat(file)
    } catch (error) {
      if (error === null || error === undefined || error.code === 'ENOENT') {
        return { refs: [], failed: true, torn: false, reason: 'log-disappeared' }
      }
      logger.warn(`cannot inspect the session log ${file}: ${messageOf(error)}`)
      return { refs: [], failed: true, torn: false, reason: 'log-unreadable' }
    }
    if (!stats.isFile()) return { refs: [], failed: true, torn: false, reason: 'not-a-file' }

    const cached = cache.get(file)
    if (cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      return cached.result
    }

    let buffer
    try {
      buffer = await fs.readFile(file)
    } catch (error) {
      logger.warn(`cannot read the session log ${file}: ${messageOf(error)}`)
      const result = { refs: [], failed: true, torn: false, reason: 'log-unreadable' }
      cache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, result })
      return result
    }

    const decoded = decompressZstdLog(buffer)
    let result
    if (!decoded.ok) {
      const reason = 'reason' in decoded && typeof decoded.reason === 'string' ? decoded.reason : 'decode-failed'
      logger.warn(`cannot decode the session log ${file}: ${reason}`)
      result = { refs: [], failed: true, torn: false, reason }
    } else {
      const refs = []
      for (const match of decoded.text.matchAll(REFERENCE_PATTERN)) {
        const hash = match[1].toLowerCase()
        if (!refs.includes(hash)) refs.push(hash)
      }
      result = { refs, failed: false, torn: !decoded.complete }
    }
    cache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, result })
    return result
  }

  /**
   * @returns {Promise<object>} the aggregate reference scan.
   */
  async function scan() {
    if (!hasHome()) {
      return {
        refs: new Set(),
        status: 'unavailable',
        reason: 'no-home',
        scannedFiles: 0,
        failedFiles: 0,
        failedDirs: 0,
        tornFiles: 0,
        at: Date.now(),
        durationMs: 0,
      }
    }
    if (!hasZstd()) {
      return {
        refs: new Set(),
        status: 'unavailable',
        reason: 'zstd-unavailable',
        scannedFiles: 0,
        failedFiles: 0,
        failedDirs: 0,
        tornFiles: 0,
        at: Date.now(),
        durationMs: 0,
      }
    }
    if (inFlight !== null) return inFlight

    inFlight = (async () => {
      const startedAt = Date.now()
      const listing = await listLogs()
      const { files } = listing
      const failedDirs = listing.failures.length
      if (failedDirs === 0) {
        const live = new Set(files)
        for (const key of cache.keys()) {
          if (!live.has(key)) cache.delete(key)
        }
      }

      const refs = new Set()
      let failedFiles = 0
      let tornFiles = 0
      let failureReason = listing.failures[0]
      for (const file of files) {
        const result = await scanFile(file)
        for (const hash of result.refs) refs.add(hash)
        if (result.failed) {
          failedFiles += 1
          failureReason ??= result.reason
        }
        if (result.torn) tornFiles += 1
      }
      return {
        refs,
        status: failedFiles === 0 && failedDirs === 0 ? 'complete' : 'partial',
        ...(failureReason === undefined ? {} : { reason: failureReason }),
        scannedFiles: files.length,
        failedFiles,
        failedDirs,
        tornFiles,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
      }
    })()

    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  return { scan }
}
