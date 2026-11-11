import test from 'node:test'
import assert from 'node:assert/strict'
import { createStateService, lastErrorCode } from '../lib/state.js'

const config = { retentionDays: 30, sweepIntervalHours: 6, enableAutoCleanup: true }

/**
 * @param {string} sessionId entry identity.
 * @param {string | null} cwd original workspace.
 * @param {object} [extra] extra entry fields.
 * @returns {object} one index entry.
 */
function entry(sessionId, cwd, extra = {}) {
  return {
    sessionId,
    title: sessionId,
    trashedAt: Date.now(),
    originalCwd: cwd,
    state: 'trashed',
    sizeBytes: 1,
    fileCount: 1,
    members: [{ sessionId, origin: null, sizeBytes: 1 }],
    lastError: null,
    ...extra,
  }
}

/**
 * @param {object[]} entries index entries.
 * @param {(cwd: string) => Promise<boolean>} probe workspace probe.
 * @returns {object} the state service.
 */
function createService(entries, probe) {
  const store = {
    entries: () => entries,
    describe: () => ({ status: 'ok', updatedAt: 1, error: null, unindexed: 0 }),
  }
  return createStateService({
    store,
    config,
    trashRootDisplay: '$DSH_HOME/.session-trash',
    directoryExists: probe,
  })
}

test('the state snapshot probes each distinct workspace once', async () => {
  let probes = 0
  const service = createService(
    [entry('a', '/work/shared'), entry('b', '/work/shared'), entry('c', '/work/other'), entry('d', null)],
    async () => {
      probes += 1
      return true
    },
  )
  const snapshot = await service.snapshot()
  assert.equal(probes, 2)
  assert.equal(snapshot.entries.length, 4)
  assert.equal(snapshot.entries[0].workspaceNowExists, true)
  assert.equal(snapshot.entries[3].workspaceNowExists, null)
})

test('lastErrorCode classifies recorded failure families', () => {
  assert.equal(lastErrorCode(null), null)
  assert.equal(lastErrorCode(''), null)
  assert.equal(lastErrorCode('The trash copy of this session is missing.'), 'TRASH_COPY_MISSING')
  assert.equal(lastErrorCode('The trash copy is missing these member sessions: a, b.'), 'TRASH_COPY_MISSING_MEMBERS')
  assert.equal(lastErrorCode('The trash object directory is missing.'), 'TRASH_OBJECT_MISSING')
  assert.equal(lastErrorCode('The session log could not be deleted: EACCES'), 'PURGE_FAILED')
  assert.equal(lastErrorCode('The restored session was not visible to session storage.'), 'RESTORE_INVISIBLE')
  assert.equal(lastErrorCode('The restored session tree is not visible to session storage.'), 'RESTORE_INVISIBLE')
  assert.equal(lastErrorCode('Session storage still reports the moved session tree.'), 'MOVE_UNSETTLED')
  assert.equal(lastErrorCode('An original session directory unexpectedly exists alongside the trash copy.'), 'SOURCE_CONFLICT')
  assert.equal(lastErrorCode('The trash index could not be committed after restore: x'), 'INDEX_WRITE_FAILED')
  assert.equal(lastErrorCode('EACCES: permission denied'), 'IO_ERROR')
})

test('the wire entry carries a stable code next to the raw diagnostic', async () => {
  const missing = entry('a', '/work/x', { state: 'missing', lastError: 'The trash copy of this session is missing.' })
  const service = createService([missing], async () => true)
  const described = await service.describe(missing)
  assert.equal(described.lastErrorCode, 'TRASH_COPY_MISSING')
  assert.equal(described.lastError, 'The trash copy of this session is missing.')
})
