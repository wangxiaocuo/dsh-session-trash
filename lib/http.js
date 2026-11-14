import { TrashError, statusOf, toWireError } from './errors.js'

/** Prefix shared by every route this plugin owns. */
export const API_PREFIX = '/plugins/dsh-session-trash/api'

/** Request header that proves a same-origin scripted call. */
export const CSRF_HEADER = 'x-dsh-session-trash'

/** Largest accepted JSON request body. */
export const MAX_BODY_BYTES = 64 * 1024

/** Budget for one native reveal request. */
const REVEAL_TIMEOUT_MS = 10_000

/**
 * @returns {AbortSignal} a signal that aborts the reveal after its budget.
 */
function revealSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(REVEAL_TIMEOUT_MS)
  }
  const controller = new AbortController()
  const handle = setTimeout(() => controller.abort(), REVEAL_TIMEOUT_MS)
  handle.unref?.()
  return controller.signal
}

/**
 * @param {import('node:http').IncomingMessage} req incoming request.
 * @returns {Headers} a Fetch-shaped header bag for the connection service.
 */
function headerBag(req) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }
  return headers
}

/**
 * @param {import('node:http').ServerResponse} res response to complete.
 * @param {number} status HTTP status.
 * @param {any} body JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/**
 * @param {import('node:http').ServerResponse} res response to complete.
 * @param {any} error thrown failure.
 * @returns {void}
 */
function sendError(res, error) {
  sendJson(res, statusOf(error), { ok: false, error: toWireError(error) })
}

/**
 * @param {import('node:http').IncomingMessage} req request whose body to read.
 * @param {number} limit maximum accepted bytes.
 * @returns {Promise<Buffer>} the complete body.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > limit) {
        failed = true
        chunks.length = 0
        reject(new TrashError('INVALID_REQUEST', 'Request body is too large.'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (!failed) reject(error)
    })
    req.on('aborted', () => {
      if (!failed) reject(new TrashError('INVALID_REQUEST', 'Request was aborted.'))
    })
  })
}

/**
 * @param {Buffer} buffer raw request body.
 * @returns {Record<string, unknown>} the decoded JSON object.
 */
function parseJsonObject(buffer) {
  if (buffer.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new TrashError('INVALID_REQUEST', 'Request body is not valid JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TrashError('INVALID_REQUEST', 'Request body must be a JSON object.')
  }
  return parsed
}

/**
 * @param {import('node:http').IncomingMessage} req request whose JSON body to read.
 * @returns {Promise<Record<string, unknown>>} the validated JSON object.
 */
async function readJsonRequest(req) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new TrashError('INVALID_REQUEST', 'Content-Type must be application/json.')
  }
  return parseJsonObject(await readBody(req, MAX_BODY_BYTES))
}

/**
 * @param {Record<string, unknown>} body decoded request body.
 * @returns {string} a validated session identity.
 */
function requireSessionId(body) {
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 256) {
    throw new TrashError('INVALID_REQUEST', 'sessionId must be a non-empty string.')
  }
  return sessionId
}

/**
 * Register the plugin HTTP surface: state, menu preflight, trash/restore,
 * permanent deletion (single and bulk), index maintenance, reveal, and
 * cleanup.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   eligibility: { evaluate: Function, invalidate: Function },
 *   stateService: { snapshot: () => Promise<any>, describe: (entry: any) => Promise<any> },
 *   trashService: {
 *     trash: (sessionId: string) => Promise<any>,
 *     restore: (sessionId: string, mode?: string) => Promise<any>,
 *     purge: (sessionId: string) => Promise<any>,
 *     purgeAll: () => Promise<any>,
 *     forget: (sessionId: string) => Promise<any>,
 *     reveal: (sessionId: string, signal?: AbortSignal) => Promise<any>,
 *     rebuild: () => Promise<any>,
 *     purgeEmptyOrphans: () => Promise<{ removed: number }>,
 *   },
 *   cleanupService?: {
 *     runNow: (options?: any) => Promise<any>,
 *     sweepOnPageOpen: () => Promise<{ ran: boolean, reason?: string, result?: any }>,
 *     diagnostics?: () => any,
 *   },
 *   ready: Promise<unknown>,
 *   config: any,
 *   logger: any,
 * }} deps host services.
 * @returns {void}
 */
