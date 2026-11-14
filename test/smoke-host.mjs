/**
 * Host integration smoke test. It builds a real Cordis `Context` from the
 * published `@deepseek-ai/cordis` package (a dev dependency), provides the
 * Host services the plugin injects as fakes, calls `apply`, and exercises the
 * registered HTTP routes through trash, reveal, restore, purge, cleanup, and
 * rebuild.
 *
 * Run it with plain Node:
 *
 *   pnpm test:smoke
 *
 * The script creates a throwaway `DSH_HOME` itself and removes it afterwards,
 * so it is safe to run anywhere and in CI; an inherited `DSH_HOME` is ignored.
 * Set `DSH_SMOKE_HOME` to reuse an existing temporary home (it is then left in
 * place), or `DSH_SMOKE_KEEP=1` to keep the generated home for inspection.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { INDEX_VERSION } from '../lib/store.js'

const keep = process.env.DSH_SMOKE_KEEP === '1'

/**
 * @param {string} home candidate harness home.
 * @returns {Promise<void>} resolution once the home is known to be throwaway.
 */
async function assertThrowawayHome(home) {
  const resolved = path.resolve(home)
  const realDshHome = path.join(os.homedir(), '.dsh')
  assert.ok(
    resolved !== realDshHome && !resolved.startsWith(`${realDshHome}${path.sep}`),
    'refusing to run against a real DSH home; point DSH_HOME at a temporary directory',
  )
  assert.ok(resolved !== path.parse(resolved).root, 'refusing to run against the filesystem root')
}

/**
 * @returns {Promise<{ home: string, owned: boolean }>} the harness home and whether this run owns it.
 */
async function prepareHome() {
  const configured = process.env.DSH_SMOKE_HOME
  if (typeof configured === 'string' && configured !== '') {
    await assertThrowawayHome(configured)
    process.env.DSH_HOME = path.resolve(configured)
    return { home: path.resolve(configured), owned: false }
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-trash-smoke-'))
  process.env.DSH_HOME = home
  return { home, owned: true }
}

/**
 * @param {{ home: string, owned: boolean }} prepared harness home.
 * @returns {Promise<void>} resolution once the home is cleaned up.
 */
async function cleanupHome(prepared) {
  if (!prepared.owned || keep) {
    if (keep) console.log(`kept the smoke home at ${prepared.home}`)
    return
  }
  await fs.rm(prepared.home, { recursive: true, force: true })
}

/**
 * Build the five services the Host requires, in the same shape a real Host
 * provides them, and register the plugin against a real Cordis context.
 *
 * @param {string} home throwaway harness home.
 * @returns {Promise<{ routes: Map<string, object>, calls: { revealed: object[] } }>} the registered routes.
 */
async function bootPlugin(home) {
  const routes = new Map()
  const ctx = new Context()
  const sessionsRoot = path.join(home, 'sessions', '--smoke-project--')
  const sessionId = 'session-smoke'
  const sessionDir = path.join(sessionsRoot, sessionId)
  const logPath = path.join(sessionDir, 'session.v4.jsonl')
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(logPath, '{"type":"session/start"}\n')
  await fs.writeFile(path.join(sessionDir, 'session.lock'), '')
  await fs.mkdir(path.join(home, 'project'), { recursive: true })
  const header = { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false, cwd: path.join(home, 'project') }
  const snapshot = async () => {
    try {
      const stats = await fs.stat(logPath)
      return {
        header,
        formatStatus: 'current',
        revision: 'r',
        sizeBytes: stats.size,
        location: { kind: 'jsonl', path: logPath },
      }
    } catch {
      return undefined
    }
  }
  ctx.provide('sessionPersistence', {
    async stat(id) {
      return id === sessionId ? snapshot() : undefined
    },
    async list() {
      const current = await snapshot()
      return current === undefined ? [] : [current]
    },
  })
  ctx.provide('webServer', {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  })
  ctx.provide('connection', {
    requestRejection() {
      return undefined
    },
    admit() {
      return { peer: { principal: { kind: 'owner' } } }
    },
  })
  ctx.provide('sessions', { get() {} })
  ctx.provide('agents', { get() {} })
  const revealedPaths = []
  ctx.provide('sessionController', {
    canOpenWorkspacePath() {
      return true
    },
    async openWorkspacePath(request, signal) {
      signal?.throwIfAborted?.()
      revealedPaths.push(request)
      return { opened: true }
    },
  })

  const plugin = await import(new URL('../index.js', import.meta.url).href)
  plugin.apply(ctx, plugin.Config({}))

  return { routes, sessionId, sessionDir, logPath, revealedPaths }
}

/**
 * @param {Map<string, object>} routes every registered route.
 * @returns {string[]} the route names this plugin must expose.
 */
function expectedRoutes() {
  return [
    'state',
    'sweep',
    'preflight',
    'trash',
    'restore',
    'purge',
    'purge-all',
    'forget',
    'orphans/forget',
    'reveal',
    'cleanup',
    'rebuild',
  ].map((name) => `/plugins/dsh-session-trash/api/${name}`)
}

/**
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} input request facts.
 * @returns {EventEmitter} a Node-request-shaped event emitter.
 */
function createRequest({ method = 'GET', headers = {}, body = '' } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = '/'
  request.headers = headers
  process.nextTick(() => {
    if (body !== '') request.emit('data', Buffer.from(body))
    request.emit('end')
  })
  return request
}

/**
 * @returns {object} a Node-response-shaped sink.
 */
function createResponse() {
  return {
    status: 0,
    body: '',
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.status = status
      this.headersSent = true
      Object.assign(this.headers, headers ?? {})
      return this
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
      this.writableEnded = true
    },
  }
}

