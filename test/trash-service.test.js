import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHarness, skipAsRoot, skipOnWindows } from './helpers.js'
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
    members: [
      {
        sessionId: id,
        origin: null,
        title: id,
        originalSessionDir: record.dir,
        originalLogPath: record.logPath,
        persistenceProjectDirHint: path.dirname(record.dir),
        formatStatus: 'current',
        sizeBytes: measured.sizeBytes,
        fileCount: measured.fileCount,
      },
    ],
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
  if (skipAsRoot(t, 'permission checks are meaningless as root')) return
  if (skipOnWindows(t, 'POSIX permission bits are not enforced on Windows')) return
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

test('empty unindexed objects can be removed without touching session payloads', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const indexed = await harness.service.trash('session-a')

  const objectsDir = harness.store.objectsDir
  const emptyId = '20260101T000000-emptyaaa'
  const emptyDir = path.join(objectsDir, emptyId)
  await fs.mkdir(emptyDir, { recursive: true })
  await fs.writeFile(path.join(emptyDir, 'meta.json'), '{ broken')

  const payloadId = '20260101T000000-payloaaa'
  const payloadDir = path.join(objectsDir, payloadId)
  await fs.mkdir(path.join(payloadDir, 'session'), { recursive: true })
  await fs.writeFile(path.join(payloadDir, 'session', 'session.v4.jsonl'), 'log')

  const result = await harness.service.purgeEmptyOrphans()
  assert.equal(result.removed, 1)
  await assert.rejects(fs.stat(emptyDir))
  assert.equal((await fs.stat(payloadDir)).isDirectory(), true)
  assert.equal((await fs.stat(harness.store.objectDir(indexed.trashId))).isDirectory(), true)
  assert.equal(harness.store.findEntry('session-a')?.state, 'trashed')
  assert.equal(harness.store.describe().unindexed, 1)
  await harness.dispose()
})

test('empty unindexed cleanup refuses protection mode', async () => {
  const harness = await createHarness()
  const objectsDir = harness.store.objectsDir
  const emptyId = '20260101T000000-emptybbb'
  await fs.mkdir(path.join(objectsDir, emptyId), { recursive: true })
  const indexPath = path.join(harness.trashRoot, 'trash-index.json')
  await fs.writeFile(indexPath, '{ broken')
  await fs.writeFile(`${indexPath}.bak`, '{ also broken')
  await harness.store.init()
  assert.equal(harness.store.isProtected(), true)
  await assert.rejects(harness.service.purgeEmptyOrphans(), trashCode('INDEX_CORRUPT'))
  assert.equal((await fs.stat(path.join(objectsDir, emptyId))).isDirectory(), true)
  await harness.dispose()
})

test('an object-creation failure maps to IO_ERROR without touching the session', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const record = await harness.addSession({ id: 'session-denied', cwd: project, title: 'Denied' })
  const original = harness.store.createObjectDir.bind(harness.store)
  harness.store.createObjectDir = async () => {
    const error = new Error('access denied')
    error.code = 'EACCES'
    throw error
  }
  try {
    await assert.rejects(
      harness.service.trash('session-denied'),
      (error) =>
        error instanceof TrashError &&
        error.code === 'IO_ERROR' &&
        error.details.phase === 'create-object' &&
        error.details.code === 'EACCES',
    )
  } finally {
    harness.store.createObjectDir = original
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

test('purge all deletes every trashed session and forgets missing entries', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  await harness.addSession({ id: 'session-c', cwd: project, title: 'C' })
  const untouched = await harness.addSession({ id: 'session-d', cwd: project, title: 'D' })
  const trashedA = await harness.service.trash('session-a')
  const trashedB = await harness.service.trash('session-b')
  const missing = await harness.service.trash('session-c')
  await fs.rm(path.join(harness.trashRoot, 'objects', missing.trashId), { recursive: true, force: true })
  await harness.service.recover()
  assert.equal(harness.store.findEntry('session-c')?.state, 'missing')

  const result = await harness.service.purgeAll()
  assert.equal(result.purged, 2)
  assert.equal(result.forgotten, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.freedBytes, trashedA.sizeBytes + trashedB.sizeBytes)
  assert.deepEqual(result.failures, [])
  assert.ok(result.changed > 0)
  assert.deepEqual(await fs.readdir(harness.store.objectsDir), [])
  assert.deepEqual(harness.store.entries(), [])
  for (const trashId of [trashedA.trashId, trashedB.trashId]) {
    await assert.rejects(fs.stat(path.join(harness.trashRoot, 'objects', trashId)))
  }
  assert.equal((await fs.stat(untouched.dir)).isDirectory(), true)
  assert.ok(
    harness.logger.lines.some(
      (line) => line.level === 'info' && String(line.args[0]).includes('purged 2, forgotten 1, failed 0'),
    ),
  )
  await harness.dispose()
})

test('purge all on an empty trash returns zero counts', async () => {
  const harness = await createHarness()
  const result = await harness.service.purgeAll()
  assert.deepEqual(result, { purged: 0, forgotten: 0, failed: 0, failures: [], freedBytes: 0, changed: 0 })
  assert.deepEqual(await fs.readdir(harness.store.objectsDir), [])
  assert.deepEqual(harness.store.entries(), [])
  await harness.dispose()
})

test('purge all refuses protection mode before touching the trash', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const entry = await harness.service.trash('session-a')
  const indexPath = path.join(harness.trashRoot, 'trash-index.json')
  await fs.writeFile(indexPath, '{ broken')
  await fs.writeFile(`${indexPath}.bak`, '{ also broken')
  await harness.store.init()
  assert.equal(harness.store.isProtected(), true)

  await assert.rejects(harness.service.purgeAll(), trashCode('INDEX_CORRUPT'))
  assert.equal((await fs.stat(harness.store.sessionPath(entry.trashId))).isDirectory(), true)
  assert.equal(await fs.readFile(indexPath, 'utf8'), '{ broken')
  assert.deepEqual(harness.store.entries(), [])
  await harness.dispose()
})

