import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDir } from './helpers.js'
import {
  CASE_INSENSITIVE_PATHS,
  comparablePath,
  createTrashId,
  isInside,
  isInsideUsing,
  isSafeDirectoryPath,
  measureDirectory,
  metricsMatch,
  moveDirectory,
  removePathWithRetry,
  renameWithRetry,
  samePath,
} from '../lib/fsops.js'
import { TrashError } from '../lib/errors.js'

test('measureDirectory excludes session.lock and never follows symlinks', async () => {
  const root = await createTempDir()
  const session = path.join(root, 'session-a')
  const outside = path.join(root, 'outside.bin')
  await fs.mkdir(path.join(session, 'nested'), { recursive: true })
  await fs.writeFile(path.join(session, 'session.v4.jsonl'), 'abcde')
  await fs.writeFile(path.join(session, 'session.lock'), 'lock data that is not payload')
  await fs.writeFile(path.join(session, 'nested', 'more.txt'), 'xy')
  await fs.writeFile(outside, 'z'.repeat(1000))
  await fs.symlink(outside, path.join(session, 'link.bin'))

  const measured = await measureDirectory(session)
  assert.deepEqual(measured, { sizeBytes: 7, fileCount: 2, symlinkCount: 1 })
  await fs.rm(root, { recursive: true, force: true })
})

test('metricsMatch allows absent metrics and rejects a size difference', () => {
  assert.equal(metricsMatch(null, { sizeBytes: 1, fileCount: 1 }), true)
  assert.equal(metricsMatch({}, { sizeBytes: 1, fileCount: 1 }), true)
  assert.equal(metricsMatch({ sizeBytes: 1, fileCount: 1 }, { sizeBytes: 1, fileCount: 1 }), true)
  assert.equal(metricsMatch({ sizeBytes: 2, fileCount: 1 }, { sizeBytes: 1, fileCount: 1 }), false)
  assert.equal(metricsMatch({ sizeBytes: 1, fileCount: 2 }, { sizeBytes: 1, fileCount: 1 }), false)
})

test('moveDirectory renames on the same filesystem', async () => {
  const root = await createTempDir()
  const source = path.join(root, 'source')
  const destination = path.join(root, 'objects', 'session')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'session.v4.jsonl'), 'hello')
  const measured = await measureDirectory(source)
  await moveDirectory(source, destination, measured)
  assert.equal(await fs.readFile(path.join(destination, 'session.v4.jsonl'), 'utf8'), 'hello')
  await assert.rejects(fs.stat(source))
  await fs.rm(root, { recursive: true, force: true })
})

test('moveDirectory falls back to copy, verify, and delete on EXDEV', async () => {
  const root = await createTempDir()
  const source = path.join(root, 'source')
  const destination = path.join(root, 'objects', 'session')
  await fs.mkdir(path.join(source, 'nested'), { recursive: true })
  await fs.writeFile(path.join(source, 'session.v4.jsonl'), 'hello')
  await fs.writeFile(path.join(source, 'session.lock'), '')
  await fs.writeFile(path.join(source, 'nested', 'part'), 'world')
  const measured = await measureDirectory(source)

  let first = true
  const rename = async (from, to) => {
    if (first) {
      first = false
      const error = new Error('cross-device link')
      error.code = 'EXDEV'
      throw error
    }
    return fs.rename(from, to)
  }
  await moveDirectory(source, destination, measured, { rename })
  assert.equal(await fs.readFile(path.join(destination, 'session.v4.jsonl'), 'utf8'), 'hello')
  assert.equal(await fs.readFile(path.join(destination, 'nested', 'part'), 'utf8'), 'world')
  await assert.rejects(fs.stat(source))
  const leftovers = await fs.readdir(path.join(root, 'objects'))
  assert.deepEqual(leftovers, ['session'])
  await fs.rm(root, { recursive: true, force: true })
})

test('moveDirectory removes a failed cross-device copy and keeps the source', async () => {
  const root = await createTempDir()
  const source = path.join(root, 'source')
  const destination = path.join(root, 'objects', 'session')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'session.v4.jsonl'), 'hello')
  const measured = await measureDirectory(source)

  let first = true
  const rename = async (from, to) => {
    if (first) {
      first = false
      const error = new Error('cross-device link')
      error.code = 'EXDEV'
      throw error
    }
    return fs.rename(from, to)
  }
  await assert.rejects(
    // Wrong recorded size makes the copy verification fail.
    moveDirectory(source, destination, { sizeBytes: 999, fileCount: 1 }, { rename }),
    (error) => error instanceof TrashError && error.code === 'MOVE_VERIFY_FAILED',
  )
  assert.equal(await fs.readFile(path.join(source, 'session.v4.jsonl'), 'utf8'), 'hello')
  assert.deepEqual(await fs.readdir(path.join(root, 'objects')), [])
  await fs.rm(root, { recursive: true, force: true })
})

