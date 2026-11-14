import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { decompressZstdLog, hasZstd, scanZstdFrames } from '../lib/zstd-frames.js'

const canCompress = typeof zlib.zstdCompressSync === 'function'

/**
 * @param {string[]} chunks text chunks, each written as its own frame.
 * @returns {Buffer} the concatenated log bytes.
 */
function framesOf(chunks) {
  return Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'))))
}

test('concatenated frames are located and decoded as one log', { skip: !canCompress }, () => {
  const first = '{"type":"user/message","text":"sha256:' + 'a'.repeat(64) + '"}\n'
  const second = '{"type":"assistant/message","text":"sha256:' + 'b'.repeat(64) + '"}\n'
  const buffer = framesOf([first, second])

  const scan = scanZstdFrames(buffer)
  assert.equal(scan.frames.length, 2)
  assert.equal(scan.tornStart, undefined)

  const decoded = decompressZstdLog(buffer)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.complete, true)
  assert.equal(decoded.text, first + second)
  assert.equal(decoded.frames, 2)
})

test('a torn final frame keeps the complete prefix and reports incompleteness', { skip: !canCompress }, () => {
  const first = '{"type":"user/message"}\n'
  const second = '{"type":"assistant/message"}\n'
  const complete = framesOf([first, second])
  const third = zlib.zstdCompressSync(Buffer.from('{"type":"user/message","partial":true}\n'))
  const buffer = Buffer.concat([complete, third.subarray(0, Math.max(5, third.length - 3))])

  const scan = scanZstdFrames(buffer)
  assert.equal(scan.frames.length, 2)
  assert.equal(typeof scan.tornStart, 'number')

  const decoded = decompressZstdLog(buffer)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.complete, false)
  assert.equal(decoded.text, first + second)
})

test('invalid or empty logs fail closed', { skip: !canCompress }, () => {
  assert.deepEqual(decompressZstdLog(Buffer.alloc(0)), { ok: false, reason: 'empty-log' })
  assert.throws(() => scanZstdFrames(Buffer.from('not a zstd frame')), /invalid Zstandard frame magic/)
  assert.equal(decompressZstdLog(Buffer.from('not a zstd frame')).ok, false)
})

test('the runtime reports zstd availability consistently', () => {
  assert.equal(hasZstd(), typeof zlib.zstdDecompressSync === 'function')
})