export function registerApi({ ctx, eligibility, stateService, trashService, cleanupService, ready, config, logger }) {
  /**
   * Apply the shared trust, ownership, and CSRF checks.
   *
   * @param {import('node:http').IncomingMessage} req incoming request.
   * @param {import('node:http').ServerResponse} res response to complete on refusal.
   * @param {{ csrf: boolean }} options whether the scripted-call header is required.
   * @returns {boolean} whether the request may proceed.
   */
  function authorize(req, res, { csrf }) {
    const headers = headerBag(req)
    let rejection
    try {
      rejection = ctx.connection.requestRejection({ headers })
    } catch (error) {
      logger.warn(`connection rejection check failed: ${error instanceof Error ? error.message : String(error)}`)
      sendError(res, new TrashError('FORBIDDEN', 'The request could not be authenticated.'))
      return false
    }
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, error: { code: 'FORBIDDEN', message: 'The request is not trusted.' } })
      return false
    }
    let admission
    try {
      admission = ctx.connection.admit({ headers })
    } catch (error) {
      logger.warn(`connection admission failed: ${error instanceof Error ? error.message : String(error)}`)
      sendError(res, new TrashError('FORBIDDEN', 'The request could not be admitted.'))
      return false
    }
    if (admission.rejection !== undefined) {
      sendJson(res, admission.rejection, {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'The request is not authenticated.' },
      })
      return false
    }
    if (admission.peer?.principal?.kind !== 'owner') {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Only the owner may use the trash.' } })
      return false
    }
    if (csrf && headers.get(CSRF_HEADER) !== '1') {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: `Missing the ${CSRF_HEADER} header.` } })
      return false
    }
    return true
  }

  /**
   * @param {string} pathname route path below the API prefix.
   * @param {string} method allowed HTTP method.
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler route body.
   * @returns {void}
   */
  function route(pathname, method, handler) {
    const path = `${API_PREFIX}/${pathname}`
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          async handler(req, res) {
            const startedAt = Date.now()
            try {
              if (req.method !== method) {
                res.setHeader('Allow', method)
                sendJson(res, 405, {
                  ok: false,
                  error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${method} for this endpoint.` },
                })
                return
              }
              if (!authorize(req, res, { csrf: method !== 'GET' })) return
              await ready
              await handler(req, res)
            } catch (error) {
              if (error instanceof TrashError) {
                logger.debug(`${method} ${path} -> ${error.code} (${Date.now() - startedAt}ms)`)
              } else {
                logger.error(`${method} ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
              }
              sendError(res, error)
            }
          },
        }),
      `session-trash: route ${method} ${path}`,
    )
  }

  route('state', 'GET', async (_req, res) => {
    sendJson(res, 200, await stateService.snapshot())
  })

  route('sweep', 'POST', async (_req, res) => {
    const outcome = await cleanupService.sweepOnPageOpen()
    const result = outcome.result !== null && outcome.result !== undefined ? outcome.result : null
    sendJson(res, 200, {
      ok: true,
      ran: outcome.ran === true,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(result === null
        ? {}
        : {
            purged: result.purged ?? 0,
            failed: result.failed ?? 0,
            settled: result.changed ?? 0,
          }),
    })
  })

  route('orphans/forget', 'POST', async (_req, res) => {
    const result = await trashService.purgeEmptyOrphans()
    sendJson(res, 200, { ok: true, removed: result.removed ?? 0 })
  })

  route('preflight', 'POST', async (req, res) => {
    const body = await readJsonRequest(req)
    const sessionId = requireSessionId(body)
    const verdict = await eligibility.evaluate(sessionId)
    if (config.debug) {
      logger.debug(`preflight ${sessionId} -> ${verdict.eligible ? 'eligible' : verdict.code}`)
    }
    if (verdict.eligible === true) {
      const members = Array.isArray(verdict.members) ? verdict.members : []
      sendJson(res, 200, { eligible: true, descendants: Math.max(0, members.length - 1) })
      return
    }
    sendJson(res, 200, verdict)
  })

  route('trash', 'POST', async (req, res) => {
    const body = await readJsonRequest(req)
    const sessionId = requireSessionId(body)
    const entry = await trashService.trash(sessionId)
    sendJson(res, 200, { ok: true, entry: await stateService.describe(entry) })
  })

  route('restore', 'POST', async (req, res) => {
    const body = await readJsonRequest(req)
    const sessionId = requireSessionId(body)
    const rawMode = body.mode
    if (rawMode !== undefined && typeof rawMode !== 'string') {
      throw new TrashError('INVALID_REQUEST', 'mode must be "normal" or "orphan".')
    }
    const mode = typeof rawMode === 'string' ? rawMode : undefined
    if (mode !== undefined && mode !== 'normal' && mode !== 'orphan') {
      throw new TrashError('INVALID_REQUEST', 'mode must be "normal" or "orphan".')
    }
    const session = await trashService.restore(sessionId, mode ?? 'normal')
    sendJson(res, 200, { ok: true, session })
  })

  route('purge', 'POST', async (req, res) => {
    const body = await readJsonRequest(req)
    const sessionId = requireSessionId(body)
    const result = await trashService.purge(sessionId)
    sendJson(res, 200, {
      ok: true,
      sessionId: result.sessionId,
      ...(typeof result.freedBytes === 'number' ? { freedBytes: result.freedBytes } : {}),
    })
  })

  route('purge-all', 'POST', async (_req, res) => {
    const result = await trashService.purgeAll()
    sendJson(res, 200, {
      ok: true,
      purged: result.purged ?? 0,
      forgotten: result.forgotten ?? 0,
      failed: result.failed ?? 0,
      ...(typeof result.freedBytes === 'number' ? { freedBytes: result.freedBytes } : {}),
    })
  })

  route('forget', 'POST', async (req, res) => {
    const body = await readJsonRequest(req)
    const sessionId = requireSessionId(body)
    const result = await trashService.forget(sessionId)
    sendJson(res, 200, { ok: true, sessionId: result.sessionId })
  })

  route('reveal', 'POST', async (req, res) => {
    const body = await readJsonRequest(req)
    const sessionId = requireSessionId(body)
    await trashService.reveal(sessionId, revealSignal())
    sendJson(res, 200, { ok: true, opened: true })
  })

  route('cleanup', 'POST', async (_req, res) => {
    const result = await cleanupService.runNow({ manual: true, reason: 'manual' })
    const diagnostics =
      typeof cleanupService.diagnostics === 'function' ? cleanupService.diagnostics() : undefined
    sendJson(res, 200, {
      ok: true,
      purged: result.purged ?? 0,
      failed: result.failed ?? 0,
      settled: result.changed ?? 0,
      ...(diagnostics === undefined ? {} : { cleanup: diagnostics }),
    })
  })

  route('rebuild', 'POST', async (_req, res) => {
    const result = await trashService.rebuild()
    sendJson(res, 200, { ok: true, entries: result.entries, unindexed: result.unindexed })
  })
}
