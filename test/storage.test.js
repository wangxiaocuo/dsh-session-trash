import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createStorageStats } from '../lib/storage.js'
import { createLogger, createTempDir } from './helpers.js'

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
  const fileAlias = path.join(attachments, 'files', 'ff', 'f'.repeat(64), 'linked.pdf')
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
  assert.deepEqual(snapshot.attachments, { files: 4, bytes: 200 })
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

test('storage stats are zero when every measured root is absent', async () => {
  const home = await createTempDir()
  const ctx = {
    sessionPersistence: { async list() { return [] } },
    sessions: { list() { return [] } },
  }
  const snapshot = await createStorageStats({ ctx, home, logger: createLogger() }).snapshot()

  assert.deepEqual(snapshot.sessionLogs, { count: 0, bytes: 0 })
  assert.deepEqual(snapshot.trashLogs, { count: 0, bytes: 0 })
  assert.deepEqual(snapshot.attachments, { files: 0, bytes: 0 })
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
