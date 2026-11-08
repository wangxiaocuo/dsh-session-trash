import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHarness } from './helpers.js'
import { createCleanupService } from '../lib/cleanup.js'
import { TrashError } from '../lib/errors.js'

const DAY = 86_400_000

/**
 * @param {string} code expected error code.
 * @returns {(error: unknown) => boolean} an assertion predicate.
 */
function trashCode(code) {
  return (error) => error instanceof TrashError && error.code === code
}

/**
 * @param {object} harness test harness.
 * @param {string} sessionId entry to re-age.
 * @param {number} trashedAt replacement timestamp.
 * @returns {Promise<void>} resolution once committed.
 */
async function setTrashedAt(harness, sessionId, trashedAt) {
  const entries = harness.store
    .entries()
    .map((entry) => (entry.sessionId === sessionId ? { ...entry, trashedAt } : entry))
  await harness.store.commit(entries)
}

/**
 * @param {object} harness test harness.
 * @param {string} sessionId entry whose state to replace.
 * @param {string} state replacement state.
 * @returns {Promise<object>} the committed entry.
 */
async function setState(harness, sessionId, state) {
  const entries = harness.store
    .entries()
    .map((entry) => (entry.sessionId === sessionId ? { ...entry, state } : entry))
  await harness.store.commit(entries)
  return harness.store.findEntry(sessionId)
}

/**
 * @returns {object} a fake timer service capturing scheduled callbacks.
 */
function createFakeTimer() {
  const scheduled = []
  return {
    scheduled,
    interval(callback, delay) {
      const record = { kind: 'interval', callback, delay, disposed: false }
      scheduled.push(record)
      return () => {
        record.disposed = true
      }
    },
    timeout(callback, delay) {
      const record = { kind: 'timeout', callback, delay, disposed: false }
      scheduled.push(record)
      return () => {
        record.disposed = true
      }
    },
  }
}

/**
 * @param {object} timer fake timer service.
 * @returns {{ ctx: object, disposers: Function[] }} a minimal plugin context.
 */
function cleanupContext(timer) {
  const disposers = []
  return {
    disposers,
    ctx: {
      get(name) {
        return name === 'timer' ? timer : undefined
      },
      effect(callback) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
    },
  }
}

/**
 * @param {(options: object) => Promise<object>} sweep fake sweep implementation.
 * @param {{ sweepIntervalHours?: number, enableAutoCleanup?: boolean }} [config] overrides.
 * @returns {{ service: object, calls: object[], timer: object, disposers: Function[] }} the wired service.
 */
