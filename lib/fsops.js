import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { TrashError } from './errors.js'

/** Kernel lock file the JSONL persistence backend keeps inside a session directory. */
export const SESSION_LOCK_FILENAME = 'session.lock'

/**
 * Error codes that commonly mean “another process is touching this entry right
 * now”. Windows returns `EPERM`/`EACCES`/`EBUSY` for an antivirus scan or an
 * open handle; network filesystems return `EAGAIN`/`EMFILE`/`ENFILE`.
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'EAGAIN'])

/** Rename attempts before a transient failure is reported. */
const RENAME_ATTEMPTS = process.platform === 'win32' ? 10 : 3

/** Base delay between transient rename attempts. */
const RENAME_RETRY_DELAY_MS = 50

/** Windows device names a directory segment must never become. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** macOS and Windows default filesystems compare paths case-insensitively. */
export const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

/** Options shared by every directory copy performed for a cross-device move. */
const COPY_OPTIONS = {
  recursive: true,
  force: false,
  errorOnExist: true,
  dereference: false,
  verbatimSymlinks: true,
  preserveTimestamps: true,
}

/**
 * @param {any} error thrown filesystem failure.
 * @returns {string | undefined} the Node error code.
 */
export function errorCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
}

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
 * Retry an idempotent filesystem operation for the short window in which
 * another process holds the entry.
 *
 * @param {() => Promise<T>} operation filesystem operation to retry.
 * @param {{ attempts?: number, delayMs?: number }} [options] retry policy.
 * @returns {Promise<T>} the operation result.
 * @template T
 */
async function retryTransient(operation, options = {}) {
  const attempts = options.attempts ?? RENAME_ATTEMPTS
  const delayMs = options.delayMs ?? RENAME_RETRY_DELAY_MS
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !TRANSIENT_FS_CODES.has(errorCode(error))) throw error
      await sleep(delayMs * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Rename one path, retrying the transient sharing violations Windows and
 * network volumes report.
 *
 * @param {string} from current path.
 * @param {string} to target path.
 * @param {{ attempts?: number, delayMs?: number, operation?: () => Promise<void> }} [options] retry policy and test seam.
 * @returns {Promise<void>} resolution once the rename succeeded.
 */
export function renameWithRetry(from, to, options = {}) {
  return retryTransient(options.operation ?? (() => fs.rename(from, to)), options)
}

/**
 * Remove one file or directory, retrying transient sharing violations. Missing
 * targets are ignored when `force` is set.
 *
 * @param {string} target path to remove.
 * @param {{ recursive?: boolean, force?: boolean, attempts?: number, delayMs?: number, operation?: () => Promise<void> }} [options] removal policy and test seam.
 * @returns {Promise<void>} resolution once the target is gone.
 */
export function removePathWithRetry(target, options = {}) {
  const recursive = options.recursive ?? true
  const force = options.force ?? true
  return retryTransient(
    options.operation ?? (() => fs.rm(target, { recursive, force, maxRetries: 0 })),
    options,
  )
}

/**
 * Normalize a path for identity comparisons. The comparison is lowercased on
 * platforms whose default filesystem is case-insensitive; the returned path is
 * only ever compared, never used for filesystem access.
 *
 * @param {string} target path to normalize.
 * @param {{ pathImpl?: typeof path, caseInsensitive?: boolean }} [options] path implementation and platform policy.
 * @returns {string} the comparable form.
 */
export function comparablePath(target, options = {}) {
  const pathImpl = options.pathImpl ?? path
  const caseInsensitive = options.caseInsensitive ?? CASE_INSENSITIVE_PATHS
  const resolved = pathImpl.resolve(target)
  return caseInsensitive ? resolved.toLowerCase() : resolved
}

/**
 * @param {string} left first path.
 * @param {string} right second path.
 * @param {{ pathImpl?: typeof path, caseInsensitive?: boolean }} [options] path implementation and platform policy.
 * @returns {boolean} whether both paths name the same location.
 */
export function samePath(left, right, options = {}) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return comparablePath(left, options) === comparablePath(right, options)
}

/**
 * @param {string} target path to inspect.
 * @returns {Promise<'directory' | 'file' | 'symlink' | 'other' | 'missing'>} the entry type without following symlinks.
 */
