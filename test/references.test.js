import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { createReferenceScanner } from '../lib/references.js'
import { createLogger, createTempDir, skipAsRoot, skipOnWindows } from './helpers.js'

const canCompress = typeof zlib.zstdCompressSync === 'function'

/**
 * @param {string} file log path.
 * @param {string[]} chunks text chunks, one frame each.
 * @returns {Promise<void>} resolution after the log exists.
 */
async function writeLog(file, chunks) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')))),
  )
}

/**
 * @param {string} hash hex digest.
 * @returns {string} one canonical event carrying the attachment reference.
 */
function eventWith(hash) {
  return `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${hash}` } }] } })}\n`
}

test('the reference scan covers live and trashed logs', { skip: !canCompress }, async () => {
  const home = await createTempDir()
  const logger = createLogger()
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)

  const live = path.join(home, 'sessions', 'project', 'session-a', 'session.v4.jsonl.zstd')
  await writeLog(live, [eventWith(a), eventWith(b)])
  const trashed = path.join(home, '.session-trash', 'objects', 'trash-1', 'session', 'session.v4.jsonl.zstd')
  await writeLog(trashed, [eventWith(c)])
  await fs.mkdir(path.join(home, 'sessions', 'project', 'session-empty'), { recursive: true })

  const scanner = createReferenceScanner({ home, logger })
  const scan = await scanner.scan()

  assert.equal(scan.status, 'complete')
  assert.equal(scan.scannedFiles, 2)
  assert.equal(scan.failedFiles, 0)
  assert.equal(scan.tornFiles, 0)
  assert.deepEqual([...scan.refs].sort(), [a, b, c].sort())
  await fs.rm(home, { recursive: true, force: true })
})

test('the scan reuses cached logs and notices an appended frame', { skip: !canCompress }, async () => {
  const home = await createTempDir()
  const logger = createLogger()
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const log = path.join(home, 'sessions', 'project', 'session-a', 'session.v4.jsonl.zstd')
  await writeLog(log, [eventWith(a)])

  const scanner = createReferenceScanner({ home, logger })
  assert.deepEqual([...((await scanner.scan()).refs)], [a])

  await new Promise((resolve) => setTimeout(resolve, 10))
  await fs.appendFile(log, zlib.zstdCompressSync(Buffer.from(eventWith(b))))

  const updated = await scanner.scan()
  assert.equal(updated.status, 'complete')
  assert.deepEqual([...updated.refs].sort(), [a, b].sort())
  await fs.rm(home, { recursive: true, force: true })
})

test('a corrupt log makes the scan partial without dropping healthy references', { skip: !canCompress }, async () => {
  const home = await createTempDir()
  const logger = createLogger()
  const a = 'a'.repeat(64)
  const healthy = path.join(home, 'sessions', 'project', 'session-a', 'session.v4.jsonl.zstd')
  await writeLog(healthy, [eventWith(a)])
  const corrupt = path.join(home, 'sessions', 'project', 'session-b', 'session.v4.jsonl.zstd')
  await fs.mkdir(path.dirname(corrupt), { recursive: true })
  await fs.writeFile(corrupt, 'not a zstd log')

  const scan = await createReferenceScanner({ home, logger }).scan()

  assert.equal(scan.status, 'partial')
  assert.equal(scan.failedFiles, 1)
  assert.deepEqual([...scan.refs], [a])
  await fs.rm(home, { recursive: true, force: true })
})

test('a torn live tail is reported without failing the scan', { skip: !canCompress }, async () => {
  const home = await createTempDir()
  const logger = createLogger()
  const a = 'a'.repeat(64)
  const log = path.join(home, 'sessions', 'project', 'session-a', 'session.v4.jsonl.zstd')
  await writeLog(log, [eventWith(a)])
  const extra = zlib.zstdCompressSync(Buffer.from(eventWith('b'.repeat(64))))
  await fs.appendFile(log, extra.subarray(0, Math.max(5, extra.length - 3)))

  const scan = await createReferenceScanner({ home, logger }).scan()

  assert.equal(scan.status, 'complete')
  assert.equal(scan.tornFiles, 1)
  assert.deepEqual([...scan.refs], [a])
  await fs.rm(home, { recursive: true, force: true })
})

test('an unreadable log directory makes the scan partial', async (t) => {
  if (skipOnWindows(t, 'directory permissions are not enforced on Windows')) return
  if (skipAsRoot(t, 'root can read a 000 directory')) return
  const home = await createTempDir()
  const logger = createLogger()
  const a = 'a'.repeat(64)
  const healthy = path.join(home, 'sessions', 'project', 'session-a', 'session.v4.jsonl.zstd')
  await writeLog(healthy, [eventWith(a)])
  const locked = path.join(home, 'sessions', 'project', 'locked')
  await writeLog(path.join(locked, 'session-b', 'session.v4.jsonl.zstd'), [eventWith('b'.repeat(64))])
  try {
    await fs.chmod(locked, 0o000)
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`cannot revoke directory permissions here (${code})`)
      await fs.rm(home, { recursive: true, force: true })
      return
    }
    throw error
  }

  try {
    const scan = await createReferenceScanner({ home, logger }).scan()
    assert.equal(scan.status, 'partial')
    assert.ok(scan.failedDirs >= 1)
    assert.deepEqual([...scan.refs], [a])
  } finally {
    await fs.chmod(locked, 0o700).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a missing harness home leaves the scan unavailable', async () => {
  const scan = await createReferenceScanner({ home: undefined, logger: createLogger() }).scan()
  assert.equal(scan.status, 'unavailable')
  assert.equal(scan.reason, 'no-home')
  assert.equal(scan.scannedFiles, 0)
  assert.deepEqual([...scan.refs], [])
})