test('moveDirectory rejects a symlink source and an existing destination', async () => {
  const root = await createTempDir()
  const target = path.join(root, 'real')
  const link = path.join(root, 'link')
  const destination = path.join(root, 'dest')
  await fs.mkdir(target)
  await fs.symlink(target, link)
  await assert.rejects(moveDirectory(link, destination), (error) => error instanceof TrashError && error.code === 'UNSAFE_SESSION_DIR')
  await fs.mkdir(destination)
  await assert.rejects(moveDirectory(target, destination), (error) => error instanceof TrashError && error.code === 'RESTORE_TARGET_EXISTS')
  await fs.rm(root, { recursive: true, force: true })
})

test('path helpers sit inside their root and reject unsafe segments', () => {
  assert.equal(isInside('/tmp/root', '/tmp/root/objects/a'), true)
  assert.equal(isInside('/tmp/root', '/tmp/root'), true)
  assert.equal(isInside('/tmp/root', '/tmp/rooted/a'), false)
  assert.equal(isInside('/tmp/root', '/tmp/other/a'), false)
  assert.equal(isSafeDirectoryPath('/tmp/root/session-a'), true)
  assert.equal(isSafeDirectoryPath('/tmp/root/..'), false)
  assert.equal(isSafeDirectoryPath('relative/session-a'), false)
})

test('createTrashId is time sortable and unique', () => {
  const first = createTrashId()
  const second = createTrashId()
  assert.match(first, /^\d{8}T\d{6}-[0-9a-f]{8}$/)
  assert.notEqual(first, second)
  assert.equal(first.slice(0, 15), second.slice(0, 15))
})

test('path identity follows the platform case rules and Windows segments', () => {
  assert.equal(isInsideUsing(path.posix, '/tmp/root', '/tmp/root/objects/a', false), true)
  assert.equal(isInsideUsing(path.posix, '/tmp/root', '/tmp/ROOT/objects/a', false), false)
  assert.equal(isInsideUsing(path.posix, '/tmp/root', '/tmp/ROOT/objects/a', true), true)
  assert.equal(isInsideUsing(path.win32, 'C:\\Root', 'c:\\root\\objects\\a', true), true)
  assert.equal(isInsideUsing(path.win32, 'C:\\Root', 'D:\\Root\\objects\\a', true), false)
  assert.equal(isInsideUsing(path.win32, 'C:\\Root', 'C:\\Rooted\\objects\\a', true), false)
  assert.equal(isInsideUsing(path.win32, 'C:\\Root', 'C:\\Root\\..\\Other', true), false)
  assert.equal(samePath('C:\\Root\\A', 'c:\\root\\a', { pathImpl: path.win32, caseInsensitive: true }), true)
  assert.equal(samePath('/tmp/root/A', '/tmp/root/a', { pathImpl: path.posix, caseInsensitive: false }), false)
  assert.equal(comparablePath('/tmp/root', { pathImpl: path.posix, caseInsensitive: false }), '/tmp/root')
  // The default policy is decided once from the running platform.
  assert.equal(typeof CASE_INSENSITIVE_PATHS, 'boolean')
  assert.equal(isInside('/tmp/root', '/tmp/root/objects/a'), true)

  const windows = { pathImpl: path.win32, platform: 'win32' }
  assert.equal(isSafeDirectoryPath('C:\\root\\session-a', windows), true)
  assert.equal(isSafeDirectoryPath('C:\\root\\..', windows), false)
  assert.equal(isSafeDirectoryPath('C:\\root\\CON', windows), false)
  assert.equal(isSafeDirectoryPath('C:\\root\\LPT1.txt', windows), false)
  assert.equal(isSafeDirectoryPath('C:\\root\\session.', windows), false)
  assert.equal(isSafeDirectoryPath('C:\\root\\session ', windows), false)
  assert.equal(isSafeDirectoryPath('C:\\root\\session\u0001', windows), false)
})

test('renameWithRetry retries transient sharing violations but not real errors', async () => {
  let attempts = 0
  await renameWithRetry('from', 'to', {
    attempts: 4,
    delayMs: 1,
    async operation() {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('sharing violation')
        error.code = 'EPERM'
        throw error
      }
    },
  })
  assert.equal(attempts, 3)

  let realAttempts = 0
  await assert.rejects(
    renameWithRetry('from', 'to', {
      attempts: 4,
      delayMs: 1,
      async operation() {
        realAttempts += 1
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      },
    }),
    (error) => error.code === 'ENOENT',
  )
  assert.equal(realAttempts, 1)

  const target = path.join(await createTempDir(), 'file.txt')
  await fs.writeFile(target, 'x')
  await removePathWithRetry(target)
  await assert.rejects(fs.stat(target))
  let removals = 0
  await removePathWithRetry('ignored', {
    attempts: 3,
    delayMs: 1,
    async operation() {
      removals += 1
      if (removals < 2) {
        const error = new Error('busy')
        error.code = 'EBUSY'
        throw error
      }
    },
  })
  assert.equal(removals, 2)
})

