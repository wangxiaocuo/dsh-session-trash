import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../index.js'

test('Config applies the documented defaults', () => {
  assert.deepEqual(Config({}), {
    retentionDays: 30,
    sweepIntervalHours: 6,
    enableAutoCleanup: true,
    debug: false,
  })
})

test('Config accepts both retention and sweep boundaries', () => {
  assert.equal(Config({ retentionDays: 1 }).retentionDays, 1)
  assert.equal(Config({ retentionDays: 3650 }).retentionDays, 3650)
  assert.equal(Config({ sweepIntervalHours: 1 }).sweepIntervalHours, 1)
  assert.equal(Config({ sweepIntervalHours: 168 }).sweepIntervalHours, 168)
  assert.equal(Config({ enableAutoCleanup: false }).enableAutoCleanup, false)
  assert.equal(Config({ debug: true }).debug, true)
})

test('Config rejects out-of-range and wrongly typed values', () => {
  for (const input of [
    { retentionDays: 0 },
    { retentionDays: 3651 },
    { retentionDays: 1.5 },
    { retentionDays: '30' },
    { sweepIntervalHours: 0 },
    { sweepIntervalHours: 169 },
    { sweepIntervalHours: '6' },
    { enableAutoCleanup: 'yes' },
    { debug: 1 },
  ]) {
    assert.throws(() => Config(input), undefined, `expected rejection for ${JSON.stringify(input)}`)
  }
})
