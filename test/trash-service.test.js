import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHarness } from './helpers.js'
import { measureDirectory } from '../lib/fsops.js'
import { TrashError } from '../lib/errors.js'

/**
 * @param {object} harness test harness.
 * @param {string} code expected error code.
 * @returns {(error: unknown) => boolean} an assertion predicate.
 */
function trashCode(code) {
  return (error) => error instanceof TrashError && error.code === code
}

test('trash moves the session directory and restore brings it back', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-a', cwd: project, title: 'Refactor login' })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-a'] })
  const originalDir = record.dir
  const originalLog = record.logPath

  const entry = await harness.service.trash('session-a')
  assert.equal(entry.state, 'trashed')
  assert.equal(entry.title, 'Refactor login')
  assert.equal(entry.originalCwd, project)
  assert.equal(entry.originalWorkspaceId, 'ws-1')
  assert.equal(entry.workspaceExistsAtDeletion, true)
  assert.equal(entry.sessionId, 'session-a')
  assert.ok(entry.sizeBytes > 0)
  assert.ok(entry.fileCount >= 1)
  await assert.rejects(fs.stat(originalDir))
  assert.equal(await fs.readFile(path.join(harness.trashRoot, 'objects', entry.trashId, 'session', 'session.v4.jsonl'), 'utf8'), '{"type":"session/start"}\n')
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.deepEqual(harness.emissions.at(-1), { event: 'api-session/removed', args: ['session-a'] })

  const state = await harness.stateService.snapshot()
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].title, 'Refactor login')
  assert.equal(state.entries[0].canRestore, true)
  assert.equal(state.entries[0].expiresAt, entry.trashedAt + 30 * 86_400_000)

  const result = await harness.service.restore('session-a')
  assert.equal(result.workspaceReattached, true)
  assert.equal(result.title, 'Refactor login')
  assert.equal(await fs.readFile(originalLog, 'utf8'), '{"type":"session/start"}\n')
  assert.equal((await harness.persistence.stat('session-a')).location.path, originalLog)
  assert.equal(harness.store.findEntry('session-a'), undefined)
  assert.deepEqual(await fs.readdir(path.join(harness.trashRoot, 'objects')), [])
  assert.deepEqual(workspace.sessionIds, ['session-a'])
  assert.deepEqual(workspace.calls, [
    ['detach', 'session-a'],
    ['attach', 'session-a'],
    // With no recorded sibling the restore appends to the workspace order.
    ['insertBefore', 'session-a', undefined],
  ])
  const added = harness.emissions.at(-1)
  assert.equal(added.event, 'api-session/added')
  assert.equal(added.args[0].sessionId, 'session-a')
  assert.equal(added.args[0].cwd, project)
  assert.equal(added.args[0].running, false)
  assert.equal(added.args[0].agentAvailable, false)
  assert.deepEqual(added.args[0].projections, { kind: 'cached', asOfSeq: 0, values: { title: 'Refactor login' } })
  await harness.dispose()
})

test('trash restores the original sibling position in its workspace', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  await harness.addSession({ id: 'session-c', cwd: project, title: 'C' })
  const workspace = harness.workspaces.add({
    id: 'ws-order',
    path: project,
    sessionIds: ['session-a', 'session-b', 'session-c'],
  })

  await harness.service.trash('session-b')
  const result = await harness.service.restore('session-b')
  assert.equal(result.workspaceReattached, true)
  assert.deepEqual(workspace.sessionIds, ['session-a', 'session-b', 'session-c'])
  assert.deepEqual(workspace.calls, [
    ['detach', 'session-b'],
    ['attach', 'session-b'],
    ['insertBefore', 'session-b', 'session-c'],
  ])
  await harness.dispose()
})

test('preflight refusals keep every source directory untouched', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)

  const parent = await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent' })
  await harness.addSession({ id: 'session-child', cwd: project, title: 'Child', parentSession: 'session-parent' })
  await assert.rejects(harness.service.trash('session-parent'), trashCode('SESSION_HAS_DESCENDANTS'))
  await fs.stat(parent.dir)

  const live = await harness.addSession({ id: 'session-live', cwd: project, title: 'Live' })
  harness.liveSessions.set('session-live', { id: 'session-live' })
  await assert.rejects(harness.service.trash('session-live'), trashCode('SESSION_LIVE'))
  harness.liveSessions.delete('session-live')
  await fs.stat(live.dir)

  const active = await harness.addSession({ id: 'session-active', cwd: project, title: 'Active' })
  harness.setActivity(() => Promise.resolve([{ kind: 'turn', id: 'turn-1' }]))
  await assert.rejects(harness.service.trash('session-active'), trashCode('SESSION_ACTIVE'))
  harness.setActivity(() => Promise.resolve([]))
  await fs.stat(active.dir)

  const subagent = await harness.addSession({ id: 'session-sub', cwd: project, title: 'Sub', origin: 'subagent' })
  await assert.rejects(harness.service.trash('session-sub'), trashCode('SESSION_SUBAGENT'))
  await fs.stat(subagent.dir)

  assert.equal(harness.store.entries().length, 0)
  assert.equal(harness.emissions.length, 0)
  await harness.dispose()
})

