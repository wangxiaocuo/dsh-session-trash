import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createStorageStats } from '../lib/storage.js'
import { createLogger, createTempDir, skipAsRoot, skipOnWindows } from './helpers.js'

/**
 * @param {string} file absolute file path.
 * @param {number} bytes byte count.
 * @returns {Promise<void>} resolution after the file exists.
 */
async function writeBytes(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, Buffer.alloc(bytes, 1))
}

test('storage stats measure logs, attachments, caches, and sweepable projection records', async () => {
  const home = await createTempDir()
  const logger = createLogger()
  const old = new Date(Date.now() - 8 * 86_400_000)
  const attachments = path.join(home, 'attachments', 'v1')

  await writeBytes(path.join(attachments, 'objects', 'aa', 'a'.repeat(64)), 100)
  await writeBytes(path.join(attachments, 'file-objects', 'bb', 'b'.repeat(64)), 50)
  await writeBytes(path.join(attachments, 'files', 'cc', 'c'.repeat(64), 'report.pdf'), 30)
  const fileObject = path.join(attachments, 'file-objects', 'bb', 'b'.repeat(64))
  const fileAlias = path.join(attachments, 'files', 'bb', 'b'.repeat(64), 'linked.pdf')
  await fs.mkdir(path.dirname(fileAlias), { recursive: true })
  try {
    await fs.link(fileObject, fileAlias)
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EXDEV' && code !== 'ENOTSUP') throw error
  }
  await writeBytes(path.join(attachments, 'request-images', 'dd', 'd'.repeat(64)), 20)
  await writeBytes(path.join(attachments, 'tmp', 'staged'), 999)
  await writeBytes(path.join(attachments, 'objects', '.DS_Store'), 500)
  await writeBytes(path.join(home, 'cache', 'attachments', 'request-images', 'ee', 'e'.repeat(64)), 40)

  const projection = path.join(home, 'storages', 'session_projcache', 'sessions')
  const live = path.join(projection, 'session-live.json')
  const stale = path.join(projection, 'session-stale.json')
  const recent = path.join(projection, 'session-recent.json')
  const trashed = path.join(projection, 'session-trashed.json')
  await writeBytes(live, 10)
  await writeBytes(stale, 20)
  await writeBytes(recent, 5)
  await writeBytes(trashed, 7)
  await fs.mkdir(path.join(projection, 'session-directory.json'), { recursive: true })
  for (const file of [live, stale, trashed]) await fs.utimes(file, old, old)

  const ctx = {
    sessionPersistence: {
      async list() {
        return [
          { header: { id: 'session-live' }, sizeBytes: 1000 },
          { header: { id: 'session-other' }, sizeBytes: 500 },
        ]
      },
    },
    sessions: {
      list() {
        return [{ id: 'session-live' }]
      },
    },
  }
  const entries = [
    {
      sessionId: 'session-trashed',
      sizeBytes: 300,
      members: [{ sessionId: 'session-trashed' }],
    },
  ]
  const stats = createStorageStats({ ctx, home, logger })

  const snapshot = await stats.snapshot({ entries })

  assert.deepEqual(snapshot.sessionLogs, { count: 2, bytes: 1500 })
  assert.deepEqual(snapshot.trashLogs, { count: 1, bytes: 300 })
  assert.deepEqual(snapshot.attachments, {
    files: 4,
    bytes: 200,
    complete: true,
    referencedBytes: null,
    orphanBytes: null,
    unclassifiedBytes: 0,
    scan: { status: 'unavailable', reason: 'no-scanner' },
  })
  assert.deepEqual(snapshot.attachmentCache, { files: 1, bytes: 40 })
  assert.deepEqual(snapshot.projectionCache, {
    records: 4,
    bytes: 42,
    sweepableRecords: 1,
    sweepableBytes: 20,
  })
  assert.equal(snapshot.totalBytes, 1500 + 300 + 200 + 40 + 42)
  await fs.rm(home, { recursive: true, force: true })
})

test('storage stats never claim sweepable records when session listing fails', async () => {
  const home = await createTempDir()
  const old = new Date(Date.now() - 8 * 86_400_000)
  const record = path.join(home, 'storages', 'session_projcache', 'sessions', 'session-stale.json')
  await writeBytes(record, 20)
  await fs.utimes(record, old, old)
  const ctx = {
    sessionPersistence: {
      async list() {
        throw new Error('listing failed')
      },
    },
    sessions: { list() { return [] } },
  }
  const snapshot = await createStorageStats({ ctx, home, logger: createLogger() }).snapshot()

  assert.equal(snapshot.projectionCache.records, 1)
  assert.equal(snapshot.projectionCache.sweepableRecords, 0)
  assert.equal(snapshot.projectionCache.sweepableBytes, 0)
  await fs.rm(home, { recursive: true, force: true })
})