test('purge all isolates one failure and removes the rest on the next run', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  await harness.addSession({ id: 'session-b', cwd: project, title: 'B' })
  const trashedA = await harness.service.trash('session-a')
  const trashedB = await harness.service.trash('session-b')

  const original = harness.store.removeObjectDir.bind(harness.store)
  let calls = 0
  harness.store.removeObjectDir = async (trashId) => {
    calls += 1
    if (calls === 1) throw new Error('disk is busy')
    return original(trashId)
  }
  let first
  try {
    first = await harness.service.purgeAll()
  } finally {
    harness.store.removeObjectDir = original
  }
  assert.equal(first.purged, 1)
  assert.equal(first.forgotten, 0)
  assert.equal(first.failed, 1)
  assert.equal(first.failures.length, 1)
  assert.equal(first.failures[0].sessionId, 'session-a')
  assert.equal(first.failures[0].title, 'A')
  assert.ok(typeof first.failures[0].message === 'string' && first.failures[0].message !== '')
  const failedEntry = harness.store.findEntry('session-a')
  assert.notEqual(failedEntry, undefined)
  assert.equal(failedEntry.state, 'purging')
  assert.match(failedEntry.lastError, /disk is busy/)
  assert.equal((await fs.stat(harness.store.sessionPath(trashedA.trashId))).isDirectory(), true)
  await assert.rejects(fs.stat(harness.store.sessionPath(trashedB.trashId)))

  const second = await harness.service.purgeAll()
  assert.equal(second.purged, 0)
  assert.equal(second.forgotten, 0)
  assert.equal(second.failed, 0)
  assert.deepEqual(second.failures, [])
  assert.ok(second.changed > 0)
  assert.deepEqual(harness.store.entries(), [])
  assert.deepEqual(await fs.readdir(harness.store.objectsDir), [])
  await harness.dispose()
})

test('purge all commits the index a bounded number of times for a large trash', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  for (let index = 0; index < 6; index += 1) {
    const id = `session-${index}`
    await harness.addSession({ id, cwd: project, title: id })
    await harness.service.trash(id)
  }

  let commits = 0
  const original = harness.store.writeIndex.bind(harness.store)
  harness.store.writeIndex = async (entries) => {
    commits += 1
    return original(entries)
  }
  let result
  try {
    result = await harness.service.purgeAll()
  } finally {
    harness.store.writeIndex = original
  }

  assert.equal(result.purged, 6)
  assert.equal(result.failed, 0)
  assert.ok(commits <= 3, `expected a bounded number of index commits, saw ${commits}`)
  assert.deepEqual(harness.store.entries(), [])
  assert.deepEqual(await fs.readdir(harness.store.objectsDir), [])
  await harness.dispose()
})