test('trash refuses a session whose log already moved', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.service.trash('session-a')
  // The source is gone, so existence is checked before the index state.
  await assert.rejects(harness.service.trash('session-a'), trashCode('SESSION_NOT_FOUND'))
  await harness.dispose()
})

test('normal restore reports WORKSPACE_MISSING and leaves the trash object in place', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  await fs.rm(project, { recursive: true, force: true })
  await assert.rejects(harness.service.restore('session-a'), trashCode('WORKSPACE_MISSING'))
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.equal(await fs.readFile(path.join(harness.trashRoot, 'objects', entry.trashId, 'session', 'session.v4.jsonl'), 'utf8'), '{"type":"session/start"}\n')
  await assert.rejects(fs.stat(record.dir))
  await harness.dispose()
})

test('restore refuses an occupied target', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.service.trash('session-a')
  await fs.mkdir(record.dir, { recursive: true })
  await assert.rejects(harness.service.restore('session-a'), trashCode('RESTORE_TARGET_EXISTS'))
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  await harness.dispose()
})

test('restore missing trash object marks the entry missing', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  await fs.rm(path.join(harness.trashRoot, 'objects', entry.trashId), { recursive: true, force: true })
  await assert.rejects(harness.service.restore('session-a'), trashCode('TRASH_DIR_MISSING'))
  assert.equal(harness.store.findEntry('session-a')?.state, 'missing')
  await harness.dispose()
})

/**
 * Seed one index entry in a chosen crash state.
 *
 * @param {object} harness test harness.
 * @param {{ id: string, state: string, source: boolean, trash: boolean }} input state row.
 * @returns {Promise<object>} the seeded entry.
 */
async function seedCrashEntry(harness, { id, state, source, trash }) {
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project, { recursive: true })
  const record = await harness.addSession({ id, cwd: project, title: id })
  const measured = await measureDirectory(record.dir)
  const trashId = `20260101T000000-${id.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, '0')}`
  const entry = {
    sessionId: id,
    trashId,
    state,
    title: id,
    trashedAt: state === 'trashed' ? Date.now() - 1000 : 0,
    startedAt: Date.now() - 2000,
    originalCwd: project,
    workspaceExistsAtDeletion: true,
    originalWorkspaceId: null,
    originalWorkspaceTitle: null,
    originalNextSessionId: null,
    originalSessionDir: record.dir,
    originalLogPath: record.logPath,
    persistenceProjectDirHint: path.dirname(record.dir),
    formatStatus: 'current',
    sizeBytes: measured.sizeBytes,
    fileCount: measured.fileCount,
    lastError: null,
  }
  await harness.store.createObjectDir(trashId)
  if (trash) {
    await fs.cp(record.dir, harness.store.sessionPath(trashId), { recursive: true })
  }
  if (!source) await fs.rm(record.dir, { recursive: true, force: true })
  await harness.store.writeMeta(entry)
  await harness.store.commit([entry])
  return entry
}

const matrix = [
  { name: 'trashing, source only -> rollback', state: 'trashing', source: true, trash: false, expect: 'gone', expectSource: true, expectTrash: false },
  { name: 'trashing, trash only -> complete', state: 'trashing', source: false, trash: true, expect: 'trashed', expectSource: false, expectTrash: true },
  { name: 'trashing, both -> verify and finish', state: 'trashing', source: true, trash: true, expect: 'trashed', expectSource: false, expectTrash: true },
  { name: 'trashing, neither -> missing', state: 'trashing', source: false, trash: false, expect: 'missing', expectSource: false, expectTrash: false },
  { name: 'restoring, source only -> complete', state: 'restoring', source: true, trash: false, expect: 'gone', expectSource: true, expectTrash: false },
  { name: 'restoring, trash only -> rollback', state: 'restoring', source: false, trash: true, expect: 'trashed', expectSource: false, expectTrash: true },
  { name: 'restoring, both -> verify and finish', state: 'restoring', source: true, trash: true, expect: 'gone', expectSource: true, expectTrash: false },
  { name: 'restoring, neither -> missing', state: 'restoring', source: false, trash: false, expect: 'missing', expectSource: false, expectTrash: false },
  { name: 'trashed, trash only -> untouched', state: 'trashed', source: false, trash: true, expect: 'trashed', expectSource: false, expectTrash: true, changed: 0 },
  { name: 'trashed, object missing -> missing', state: 'trashed', source: false, trash: false, expect: 'missing', expectSource: false, expectTrash: false },
]

