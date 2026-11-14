import zlib from 'node:zlib'

/** Zstandard frame magic, little-endian. */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * @returns {((buffer: Buffer) => Buffer) | undefined} the runtime's Zstandard decoder, when the @types/node build predates it.
 */
function zstdDecoder() {
  const candidate = /** @type {{ zstdDecompressSync?: unknown }} */ (zlib).zstdDecompressSync
  if (typeof candidate !== 'function') return undefined
  return /** @type {(buffer: Buffer) => Buffer} */ (candidate)
}

/** @returns {boolean} whether this Node runtime provides a Zstandard decoder. */
export function hasZstd() {
  return zstdDecoder() !== undefined
}

/**
 * Locate every complete Zstandard frame in a concatenated log without
 * decompressing any block. Session logs append one frame per batch, so a
 * single `zstdDecompress` call would stop after the first frame.
 *
 * @param {Buffer} buffer complete log bytes.
 * @returns {{ frames: { start: number, end: number }[], tornStart: number | undefined }} complete frame ranges and an optional incomplete final frame.
 * @throws {Error} when a frame header is invalid or a block runs past the end of a complete frame.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset >= buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`unsupported reserved bits in the Zstandard frame header at byte ${start}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03

    const windowBytes = singleSegment ? 0 : 1
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : contentSizeFlag === 1
        ? 2
        : contentSizeFlag === 2
          ? 4
          : 8
    const headerBytes = windowBytes + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < headerBytes) return { frames, tornStart: start }
    offset += headerBytes

    while (true) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (header & 0x01) !== 0
      const blockType = (header >>> 1) & 0x03
      const blockSize = header >>> 3
      if (blockType === 3) {
        throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: undefined }
}

/**
 * Decompress a concatenated Zstandard session log.
 *
 * A torn final frame is reported instead of discarded silently: the complete
 * prefix stays usable for reference discovery, while callers can mark their
 * scan incomplete.
 *
 * @param {Buffer} buffer complete session-log bytes.
 * @returns {{ ok: true, text: string, complete: boolean, frames: number } | { ok: false, reason: string }} the decoded text or a stable failure reason.
 */
export function decompressZstdLog(buffer) {
  const decompress = zstdDecoder()
  if (decompress === undefined) {
    return { ok: false, reason: 'zstd-unavailable' }
  }
  let scan
  try {
    scan = scanZstdFrames(buffer)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (scan.frames.length === 0) {
    return { ok: false, reason: scan.tornStart === undefined ? 'empty-log' : 'incomplete-frame' }
  }
  const parts = []
  for (const frame of scan.frames) {
    try {
      parts.push(decompress(buffer.subarray(frame.start, frame.end)))
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    ok: true,
    text: Buffer.concat(parts).toString('utf8'),
    complete: scan.tornStart === undefined,
    frames: scan.frames.length,
  }
}
