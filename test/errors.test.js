import test from 'node:test'
import assert from 'node:assert/strict'
import { TrashError, sanitizeDetails, toWireError } from '../lib/errors.js'

test('wire errors only expose whitelisted detail keys', () => {
  const wire = toWireError(
    new TrashError('IO_ERROR', 'The session directory could not be moved.', {
      code: 'EACCES',
      phase: 'rename',
      copied: true,
      source: '/tmp/session-a',
      destination: '/tmp/.session-trash/objects/id/session',
      lastError: 'ENOENT: /tmp/.session-trash/trash-index.json',
      nested: { path: '/tmp/.session-trash' },
    }),
  )
  assert.deepEqual(wire.details, { code: 'EACCES', phase: 'rename', copied: true })
  assert.equal(JSON.stringify(wire).includes('/tmp/.session-trash'), false)
})

test('wire errors keep safe context and drop an empty detail object', () => {
  const withContext = toWireError(
    new TrashError('MOVE_VERIFY_FAILED', 'The copied session does not match the measured snapshot.', {
      expected: { sizeBytes: 3, fileCount: 1 },
      measured: { sizeBytes: 2, fileCount: 1 },
    }),
  )
  assert.deepEqual(withContext.details, {
    expected: { sizeBytes: 3, fileCount: 1 },
    measured: { sizeBytes: 2, fileCount: 1 },
  })

  const withoutContext = toWireError(new TrashError('IO_ERROR', 'x', { source: '/tmp/source' }))
  assert.equal('details' in withoutContext, false)
})

test('sanitizeDetails rejects non-objects and filters primitive arrays', () => {
  assert.equal(sanitizeDetails(undefined), undefined)
  assert.equal(sanitizeDetails(null), undefined)
  assert.equal(sanitizeDetails('text'), undefined)
  assert.equal(sanitizeDetails(['a']), undefined)
  assert.deepEqual(sanitizeDetails({ sessions: ['a', 2, { path: '/tmp' }] }), { sessions: ['a', 2] })
  assert.deepEqual(sanitizeDetails({ nested: { path: '/tmp' } }), undefined)
})

test('plain errors still become IO_ERROR without details', () => {
  const wire = toWireError(new Error('boom'))
  assert.deepEqual(wire, { code: 'IO_ERROR', message: 'boom' })
})
