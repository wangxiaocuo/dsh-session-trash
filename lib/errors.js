import path from 'node:path'

/**
 * Error codes shared by the Host API and the Client UI, with their HTTP status.
 * `null` marks a startup-only failure that never reaches HTTP.
 */
export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  FORBIDDEN: 403,
  METHOD_NOT_ALLOWED: 405,
  SESSION_NOT_FOUND: 404,
  SESSION_LIVE: 409,
  SESSION_ACTIVE: 409,
  SESSION_SUBAGENT: 409,
  SESSION_HAS_DESCENDANTS: 409,
  SESSION_LINEAGE_UNRESOLVED: 409,
  SESSION_NOT_MATERIALIZED: 409,
  STORAGE_UNSUPPORTED: 409,
  ALREADY_TRASHED: 409,
  TRASH_ENTRY_NOT_FOUND: 404,
  TRASH_STATE_INVALID: 409,
  FORGET_NOT_ALLOWED: 409,
  TRASH_DIR_MISSING: 409,
  RESTORE_TARGET_EXISTS: 409,
  WORKSPACE_MISSING: 409,
  RESTORE_VERIFY_FAILED: 500,
  MOVE_VERIFY_FAILED: 500,
  MOVE_CONFLICT: 409,
  INDEX_WRITE_FAILED: 500,
  INDEX_NOT_CORRUPT: 409,
  UNSAFE_SESSION_DIR: 409,
  UNSAFE_RESTORE_PATH: 409,
  REVEAL_UNAVAILABLE: 409,
  REVEAL_FAILED: 500,
  LOCKED: 409,
  INDEX_CORRUPT: 500,
  IO_ERROR: 500,
  HOME_UNRESOLVED: null,
}

/** A failure with a stable machine code and an owner-facing message. */
export class TrashError extends Error {
  /**
   * @param {string} code stable error code.
   * @param {string} message owner-facing explanation.
   * @param {Record<string, unknown>} [details] optional structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'TrashError'
    this.code = code
    this.details = details
  }
}

/**
 * @param {unknown} error arbitrary thrown value.
 * @returns {number} HTTP status for this error.
 */
export function statusOf(error) {
  const code = error instanceof TrashError ? error.code : 'IO_ERROR'
  return ERROR_STATUS[code] ?? 500
}

/**
 * Detail keys the Host may return to the Client. Anything else - notably raw
 * filesystem paths or nested error text - stays in the Host log, because the
 * wire contract promises that the trash root's absolute path is never exposed.
 */
const SAFE_DETAIL_KEYS = new Set([
  'sessionId',
  'trashId',
  'code',
  'phase',
  'copied',
  'kind',
  'targetKind',
  'expected',
  'measured',
  'activity',
  'descendants',
  'sessions',
])

/**
 * Metrics snapshots are the only nested detail value the Host returns; keep
 * only their numeric counters so no path can ride along.
 *
 * @param {unknown} value candidate metrics object.
 * @returns {{ sizeBytes?: number, fileCount?: number, symlinkCount?: number } | undefined} the numeric metrics.
 */
function sanitizeMetrics(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  /** @type {Record<string, unknown>} */
  const safe = {}
  for (const key of ['sizeBytes', 'fileCount', 'symlinkCount']) {
    if (typeof record[key] === 'number') safe[key] = record[key]
  }
  return Object.keys(safe).length === 0 ? undefined : safe
}

/**
 * @param {unknown} details arbitrary structured context.
 * @returns {Record<string, unknown> | undefined} the same context restricted to whitelisted keys.
 */
export function sanitizeDetails(details) {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined
  /** @type {Record<string, unknown>} */
  const safe = {}
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (details))) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue
    if (key === 'expected' || key === 'measured') {
      const metrics = sanitizeMetrics(value)
      if (metrics !== undefined) safe[key] = metrics
      continue
    }
    if (Array.isArray(value)) {
      safe[key] = value.filter((item) => typeof item === 'string' || typeof item === 'number')
      continue
    }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value
  }
  return Object.keys(safe).length === 0 ? undefined : safe
}

/**
 * @param {unknown} error arbitrary thrown value.
 * @returns {{ code: string, message: string, details?: Record<string, unknown> }} the wire error shape.
 */
export function toWireError(error) {
  if (error instanceof TrashError) {
    const details = sanitizeDetails(error.details)
    return {
      code: error.code,
      message: error.message,
      ...(details === undefined ? {} : { details }),
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'IO_ERROR', message }
}

/**
 * @param {string} sessionDir a session-owned directory.
 * @returns {boolean} whether the directory name is a single safe path segment.
 */
export function isSafeSegment(sessionDir) {
  const base = path.basename(sessionDir)
  if (base === '' || base === '.' || base === '..') return false
  if (base !== sessionDir.split(path.sep).pop()) return false
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return false
  return path.dirname(sessionDir) !== sessionDir
}