test('purge all forgets missing entries without one index commit per entry', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const missing = []
  for (const id of ['session-a', 'session-b', 'session-c']) {
    await harness.addSession({ id, cwd: project, title: id })
    missing.push(await harness.service.trash(id))
  }
  for (const entry of missing) {
    await fs.rm(path.join(harness.trashRoot, 'objects', entry.trashId), { recursive: true, force: true })
  }
  await harness.service.recover()
  assert.equal(harness.store.entries().every((entry) => entry.state === 'missing'), true)

  let commits = 0
  const original = harness.store.writeIndex.bind(harness.store)
  harness.store.writeIndex = async (entries) => {
    commits += 1
    return original(entries)
  }
  let result
  try {
    result = await harness.service.purgeAll()
  } finally {
    harness.store.writeIndex = original
  }

  assert.equal(result.forgotten, 3)
  assert.equal(result.failed, 0)
  assert.ok(commits <= 2, `expected the missing entries to share one commit, saw ${commits}`)
  assert.deepEqual(harness.store.entries(), [])
  await harness.dispose()
})

test('recovery rewrites only the metadata of entries it changed', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const entries = []
  for (const id of ['session-a', 'session-b', 'session-c']) {
    await harness.addSession({ id, cwd: project, title: id })
    entries.push(await harness.service.trash(id))
  }
  // Recreate one original directory: recovery flags that entry and leaves the
  // other two untouched.
  const sourceDir = entries[0].members[0].originalSessionDir
  await fs.mkdir(sourceDir, { recursive: true })

  let metaWrites = 0
  const original = harness.store.writeMeta.bind(harness.store)
  harness.store.writeMeta = async (entry) => {
    metaWrites += 1
    return original(entry)
  }
  let summary
  try {
    summary = await harness.service.recover()
  } finally {
    harness.store.writeMeta = original
  }

  assert.equal(summary.changed, 1)
  assert.equal(metaWrites, 1)
  assert.match(harness.store.findEntry('session-a').lastError, /unexpectedly exists/)
  await harness.dispose()
})

/**
 * Seed one two-member (parent + hidden subagent child) entry with explicit
 * member positions on disk, so the multi-directory crash matrix can be driven.
 *
 * @param {object} harness test harness.
 * @param {{ id: string, childId: string, state: string, parentSource: boolean, parentTrash: boolean, childSource: boolean, childTrash: boolean }} input state row.
 * @returns {Promise<{ entry: object, parent: object, child: object }>} the seeded pieces.
 */
async function seedTreeCrashEntry(harness, input) {
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project, { recursive: true })
  const parent = await harness.addSession({ id: input.id, cwd: project, title: input.id })
  const child = await harness.addSession({
    id: input.childId,
    cwd: project,
    title: input.childId,
    origin: 'subagent',
    parentSession: input.id,
  })
  const parentMeasured = await measureDirectory(parent.dir)
  const childMeasured = await measureDirectory(child.dir)
  const trashId = `20260101T000000-${input.id.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, '0')}`
  const members = [
    {
      sessionId: input.id,
      origin: null,
      title: input.id,
      originalSessionDir: parent.dir,
      originalLogPath: parent.logPath,
      persistenceProjectDirHint: path.dirname(parent.dir),
      formatStatus: 'current',
      sizeBytes: parentMeasured.sizeBytes,
      fileCount: parentMeasured.fileCount,
    },
    {
      sessionId: input.childId,
      origin: 'subagent',
      title: input.childId,
      originalSessionDir: child.dir,
      originalLogPath: child.logPath,
      persistenceProjectDirHint: path.dirname(child.dir),
      formatStatus: 'current',
      sizeBytes: childMeasured.sizeBytes,
      fileCount: childMeasured.fileCount,
    },
  ]
  const entry = {
    sessionId: input.id,
    trashId,
    state: input.state,
    title: input.id,
    trashedAt: input.state === 'trashed' ? Date.now() - 1000 : 0,
    startedAt: Date.now() - 2000,
    originalCwd: project,
    workspaceExistsAtDeletion: true,
    originalWorkspaceId: null,
    originalWorkspaceTitle: null,
    originalNextSessionId: null,
    originalSessionDir: parent.dir,
    originalLogPath: parent.logPath,
    persistenceProjectDirHint: path.dirname(parent.dir),
    formatStatus: 'current',
    sizeBytes: parentMeasured.sizeBytes + childMeasured.sizeBytes,
    fileCount: parentMeasured.fileCount + childMeasured.fileCount,
    members,
    lastError: null,
  }
  await harness.store.createObjectDir(trashId)
  if (input.parentTrash) await fs.cp(parent.dir, harness.store.memberPath(trashId, 0, input.id), { recursive: true })
  if (input.childTrash) {
    await fs.cp(child.dir, harness.store.memberPath(trashId, 1, input.childId), { recursive: true })
  }
  if (!input.parentSource) await fs.rm(parent.dir, { recursive: true, force: true })
  if (!input.childSource) await fs.rm(child.dir, { recursive: true, force: true })
  await harness.store.writeMeta(entry)
  await harness.store.commit([entry])
  return { entry, parent, child }
}

