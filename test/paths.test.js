import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { createTempDir } from './helpers.js'

test('resolveTrashPaths honors $DSH_HOME and displays it symbolically', async () => {
  const root = await createTempDir()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const { resolveTrashPaths } = await import('../lib/paths.js')
    const paths = resolveTrashPaths()
    assert.equal(paths.home, root)
    assert.equal(paths.root, path.join(root, '.session-trash'))
    assert.equal(paths.display, '$DSH_HOME/.session-trash')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a blank $DSH_HOME falls back to ~/.dsh', async () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '   '
  try {
    const { resolveTrashPaths } = await import('../lib/paths.js')
    const paths = resolveTrashPaths()
    assert.equal(paths.home, path.join(os.homedir(), '.dsh'))
    assert.equal(paths.root, path.join(os.homedir(), '.dsh', '.session-trash'))
    assert.equal(paths.display, '~/.dsh/.session-trash')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
