import fs from 'node:fs/promises'
import { mapLimit } from './concurrency.js'
import { memberList } from './members.js'

/** Maximum concurrent filesystem probes while describing entries. */
const PROBE_CONCURRENCY = 3

/**
 * Known failure families recorded in `lastError`, in match order. The raw text
 * stays an English diagnostic for logs and tooltips; the code is what the
 * Client localizes.
 */
const LAST_ERROR_KINDS = [
  [/^The trash copy of this session is missing\./, 'TRASH_COPY_MISSING'],
  [/^The trash copy is missing these member sessions:/, 'TRASH_COPY_MISSING_MEMBERS'],
  [/^The trash object directory is missing\./, 'TRASH_OBJECT_MISSING'],
  [/^The session log could not be deleted:/, 'PURGE_FAILED'],
  [/^The restored session (tree )?(is|was) not visible to session storage\./, 'RESTORE_INVISIBLE'],
  [/^Session storage still reports the moved session tree/, 'MOVE_UNSETTLED'],
  [/^An original session directory unexpectedly exists/, 'SOURCE_CONFLICT'],
  [/^The trash index could not be committed/, 'INDEX_WRITE_FAILED'],
]

/**
 * @param {unknown} message raw `lastError` text.
 * @returns {string | null} a stable failure family, or null when none was recorded.
 */
export function lastErrorCode(message) {
  if (typeof message !== 'string' || message === '') return null
  for (const [pattern, code] of LAST_ERROR_KINDS) {
    if (pattern.test(message)) return code
  }
  return 'IO_ERROR'
}

/**
 * @param {string | null | undefined} directory candidate workspace directory.
 * @returns {Promise<boolean>} whether the directory exists right now.
 */
async function directoryExists(directory) {
  if (typeof directory !== 'string' || directory === '') return false
  try {
    const stats = await fs.stat(directory)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Build the read-only `/state` projection from the committed index.
 *
 * @param {{
 *   store: import('./store.js').TrashStore,
 *   config: { retentionDays: number, sweepIntervalHours: number, enableAutoCleanup: boolean },
 *   trashRootDisplay: string,
 *   nextSweepAt?: () => number | null,
 *   cleanup?: () => object,
 * }} deps state inputs.
 * @returns {{ snapshot: () => Promise<object>, describe: (entry: object) => Promise<object> }} the state service.
 */
export function createStateService({
  store,
  config,
  trashRootDisplay,
  nextSweepAt = () => null,
  cleanup,
  directoryExists: probeDirectory = directoryExists,
}) {
  /**
   * @returns {object} cleanup diagnostics, or a neutral fallback.
   */
  function cleanupDiagnostics() {
    if (typeof cleanup === 'function') {
      try {
        const value = cleanup()
        if (value !== null && typeof value === 'object') return value
      } catch {
        // Diagnostics must never break the read-only state projection.
      }
    }
    return {
      enabled: config.enableAutoCleanup,
      timerBacked: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextSweepAt: nextSweepAt(),
      retryAt: null,
      consecutiveFailures: 0,
      lastRun: null,
    }
  }

  /**
   * @param {object} entry committed index entry.
   * @param {Map<string, Promise<boolean>>} [probeCache] workspace probes already
   *   started for this snapshot, so entries sharing a cwd probe it once.
   * @returns {Promise<object>} the wire entry.
   */
  async function describeEntry(entry, probeCache = new Map()) {
    const cwd = typeof entry.originalCwd === 'string' && entry.originalCwd !== '' ? entry.originalCwd : null
    let workspaceNowExists = null
    if (cwd !== null) {
      if (!probeCache.has(cwd)) probeCache.set(cwd, probeDirectory(cwd))
      workspaceNowExists = await probeCache.get(cwd)
    }
    const expiresAt =
      typeof entry.trashedAt === 'number' && entry.trashedAt > 0 ? entry.trashedAt + config.retentionDays * 86_400_000 : null
    const trashed = entry.state === 'trashed'
    const members = memberList(entry)
    return {
      sessionId: entry.sessionId,
      title: entry.title,
      trashedAt: entry.trashedAt,
      expiresAt,
      originalCwd: cwd,
      workspaceExistsAtDeletion:
        typeof entry.workspaceExistsAtDeletion === 'boolean' ? entry.workspaceExistsAtDeletion : null,
      workspaceNowExists,
      sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : null,
      fileCount: typeof entry.fileCount === 'number' ? entry.fileCount : null,
      formatStatus: entry.formatStatus ?? null,
      state: entry.state,
      canRestore: trashed,
      canPurge: trashed,
      canForget: entry.state === 'missing',
      requiresOrphanRestore: cwd !== null && workspaceNowExists === false,
      lastError: entry.lastError ?? null,
      lastErrorCode: lastErrorCode(entry.lastError),
      subagentCount: Math.max(0, members.length - 1),
      members: members.map((member) => ({
        sessionId: member.sessionId,
        origin: member.origin === 'subagent' ? 'subagent' : null,
        sizeBytes: typeof member.sizeBytes === 'number' ? member.sizeBytes : null,
      })),
    }
  }

  return {
    /**
     * @param {object} entry committed index entry.
     * @returns {Promise<object>} the wire entry.
     */
    describe: describeEntry,
    /**
     * @returns {Promise<object>} the complete `/state` response body.
     */
    async snapshot() {
      const probeCache = new Map()
      const entries = await mapLimit(store.entries(), PROBE_CONCURRENCY, (entry) => describeEntry(entry, probeCache))
      let totalBytes = 0
      let failedEntries = 0
      for (const entry of entries) {
        if (typeof entry.sizeBytes === 'number') totalBytes += entry.sizeBytes
        if (typeof entry.lastError === 'string' && entry.lastError !== '') failedEntries += 1
      }
      const diagnostics = cleanupDiagnostics()
      return {
        version: 1,
        config: {
          retentionDays: config.retentionDays,
          sweepIntervalHours: config.sweepIntervalHours,
          enableAutoCleanup: config.enableAutoCleanup,
        },
        trashRootDisplay,
        index: store.describe(),
        entries,
        stats: {
          count: entries.length,
          totalBytes,
          failedEntries,
          nextSweepAt: diagnostics.nextSweepAt ?? nextSweepAt(),
          cleanup: diagnostics,
        },
      }
    },
  }
}