test('cascade trash moves hidden subagent children and restores them together', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const parent = await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent' })
  const childA = await harness.addSession({
    id: 'child-a',
    cwd: project,
    title: 'A',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  const childB = await harness.addSession({
    id: 'child-b',
    cwd: project,
    title: 'B',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-parent'] })

  const entry = await harness.service.trash('session-parent')
  assert.equal(entry.state, 'trashed')
  assert.equal(entry.members.length, 3)
  assert.deepEqual(
    entry.members.map((member) => member.sessionId),
    ['session-parent', 'child-a', 'child-b'],
  )
  assert.deepEqual(
    entry.members.map((member) => member.origin),
    [null, 'subagent', 'subagent'],
  )
  assert.equal(
    entry.sizeBytes,
    entry.members.reduce((total, member) => total + member.sizeBytes, 0),
  )
  for (const record of [parent, childA, childB]) await assert.rejects(fs.stat(record.dir))
  assert.equal(
    await fs.readFile(path.join(harness.store.sessionPath(entry.trashId), 'session.v4.jsonl'), 'utf8'),
    '{"type":"session/start"}\n',
  )
  assert.equal(
    await fs.readFile(path.join(harness.store.memberPath(entry.trashId, 1, 'child-a'), 'session.v4.jsonl'), 'utf8'),
    '{"type":"session/start"}\n',
  )
  assert.deepEqual(harness.emissions.at(-1), { event: 'api-session/removed', args: ['session-parent'] })

  const state = await harness.stateService.snapshot()
  assert.equal(state.entries[0].subagentCount, 2)
  assert.deepEqual(
    state.entries[0].members.map((member) => member.sessionId),
    ['session-parent', 'child-a', 'child-b'],
  )
  assert.equal(
    state.entries[0].sizeBytes,
    entry.members.reduce((total, member) => total + member.sizeBytes, 0),
  )

  const result = await harness.service.restore('session-parent')
  assert.equal(result.workspaceReattached, true)
  for (const record of [parent, childA, childB]) {
    assert.equal(await fs.readFile(record.logPath, 'utf8'), '{"type":"session/start"}\n')
  }
  assert.equal(harness.store.findEntry('session-parent'), undefined)
  assert.deepEqual(await fs.readdir(harness.store.objectsDir), [])
  assert.deepEqual(workspace.sessionIds, ['session-parent'])
  assert.equal(harness.emissions.at(-1).event, 'api-session/added')
  assert.equal(harness.emissions.at(-1).args[0].sessionId, 'session-parent')
  await harness.dispose()
})

test('cascade purge deletes every session directory of the tree', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent' })
  await harness.addSession({
    id: 'child-a',
    cwd: project,
    title: 'A',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  const entry = await harness.service.trash('session-parent')
  const result = await harness.service.purgeAll()
  assert.equal(result.purged, 1)
  assert.equal(result.failed, 0)
  await assert.rejects(fs.stat(harness.store.objectDir(entry.trashId)))
  assert.deepEqual(harness.store.entries(), [])
  await harness.dispose()
})

test('purge releases workspace accounting and the projection-cache record', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-a'] })
  const cacheFile = await harness.writeCachedTitle('session-a', 'A')

  const entry = await harness.service.trash('session-a')
  assert.equal((await fs.stat(cacheFile)).isFile(), true)
  const purged = await harness.service.purge('session-a')
  assert.equal(purged.freedBytes, entry.sizeBytes)

  assert.deepEqual(workspace.sessionIds, [])
  assert.deepEqual(workspace.calls, [['detach', 'session-a']])
  assert.deepEqual(harness.workspaces.calls, [
    ['unarchive', 'session-a'],
    ['unpin', 'session-a'],
  ])
  await assert.rejects(fs.stat(cacheFile))
  await assert.rejects(fs.stat(harness.store.objectDir(entry.trashId)))
  assert.deepEqual(harness.store.entries(), [])
  await harness.dispose()
})

test('purge all releases the projection records of every tree member', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent' })
  await harness.addSession({
    id: 'child-a',
    cwd: project,
    title: 'A',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-parent'] })
  const parentCache = await harness.writeCachedTitle('session-parent', 'Parent')
  const childCache = await harness.writeCachedTitle('child-a', 'A')

  await harness.service.trash('session-parent')
  const result = await harness.service.purgeAll()

  assert.equal(result.purged, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(workspace.sessionIds, [])
  await assert.rejects(fs.stat(parentCache))
  await assert.rejects(fs.stat(childCache))
  await harness.dispose()
})

test('purge succeeds when workspace cleanup fails and still removes the cache record', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-a'] })
  workspace.detachSession = async () => {
    throw new Error('detach failed')
  }
  const cacheFile = await harness.writeCachedTitle('session-a', 'A')
  await harness.service.trash('session-a')

  const result = await harness.service.purge('session-a')

  assert.equal(result.sessionId, 'session-a')
  assert.deepEqual(result.title, 'A')
  await assert.rejects(fs.stat(cacheFile))
  assert.deepEqual(harness.workspaces.calls, [
    ['unarchive', 'session-a'],
    ['unpin', 'session-a'],
  ])
  assert.ok(
    harness.logger.lines.some(
      (line) => line.level === 'warn' && String(line.args[0]).includes('detach failed'),
    ),
  )
  assert.deepEqual(harness.store.entries(), [])
  await harness.dispose()
})

test('startup projection sweep removes only old records no session can use', async () => {
  const harness = await createHarness()
  const old = new Date(Date.now() - 8 * 86_400_000)
  const stale = await harness.writeCachedTitle('session-stale', 'Stale')
  const recent = await harness.writeCachedTitle('session-recent', 'Recent')
  await harness.addSession({ id: 'session-live', title: 'Live' })
  const liveCache = await harness.writeCachedTitle('session-live', 'Live')
  await harness.addSession({ id: 'session-trashed', title: 'Trashed' })
  const trashedCache = await harness.writeCachedTitle('session-trashed', 'Trashed')
  await harness.service.trash('session-trashed')

  for (const file of [stale, liveCache, trashedCache]) await fs.utimes(file, old, old)

  const result = await harness.service.sweepProjectionCache()

  assert.deepEqual(result, { removed: 1 })
  await assert.rejects(fs.stat(stale))
  for (const file of [recent, liveCache, trashedCache]) {
    assert.equal((await fs.stat(file)).isFile(), true)
  }
  await harness.dispose()
})

test('projection sweep tolerates a missing cache directory and skips non-files', async () => {
  const harness = await createHarness()
  assert.deepEqual(await harness.service.sweepProjectionCache(), { removed: 0 })

  const directory = path.join(harness.root, 'storages', 'session_projcache', 'sessions')
  await fs.mkdir(path.join(directory, 'session-directory.json'), { recursive: true })
  const old = new Date(Date.now() - 8 * 86_400_000)
  await fs.utimes(path.join(directory, 'session-directory.json'), old, old)

  assert.deepEqual(await harness.service.sweepProjectionCache(), { removed: 0 })
  assert.equal((await fs.stat(path.join(directory, 'session-directory.json'))).isDirectory(), true)
  await harness.dispose()
})

test('recovery finishes an interrupted purge and releases its derived records', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'A' })
  const workspace = harness.workspaces.add({ id: 'ws-1', path: project, sessionIds: ['session-a'] })
  const cacheFile = await harness.writeCachedTitle('session-a', 'A')
  const entry = await harness.service.trash('session-a')
  await harness.store.commit([{ ...entry, state: 'purging' }])
  await fs.rm(harness.store.objectDir(entry.trashId), { recursive: true, force: true })

  await harness.service.recover()

  assert.deepEqual(workspace.sessionIds, [])
  await assert.rejects(fs.stat(cacheFile))
  assert.deepEqual(harness.store.entries(), [])
  await harness.dispose()
})

test('cascade preflight refuses a live hidden child and leaves every directory', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const parent = await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent' })
  const child = await harness.addSession({
    id: 'child-a',
    cwd: project,
    title: 'A',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  harness.liveSessions.set('child-a', { id: 'child-a' })
  await assert.rejects(harness.service.trash('session-parent'), trashCode('SESSION_LIVE'))
  assert.equal(harness.store.entries().length, 0)
  assert.equal((await fs.stat(parent.dir)).isDirectory(), true)
  assert.equal((await fs.stat(child.dir)).isDirectory(), true)
  harness.liveSessions.delete('child-a')
  await harness.dispose()
})

test('cascade restore refuses when a child target directory reappeared', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  const child = await harness.addSession({
    id: 'child-a',
    cwd: project,
    title: 'A',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent' })
  const entry = await harness.service.trash('session-parent')
  await fs.mkdir(child.dir, { recursive: true })
  try {
    await assert.rejects(harness.service.restore('session-parent'), trashCode('RESTORE_TARGET_EXISTS'))
  } finally {
    await harness.dispose()
  }
  assert.equal(entry.members.length, 2)
})

const treeMatrix = [
  {
    name: 'trashing, parent moved only -> complete forward',
    state: 'trashing',
    parentSource: false,
    parentTrash: true,
    childSource: true,
    childTrash: false,
    expect: 'trashed',
    expectParentSource: false,
    expectChildSource: false,
  },
  {
    name: 'trashing, child moved only -> complete forward',
    state: 'trashing',
    parentSource: true,
    parentTrash: false,
    childSource: false,
    childTrash: true,
    expect: 'trashed',
    expectParentSource: false,
    expectChildSource: false,
  },
  {
    name: 'trashing, one member lost -> missing',
    state: 'trashing',
    parentSource: true,
    parentTrash: false,
    childSource: false,
    childTrash: false,
    expect: 'missing',
    expectParentSource: true,
    expectChildSource: false,
  },
  {
    name: 'restoring, parent restored only -> complete forward',
    state: 'restoring',
    parentSource: true,
    parentTrash: false,
    childSource: false,
    childTrash: true,
    expect: null,
    expectParentSource: true,
    expectChildSource: true,
  },
  {
    name: 'restoring, child restored only -> complete forward',
    state: 'restoring',
    parentSource: false,
    parentTrash: true,
    childSource: true,
    childTrash: false,
    expect: null,
    expectParentSource: true,
    expectChildSource: true,
  },
  {
    name: 'restoring, one member lost -> missing',
    state: 'restoring',
    parentSource: true,
    parentTrash: false,
    childSource: false,
    childTrash: false,
    expect: 'missing',
    expectParentSource: true,
    expectChildSource: false,
  },
]

for (const row of treeMatrix) {
  test(`tree recovery matrix: ${row.name}`, async () => {
    const harness = await createHarness()
    const seeded = await seedTreeCrashEntry(harness, {
      id: `session-tree-${row.name.replace(/[^a-z0-9]+/g, '-')}`,
      childId: `child-${row.name.replace(/[^a-z0-9]+/g, '-')}`,
      state: row.state,
      parentSource: row.parentSource,
      parentTrash: row.parentTrash,
      childSource: row.childSource,
      childTrash: row.childTrash,
    })
    const summary = await harness.service.recover()
    const current = harness.store.findEntry(seeded.entry.sessionId)
    if (row.expect === null) assert.equal(current, undefined)
    else assert.equal(current?.state, row.expect)
    const parentSourceExists = await fs
      .stat(seeded.parent.dir)
      .then(() => true)
      .catch(() => false)
    const childSourceExists = await fs
      .stat(seeded.child.dir)
      .then(() => true)
      .catch(() => false)
    assert.equal(parentSourceExists, row.expectParentSource, 'parent source presence')
    assert.equal(childSourceExists, row.expectChildSource, 'child source presence')
    assert.equal(summary.changed, 1)
    await harness.dispose()
  })
}

test('trash captures the folded title snapshot returned by the modern query service', async () => {
  const harness = await createHarness({ titleApi: 'snapshot' })
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'Refactor login' })

  const entry = await harness.service.trash('session-a')
  assert.equal(entry.title, 'Refactor login')
  const state = await harness.stateService.snapshot()
  assert.equal(state.entries[0].title, 'Refactor login')
  await harness.dispose()
})

test('trash still accepts a plain string title from older query services', async () => {
  const harness = await createHarness({ titleApi: 'string' })
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'Fix navbar' })

  const entry = await harness.service.trash('session-a')
  assert.equal(entry.title, 'Fix navbar')
  await harness.dispose()
})

