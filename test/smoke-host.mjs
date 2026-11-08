/**
 * Manual Host integration smoke test. Run with the desktop Electron binary as
 * Node so the real 0.2.2-rc.1 Cordis package can be imported from app.asar:
 *
 *   DSH_HOME=$(mktemp -d) ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/smoke-host.mjs
 *
 * The script provides the five required Host services as fakes, calls `apply`,
 * and asserts the plugin registered its routes and created the trash root. It
 * refuses to run unless DSH_HOME points at a throwaway directory.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Context } from 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'

const home = process.env.DSH_HOME
assert.ok(typeof home === 'string' && home !== '', 'set DSH_HOME to a temporary directory before running this smoke test')
assert.ok(!home.includes('/.dsh'), 'refusing to run against a real DSH home')

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
    return { header, formatStatus: 'current', revision: 'r', sizeBytes: stats.size, location: { kind: 'jsonl', path: logPath } }
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

const expected = ['state', 'preflight', 'trash', 'restore', 'purge', 'forget', 'reveal', 'cleanup', 'rebuild'].map(
  (name) => `/plugins/dsh-session-trash/api/${name}`,
)
await new Promise((resolve) => setTimeout(resolve, 100))
assert.deepEqual([...routes.keys()].sort(), [...expected].sort())
const index = JSON.parse(await fs.readFile(path.join(home, '.session-trash', 'trash-index.json'), 'utf8'))
assert.equal(index.version, 1)
assert.deepEqual(index.entries, [])

const stateRoute = routes.get('/plugins/dsh-session-trash/api/state')
const request = new EventEmitter()
request.method = 'GET'
request.url = '/plugins/dsh-session-trash/api/state'
request.headers = { host: '127.0.0.1:3080' }
const response = {
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
  },
  end(body) {
    this.body = body === undefined ? '' : String(body)
    this.writableEnded = true
  },
}
await stateRoute.handler(request, response)
assert.equal(response.status, 200)
const state = JSON.parse(response.body)
assert.equal(state.version, 1)
assert.equal(state.trashRootDisplay, '$DSH_HOME/.session-trash')
assert.deepEqual(state.entries, [])

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
async function call(name, input) {
  const response = createResponse()
  await routes.get(`/plugins/dsh-session-trash/api/${name}`).handler(createRequest(input), response)
  return { status: response.status, body: response.body === '' ? null : JSON.parse(response.body) }
}

const jsonHeaders = {
  host: '127.0.0.1:3080',
  'content-type': 'application/json',
  'x-dsh-session-trash': '1',
}

const trashed = await call('trash', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ sessionId }) })
assert.equal(trashed.status, 200)
assert.equal(trashed.body.entry.state, 'trashed')
assert.equal(trashed.body.entry.title, path.basename(path.join(home, 'project')))
await assert.rejects(fs.stat(sessionDir))
const afterTrash = JSON.parse(await fs.readFile(path.join(home, '.session-trash', 'trash-index.json'), 'utf8'))
assert.equal(afterTrash.entries.length, 1)
assert.equal(afterTrash.entries[0].sessionId, sessionId)

const reveal = await call('reveal', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ sessionId }) })
assert.equal(reveal.status, 200)
assert.deepEqual(reveal.body, { ok: true, opened: true })
assert.deepEqual(revealedPaths, [{ path: path.join(home, 'project'), action: 'reveal' }])

const restored = await call('restore', {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ sessionId, mode: 'normal' }),
})
assert.equal(restored.status, 200)
assert.equal(restored.body.session.sessionId, sessionId)
assert.equal(await fs.readFile(logPath, 'utf8'), '{"type":"session/start"}\n')
const afterRestore = JSON.parse(await fs.readFile(path.join(home, '.session-trash', 'trash-index.json'), 'utf8'))
assert.deepEqual(afterRestore.entries, [])

const trashedAgain = await call('trash', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ sessionId }) })
assert.equal(trashedAgain.status, 200)
const purged = await call('purge', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ sessionId }) })
assert.equal(purged.status, 200)
assert.deepEqual(purged.body, { ok: true, sessionId })
await assert.rejects(fs.stat(sessionDir))
const afterPurge = JSON.parse(await fs.readFile(path.join(home, '.session-trash', 'trash-index.json'), 'utf8'))
assert.deepEqual(afterPurge.entries, [])
assert.deepEqual(await fs.readdir(path.join(home, '.session-trash', 'objects')), [])

const cleanup = await call('cleanup', { method: 'POST', headers: jsonHeaders })
assert.equal(cleanup.status, 200)
assert.equal(cleanup.body.ok, true)
assert.equal(cleanup.body.purged, 0)
assert.equal(cleanup.body.failed, 0)
assert.equal(typeof cleanup.body.cleanup, 'object')
assert.equal(cleanup.body.cleanup.consecutiveFailures, 0)

const rebuild = await call('rebuild', { method: 'POST', headers: jsonHeaders })
assert.equal(rebuild.status, 409)
assert.equal(rebuild.body.error.code, 'INDEX_NOT_CORRUPT')

const revealAfterPurge = await call('reveal', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ sessionId }) })
assert.equal(revealAfterPurge.status, 404)
assert.equal(revealAfterPurge.body.error.code, 'TRASH_ENTRY_NOT_FOUND')

console.log('host smoke test passed:', [...routes.keys()].join(', '))