export async function entryKind(target) {
  try {
    const stats = await fs.lstat(target)
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isDirectory()) return 'directory'
    if (stats.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

/**
 * @param {string} target path to inspect.
 * @returns {Promise<boolean>} whether a plain directory exists at `target`.
 */
export async function directoryExists(target) {
  if (typeof target !== 'string' || target === '') return false
  try {
    const stats = await fs.stat(target)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {typeof path} pathImpl path implementation.
 * @param {string} root containing directory.
 * @param {string} target path that must stay inside `root`.
 * @param {boolean} caseInsensitive whether this platform compares paths case-insensitively.
 * @returns {boolean} whether `target` is `root` itself or a descendant of it.
 */
export function isInsideUsing(pathImpl, root, target, caseInsensitive) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const left = comparablePath(root, { pathImpl, caseInsensitive })
  const right = comparablePath(target, { pathImpl, caseInsensitive })
  const relative = pathImpl.relative(left, right)
  return (
    relative === '' ||
    (!relative.startsWith(`..${pathImpl.sep}`) && relative !== '..' && !pathImpl.isAbsolute(relative))
  )
}

/**
 * @param {string} root containing directory.
 * @param {string} target path that must stay inside `root`.
 * @returns {boolean} whether `target` is `root` itself or a descendant of it.
 */
export function isInside(root, target) {
  return isInsideUsing(path, root, target, CASE_INSENSITIVE_PATHS)
}

/**
 * @param {any} trashId candidate object identity.
 * @returns {boolean} whether the identity is one safe path segment.
 */
export function isSafeTrashId(trashId) {
  return (
    typeof trashId === 'string' &&
    trashId !== '' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trashId) &&
    !trashId.includes('/') &&
    !trashId.includes('\\') &&
    trashId !== '.' &&
    trashId !== '..'
  )
}

/**
 * Whether a session identity may name one child directory inside a trash
 * object. Session ids are `session-<uuid>` or a bare uuid today, so the
 * accepted alphabet is deliberately conservative.
 *
 * @param {any} sessionId candidate member identity.
 * @returns {boolean} whether the identity is one safe path segment.
 */
export function isSafeMemberId(sessionId) {
  return (
    typeof sessionId === 'string' &&
    sessionId !== '' &&
    sessionId.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) &&
    sessionId !== '.' &&
    sessionId !== '..'
  )
}

/**
 * Reject a path that is not one safe segment below its parent.
 *
 * @param {string} directory absolute directory path.
 * @param {{ pathImpl?: typeof path, platform?: NodeJS.Platform }} [options] path implementation and platform policy.
 * @returns {boolean} whether the path is absolute and names one ordinary segment.
 */
export function isSafeDirectoryPath(directory, options = {}) {
  const pathImpl = options.pathImpl ?? path
  const platform = options.platform ?? process.platform
  if (typeof directory !== 'string' || directory === '' || !pathImpl.isAbsolute(directory)) return false
  const base = pathImpl.basename(directory)
  if (base === '' || base === '.' || base === '..') return false
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return false
  if (/[\u0000-\u001f]/.test(base)) return false
  if (platform === 'win32') {
    // Windows silently strips a trailing dot or space and treats the remaining
    // name as a device file; neither may become a session directory.
    if (/[ .]$/.test(base)) return false
    if (WINDOWS_RESERVED_NAMES.test(base)) return false
  }
  return pathImpl.dirname(directory) !== directory
}

/**
 * Walk one session directory without following symlinks. `session.lock` is a
 * live backend artifact and never counts toward the payload measured for a
 * move.
 *
 * @param {string} directory session-owned directory.
 * @returns {Promise<{ sizeBytes: number, fileCount: number, symlinkCount: number }>} aggregate regular-file metrics.
 */
export async function measureDirectory(directory) {
  const total = { sizeBytes: 0, fileCount: 0, symlinkCount: 0 }
  const walk = async (current, isRoot) => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        total.symlinkCount += 1
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolute, false)
        continue
      }
      if (!entry.isFile()) continue
      if (isRoot && entry.name === SESSION_LOCK_FILENAME) continue
      const stats = await fs.lstat(absolute)
      total.sizeBytes += stats.size
      total.fileCount += 1
    }
  }
  await walk(directory, true)
  return total
}

/**
 * @param {{ sizeBytes?: number | null, fileCount?: number | null, symlinkCount?: number | null } | null | undefined} entry index entry.
 * @param {{ sizeBytes: number, fileCount: number, symlinkCount?: number }} measured current metrics.
 * @returns {boolean} whether the recorded metrics are absent or match exactly.
 */
export function metricsMatch(entry, measured) {
  if (entry === null || entry === undefined) return true
  if (typeof entry.sizeBytes === 'number' && entry.sizeBytes !== measured.sizeBytes) return false
  if (typeof entry.fileCount === 'number' && entry.fileCount !== measured.fileCount) return false
  // A cross-device copy records the symlink count of the source; comparing it
  // catches a symlink that the copy silently dropped.
  if (typeof entry.symlinkCount === 'number' && typeof measured.symlinkCount === 'number' && entry.symlinkCount !== measured.symlinkCount) {
    return false
  }
  return true
}

