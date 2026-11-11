import fs from 'node:fs/promises'
import { mapLimit } from './concurrency.js'
import { memberList } from './members.js'

/** Maximum concurrent filesystem probes while describing entries. */
const PROBE_CONCURRENCY = 3

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
export function createStateService({ store, config, trashRootDisplay, nextSweepAt = () => null, cleanup }) {
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
   * @returns {Promise<object>} the wire entry.
   */
  async function describeEntry(entry) {
    const cwd = typeof entry.originalCwd === 'string' && entry.originalCwd !== '' ? entry.originalCwd : null
    const workspaceNowExists = cwd === null ? null : await directoryExists(cwd)
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
      const entries = await mapLimit(store.entries(), PROBE_CONCURRENCY, (entry) => describeEntry(entry))
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