for (const row of matrix) {
  test(`recovery matrix: ${row.name}`, async () => {
    const harness = await createHarness()
    const entry = await seedCrashEntry(harness, {
      id: `session-${row.name.replace(/[^a-z0-9]+/g, '-')}`,
      state: row.state,
      source: row.source,
      trash: row.trash,
    })
    const originalDir = entry.originalSessionDir
    const trashDir = harness.store.sessionPath(entry.trashId)
    const summary = await harness.service.recover()
    const current = harness.store.findEntry(entry.sessionId)
    if (row.expect === 'gone') assert.equal(current, undefined)
    else assert.equal(current?.state, row.expect)
    const sourceExists = await fs
      .stat(originalDir)
      .then(() => true)
      .catch(() => false)
    const trashExists = await fs
      .stat(trashDir)
      .then(() => true)
      .catch(() => false)
    assert.equal(sourceExists, row.expectSource, 'source presence')
    assert.equal(trashExists, row.expectTrash, 'trash presence')
    assert.equal(summary.changed, row.changed ?? 1)
    await harness.dispose()
  })
}

test('concurrent trash requests serialize without losing entries', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const ids = ['session-c1', 'session-c2', 'session-c3', 'session-c4']
  const records = new Map()
  for (const id of ids) records.set(id, await harness.addSession({ id, cwd: project, title: id }))

  const entries = await Promise.all(ids.map((id) => harness.service.trash(id)))
  assert.deepEqual(entries.map((entry) => entry.sessionId).sort(), [...ids].sort())
  assert.equal(harness.store.entries().length, ids.length)
  for (const id of ids) {
    const entry = harness.store.findEntry(id)
    assert.equal(entry?.state, 'trashed')
    assert.equal((await fs.stat(harness.store.sessionPath(entry.trashId))).isDirectory(), true)
    await assert.rejects(fs.stat(records.get(id).dir))
  }
  assert.equal(harness.emissions.filter((item) => item.event === 'api-session/removed').length, ids.length)
  assert.deepEqual((await fs.readdir(harness.store.objectsDir)).sort(), entries.map((entry) => entry.trashId).sort())
  await harness.dispose()
})

test('a session that becomes live just before the move is rolled back', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-race', cwd: project, title: 'Race' })
  let calls = 0
  harness.ctx.sessions.get = () => {
    calls += 1
    return calls >= 3 ? { id: 'session-race' } : undefined
  }
  await assert.rejects(harness.service.trash('session-race'), trashCode('SESSION_LIVE'))
  assert.equal(calls >= 3, true)
  assert.equal((await fs.stat(record.dir)).isDirectory(), true)
  assert.equal(harness.store.entries().length, 0)
  assert.deepEqual(await fs.readdir(harness.store.objectsDir), [])
  assert.deepEqual(harness.emissions, [])
  await harness.dispose()
})

test('a read-only trash root reports IO_ERROR without touching the session', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('permission checks are meaningless as root')
    return
  }
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-ro', cwd: project, title: 'Read-only' })
  await fs.chmod(harness.store.objectsDir, 0o500)
  try {
    await assert.rejects(
      harness.service.trash('session-ro'),
      (error) =>
        error instanceof TrashError &&
        error.code === 'IO_ERROR' &&
        error.details.phase === 'create-object' &&
        (error.details.code === 'EACCES' || error.details.code === 'EPERM'),
    )
  } finally {
    await fs.chmod(harness.store.objectsDir, 0o700)
  }
  assert.equal((await fs.stat(record.dir)).isDirectory(), true)
  assert.equal(harness.store.entries().length, 0)
  assert.deepEqual(await fs.readdir(harness.store.objectsDir), [])
  await harness.dispose()
})

