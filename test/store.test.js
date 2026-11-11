import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDir, createLogger, skipOnWindows } from './helpers.js'
import { TrashStore, emptyIndex } from '../lib/store.js'
import { TrashError } from '../lib/errors.js'

test('init creates the private layout and an empty index', async () => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  const summary = await store.init()
  assert.equal(summary.status, 'ok')
  const entries = await fs.readdir(trashRoot)
  assert.ok(entries.includes('trash-index.json'))
  assert.ok(entries.includes('objects'))
  const index = JSON.parse(await fs.readFile(path.join(trashRoot, 'trash-index.json'), 'utf8'))
  assert.equal(index.version, 2)
  assert.deepEqual(index.entries, [])
  if (process.platform !== 'win32') {
    const stats = await fs.stat(trashRoot)
    assert.equal(stats.mode & 0o777, 0o700)
    const indexStats = await fs.stat(path.join(trashRoot, 'trash-index.json'))
    assert.equal(indexStats.mode & 0o777, 0o600)
  }
  await fs.rm(root, { recursive: true, force: true })
})

test('a corrupt primary index falls back to the previous commit', async () => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  await store.init()
  const entry = { sessionId: 'session-a', trashId: '20260101T000000-aaaaaaaa', state: 'trashed', title: 'A', trashedAt: 1, startedAt: 1 }
  await store.commit([entry])
  await store.commit([])
  // The `.bak` now holds the single-entry commit; damage the primary.
  await fs.writeFile(path.join(trashRoot, 'trash-index.json'), '{ not json')
  const reopened = new TrashStore({ root: trashRoot, logger: createLogger() })
  const summary = await reopened.init()
  assert.equal(summary.status, 'recovered')
  assert.equal(reopened.entries().length, 1)
  assert.equal(reopened.entries()[0].sessionId, 'session-a')
  await fs.rm(root, { recursive: true, force: true })
})

test('both files unreadable enters protection mode and refuses writes', async () => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  await fs.mkdir(trashRoot, { recursive: true })
  await fs.writeFile(path.join(trashRoot, 'trash-index.json'), '{"version":2,"entries":[]}')
  await fs.writeFile(path.join(trashRoot, 'trash-index.json.bak'), '{"version":3,"entries":[]}')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  const summary = await store.init()
  assert.equal(summary.status, 'corrupt')
  assert.equal(store.isProtected(), true)
  await store.withLock(async () => {
    assert.equal(store.isProtected(), true)
  })
  await fs.rm(root, { recursive: true, force: true })
})

test('withLock serializes operations and refreshes another commit', async () => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  await store.init()
  const order = []
  const first = store.withLock(async () => {
    order.push('first-start')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await store.commit([{ sessionId: 'session-a', trashId: '20260101T000000-aaaaaaaa', state: 'trashed', title: 'A', trashedAt: 1, startedAt: 1 }])
    order.push('first-end')
  })
  const second = store.withLock(async () => {
    order.push('second-start')
    // withLock refreshes before the operation, so the first commit is visible.
    assert.equal(store.findEntry('session-a')?.title, 'A')
    order.push('second-end')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
  await fs.rm(root, { recursive: true, force: true })
})

test('a stale lock is taken over and a live lock is refused', async () => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  await store.init()
  await fs.writeFile(
    path.join(trashRoot, '.lock'),
    JSON.stringify({ pid: 1, host: 'test', startedAt: Date.now() - 11 * 60 * 1000 }),
  )
  assert.equal(await store.withLock(async () => 'ok'), 'ok')

  await fs.writeFile(
    path.join(trashRoot, '.lock'),
    JSON.stringify({ pid: 1, host: 'test', startedAt: Date.now() }),
  )
  await assert.rejects(store.withLock(async () => 'no'), (error) => error instanceof TrashError && error.code === 'LOCKED')
  await fs.writeFile(
    path.join(trashRoot, '.lock'),
    JSON.stringify({ pid: 1, host: 'test', startedAt: Date.now() - 11 * 60 * 1000 }),
  )
  await store.withLock(async () => {})
  await fs.rm(root, { recursive: true, force: true })
})

test('a lock owned by another live process is respected until it exits', async (t) => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  await store.init()
  const lockPath = path.join(trashRoot, '.lock')
  const script = [
    'const fs = require("node:fs");',
    'const os = require("node:os");',
    'const lockPath = process.argv[1];',
    'fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }));',
    'setTimeout(() => {}, 60000);',
  ].join('')
  const child = spawn(process.execPath, ['-e', script, lockPath], { stdio: 'ignore' })
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  })
  if (child.pid === undefined) {
    t.skip('cannot spawn a second node process on this host')
    return
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await fs.stat(lockPath)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  await assert.rejects(
    store.withLock(async () => 'no'),
    (error) => error instanceof TrashError && error.code === 'LOCKED',
  )
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  // A crashed owner leaves its lock behind; waiting out the ten-minute stale
  // window is impractical, so remove it the way an operator would.
  await fs.rm(lockPath, { force: true })
  assert.equal(await store.withLock(async () => 'ok'), 'ok')
  await fs.rm(root, { recursive: true, force: true })
})