/**
 * @param {{ sizeBytes?: number | null, fileCount?: number | null, symlinkCount?: number | null } | null | undefined} entry index entry.
 * @returns {boolean} whether the entry carries a complete move snapshot.
 */
export function hasMetrics(entry) {
  return (
    entry !== null &&
    entry !== undefined &&
    typeof entry.sizeBytes === 'number' &&
    typeof entry.fileCount === 'number'
  )
}

/**
 * Build a time-sortable trash identity: compact UTC timestamp plus random hex.
 *
 * @returns {string} a new candidate trash id.
 */
export function createTrashId() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
  return `${timestamp}-${randomBytes(4).toString('hex')}`
}

/**
 * Copy one directory tree into a sibling temporary directory, verify it, then
 * publish it with a rename and remove the source. Symlinks are copied as
 * symlinks and never dereferenced. Any failure before the source is removed
 * deletes the temporary tree, so a disk-full or permission failure never
 * leaves a half-published object behind.
 *
 * @param {string} source directory to copy.
 * @param {string} destination final directory path.
 * @param {{ sizeBytes: number, fileCount: number }} expected recorded metrics.
 * @param {(from: string, to: string) => Promise<void>} rename rename implementation for tests.
 * @param {(source: string, destination: string, options: any) => Promise<void>} copy copy implementation for tests.
 * @returns {Promise<void>} resolution after the destination is published.
 */
async function copyAcrossDevices(source, destination, expected, rename, copy) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.tmp-${randomBytes(4).toString('hex')}`)
  try {
    await copy(source, temporary, COPY_OPTIONS)
    const measured = await measureDirectory(temporary)
    if (!metricsMatch(expected, measured)) {
      throw new TrashError('MOVE_VERIFY_FAILED', 'The copied session does not match the measured snapshot.', {
        expected,
        measured,
      })
    }
    await rename(temporary, destination)
  } catch (error) {
    await removePathWithRetry(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  try {
    await fs.rm(source, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    // The paths stay in the Host log; the wire error only carries the error
    // code and the fact that a verified copy already exists.
    throw new TrashError(
      'IO_ERROR',
      'The session was copied to the destination, but the source could not be removed.',
      { code: errorCode(error) ?? null, copied: true },
    )
  }
}

/**
 * Move one session directory. A same-filesystem rename is atomic; `EXDEV`
 * falls back to copy → verify → publish → delete. The source must be a plain
 * directory, never a symlink.
 *
 * @param {string} source session directory to move.
 * @param {string} destination final directory path, which must not exist.
 * @param {{ sizeBytes?: number | null, fileCount?: number | null } | null | undefined} expected recorded metrics.
 * @param {{
 *   logger?: { warn: Function },
 *   rename?: (from: string, to: string) => Promise<void>,
 *   copy?: (source: string, destination: string, options: any) => Promise<void>,
 * }} [options] diagnostics sink and test seams.
 * @returns {Promise<void>} resolution after the directory lives at `destination`.
 */
export async function moveDirectory(source, destination, expected, options = {}) {
  const rename = options.rename ?? renameWithRetry
  const copy = options.copy ?? fs.cp
  const kind = await entryKind(source)
  if (kind !== 'directory') {
    throw new TrashError('UNSAFE_SESSION_DIR', 'The session directory is missing or is not a plain directory.', {
      kind,
    })
  }
  const targetKind = await entryKind(destination)
  if (targetKind !== 'missing') {
    throw new TrashError('RESTORE_TARGET_EXISTS', 'The destination directory already exists.', { targetKind })
  }
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new TrashError('IO_ERROR', 'The destination parent directory could not be created.', {
      code: errorCode(error) ?? null,
      phase: 'mkdir',
    })
  }
  try {
    await rename(source, destination)
    return
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') {
      throw new TrashError('IO_ERROR', 'The session directory could not be moved.', {
        code: errorCode(error) ?? null,
        phase: 'rename',
      })
    }
  }
  if (options.logger !== undefined) {
    options.logger.warn('the session storage and the trash root are on different filesystems; copying instead of renaming')
  }
  const recorded =
    expected !== null &&
    expected !== undefined &&
    typeof expected.sizeBytes === 'number' &&
    typeof expected.fileCount === 'number'
      ? { sizeBytes: expected.sizeBytes, fileCount: expected.fileCount }
      : await measureDirectory(source)
  try {
    await copyAcrossDevices(source, destination, recorded, rename, copy)
  } catch (error) {
    if (error instanceof TrashError) throw error
    throw new TrashError('IO_ERROR', 'The session directory could not be copied across filesystems.', {
      code: errorCode(error) ?? null,
      phase: 'copy',
    })
  }
}