test('preflight refuses unmaterialized, unsupported, and already-trashed sessions', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const originalStat = harness.persistence.stat

  harness.persistence.stat = async (id) => (id === 'session-a' ? { header: { id } } : originalStat(id))
  harness.eligibility.invalidate()
  assert.equal((await harness.eligibility.evaluate('session-a')).code, 'SESSION_NOT_MATERIALIZED')

  harness.persistence.stat = async (id) =>
    id === 'session-a'
      ? { header: { id }, location: { kind: 'sqlite', path: record.logPath } }
      : originalStat(id)
  harness.eligibility.invalidate()
  assert.equal((await harness.eligibility.evaluate('session-a')).code, 'STORAGE_UNSUPPORTED')

  harness.persistence.stat = async (id) =>
    id === 'session-a'
      ? { header: { id }, location: { kind: 'jsonl', path: 'relative/session.jsonl' } }
      : originalStat(id)
  harness.eligibility.invalidate()
  assert.equal((await harness.eligibility.evaluate('session-a')).code, 'STORAGE_UNSUPPORTED')

  harness.persistence.stat = originalStat
  const measured = await measureDirectory(record.dir)
  await harness.store.commit([
    {
      sessionId: 'session-a',
      trashId: '20260101T000000-aaaaaaaa',
      state: 'trashed',
      title: 'A',
      trashedAt: Date.now() - 1000,
      startedAt: Date.now() - 2000,
      originalSessionDir: record.dir,
      originalLogPath: record.logPath,
      persistenceProjectDirHint: path.dirname(record.dir),
      sizeBytes: measured.sizeBytes,
      fileCount: measured.fileCount,
    },
  ])
  harness.eligibility.invalidate()
  assert.equal((await harness.eligibility.evaluate('session-a')).code, 'ALREADY_TRASHED')
  await assert.rejects(harness.service.trash('session-a'), trashCode('ALREADY_TRASHED'))
  assert.equal((await fs.stat(record.dir)).isDirectory(), true)
  await harness.dispose()
})

test('restore rejects a tampered persistence project hint', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  await harness.store.commit([
    { ...entry, persistenceProjectDirHint: path.join(harness.root, 'some-other-project') },
  ])
  await assert.rejects(harness.service.restore('session-a'), trashCode('UNSAFE_RESTORE_PATH'))
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.equal((await fs.stat(harness.store.sessionPath(entry.trashId))).isDirectory(), true)
  await harness.dispose()
})

test('restore rolls back when session storage cannot see the restored log', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  const originalStat = harness.persistence.stat
  harness.persistence.stat = async (id) => (id === 'session-a' ? undefined : originalStat(id))
  try {
    await assert.rejects(harness.service.restore('session-a'), trashCode('RESTORE_VERIFY_FAILED'))
  } finally {
    harness.persistence.stat = originalStat
  }
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.equal((await fs.stat(harness.store.sessionPath(entry.trashId))).isDirectory(), true)
  await assert.rejects(fs.stat(record.dir))
  await harness.dispose()
})

test('trash reports INDEX_WRITE_FAILED and recovery finishes the moved log', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const originalCommit = harness.store.commit.bind(harness.store)
  let commits = 0
  harness.store.commit = async (entries) => {
    commits += 1
    if (commits === 2) throw new Error('index disk full')
    return originalCommit(entries)
  }
  try {
    await assert.rejects(harness.service.trash('session-a'), trashCode('INDEX_WRITE_FAILED'))
  } finally {
    delete harness.store.commit
  }
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashing')
  assert.ok(typeof harness.store.findEntry('session-a')?.lastError === 'string')
  await assert.rejects(fs.stat(record.dir))
  const recovery = await harness.service.recover()
  assert.equal(recovery.completed, 1)
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.equal((await fs.stat(harness.store.sessionPath(harness.store.findEntry('session-a').trashId))).isDirectory(), true)
  await harness.dispose()
})

test('preflight conservatively refuses when lineage cannot be resolved', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-lineage', cwd: project, title: 'Lineage' })
  const query = harness.ctx.get('sessionQuery')
  query.traceSession = async () => {
    throw new Error('lineage database unavailable')
  }
  try {
    harness.eligibility.invalidate()
    const verdict = await harness.eligibility.evaluate('session-lineage')
    assert.equal(verdict.eligible, false)
    assert.equal(verdict.code, 'SESSION_LINEAGE_UNRESOLVED')
    await assert.rejects(harness.service.trash('session-lineage'), trashCode('SESSION_LINEAGE_UNRESOLVED'))
  } finally {
    delete query.traceSession
  }
  assert.equal(harness.store.entries().length, 0)
  await harness.dispose()
})