test('trash falls back to the documented snapshot batch face when readTitle is absent', async () => {
  const harness = await createHarness({ titleApi: 'snapshots' })
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'Batch title' })

  const entry = await harness.service.trash('session-a')
  assert.equal(entry.title, 'Batch title')
  await harness.dispose()
})

test('trash falls back to the cached title projection when the log fold fails', async () => {
  const harness = await createHarness({
    titleApi: 'throwing',
    cachedTitles: new Map([['session-a', 'Cached conversation title']]),
  })
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-a', cwd: project, title: 'Unreadable log title' })

  const entry = await harness.service.trash('session-a')
  assert.equal(entry.title, 'Cached conversation title')
  await harness.dispose()
})

test('state entries expose the original workspace title and every member title', async () => {
  const harness = await createHarness()
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent title' })
  await harness.addSession({
    id: 'child-a',
    cwd: project,
    title: 'Child title',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  harness.workspaces.add({ id: 'ws-1', path: project, title: 'Scratch workspace', sessionIds: ['session-parent'] })
  await harness.service.trash('session-parent')

  const state = await harness.stateService.snapshot()
  assert.equal(state.entries[0].originalWorkspaceTitle, 'Scratch workspace')
  assert.deepEqual(
    state.entries[0].members.map((member) => member.title),
    ['Parent title', 'Child title'],
  )
  await harness.dispose()
})

test('startup title repair recovers fallback titles from the projection cache', async () => {
  const harness = await createHarness({ titleApi: 'none' })
  const project = path.join(harness.root, 'project')
  await fs.mkdir(project)
  await harness.addSession({ id: 'session-parent', cwd: project, title: 'Parent title' })
  await harness.addSession({
    id: 'child-a',
    cwd: project,
    title: 'Child title',
    origin: 'subagent',
    parentSession: 'session-parent',
  })
  const entry = await harness.service.trash('session-parent')
  // With no title service the old release shape is reproduced: the cwd basename.
  assert.equal(entry.title, 'project')
  assert.deepEqual(
    entry.members.map((member) => member.title),
    ['project', 'project'],
  )
  await harness.writeCachedTitle('session-parent', 'Fix the parser', { cwd: project })
  await harness.writeCachedTitle('child-a', 'Audit the parser', { cwd: project })

  assert.deepEqual(await harness.service.repairTitles(), { repaired: 1 })
  const repaired = harness.store.findEntry('session-parent')
  assert.equal(repaired?.title, 'Fix the parser')
  assert.deepEqual(
    repaired?.members.map((member) => member.title),
    ['Fix the parser', 'Audit the parser'],
  )
  const state = await harness.stateService.snapshot()
  assert.equal(state.entries[0].title, 'Fix the parser')
  const meta = JSON.parse(await fs.readFile(harness.store.metaPath(entry.trashId), 'utf8'))
  assert.equal(meta.title, 'Fix the parser')
  // The repair is idempotent.
  assert.deepEqual(await harness.service.repairTitles(), { repaired: 0 })
  await harness.dispose()
})

test('title repair keeps real titles and ignores unrelated or missing cache records', async () => {
  const titled = await createHarness()
  const project = path.join(titled.root, 'project')
  await fs.mkdir(project)
  await titled.addSession({ id: 'session-real', cwd: project, title: 'Real title' })
  await titled.service.trash('session-real')
  await titled.writeCachedTitle('session-real', 'Stale cached title', { cwd: project })
  assert.deepEqual(await titled.service.repairTitles(), { repaired: 0 })
  assert.equal(titled.store.findEntry('session-real')?.title, 'Real title')
  await titled.dispose()

  const unrelated = await createHarness({ titleApi: 'none' })
  const otherProject = path.join(unrelated.root, 'project')
  await fs.mkdir(otherProject)
  await unrelated.addSession({ id: 'session-old', cwd: otherProject, title: 'Unused' })
  await unrelated.service.trash('session-old')
  await unrelated.writeCachedTitle('session-old', 'Another workspace title', {
    cwd: path.join(unrelated.root, 'other-project'),
  })
  assert.deepEqual(await unrelated.service.repairTitles(), { repaired: 0 })
  assert.equal(unrelated.store.findEntry('session-old')?.title, 'project')
  await unrelated.dispose()
})