test('emptyIndex is versioned and empty', () => {
  const now = Date.now()
  assert.deepEqual(emptyIndex(now), { version: 2, updatedAt: now, entries: [] })
})

test('a failed index write keeps the previous commit and removes the temporary file', async (t) => {
  if (skipOnWindows(t, 'POSIX permission bits are not enforced on Windows')) return
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('permission checks are meaningless as root')
    return
  }
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  await store.init()
  const entry = { sessionId: 'session-a', trashId: '20260101T000000-aaaaaaaa', state: 'trashed', title: 'A', trashedAt: 1, startedAt: 1 }
  await store.commit([entry])
  await fs.chmod(trashRoot, 0o500)
  try {
    await assert.rejects(store.commit([]), (error) => error.code === 'EACCES' || error.code === 'EPERM')
  } finally {
    await fs.chmod(trashRoot, 0o700)
  }
  assert.equal(store.findEntry('session-a')?.title, 'A')
  assert.equal((await fs.readdir(trashRoot)).includes('trash-index.json.tmp'), false)
  const reopened = new TrashStore({ root: trashRoot, logger: createLogger() })
  await reopened.init()
  assert.equal(reopened.entries().length, 1)
  await fs.rm(root, { recursive: true, force: true })
})

test('an index write blocked by its temporary path keeps the previous commit', async () => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  await store.init()
  const entry = { sessionId: 'session-a', trashId: '20260101T000000-aaaaaaaa', state: 'trashed', title: 'A', trashedAt: 1, startedAt: 1 }
  await store.commit([entry])

  // A directory at the temporary path makes the write fail on every platform,
  // without relying on POSIX permission bits.
  const blocker = path.join(trashRoot, 'trash-index.json.tmp')
  await fs.mkdir(blocker)
  try {
    await assert.rejects(
      store.commit([]),
      (error) =>
        error instanceof Error &&
        (error.code === 'EISDIR' || error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EEXIST'),
    )
  } finally {
    await fs.rm(blocker, { recursive: true, force: true })
  }
  assert.equal(store.findEntry('session-a')?.title, 'A')
  assert.equal((await fs.readdir(trashRoot)).includes('trash-index.json.tmp'), false)
  const reopened = new TrashStore({ root: trashRoot, logger: createLogger() })
  await reopened.init()
  assert.equal(reopened.entries().length, 1)
  await fs.rm(root, { recursive: true, force: true })
})

test('a version 1 index is upgraded to version 2 with one parent member', async () => {
  const root = await createTempDir()
  const trashRoot = path.join(root, '.session-trash')
  await fs.mkdir(path.join(trashRoot, 'objects'), { recursive: true })
  const project = path.join(root, 'project')
  const sessionDir = path.join(project, 'session-a')
  await fs.mkdir(sessionDir, { recursive: true })
  const logPath = path.join(sessionDir, 'session.v4.jsonl')
  await fs.writeFile(logPath, '{"type":"session/start"}\n')
  const now = Date.now()
  const legacy = {
    version: 1,
    updatedAt: now,
    entries: [
      {
        sessionId: 'session-a',
        trashId: '20260101T000000-aaaaaaaa',
        state: 'trashed',
        title: 'A',
        trashedAt: now,
        startedAt: now,
        originalCwd: project,
        originalSessionDir: sessionDir,
        originalLogPath: logPath,
        persistenceProjectDirHint: project,
        sizeBytes: 25,
        fileCount: 1,
      },
    ],
  }
  await fs.writeFile(path.join(trashRoot, 'trash-index.json'), JSON.stringify(legacy))
  const store = new TrashStore({ root: trashRoot, logger: createLogger() })
  await store.init()
  const upgraded = JSON.parse(await fs.readFile(path.join(trashRoot, 'trash-index.json'), 'utf8'))
  assert.equal(upgraded.version, 2)
  assert.equal(upgraded.entries.length, 1)
  assert.equal(upgraded.entries[0].members.length, 1)
  assert.equal(upgraded.entries[0].members[0].sessionId, 'session-a')
  assert.equal(upgraded.entries[0].members[0].originalSessionDir, sessionDir)
  assert.equal(upgraded.entries[0].members[0].originalLogPath, logPath)
  const backup = JSON.parse(await fs.readFile(path.join(trashRoot, 'trash-index.json.bak'), 'utf8'))
  assert.equal(backup.version, 1)
  assert.equal(store.findEntry('session-a')?.state, 'trashed')
  await fs.rm(root, { recursive: true, force: true })
})