function createCleanup(sweep, config = {}) {
  const timer = createFakeTimer()
  const { ctx, disposers } = cleanupContext(timer)
  const calls = []
  const service = createCleanupService({
    ctx,
    trashService: {
      async sweep(options) {
        calls.push(options)
        return sweep(options)
      },
    },
    config: { sweepIntervalHours: 2, enableAutoCleanup: true, ...config },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  return { service, calls, timer, disposers }
}

/**
 * @returns {Promise<void>} resolution after pending microtasks and one timer turn.
 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

test('the sweep purges entries past the retention window and keeps fresh ones', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-old', cwd: project, title: 'Old' })
  await harness.addSession({ id: 'session-edge', cwd: project, title: 'Edge' })
  await harness.addSession({ id: 'session-fresh', cwd: project, title: 'Fresh' })
  const old = await harness.service.trash('session-old')
  await harness.service.trash('session-edge')
  const fresh = await harness.service.trash('session-fresh')
  const now = Date.now()
  await setTrashedAt(harness, 'session-old', now - 31 * DAY)
  await setTrashedAt(harness, 'session-edge', now - 30 * DAY)

  const summary = await harness.service.sweep({ allowPurge: true, now })
  assert.equal(summary.purged, 2, '31 days and exactly 30 days are both expired')
  assert.equal(harness.store.findEntry('session-old'), undefined)
  assert.equal(harness.store.findEntry('session-edge'), undefined)
  assert.equal(harness.store.findEntry('session-fresh')?.trashId, fresh.trashId)
  await assert.rejects(fs.stat(harness.store.objectDir(old.trashId)))
  assert.ok((await fs.stat(harness.store.sessionPath(fresh.trashId))).isDirectory())
  await harness.dispose()
})

test('the sweep follows a changed retention window', async () => {
  const harness = await createHarness({ config: { retentionDays: 30 } })
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.service.trash('session-a')
  const now = Date.now()
  await setTrashedAt(harness, 'session-a', now - 6 * DAY)
  harness.config.retentionDays = 5
  const summary = await harness.service.sweep({ allowPurge: true, now })
  assert.equal(summary.purged, 1)
  assert.equal(harness.store.findEntry('session-a'), undefined)
  await harness.dispose()
})

test('a sweep without purge permission only settles unfinished states', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  await setTrashedAt(harness, 'session-a', Date.now() - 90 * DAY)
  const summary = await harness.service.sweep({ allowPurge: false, now: Date.now() })
  assert.equal(summary.purged, 0)
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.ok((await fs.stat(harness.store.sessionPath(entry.trashId))).isDirectory())
  await harness.dispose()
})

test('manual purge deletes the object directory and removes the index entry', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  const result = await harness.service.purge('session-a')
  assert.equal(result.sessionId, 'session-a')
  assert.equal(harness.store.findEntry('session-a'), undefined)
  await assert.rejects(fs.stat(harness.store.objectDir(entry.trashId)))
  await assert.rejects(harness.service.purge('session-a'), trashCode('TRASH_ENTRY_NOT_FOUND'))

  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  await harness.service.trash('session-b')
  const second = harness.store.findEntry('session-b')
  await fs.rm(harness.store.sessionPath(second.trashId), { recursive: true, force: true })
  await harness.service.recover()
  await assert.rejects(harness.service.purge('session-b'), trashCode('TRASH_STATE_INVALID'))
  await harness.dispose()
})

test('forget removes only missing entries and keeps unknown object files', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  const first = await harness.service.trash('session-a')
  const second = await harness.service.trash('session-b')
  await assert.rejects(harness.service.forget('session-a'), trashCode('FORGET_NOT_ALLOWED'))

  await fs.rm(harness.store.sessionPath(first.trashId), { recursive: true, force: true })
  await fs.writeFile(path.join(harness.store.objectDir(first.trashId), 'keep.txt'), 'keep me')
  await harness.service.recover()
  assert.equal(harness.store.findEntry('session-a')?.state, 'missing')
  const result = await harness.service.forget('session-a')
  assert.equal(result.sessionId, 'session-a')
  assert.equal(harness.store.findEntry('session-a'), undefined)
  // The unknown file survives, so the object directory itself stays.
  assert.deepEqual(await fs.readdir(harness.store.objectDir(first.trashId)), ['keep.txt'])

  await fs.rm(harness.store.sessionPath(second.trashId), { recursive: true, force: true })
  await harness.service.recover()
  await harness.service.forget('session-b')
  await assert.rejects(fs.stat(harness.store.objectDir(second.trashId)))
  await harness.dispose()
})

test('orphan restore restores the log and detaches the workspace', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-a'] })
  await harness.service.trash('session-a')
  await fs.rm(project, { recursive: true, force: true })
  await assert.rejects(harness.service.restore('session-a', 'normal'), trashCode('WORKSPACE_MISSING'))

  const result = await harness.service.restore('session-a', 'orphan')
  assert.equal(result.orphan, true)
  assert.equal(result.workspaceReattached, false)
  assert.equal((await harness.persistence.stat('session-a')).location.path, record.logPath)
  assert.equal(harness.store.findEntry('session-a'), undefined)
  assert.deepEqual(workspace.calls, [['detach', 'session-a']])
  assert.deepEqual(workspace.sessionIds, [])
  assert.equal(harness.emissions.at(-1).event, 'api-session/added')
  assert.equal((await fs.readdir(path.join(harness.trashRoot, 'objects'))).length, 0)
  await harness.dispose()
})

test('orphan restore detaches even when the workspace directory still exists', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-a'] })
  await harness.service.trash('session-a')
  const result = await harness.service.restore('session-a', 'orphan')
  assert.equal(result.orphan, true)
  assert.equal(result.workspaceReattached, false)
  assert.deepEqual(workspace.calls, [['detach', 'session-a']])
  await harness.dispose()
})

test('a session without a cwd restores normally as ungrouped', async () => {
  const harness = await createHarness()
  const record = await harness.addSession({ id: 'session-a', title: 'A' })
  await harness.service.trash('session-a')
  const result = await harness.service.restore('session-a', 'normal')
  assert.equal(result.orphan, false)
  assert.equal(result.workspaceReattached, false)
  assert.equal((await harness.persistence.stat('session-a')).location.path, record.logPath)
  await harness.dispose()
})

test('an unknown restore mode is rejected without moving anything', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  await assert.rejects(harness.service.restore('session-a', 'other'), trashCode('INVALID_REQUEST'))
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.ok((await fs.stat(harness.store.sessionPath(entry.trashId))).isDirectory())
  await harness.dispose()
})

test('reveal opens the original workspace through the session controller', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.service.trash('session-a')
  const result = await harness.service.reveal('session-a')
  assert.equal(result.path, project)
  assert.deepEqual(harness.revealed, [{ path: project, action: 'reveal' }])

  await fs.rm(project, { recursive: true, force: true })
  await assert.rejects(harness.service.reveal('session-a'), trashCode('WORKSPACE_MISSING'))
  await harness.dispose()

  const withoutController = await createHarness({ sessionController: false })
  const otherProject = path.join(withoutController.root, 'project')
  await fs.mkdir(otherProject)
  await withoutController.addSession({ id: 'session-b', cwd: otherProject, title: 'B' })
  await withoutController.service.trash('session-b')
  await assert.rejects(withoutController.service.reveal('session-b'), trashCode('REVEAL_UNAVAILABLE'))
  await withoutController.dispose()

  const failing = await createHarness({ revealError: new Error('no native opener') })
  const failingProject = path.join(failing.root, 'project')
  await fs.mkdir(failingProject)
  await failing.addSession({ id: 'session-c', cwd: failingProject, title: 'C' })
  await failing.service.trash('session-c')
  await assert.rejects(failing.service.reveal('session-c'), trashCode('REVEAL_FAILED'))
  await failing.dispose()
})

test('reconcile imports orphaned objects and marks vanished ones missing', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  // Drop the index while keeping the object and its metadata.
  await harness.store.commit([])
  await harness.store.commit([])
  const summary = await harness.service.recover()
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.equal(harness.store.findEntry('session-a')?.trashId, entry.trashId)
  assert.equal(summary.changed, 0, 'an import is not a crash-matrix change')

  await fs.rm(harness.store.sessionPath(entry.trashId), { recursive: true, force: true })
  await harness.service.recover()
  assert.equal(harness.store.findEntry('session-a')?.state, 'missing')

  const junk = path.join(harness.trashRoot, 'objects', '20260101T000000-deadbeef')
  await fs.mkdir(junk, { recursive: true })
  await harness.service.recover()
  assert.equal(harness.store.describe().unindexed, 1)
  assert.equal(harness.store.findEntry('session-a')?.state, 'missing')
  await harness.dispose()
})

test('rebuild restores the index from object metadata after corruption', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  await harness.service.trash('session-a')
  await harness.service.trash('session-b')
  const unindexedDir = path.join(harness.trashRoot, 'objects', '20260101T000000-deadbeef')
  await fs.mkdir(unindexedDir, { recursive: true })

  await assert.rejects(harness.service.rebuild(), trashCode('INDEX_NOT_CORRUPT'))

  await fs.writeFile(path.join(harness.trashRoot, 'trash-index.json'), '{ broken')
  await fs.writeFile(path.join(harness.trashRoot, 'trash-index.json.bak'), '{ also broken')
  await harness.store.load()
  assert.equal(harness.store.isProtected(), true)
  const result = await harness.service.rebuild()
  assert.equal(result.entries, 2)
  assert.equal(result.unindexed, 1)
  assert.equal(harness.store.isProtected(), false)
  assert.equal(harness.store.describe().status, 'ok')
  assert.deepEqual(
    harness.store.entries().map((entry) => entry.sessionId).sort(),
    ['session-a', 'session-b'],
  )
  await harness.dispose()
})

test('purging entries are settled on the next recovery', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  const first = await harness.service.trash('session-a')
  const second = await harness.service.trash('session-b')
  await setState(harness, 'session-a', 'purging')
  await setState(harness, 'session-b', 'purging')
  await fs.rm(harness.store.objectDir(second.trashId), { recursive: true, force: true })
  await harness.service.recover()
  assert.equal(harness.store.findEntry('session-a'), undefined)
  assert.equal(harness.store.findEntry('session-b'), undefined)
  await assert.rejects(fs.stat(harness.store.objectDir(first.trashId)))
  await harness.dispose()
})

test('the state projection exposes retention, flags, and index summary', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  const first = await harness.service.trash('session-a')
  await harness.service.trash('session-b')
  await fs.rm(harness.store.sessionPath(harness.store.findEntry('session-b').trashId), { recursive: true, force: true })
  await harness.service.recover()

  const state = await harness.stateService.snapshot()
  assert.equal(state.version, 1)
  assert.deepEqual(state.config, { retentionDays: 30, sweepIntervalHours: 6, enableAutoCleanup: true })
  assert.equal(state.trashRootDisplay, '$DSH_HOME/.session-trash')
  assert.equal(state.index.status, 'ok')
  assert.equal(state.index.unindexed, 0)
  assert.equal(state.stats.count, 2)
  assert.equal(state.stats.nextSweepAt, null)

  const trashed = state.entries.find((entry) => entry.sessionId === 'session-a')
  assert.equal(trashed.state, 'trashed')
  assert.equal(trashed.canRestore, true)
  assert.equal(trashed.canPurge, true)
  assert.equal(trashed.canForget, false)
  assert.equal(trashed.expiresAt, first.trashedAt + 30 * DAY)
  assert.equal(trashed.workspaceNowExists, true)
  assert.equal(trashed.requiresOrphanRestore, false)

  const missing = state.entries.find((entry) => entry.sessionId === 'session-b')
  assert.equal(missing.state, 'missing')
  assert.equal(missing.canRestore, false)
  assert.equal(missing.canPurge, false)
  assert.equal(missing.canForget, true)
  await harness.dispose()
})

test('cleanup service schedules activation and interval sweeps', async () => {
  const { service, calls, timer, disposers } = createCleanup(async () => ({ purged: 1, failed: 0 }))
  service.start()
  const activation = timer.scheduled.find((record) => record.kind === 'timeout')
  assert.equal(activation.delay, 10_000)
  assert.ok(service.nextSweepAt() !== null)

  activation.callback()
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reason, 'activation')
  assert.equal(calls[0].allowPurge, true)
  assert.ok(service.lastSweepAt() > 0)

  const interval = timer.scheduled.find((record) => record.kind === 'interval')
  assert.equal(interval.delay, 2 * 60 * 60 * 1000)
  interval.callback()
  await flush()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].reason, 'interval')

  service.stop()
  assert.equal(disposers.length, 2)
})

test('cleanup service throttles page-open sweeps', async () => {
  const { service, calls } = createCleanup(async () => ({ purged: 0, failed: 0 }))
  service.maybeSweepOnPageOpen()
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reason, 'page-open')
  service.maybeSweepOnPageOpen()
  await flush()
  assert.equal(calls.length, 1)
  service.stop()
})

test('cleanup service degrades when automatic cleanup is disabled', async () => {
  const { service, calls, timer } = createCleanup(async () => ({ purged: 0, failed: 0 }), {
    enableAutoCleanup: false,
  })
  service.start()
  assert.equal(timer.scheduled.length, 0)
  assert.equal(service.nextSweepAt(), null)
  await service.runNow({ manual: true, reason: 'manual' })
  assert.equal(calls.at(-1).allowPurge, true)
  await service.runNow({ reason: 'scheduled' })
  assert.equal(calls.at(-1).allowPurge, false)
  service.stop()
})

test('failed automatic purges are retried with exponential backoff', async () => {
  const results = [
    { purged: 0, failed: 2 },
    { purged: 0, failed: 1 },
    { purged: 1, failed: 0 },
  ]
  const { service, calls, timer } = createCleanup(async () => results.shift())
  service.start()
  const activation = timer.scheduled.find((record) => record.kind === 'timeout')
  activation.callback()
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(service.diagnostics().consecutiveFailures, 1)
  const firstRetry = service.diagnostics().retryAt
  assert.ok(typeof firstRetry === 'number')

  const retryOne = timer.scheduled.find((record) => record.kind === 'timeout' && !record.disposed && record !== activation)
  assert.equal(retryOne.delay, 60_000)
  retryOne.callback()
  await flush()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].reason, 'retry')
  assert.equal(service.diagnostics().consecutiveFailures, 2)
  const retryTwo = timer.scheduled.find(
    (record) => record.kind === 'timeout' && !record.disposed && record !== activation && record !== retryOne,
  )
  assert.equal(retryTwo.delay, 120_000)

  retryTwo.callback()
  await flush()
  assert.equal(calls.length, 3)
  assert.equal(service.diagnostics().consecutiveFailures, 0)
  assert.equal(service.diagnostics().retryAt, null)
  assert.equal(service.diagnostics().lastRun.failed, 0)
  assert.equal(service.diagnostics().lastRun.purged, 1)
  assert.ok(service.lastSweepAt() > 0)
  service.stop()
})

test('a thrown automatic sweep records diagnostics and schedules a retry', async () => {
  let fail = true
  const { service, calls, timer } = createCleanup(async () => {
    if (fail) {
      fail = false
      throw new TrashError('INDEX_CORRUPT', 'index unavailable')
    }
    return { purged: 0, failed: 0 }
  })
  service.start()
  const activation = timer.scheduled.find((record) => record.kind === 'timeout')
  activation.callback()
  await flush()
  assert.equal(calls.length, 1)
  const failed = service.diagnostics()
  assert.equal(failed.consecutiveFailures, 1)
  assert.equal(failed.lastRun.error, 'index unavailable')
  assert.ok(failed.retryAt !== null)

  const retry = timer.scheduled.find((record) => record.kind === 'timeout' && !record.disposed && record !== activation)
  retry.callback()
  await flush()
  assert.equal(calls.length, 2)
  const recovered = service.diagnostics()
  assert.equal(recovered.consecutiveFailures, 0)
  assert.equal(recovered.retryAt, null)
  assert.equal(recovered.lastRun.error, null)
  service.stop()
})

test('a failed manual cleanup is recorded but does not schedule a retry', async () => {
  const { service, timer } = createCleanup(async () => {
    throw new TrashError('IO_ERROR', 'disk unavailable')
  })
  await assert.rejects(service.runNow({ manual: true, reason: 'manual' }), trashCode('IO_ERROR'))
  const diagnostics = service.diagnostics()
  assert.equal(diagnostics.consecutiveFailures, 1)
  assert.equal(diagnostics.retryAt, null)
  assert.equal(diagnostics.lastRun.error, 'disk unavailable')
  assert.equal(timer.scheduled.filter((record) => record.kind === 'timeout').length, 0)
  service.stop()
})

test('stop disposes a pending cleanup retry', async () => {
  const { service, calls, timer } = createCleanup(async () => ({ purged: 0, failed: 1 }))
  service.start()
  const activation = timer.scheduled.find((record) => record.kind === 'timeout')
  activation.callback()
  await flush()
  const retry = timer.scheduled.find((record) => record.kind === 'timeout' && !record.disposed && record !== activation)
  assert.ok(retry !== undefined)
  service.stop()
  assert.equal(retry.disposed, true)
  retry.callback()
  await flush()
  assert.equal(calls.length, 1)
})

test('a manual cleanup waits for an automatic sweep before purging', async () => {
  const calls = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { service } = createCleanup(async (options) => {
    calls.push(options)
    if (calls.length === 1) {
      await gate
      return { purged: 0, failed: 0 }
    }
    return { purged: 1, failed: 0 }
  })
  const automatic = service.runNow({ reason: 'interval' })
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].allowPurge, true)
  const manual = service.runNow({ manual: true, reason: 'manual' })
  await flush()
  assert.equal(calls.length, 1, 'the manual sweep waits for the in-flight sweep')
  release()
  await automatic
  const result = await manual
  assert.equal(result.purged, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].reason, 'manual')
  service.stop()
})

test('the state projection exposes cleanup diagnostics and failed entries', async () => {
  const cleanup = {
    enabled: true,
    timerBacked: true,
    lastAttemptAt: 10,
    lastSuccessAt: 10,
    nextSweepAt: 20,
    retryAt: null,
    consecutiveFailures: 0,
    lastRun: { at: 10, reason: 'interval', purged: 0, failed: 0, settled: 0, allowPurge: true, durationMs: 1, error: null },
  }
  const harness = await createHarness({ cleanup: () => cleanup })
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  await harness.store.commit([{ ...entry, lastError: 'The trash copy is missing.' }])
  const state = await harness.stateService.snapshot()
  assert.equal(state.stats.failedEntries, 1)
  assert.deepEqual(state.stats.cleanup, cleanup)
  assert.equal(state.stats.nextSweepAt, 20)
  await harness.dispose()
})
