import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerApi, API_PREFIX } from '../lib/http.js'
import { TrashError } from '../lib/errors.js'

/**
 * @param {object} [options] request/response facts.
 * @returns {object} a fake Node response capturing status, headers, and body.
 */
function createResponse() {
  const response = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.status = status
      this.headersSent = true
      for (const [name, value] of Object.entries(headers ?? {})) {
        this.headers[String(name).toLowerCase()] = value
      }
      return this
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
      this.writableEnded = true
    },
  }
  return response
}

/**
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} input request facts.
 * @returns {import('node:events').EventEmitter} a request stream.
 */
function createRequest({ method = 'POST', headers = {}, body = '' } = {}) {
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
 * Build one API instance over fakes.
 *
 * @param {{ rejection?: number, admission?: object, trash?: Function, restore?: Function, purge?: Function, purgeAll?: Function, forget?: Function, reveal?: Function, rebuild?: Function, state?: Function, cleanup?: Function, cleanupDiagnostics?: object }} [options] behaviour overrides.
 * @returns {{ call: Function, calls: unknown[], routes: Map<string, Function>, pageOpens: number[] }} the call helper and captured API pieces.
 */
function createApi(options = {}) {
  const routes = new Map()
  const calls = []
  
  const ctx = {
    connection: {
      requestRejection() {
        return options.rejection
      },
      admit() {
        return options.admission ?? { peer: { principal: { kind: 'owner' } } }
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(callback) {
      const dispose = callback()
      return dispose
    },
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const trashService = {
    async trash(sessionId) {
      calls.push(['trash', sessionId])
      if (options.trash !== undefined) return options.trash(sessionId)
      return { sessionId, trashId: 't-1', state: 'trashed', title: 'A', trashedAt: 1 }
    },
    async restore(sessionId, mode) {
      calls.push(['restore', sessionId, mode])
      if (options.restore !== undefined) return options.restore(sessionId, mode)
      return { sessionId, title: 'A', orphan: mode === 'orphan', workspaceReattached: mode !== 'orphan' }
    },
    async purge(sessionId) {
      calls.push(['purge', sessionId])
      if (options.purge !== undefined) return options.purge(sessionId)
      return { sessionId, title: 'A' }
    },
    async purgeAll() {
      calls.push(['purgeAll'])
      if (options.purgeAll !== undefined) return options.purgeAll()
      return { purged: 2, forgotten: 1, failed: 0 }
    },
    async forget(sessionId) {
      calls.push(['forget', sessionId])
      if (options.forget !== undefined) return options.forget(sessionId)
      return { sessionId, title: 'A' }
    },
    async reveal(sessionId, signal) {
      calls.push(['reveal', sessionId, signal !== undefined])
      if (options.reveal !== undefined) return options.reveal(sessionId)
      return { path: '/tmp/project' }
    },
    async rebuild() {
      calls.push(['rebuild'])
      if (options.rebuild !== undefined) return options.rebuild()
      return { entries: 2, unindexed: 1 }
    },
    async purgeEmptyOrphans() {
      calls.push(['purgeEmptyOrphans'])
      if (options.orphans !== undefined) return options.orphans()
      return { removed: 2 }
    },
  }
  const cleanupService = {
    async runNow(input) {
      calls.push(['cleanup', input])
      if (options.cleanup !== undefined) return options.cleanup(input)
      return { purged: 2, failed: 0 }
    },
    async sweepOnPageOpen() {
      calls.push(['sweep'])
      if (options.sweep !== undefined) return options.sweep()
      return { ran: true, result: { purged: 1, failed: 0, changed: 0 } }
    },
    ...(options.cleanupDiagnostics === undefined
      ? {}
      : { diagnostics: () => options.cleanupDiagnostics }),
  }
  registerApi({
    ctx,
    eligibility: {
      evaluate: options.eligibility ?? (async (sessionId) => ({ eligible: true, sessionId })),
      invalidate() {},
    },
    stateService: {
      async snapshot() {
        if (options.state !== undefined) return options.state()
        return { version: 1, config: {}, trashRootDisplay: '$DSH_HOME/.session-trash', index: { status: 'ok' }, entries: [], stats: { count: 0, totalBytes: 0, nextSweepAt: null } }
      },
      async describe(entry) {
        return { ...entry, expiresAt: 1, canRestore: true, workspaceNowExists: true, requiresOrphanRestore: false }
      },
    },
    trashService,
    cleanupService,
    ready: Promise.resolve(),
    config: { debug: false },
    logger,
  })
  return {
    calls,
    routes,
    async call(pathname, { method = 'POST', headers = {}, body = '' } = {}) {
      const handler = routes.get(`${API_PREFIX}/${pathname}`)
      assert.ok(handler !== undefined, `route ${pathname} registered`)
      const response = createResponse()
      await handler(createRequest({ method, headers, body }), response)
      let parsed = null
      try {
        parsed = response.body === '' ? null : JSON.parse(response.body)
      } catch {
        parsed = response.body
      }
      return { status: response.status, body: parsed, headers: response.headers }
    },
  }
}

const JSON_HEADERS = {
  host: '127.0.0.1:3080',
  'content-type': 'application/json',
  'x-dsh-session-trash': '1',
}

test('GET /state returns the state projection without running a sweep', async () => {
  const { call, calls } = createApi()
  const result = await call('state', { method: 'GET', headers: { host: '127.0.0.1:3080' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.version, 1)
  assert.equal(result.body.trashRootDisplay, '$DSH_HOME/.session-trash')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(calls, [])
})

test('POST /sweep runs the throttled maintenance sweep', async () => {
  const { call, calls } = createApi()
  const result = await call('sweep', { headers: JSON_HEADERS })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.ran, true)
  assert.equal(result.body.purged, 1)
  assert.deepEqual(calls, [['sweep']])

  const throttled = createApi({ sweep: async () => ({ ran: false, reason: 'throttled' }) })
  const second = await throttled.call('sweep', { headers: JSON_HEADERS })
  assert.equal(second.body.ran, false)
  assert.equal(second.body.reason, 'throttled')
})

test('POST /orphans/forget removes empty unindexed objects', async () => {
  const { call, calls } = createApi()
  const result = await call('orphans/forget', { headers: JSON_HEADERS })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true, removed: 2 })
  assert.deepEqual(calls, [['purgeEmptyOrphans']])
})

test('POST /trash requires the CSRF header and owner identity', async () => {
  const withoutCsrf = createApi()
  const missing = await withoutCsrf.call('trash', {
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(missing.status, 403)
  assert.equal(missing.body.error.code, 'FORBIDDEN')
  assert.deepEqual(withoutCsrf.calls, [])

  const nonOwner = createApi({ admission: { peer: { principal: { kind: 'guest' } } } })
  const forbidden = await nonOwner.call('trash', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(forbidden.status, 403)
  assert.deepEqual(nonOwner.calls, [])

  const unauthenticated = createApi({ rejection: 401 })
  const unauthorized = await unauthenticated.call('trash', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(unauthorized.status, 401)
})

test('POST /trash validates the body and returns the described entry', async () => {
  const { call, calls } = createApi()
  const result = await call('trash', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.entry.sessionId, 'session-a')
  assert.equal(result.body.entry.canRestore, true)
  assert.deepEqual(calls, [['trash', 'session-a']])

  const missing = await call('trash', { headers: JSON_HEADERS, body: JSON.stringify({}) })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'INVALID_REQUEST')

  const malformed = await call('trash', { headers: JSON_HEADERS, body: '{ nope' })
  assert.equal(malformed.status, 400)

  const wrongType = await call('trash', {
    headers: { ...JSON_HEADERS, 'content-type': 'text/plain' },
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(wrongType.status, 400)

  const oversized = await call('trash', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a', padding: 'x'.repeat(70 * 1024) }),
  })
  assert.equal(oversized.status, 400)
  assert.equal(oversized.body.error.code, 'INVALID_REQUEST')
})

test('POST /trash maps service failures to their HTTP status', async () => {
  const { call } = createApi({
    trash() {
      throw new TrashError('SESSION_LIVE', 'This session is open.')
    },
  })
  const result = await call('trash', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'SESSION_LIVE')
})

test('POST /restore accepts normal and orphan and rejects other modes', async () => {
  const { call, calls } = createApi()
  const result = await call('restore', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a', mode: 'normal' }),
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.session.sessionId, 'session-a')
  assert.equal(result.body.session.orphan, false)
  assert.deepEqual(calls, [['restore', 'session-a', 'normal']])

  const defaults = await call('restore', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-b' }),
  })
  assert.equal(defaults.status, 200)
  assert.deepEqual(calls.at(-1), ['restore', 'session-b', 'normal'])

  const orphan = await call('restore', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-c', mode: 'orphan' }),
  })
  assert.equal(orphan.status, 200)
  assert.equal(orphan.body.session.orphan, true)
  assert.deepEqual(calls.at(-1), ['restore', 'session-c', 'orphan'])

  const invalid = await call('restore', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-d', mode: 'other' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'INVALID_REQUEST')
  const numeric = await call('restore', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-d', mode: 7 }),
  })
  assert.equal(numeric.status, 400)
  assert.equal(numeric.body.error.code, 'INVALID_REQUEST')
})

test('POST /purge and /forget forward the session identity', async () => {
  const { call, calls } = createApi()
  const purged = await call('purge', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(purged.status, 200)
  assert.deepEqual(purged.body, { ok: true, sessionId: 'session-a' })
  assert.deepEqual(calls.at(-1), ['purge', 'session-a'])

  const forgotten = await call('forget', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-b' }),
  })
  assert.equal(forgotten.status, 200)
  assert.deepEqual(forgotten.body, { ok: true, sessionId: 'session-b' })
  assert.deepEqual(calls.at(-1), ['forget', 'session-b'])

  const missing = await call('purge', { headers: JSON_HEADERS, body: JSON.stringify({}) })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'INVALID_REQUEST')
})

test('POST /purge-all returns the bulk counts without reading a body', async () => {
  const { call, calls } = createApi()
  const result = await call('purge-all', { headers: JSON_HEADERS })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true, purged: 2, forgotten: 1, failed: 0 })
  assert.deepEqual(calls, [['purgeAll']])

  const empty = createApi({ purgeAll: () => ({}) })
  const zeros = await empty.call('purge-all', { headers: JSON_HEADERS })
  assert.equal(zeros.status, 200)
  assert.deepEqual(zeros.body, { ok: true, purged: 0, forgotten: 0, failed: 0 })
})

test('POST /purge and /purge-all report freed bytes when the service knows them', async () => {
  const { call } = createApi({
    purge: (sessionId) => ({ sessionId, freedBytes: 4096 }),
    purgeAll: () => ({ purged: 2, forgotten: 0, failed: 0, freedBytes: 8192 }),
  })

  const purged = await call('purge', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(purged.status, 200)
  assert.deepEqual(purged.body, { ok: true, sessionId: 'session-a', freedBytes: 4096 })

  const purgedAll = await call('purge-all', { headers: JSON_HEADERS })
  assert.equal(purgedAll.status, 200)
  assert.deepEqual(purgedAll.body, { ok: true, purged: 2, forgotten: 0, failed: 0, freedBytes: 8192 })
})

test('POST /purge-all requires the CSRF header and never calls the service', async () => {
  const { call, calls } = createApi()
  const result = await call('purge-all', { headers: { host: '127.0.0.1:3080' } })
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'FORBIDDEN')
  assert.deepEqual(calls, [])
})

test('POST /purge-all maps INDEX_CORRUPT to a server error', async () => {
  const { call } = createApi({
    purgeAll() {
      throw new TrashError('INDEX_CORRUPT', 'The trash index is unreadable.')
    },
  })
  const result = await call('purge-all', { headers: JSON_HEADERS })
  assert.equal(result.status, 500)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'INDEX_CORRUPT')
})

test('POST /reveal passes an abort signal and reports the opened state', async () => {
  const { call, calls } = createApi()
  const result = await call('reveal', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true, opened: true })
  assert.equal(calls.at(-1)[0], 'reveal')
  assert.equal(calls.at(-1)[1], 'session-a')
  assert.equal(calls.at(-1)[2], true)

  const failures = createApi({
    reveal() {
      throw new TrashError('REVEAL_UNAVAILABLE', 'no desktop')
    },
  })
  const denied = await failures.call('reveal', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(denied.status, 409)
  assert.equal(denied.body.error.code, 'REVEAL_UNAVAILABLE')
})

test('POST /cleanup runs a manual sweep and /rebuild reports its summary', async () => {
  const { call, calls } = createApi()
  const cleaned = await call('cleanup', { headers: JSON_HEADERS })
  assert.equal(cleaned.status, 200)
  assert.deepEqual(cleaned.body, { ok: true, purged: 2, failed: 0, settled: 0 })
  assert.equal(calls.at(-1)[0], 'cleanup')
  assert.equal(calls.at(-1)[1].manual, true)

  const withDiagnostics = createApi({ cleanupDiagnostics: { consecutiveFailures: 2, retryAt: 123 } })
  const diagnosed = await withDiagnostics.call('cleanup', { headers: JSON_HEADERS })
  assert.equal(diagnosed.status, 200)
  assert.deepEqual(diagnosed.body.cleanup, { consecutiveFailures: 2, retryAt: 123 })

  const rebuilt = await call('rebuild', { headers: JSON_HEADERS })
  assert.equal(rebuilt.status, 200)
  assert.deepEqual(rebuilt.body, { ok: true, entries: 2, unindexed: 1 })
  assert.deepEqual(calls.at(-1), ['rebuild'])

  const withoutCsrf = createApi()
  const refused = await withoutCsrf.call('cleanup', {
    headers: { host: '127.0.0.1:3080' },
  })
  assert.equal(refused.status, 403)
  assert.deepEqual(withoutCsrf.calls, [])
})

test('a route refuses the wrong HTTP method before authentication', async () => {
  const { call } = createApi({ rejection: 401 })
  const result = await call('trash', { method: 'GET', headers: { host: '127.0.0.1:3080' } })
  assert.equal(result.status, 405)
  assert.equal(result.headers.allow, 'POST')
})

test('POST /preflight summarizes an eligible cascade without leaking member paths', async () => {
  const { call } = createApi({
    eligibility: async () => ({
      eligible: true,
      members: [
        { sessionId: 'session-a', location: { path: '/tmp/session-a/session.v4.jsonl' } },
        { sessionId: 'child-1', location: { path: '/tmp/child-1/session.v4.jsonl' } },
        { sessionId: 'child-2', location: { path: '/tmp/child-2/session.v4.jsonl' } },
      ],
    }),
  })
  const result = await call('preflight', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { eligible: true, descendants: 2 })
})

test('POST /preflight forwards a refusal verdict unchanged', async () => {
  const refusal = { eligible: false, code: 'SESSION_LIVE', message: 'This session is open.' }
  const { call } = createApi({ eligibility: async () => refusal })
  const result = await call('preflight', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId: 'session-a' }),
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, refusal)
})