test('storage stats split referenced and unreferenced attachment bytes', async () => {
  const home = await createTempDir()
  const logger = createLogger()
  const objects = path.join(home, 'attachments', 'v1', 'objects')
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)
  await writeBytes(path.join(objects, 'aa', a), 100)
  await writeBytes(path.join(objects, 'bb', b), 50)
  await writeBytes(path.join(objects, 'cc', c), 25)

  const ctx = {
    sessionPersistence: { async list() { return [] } },
    sessions: { list() { return [] } },
  }
  const references = {
    async scan() {
      return {
        refs: new Set([a, b]),
        status: 'complete',
        at: 1,
        scannedFiles: 1,
        failedFiles: 0,
        tornFiles: 0,
      }
    },
  }
  const snapshot = await createStorageStats({ ctx, home, logger, references }).snapshot()

  assert.equal(snapshot.attachments.files, 3)
  assert.equal(snapshot.attachments.bytes, 175)
  assert.equal(snapshot.attachments.complete, true)
  assert.equal(snapshot.attachments.referencedBytes, 150)
  assert.equal(snapshot.attachments.orphanBytes, 25)
  assert.equal(snapshot.attachments.unclassifiedBytes, 0)
  assert.equal(snapshot.attachments.scan.status, 'complete')
  assert.equal(snapshot.attachments.scan.scannedFiles, 1)
  await fs.rm(home, { recursive: true, force: true })
})

test('an incomplete reference scan never publishes an orphan estimate', async () => {
  const home = await createTempDir()
  const logger = createLogger()
  const a = 'a'.repeat(64)
  await writeBytes(path.join(home, 'attachments', 'v1', 'objects', 'aa', a), 100)
  await writeBytes(path.join(home, 'attachments', 'v1', 'objects', 'bb', 'not-a-hash'), 10)

  const ctx = {
    sessionPersistence: { async list() { return [] } },
    sessions: { list() { return [] } },
  }
  const references = {
    async scan() {
      return {
        refs: new Set([a]),
        status: 'partial',
        reason: 'corrupt-log',
        at: 2,
        scannedFiles: 2,
        failedFiles: 1,
        tornFiles: 0,
      }
    },
  }
  const snapshot = await createStorageStats({ ctx, home, logger, references }).snapshot()

  assert.equal(snapshot.attachments.files, 2)
  assert.equal(snapshot.attachments.bytes, 110)
  assert.equal(snapshot.attachments.complete, true)
  assert.equal(snapshot.attachments.unclassifiedBytes, 10)
  assert.equal(snapshot.attachments.referencedBytes, null)
  assert.equal(snapshot.attachments.orphanBytes, null)
  assert.equal(snapshot.attachments.scan.status, 'partial')
  assert.equal(snapshot.attachments.scan.reason, 'corrupt-log')
  await fs.rm(home, { recursive: true, force: true })
})

test('an unreadable attachment store suppresses the orphan estimate', async (t) => {
  if (skipOnWindows(t, 'directory permissions are not enforced on Windows')) return
  if (skipAsRoot(t, 'root can read a 000 directory')) return
  const home = await createTempDir()
  const logger = createLogger()
  const locked = path.join(home, 'attachments', 'v1', 'objects', 'locked')
  await writeBytes(path.join(locked, 'a'.repeat(64)), 100)
  try {
    await fs.chmod(locked, 0o000)
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`cannot revoke attachment directory permissions here (${code})`)
      await fs.rm(home, { recursive: true, force: true })
      return
    }
    throw error
  }

  const ctx = {
    sessionPersistence: { async list() { return [] } },
    sessions: { list() { return [] } },
  }
  const references = {
    async scan() {
      return { refs: new Set(), status: 'complete', at: 1, scannedFiles: 1, failedFiles: 0, tornFiles: 0 }
    },
  }
  try {
    const snapshot = await createStorageStats({ ctx, home, logger, references }).snapshot()
    assert.equal(snapshot.attachments.complete, false)
    assert.equal(snapshot.attachments.referencedBytes, null)
    assert.equal(snapshot.attachments.orphanBytes, null)
  } finally {
    await fs.chmod(locked, 0o700).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('storage stats are zero when every measured root is absent', async () => {
  const home = await createTempDir()
  const ctx = {
    sessionPersistence: { async list() { return [] } },
    sessions: { list() { return [] } },
  }
  const snapshot = await createStorageStats({ ctx, home, logger: createLogger() }).snapshot()

  assert.deepEqual(snapshot.sessionLogs, { count: 0, bytes: 0 })
  assert.deepEqual(snapshot.trashLogs, { count: 0, bytes: 0 })
  assert.deepEqual(snapshot.attachments, {
    files: 0,
    bytes: 0,
    complete: true,
    referencedBytes: null,
    orphanBytes: null,
    unclassifiedBytes: 0,
    scan: { status: 'unavailable', reason: 'no-scanner' },
  })
  assert.deepEqual(snapshot.attachmentCache, { files: 0, bytes: 0 })
  assert.deepEqual(snapshot.projectionCache, {
    records: 0,
    bytes: 0,
    sweepableRecords: 0,
    sweepableBytes: 0,
  })
  assert.equal(snapshot.totalBytes, 0)
  await fs.rm(home, { recursive: true, force: true })
})