/**
 * @param {string} name endpoint below the API prefix.
 * @param {object} input request facts.
 * @returns {Promise<{ status: number, body: any }>} decoded answer.
 */
async function call(routes, name, input) {
  const response = createResponse()
  await routes.get(`/plugins/dsh-session-trash/api/${name}`).handler(createRequest(input), response)
  return { status: response.status, body: response.body === '' ? null : JSON.parse(response.body) }
}

/**
 * @returns {Promise<void>} resolution once every assertion passed.
 */
async function main() {
  const prepared = await prepareHome()
  try {
    const { routes, sessionId, sessionDir, logPath, revealedPaths } = await bootPlugin(prepared.home)

    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual([...routes.keys()].sort(), expectedRoutes().sort())
    const index = JSON.parse(await fs.readFile(path.join(prepared.home, '.session-trash', 'trash-index.json'), 'utf8'))
    assert.equal(index.version, INDEX_VERSION)
    assert.deepEqual(index.entries, [])

    const state = await call(routes, 'state')
    assert.equal(state.status, 200)
    assert.equal(state.body.version, 1)
    assert.equal(state.body.trashRootDisplay, '$DSH_HOME/.session-trash')
    assert.deepEqual(state.body.entries, [])
    assert.equal(typeof state.body.storage, 'object')
    assert.equal(typeof state.body.storage.totalBytes, 'number')
    assert.equal(typeof state.body.storage.attachments.files, 'number')

    const jsonHeaders = {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
      'x-dsh-session-trash': '1',
    }

    const trashed = await call(routes, 'trash', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId }),
    })
    assert.equal(trashed.status, 200)
    assert.equal(trashed.body.entry.state, 'trashed')
    assert.equal(trashed.body.entry.title, path.basename(path.join(prepared.home, 'project')))
    await assert.rejects(fs.stat(sessionDir))
    const afterTrash = JSON.parse(
      await fs.readFile(path.join(prepared.home, '.session-trash', 'trash-index.json'), 'utf8'),
    )
    assert.equal(afterTrash.entries.length, 1)
    assert.equal(afterTrash.entries[0].sessionId, sessionId)

    const reveal = await call(routes, 'reveal', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId }),
    })
    assert.equal(reveal.status, 200)
    assert.deepEqual(reveal.body, { ok: true, opened: true })
    assert.deepEqual(revealedPaths, [{ path: path.join(prepared.home, 'project'), action: 'reveal' }])

    const restored = await call(routes, 'restore', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId, mode: 'normal' }),
    })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.session.sessionId, sessionId)
    assert.equal(await fs.readFile(logPath, 'utf8'), '{"type":"session/start"}\n')
    const afterRestore = JSON.parse(
      await fs.readFile(path.join(prepared.home, '.session-trash', 'trash-index.json'), 'utf8'),
    )
    assert.deepEqual(afterRestore.entries, [])

    const trashedAgain = await call(routes, 'trash', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId }),
    })
    assert.equal(trashedAgain.status, 200)
    const purged = await call(routes, 'purge', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId }),
    })
    assert.equal(purged.status, 200)
    assert.equal(purged.body.ok, true)
    assert.equal(purged.body.sessionId, sessionId)
    assert.equal(typeof purged.body.freedBytes, 'number')
    assert.ok(purged.body.freedBytes > 0)
    await assert.rejects(fs.stat(sessionDir))
    const afterPurge = JSON.parse(
      await fs.readFile(path.join(prepared.home, '.session-trash', 'trash-index.json'), 'utf8'),
    )
    assert.deepEqual(afterPurge.entries, [])
    assert.deepEqual(await fs.readdir(path.join(prepared.home, '.session-trash', 'objects')), [])

    const sweep = await call(routes, 'sweep', { method: 'POST', headers: jsonHeaders })
    assert.equal(sweep.status, 200)
    assert.equal(sweep.body.ok, true)

    const orphans = await call(routes, 'orphans/forget', { method: 'POST', headers: jsonHeaders })
    assert.equal(orphans.status, 200)
    assert.equal(orphans.body.removed, 0)

    const cleanup = await call(routes, 'cleanup', { method: 'POST', headers: jsonHeaders })
    assert.equal(cleanup.status, 200)
    assert.equal(cleanup.body.ok, true)
    assert.equal(cleanup.body.purged, 0)
    assert.equal(cleanup.body.failed, 0)
    assert.equal(typeof cleanup.body.cleanup, 'object')
    assert.equal(cleanup.body.cleanup.consecutiveFailures, 0)

    const rebuild = await call(routes, 'rebuild', { method: 'POST', headers: jsonHeaders })
    assert.equal(rebuild.status, 409)
    assert.equal(rebuild.body.error.code, 'INDEX_NOT_CORRUPT')

    const revealAfterPurge = await call(routes, 'reveal', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId }),
    })
    assert.equal(revealAfterPurge.status, 404)
    assert.equal(revealAfterPurge.body.error.code, 'TRASH_ENTRY_NOT_FOUND')

    console.log('host smoke test passed:', [...routes.keys()].join(', '))
  } finally {
    await cleanupHome(prepared)
  }
}

await main()