test('moveDirectory handles a large session directory', async () => {
  const root = await createTempDir()
  const source = path.join(root, 'source')
  const destination = path.join(root, 'objects', 'session')
  await fs.mkdir(path.join(source, 'generations'), { recursive: true })
  const payload = 'x'.repeat(4096)
  for (let index = 0; index < 300; index += 1) {
    const bucket = path.join(source, 'generations', `g${index % 7}`)
    await fs.mkdir(bucket, { recursive: true })
    await fs.writeFile(path.join(bucket, `part-${index}.jsonl`), payload)
  }
  await fs.writeFile(path.join(source, 'session.v4.jsonl'), 'header\n')
  await fs.writeFile(path.join(source, 'session.lock'), '')
  const measured = await measureDirectory(source)
  assert.equal(measured.fileCount, 301)
  assert.equal(measured.sizeBytes, 300 * 4096 + 7)

  await moveDirectory(source, destination, measured)
  const moved = await measureDirectory(destination)
  assert.deepEqual(moved, { sizeBytes: measured.sizeBytes, fileCount: measured.fileCount, symlinkCount: 0 })
  await assert.rejects(fs.stat(source))
  await fs.rm(root, { recursive: true, force: true })
})

test('a cross-device copy that runs out of space removes the temporary tree', async () => {
  const root = await createTempDir()
  const source = path.join(root, 'source')
  const destination = path.join(root, 'objects', 'session')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'session.v4.jsonl'), 'hello')
  const measured = await measureDirectory(source)

  let first = true
  const rename = async (from, to) => {
    if (first) {
      first = false
      const error = new Error('cross-device link')
      error.code = 'EXDEV'
      throw error
    }
    return fs.rename(from, to)
  }
  const copy = async (_source, temporary) => {
    await fs.mkdir(temporary, { recursive: true })
    await fs.writeFile(path.join(temporary, 'partial.bin'), 'partial')
    const error = new Error('no space left on device')
    error.code = 'ENOSPC'
    throw error
  }
  await assert.rejects(
    moveDirectory(source, destination, measured, { rename, copy }),
    (error) => error instanceof TrashError && error.code === 'IO_ERROR' && error.details.code === 'ENOSPC' && error.details.phase === 'copy',
  )
  assert.equal(await fs.readFile(path.join(source, 'session.v4.jsonl'), 'utf8'), 'hello')
  assert.deepEqual(await fs.readdir(path.join(root, 'objects')), [])
  await fs.rm(root, { recursive: true, force: true })
})

test('a cross-device move keeps symlinks as symlinks', async () => {
  const root = await createTempDir()
  const source = path.join(root, 'source')
  const destination = path.join(root, 'objects', 'session')
  const outside = path.join(root, 'outside.bin')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'session.v4.jsonl'), 'hello')
  await fs.writeFile(outside, 'outside')
  await fs.symlink(outside, path.join(source, 'link.bin'))
  const measured = await measureDirectory(source)

  let first = true
  const rename = async (from, to) => {
    if (first) {
      first = false
      const error = new Error('cross-device link')
      error.code = 'EXDEV'
      throw error
    }
    return fs.rename(from, to)
  }
  await moveDirectory(source, destination, measured, { rename })
  const link = await fs.lstat(path.join(destination, 'link.bin'))
  assert.equal(link.isSymbolicLink(), true)
  assert.equal(await fs.readlink(path.join(destination, 'link.bin')), outside)
  await fs.rm(root, { recursive: true, force: true })
})

test('a destination permission failure reports IO_ERROR and keeps the source', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('permission checks are meaningless as root')
    return
  }
  const root = await createTempDir()
  const source = path.join(root, 'source')
  const objects = path.join(root, 'objects')
  await fs.mkdir(source, { recursive: true })
  await fs.mkdir(objects)
  await fs.writeFile(path.join(source, 'session.v4.jsonl'), 'hello')
  const measured = await measureDirectory(source)
  await fs.chmod(objects, 0o500)
  try {
    await assert.rejects(
      moveDirectory(source, path.join(objects, 'session'), measured),
      (error) =>
        error instanceof TrashError &&
        error.code === 'IO_ERROR' &&
        (error.details.code === 'EACCES' || error.details.code === 'EPERM'),
    )
  } finally {
    await fs.chmod(objects, 0o700)
  }
  assert.equal(await fs.readFile(path.join(source, 'session.v4.jsonl'), 'utf8'), 'hello')
  assert.deepEqual(await fs.readdir(objects), [])
  await fs.rm(root, { recursive: true, force: true })
})
