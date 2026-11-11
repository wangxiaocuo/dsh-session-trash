/**
 * Full real-DSH regression for `dsh-session-trash`.
 *
 * The script creates a throwaway DSH home, installs this package as a bundle in
 * a generated `web` profile, boots the actual `dsh web` host from the desktop
 * runtime, authenticates with the launch token it prints, and then exercises
 * every implemented Host feature through the real HTTP API:
 *
 *   - HTTP auth, CSRF, method, content-type, and body-limit contracts
 *   - preflight refusal matrix (missing, subagent, descendants)
 *   - trash + Toast-style undo + normal restore with Workspace order
 *   - reveal guards (unknown entry, missing workspace)
 *   - forget (missing-entry flow) and permanent purge
 *   - bulk delete-all (every trashed log purged, missing index records forgotten)
 *   - cleanup failure diagnostics + manual recovery (automatic retry is unit-tested)
 *   - 30-day expiry purge
 *   - corrupt-index protection mode and rebuild from `meta.json`
 *   - orphan restore and Workspace detach
 *
 * Run it with plain Node; the Host is spawned by the script:
 *
 *   npm run test:e2e
 *
 * By default the suite boots the installed desktop app (discovered at the
 * platform's usual install location, or from `DSH_ELECTRON`). Set
 * `DSH_E2E_DSH_BIN` to a npm-installed `@deepseek-ai/dsh` bin.js to boot a
 * plain-Node Host instead; that mode works on any platform and is what CI
 * uses. When no Host is found the suite prints a skip message and exits 0
 * instead of failing. Set `DSH_E2E_KEEP=1` to keep the throwaway home and
 * server log for inspection.
 *
 * The scenario that simulates a failed deletion through POSIX permission bits
 * is skipped on Windows, where those bits are not enforced.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { projectName } from './helpers.js'

const DAY = 86_400_000
const REPO = path.resolve('.')
const keep = process.env.DSH_E2E_KEEP === '1'

/**
 * @param {string} candidate path to probe.
 * @returns {Promise<boolean>} whether the path exists.
 */
async function exists(candidate) {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Find the installed DeepSeek Harness desktop executable. `DSH_ELECTRON`
 * always wins; otherwise the platform's usual install locations are probed.
 * The suite skips (with a clear message) when nothing is found.
 *
 * @returns {Promise<string | undefined>} the executable path.
 */
async function resolveElectron() {
  const override = process.env.DSH_ELECTRON
  const candidates =
    typeof override === 'string' && override !== ''
      ? [override]
      : process.platform === 'darwin'
        ? [
            '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
            path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness'),
          ]
        : process.platform === 'win32'
          ? [
              path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
              path.join(process.env.LOCALAPPDATA ?? '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
              path.join(process.env.ProgramFiles ?? '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
            ].filter((candidate) => path.isAbsolute(candidate))
          : [
              path.join(os.homedir(), '.local', 'bin', 'deepseek-harness'),
              '/opt/DeepSeek Harness/deepseek-harness',
            ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Locate the bundled `dsh` CLI inside the desktop app resources.
 *
 * @param {string} electron desktop executable path.
 * @returns {Promise<string | undefined>} the CLI entry path.
 */
async function resolveDshBin(electron) {
  const executableDir = path.dirname(electron)
  const resourceRoots =
    process.platform === 'darwin'
      ? [path.join(executableDir, '..', 'Resources')]
      : [path.join(executableDir, 'resources'), path.join(executableDir, '..', 'resources')]
  const relative = path.join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  // app.asar is a regular file, so it can be probed; paths inside it cannot be
  // stat-ed from plain Node, which is why the bundle itself is the existence
  // check and the inner path is only handed to the spawned Electron process.
  for (const resources of resourceRoots) {
    for (const bundle of ['app.asar', 'app']) {
      const base = path.join(resources, bundle)
      if (await exists(base)) return path.join(base, relative)
    }
  }
  return undefined
}

const CLI_BIN = process.env.DSH_E2E_DSH_BIN

/**
 * @returns {Promise<{ mode: 'cli' | 'desktop', command: string, bin: string, env: Record<string, string> }>} how to boot the Host.
 */
async function resolveRuntime() {
  if (typeof CLI_BIN === 'string' && CLI_BIN !== '') {
    const bin = path.resolve(CLI_BIN)
    if (!(await exists(bin))) {
      // An explicit runtime override that is broken is a configuration error,
      // not a "skip": CI silently going green without running anything would
      // be worse than failing.
      console.error(`e2e failed: DSH_E2E_DSH_BIN does not exist: ${bin}`)
      process.exit(1)
    }
    return { mode: 'cli', command: process.execPath, bin, env: {} }
  }
  const electron = await resolveElectron()
  if (electron === undefined) {
    if (typeof process.env.DSH_ELECTRON === 'string' && process.env.DSH_ELECTRON !== '') {
      console.error(`e2e failed: DSH_ELECTRON does not exist: ${process.env.DSH_ELECTRON}`)
      process.exit(1)
    }
    console.log('e2e skipped: no DeepSeek Harness desktop found. Set DSH_ELECTRON to its executable path to run this suite.')
    process.exit(0)
  }
  const dshBin = await resolveDshBin(electron)
  if (dshBin === undefined) {
    if (typeof process.env.DSH_ELECTRON === 'string' && process.env.DSH_ELECTRON !== '') {
      console.error(`e2e failed: cannot locate the bundled dsh CLI inside ${path.dirname(electron)}.`)
      process.exit(1)
    }
    console.log(`e2e skipped: cannot locate the bundled dsh CLI inside ${path.dirname(electron)}.`)
    process.exit(0)
  }
  return { mode: 'desktop', command: electron, bin: dshBin, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

const runtime = await resolveRuntime()

/**
 * @param {string} prefix temporary-directory prefix.
 * @returns {Promise<string>} a fresh canonical directory.
 */
async function createTempHome(prefix) {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return fs.realpath(raw)
}

/**
 * Write the generated profile that loads the plugin next to the shipped web
 * bundles.
 *
 * @param {string} home throwaway DSH home.
 * @returns {Promise<void>} resolution once the profile is ready.
 */
async function writeProfile(home) {
  const profile = path.join(home, 'profiles', 'web')
  const linked = path.join(profile, 'node_modules', '@wangxiaocuo')
  await fs.mkdir(linked, { recursive: true })
  // A junction needs no extra privilege on Windows, unlike a directory symlink.
  await fs.symlink(REPO, path.join(linked, 'dsh-session-trash'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(
    path.join(profile, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { '@wangxiaocuo/dsh-session-trash': `link:${REPO}` },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-web-app',
              '@wangxiaocuo/dsh-session-trash',
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n')
  await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  await fs.writeFile(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
}

/**
 * Materialize one session directory with the compressed JSONL layout the
 * default backend expects: the header line in the first zstd frame, then one
 * concatenated frame per event, matching the real v4 writer.
 *
 * Passing `title` appends a real `session/title` event so the suite exercises
 * the backend's title fold (the production shape the trash service must read)
 * instead of only a bare header. This is the regression gap that let a
 * `readTitle()` snapshot object be silently treated as an untitled session.
 *
 * @param {string} home throwaway DSH home.
 * @param {string} sessionId session identity.
 * @param {string} cwd canonical project directory.
 * @param {{ origin?: string, parentSession?: string, title?: string }} [extra] optional header fields; `title` becomes a log event, not a header field.
 * @returns {Promise<string>} the session-owned directory.
 */
async function writeSession(home, sessionId, cwd, extra = {}) {
  const { title, ...headerExtra } = extra
  const directory = path.join(home, 'sessions', projectName(cwd), sessionId)
  await fs.mkdir(directory, { recursive: true })
  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: Date.now() - 60_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    ...headerExtra,
  }
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  if (typeof title === 'string' && title !== '') {
    const event = {
      type: 'session/title',
      seq: 0,
      time: Date.now() - 30_000,
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    }
    frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  }
  await fs.writeFile(path.join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return directory
}

/**
 * Write a durable workspace registry with an explicit session order per row.
 *
 * @param {string} home throwaway DSH home.
 * @param {{ id: string, path: string, sessionIds: string[] }[]} workspaces workspace rows.
 * @returns {Promise<void>} resolution once the registry is durable.
 */
async function writeWorkspaces(home, workspaces) {
  const now = new Date().toISOString()
  const tables = {}
  for (const workspace of workspaces) {
    tables[workspace.id] = {
      path: workspace.path,
      title: path.basename(workspace.path),
      sessionIds: workspace.sessionIds,
      createdAt: now,
      updatedAt: now,
    }
  }
  await fs.mkdir(path.join(home, 'storages'), { recursive: true })
  await fs.writeFile(
    path.join(home, 'storages', 'workspace.json'),
    `${JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: workspaces.map((workspace) => workspace.id),
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
        tables: { workspaces: tables },
      },
      null,
      2,
    )}\n`,
  )
}

/**
 * @param {string} home throwaway DSH home.
 * @returns {Promise<object>} the durable workspace registry.
 */
async function readWorkspaces(home) {
  return JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
}

/**
 * @param {string} home throwaway DSH home.
 * @returns {Promise<object>} the durable trash index.
 */
async function readIndex(home) {
  return JSON.parse(await fs.readFile(path.join(home, '.session-trash', 'trash-index.json'), 'utf8'))
}

/**
 * @param {string} home throwaway DSH home.
 * @param {string} sessionId indexed session.
 * @returns {Promise<object>} the durable index entry.
 */
async function findEntry(home, sessionId) {
  const entry = (await readIndex(home)).entries.find((candidate) => candidate.sessionId === sessionId)
  assert.ok(entry !== undefined, `index entry for ${sessionId}`)
  return entry
}

/**
 * Rewrite the durable index after applying one mutation.
 *
 * @param {string} home throwaway DSH home.
 * @param {(index: object) => void} mutate index mutation.
 * @returns {Promise<object>} the committed index.
 */
async function updateIndex(home, mutate) {
  const index = await readIndex(home)
  mutate(index)
  index.updatedAt = Date.now()
  await fs.writeFile(
    path.join(home, '.session-trash', 'trash-index.json'),
    `${JSON.stringify(index, null, 2)}\n`,
  )
  return index
}

/**
 * Boot `dsh web` in a throwaway home and wait for its authenticated URL.
 *
 * @param {string} home throwaway DSH home.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, url: string, log: string }>} the server.
 */
async function startServer(home) {
  const child = spawn(runtime.command, [runtime.bin, 'web', '--no-open', '--port', '0'], {
    cwd: home,
    env: { ...process.env, ...runtime.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let spawnError = null
  child.on('error', (error) => {
    spawnError = error
    log += `spawn error: ${error instanceof Error ? error.message : String(error)}\n`
  })
  child.stdout.on('data', (chunk) => {
    log += chunk
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
  })
  let url
  try {
    url = await new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        if (spawnError !== null) {
          clearInterval(timer)
          reject(new Error(`cannot start dsh web: ${spawnError.message}`))
          return
        }
        const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
        if (match !== null) {
          clearInterval(timer)
          resolve(match[1])
          return
        }
        if (child.exitCode !== null) {
          clearInterval(timer)
          reject(new Error(`dsh web exited with code ${child.exitCode}:\n${log}`))
          return
        }
        if (Date.now() - startedAt > 60_000) {
          clearInterval(timer)
          reject(new Error(`dsh web did not print a URL within 60s:\n${log}`))
        }
      }, 100)
    })
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
  return { child, url, log }
}

/**
 * @param {import('node:child_process').ChildProcess} child server process.
 * @returns {Promise<void>} resolution once the child is gone.
 */
async function stopServer(child) {
  if (child.pid === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve(undefined))
  })
  const timeout = new Promise((resolve) => {
    const handle = setTimeout(() => resolve('timeout'), 5000)
    handle.unref?.()
  })
  await Promise.race([exited, timeout])
  if (child.exitCode === null) child.kill('SIGKILL')
}

/**
 * Authenticate with the launch token and build the API caller.
 *
 * @param {string} url printed launch URL.
 * @returns {Promise<{ base: string, cookie: string, call: (name: string, options?: object) => Promise<{ status: number, body: any, headers: Headers }> }>} the caller.
 */
async function createApi(url) {
  const parsed = new URL(url)
  const base = parsed.origin
  const authenticated = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  assert.equal(Math.trunc(authenticated.status / 100), 3, 'the launch token redirects to the clean URL')
  const setCookies =
    typeof authenticated.headers.getSetCookie === 'function'
      ? authenticated.headers.getSetCookie()
      : [authenticated.headers.get('set-cookie')].filter(Boolean)
  assert.ok(setCookies.length > 0, 'the launch token mints a browser cookie')
  const cookie = setCookies[0].split(';')[0]

  /**
   * @param {string} name endpoint below the API prefix.
   * @param {{
   *   method?: string,
   *   body?: object,
   *   rawBody?: string,
   *   headers?: Record<string, string>,
   *   csrf?: boolean,
   *   authenticated?: boolean,
   * }} [options] request facts.
   * @returns {Promise<{ status: number, body: any, headers: Headers }>} decoded answer.
   */
  async function call(name, options = {}) {
    const method = options.method ?? 'GET'
    const headers = {
      ...(options.authenticated === false ? {} : { cookie }),
      ...(method === 'POST'
        ? {
            ...(options.csrf === false ? {} : { 'x-dsh-session-trash': '1' }),
            'content-type': 'application/json',
          }
        : {}),
      ...(options.headers ?? {}),
    }
    const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
    const response = await fetch(`${base}/plugins/dsh-session-trash/api/${name}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed, headers: response.headers }
  }

  return { base, cookie, call }
}

/**
 * @param {string} home throwaway DSH home.
 * @param {string} sessionId trashed session to age.
 * @param {number} days age in days.
 * @returns {Promise<object>} the aged index entry.
 */
async function ageEntry(home, sessionId, days) {
  let aged
  await updateIndex(home, (index) => {
    aged = index.entries.find((entry) => entry.sessionId === sessionId)
    assert.ok(aged !== undefined, `index entry for ${sessionId}`)
    aged.trashedAt = Date.now() - days * DAY
  })
  return aged
}

/**
 * Poll `/state` until the activation sweep has completed.
 *
 * @param {object} api API caller.
 * @returns {Promise<void>} resolution once the activation sweep ran.
 */
async function waitForActivationSweep(api) {
  const startedAt = Date.now()
  for (;;) {
    const state = await api.call('state')
    const cleanup = state.body?.stats?.cleanup
    if (cleanup?.lastRun?.reason === 'activation') return
    if (Date.now() - startedAt > 20_000) {
      throw new Error(`activation sweep did not run: ${JSON.stringify(cleanup)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * @param {string} home throwaway DSH home.
 * @param {string} name scenario label.
 * @returns {void}
 */
let passedGroups = 0

/**
 * @param {string} name scenario label.
 * @returns {void}
 */
function pass(name) {
  passedGroups += 1
  console.log(`e2e ✓ ${name}`)
}

const home = await createTempHome('dsh-trash-regression-')
const alphaProject = path.join(home, 'project-alpha')
const betaProject = path.join(home, 'project-beta')
const orderProject = path.join(home, 'project-order')
const subagentProject = path.join(home, 'project-subagent')
const parentProject = path.join(home, 'project-parent')
const cascadeProject = path.join(home, 'project-cascade')
const forgetProject = path.join(home, 'project-forget')
const rebuildProject = path.join(home, 'project-rebuild')
const cleanupProject = path.join(home, 'project-cleanup')
const purgeProject = path.join(home, 'project-purge')
const purgeAllProject = path.join(home, 'project-purge-all')
const alphaId = 'session-e2e-alpha'
const betaId = 'session-e2e-beta'
const orderIds = ['session-e2e-order-a', 'session-e2e-order-b', 'session-e2e-order-c']
const subagentId = 'session-e2e-subagent'
const parentId = 'session-e2e-parent'
const childId = 'session-e2e-child'
const cascadeParentId = 'session-e2e-cascade-parent'
const cascadeChildIds = ['session-e2e-cascade-child-a', 'session-e2e-cascade-child-b']
const forgetId = 'session-e2e-forget'
const rebuildId = 'session-e2e-rebuild'
const cleanupId = 'session-e2e-cleanup'
const purgeId = 'session-e2e-purge'
const bulkIds = ['session-e2e-bulk-a', 'session-e2e-bulk-b', 'session-e2e-bulk-missing']
// Real conversation titles live in `session/title` log events, never in the
// header. They deliberately differ from the cwd basename and the session id so
// a fallback regression cannot silently satisfy the assertions.
const alphaTitle = 'Investigate the flaky login retry path'
const cascadeParentTitle = 'Repair the cascaded workspace restore'
const cascadeChildTitles = ['Audit the restore ordering', 'Verify the rolled-back trash entry']
let server
let failure = null

try {
  for (const directory of [
    alphaProject,
    betaProject,
    orderProject,
    subagentProject,
    parentProject,
    cascadeProject,
    forgetProject,
    rebuildProject,
    cleanupProject,
    purgeProject,
    purgeAllProject,
  ]) {
    await fs.mkdir(directory, { recursive: true })
  }
  await writeProfile(home)
  const alphaDir = await writeSession(home, alphaId, alphaProject, { title: alphaTitle })
  const betaDir = await writeSession(home, betaId, betaProject)
  for (const id of orderIds) await writeSession(home, id, orderProject)
  await writeSession(home, subagentId, subagentProject, { origin: 'subagent' })
  await writeSession(home, parentId, parentProject)
  await writeSession(home, childId, parentProject, { parentSession: parentId })
  await writeSession(home, cascadeParentId, cascadeProject, { title: cascadeParentTitle })
  for (const [index, child] of cascadeChildIds.entries()) {
    await writeSession(home, child, cascadeProject, {
      origin: 'subagent',
      parentSession: cascadeParentId,
      title: cascadeChildTitles[index],
    })
  }
  await writeSession(home, forgetId, forgetProject)
  await writeSession(home, rebuildId, rebuildProject)
  await writeSession(home, cleanupId, cleanupProject)
  await writeSession(home, purgeId, purgeProject)
  for (const id of bulkIds) await writeSession(home, id, purgeAllProject)
  await writeWorkspaces(home, [
    { id: 'ws-alpha', path: alphaProject, sessionIds: [alphaId] },
    { id: 'ws-beta', path: betaProject, sessionIds: [betaId] },
    { id: 'ws-order', path: orderProject, sessionIds: orderIds },
    { id: 'ws-rebuild', path: rebuildProject, sessionIds: [rebuildId] },
  ])

  server = await startServer(home)
  const api = await createApi(server.url)
  console.log(`e2e: dsh web ready at ${api.base}`)

  const initial = await api.call('state')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.version, 1)
  assert.deepEqual(initial.body.config, { retentionDays: 30, sweepIntervalHours: 6, enableAutoCleanup: true })
  assert.ok(initial.body.trashRootDisplay.endsWith('/.session-trash'))
  assert.equal(initial.body.entries.length, 0)
  assert.equal(typeof initial.body.stats.cleanup, 'object')
  const bootResponse = await fetch(`${api.base}/`, {
    headers: { cookie: api.cookie },
    signal: AbortSignal.timeout(15_000),
  })
  const bootHtml = await bootResponse.text()
  assert.equal(bootResponse.status, 200)
  assert.ok(bootHtml.includes('dsh-session-trash/client.js'), 'the web boot config registers the Client half')
  const moduleMatch = bootHtml.match(/"url":"(plugins\/\?\?[^"]*dsh-session-trash\/client\.js[^"]*)"/)
  assert.ok(moduleMatch !== null, 'the boot config carries the plugin module URL')
  const moduleResponse = await fetch(new URL(moduleMatch[1].replaceAll('&amp;', '&'), `${api.base}/`), {
    headers: { cookie: api.cookie },
    signal: AbortSignal.timeout(15_000),
  })
  assert.equal(moduleResponse.status, 200)
  assert.ok((await moduleResponse.text()).includes('dsh-session-trash'), 'the Client module is served')
  pass('state projection + Client boot registration and module serving')

  // --- HTTP contract -------------------------------------------------------
  const unauthenticated = await api.call('state', { authenticated: false })
  assert.equal(unauthenticated.status, 401)
  const missingCsrf = await api.call('trash', { method: 'POST', body: { sessionId: alphaId }, csrf: false })
  assert.equal(missingCsrf.status, 403)
  assert.equal(missingCsrf.body.error.code, 'FORBIDDEN')
  const wrongMethod = await api.call('trash', { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')
  const wrongContentType = await api.call('trash', {
    method: 'POST',
    body: { sessionId: alphaId },
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongContentType.status, 400)
  assert.equal(wrongContentType.body.error.code, 'INVALID_REQUEST')
  const malformed = await api.call('trash', { method: 'POST', rawBody: '{ nope' })
  assert.equal(malformed.status, 400)
  const oversized = await api.call('trash', {
    method: 'POST',
    body: { sessionId: alphaId, padding: 'x'.repeat(70 * 1024) },
  })
  assert.equal(oversized.status, 400)
  assert.equal(oversized.body.error.code, 'INVALID_REQUEST')
  const invalidMode = await api.call('restore', {
    method: 'POST',
    body: { sessionId: alphaId, mode: 'sideways' },
  })
  assert.equal(invalidMode.status, 400)
  pass('HTTP auth, CSRF, method, content-type, body limit')

  // --- Preflight refusal matrix -------------------------------------------
  const missing = await api.call('preflight', { method: 'POST', body: { sessionId: 'session-does-not-exist' } })
  assert.equal(missing.status, 200)
  assert.equal(missing.body.eligible, false)
  assert.equal(missing.body.code, 'SESSION_NOT_FOUND')
  const subagent = await api.call('preflight', { method: 'POST', body: { sessionId: subagentId } })
  assert.equal(subagent.body.eligible, false)
  assert.equal(subagent.body.code, 'SESSION_SUBAGENT')
  const parent = await api.call('preflight', { method: 'POST', body: { sessionId: parentId } })
  assert.equal(parent.body.eligible, false)
  assert.ok(
    ['SESSION_HAS_DESCENDANTS', 'SESSION_LINEAGE_UNRESOLVED'].includes(parent.body.code),
    `descendant refusal: ${JSON.stringify(parent.body)}`,
  )
  const eligible = await api.call('preflight', { method: 'POST', body: { sessionId: alphaId } })
  assert.equal(eligible.body.eligible, true)
  const trashSubagent = await api.call('trash', { method: 'POST', body: { sessionId: subagentId } })
  assert.equal(trashSubagent.status, 409)
  assert.equal(trashSubagent.body.error.code, 'SESSION_SUBAGENT')
  const trashParent = await api.call('trash', { method: 'POST', body: { sessionId: parentId } })
  assert.equal(trashParent.status, 409)
  assert.ok(['SESSION_HAS_DESCENDANTS', 'SESSION_LINEAGE_UNRESOLVED'].includes(trashParent.body.error.code))
  assert.equal((await fs.stat(path.join(home, 'sessions', projectName(subagentProject), subagentId))).isDirectory(), true)
  assert.equal((await fs.stat(path.join(home, 'sessions', projectName(parentProject), parentId))).isDirectory(), true)
  pass('preflight/trash refusal matrix (missing, subagent, descendants)')

  // --- Cascade trash ------------------------------------------------------
  const cascadePreflight = await api.call('preflight', {
    method: 'POST',
    body: { sessionId: cascadeParentId },
  })
  assert.equal(cascadePreflight.status, 200)
  assert.equal(cascadePreflight.body.eligible, true)
  assert.equal(cascadePreflight.body.descendants, 2)
  const cascadeTrashed = await api.call('trash', { method: 'POST', body: { sessionId: cascadeParentId } })
  assert.equal(cascadeTrashed.status, 200)
  assert.equal(cascadeTrashed.body.entry.state, 'trashed')
  assert.equal(cascadeTrashed.body.entry.subagentCount, 2)
  assert.equal(cascadeTrashed.body.entry.members.length, 3)
  assert.equal(
    cascadeTrashed.body.entry.title,
    cascadeParentTitle,
    'the trashed entry stores the conversation title folded from session/title events',
  )
  assert.notEqual(
    cascadeTrashed.body.entry.title,
    path.basename(cascadeProject),
    'the title must not fall back to the cwd basename',
  )
  assert.notEqual(cascadeTrashed.body.entry.title, cascadeParentId, 'the title must not fall back to the session id')
  for (const id of [cascadeParentId, ...cascadeChildIds]) {
    await assert.rejects(fs.stat(path.join(home, 'sessions', projectName(cascadeProject), id)))
  }
  const cascadeEntry = await findEntry(home, cascadeParentId)
  assert.equal(cascadeEntry.title, cascadeParentTitle)
  assert.equal(cascadeEntry.members[0].title, cascadeParentTitle)
  assert.equal((await fs.stat(path.join(home, '.session-trash', 'objects', cascadeEntry.trashId, 'session'))).isDirectory(), true)
  for (const child of cascadeChildIds) {
    assert.equal(
      (await fs.stat(path.join(home, '.session-trash', 'objects', cascadeEntry.trashId, 'children', child))).isDirectory(),
      true,
    )
  }
  const cascadeState = await api.call('state')
  const cascadeRow = cascadeState.body.entries.find((entry) => entry.sessionId === cascadeParentId)
  assert.equal(cascadeRow.subagentCount, 2)
  assert.equal(cascadeRow.title, cascadeParentTitle, 'the /state row title is the real conversation title')
  assert.deepEqual(
    cascadeRow.members.map((member) => member.sessionId),
    [cascadeParentId, ...cascadeChildIds],
  )
  const cascadeMemberTitles = new Map(cascadeRow.members.map((member) => [member.sessionId, member.title]))
  assert.equal(
    cascadeMemberTitles.get(cascadeParentId),
    cascadeParentTitle,
    'the /state member list exposes the parent conversation title',
  )
  for (const [index, child] of cascadeChildIds.entries()) {
    assert.equal(cascadeMemberTitles.get(child), cascadeChildTitles[index], `the member title for ${child}`)
  }
  const cascadeRestored = await api.call('restore', { method: 'POST', body: { sessionId: cascadeParentId } })
  assert.equal(cascadeRestored.status, 200)
  for (const id of [cascadeParentId, ...cascadeChildIds]) {
    assert.equal((await fs.stat(path.join(home, 'sessions', projectName(cascadeProject), id))).isDirectory(), true)
  }
  const cascadeAgain = await api.call('preflight', { method: 'POST', body: { sessionId: cascadeParentId } })
  assert.equal(cascadeAgain.body.eligible, true)
  pass('cascade trash and restore move the whole hidden tree and keep per-member titles')

  // --- Trash + undo -------------------------------------------------------
  const trashed = await api.call('trash', { method: 'POST', body: { sessionId: alphaId } })
  assert.equal(trashed.status, 200)
  assert.equal(trashed.body.entry.state, 'trashed')
  assert.equal(trashed.body.entry.title, alphaTitle, 'the trash response carries the folded conversation title')
  assert.notEqual(trashed.body.entry.title, path.basename(alphaProject), 'the title must not be the cwd basename')
  assert.notEqual(trashed.body.entry.title, alphaId, 'the title must not be the session id')
  const alphaEntry = await findEntry(home, alphaId)
  assert.equal(alphaEntry.title, alphaTitle, 'the durable index stores the conversation title')
  const titledState = await api.call('state')
  const titledRow = titledState.body.entries.find((entry) => entry.sessionId === alphaId)
  assert.ok(titledRow !== undefined, 'the trashed session appears in /state')
  assert.equal(titledRow.title, alphaTitle, 'the /state row exposes the conversation title')
  await assert.rejects(fs.stat(alphaDir))
  const undo = await api.call('restore', { method: 'POST', body: { sessionId: alphaId } })
  assert.equal(undo.status, 200)
  assert.equal(undo.body.session.workspaceReattached, true)
  assert.equal((await fs.stat(alphaDir)).isDirectory(), true)
  pass('trash + undo/normal restore (Workspace reattached, real title captured)')

  // --- Workspace sibling order -------------------------------------------
  const orderTrashed = await api.call('trash', { method: 'POST', body: { sessionId: orderIds[1] } })
  assert.equal(orderTrashed.status, 200)
  const orderRestored = await api.call('restore', { method: 'POST', body: { sessionId: orderIds[1] } })
  assert.equal(orderRestored.status, 200)
  assert.equal(orderRestored.body.session.workspaceReattached, true)
  const orderRegistry = await readWorkspaces(home)
  assert.deepEqual(orderRegistry.tables.workspaces['ws-order'].sessionIds, orderIds)
  pass('normal restore keeps the original Workspace sibling order')

  // --- Reveal guards (no Finder launch) ----------------------------------
  const revealMissing = await api.call('reveal', { method: 'POST', body: { sessionId: 'session-does-not-exist' } })
  assert.equal(revealMissing.status, 404)
  assert.equal(revealMissing.body.error.code, 'TRASH_ENTRY_NOT_FOUND')
  pass('reveal guard for an unknown entry')

  // --- Cleanup failure diagnostics and recovery --------------------------
  await waitForActivationSweep(api)
  const cleanupEntry = await api.call('trash', { method: 'POST', body: { sessionId: cleanupId } })
  assert.equal(cleanupEntry.status, 200)
  const agedCleanup = await ageEntry(home, cleanupId, 31)
  const objectsDir = path.join(home, '.session-trash', 'objects')
  if (process.platform === 'win32') {
    // Windows does not enforce POSIX permission bits, so a read-only directory
    // cannot simulate a failed deletion there. Purge the entry and move on; the
    // failure path is covered by the unit tests.
    const skippedCleanup = await api.call('purge', { method: 'POST', body: { sessionId: cleanupId } })
    assert.equal(skippedCleanup.status, 200)
    console.log('e2e skip: cleanup failure diagnostics need POSIX permission bits')
  } else {
    await fs.chmod(objectsDir, 0o500)
    let failedCleanup
    try {
      failedCleanup = await api.call('cleanup', { method: 'POST' })
    } finally {
      await fs.chmod(objectsDir, 0o700)
    }
    assert.equal(failedCleanup.status, 200)
    assert.equal(failedCleanup.body.failed, 1)
    assert.equal(failedCleanup.body.cleanup.consecutiveFailures >= 1, true)
    // A manual cleanup records the failure but never schedules an automatic
    // retry; the automatic retry policy is covered by the unit tests.
    assert.equal(failedCleanup.body.cleanup.retryAt, null)
    assert.equal(failedCleanup.body.cleanup.lastRun.failed, 1)
    const failedState = await api.call('state')
    const failedEntry = failedState.body.entries.find((entry) => entry.sessionId === cleanupId)
    assert.equal(failedEntry.state, 'purging')
    assert.ok(typeof failedEntry.lastError === 'string')
    assert.equal((await fs.stat(path.join(home, '.session-trash', 'objects', agedCleanup.trashId))).isDirectory(), true)
    const recoveredCleanup = await api.call('cleanup', { method: 'POST' })
    assert.equal(recoveredCleanup.status, 200)
    assert.equal(recoveredCleanup.body.failed, 0)
    assert.equal(recoveredCleanup.body.cleanup.consecutiveFailures, 0)
    assert.equal(recoveredCleanup.body.cleanup.retryAt, null)
    const recoveredState = await api.call('state')
    assert.equal(recoveredState.body.entries.some((entry) => entry.sessionId === cleanupId), false)
    pass('cleanup failure diagnostics and manual recovery')
  }

  // --- Forget a missing entry --------------------------------------------
  const forgetTrashed = await api.call('trash', { method: 'POST', body: { sessionId: forgetId } })
  assert.equal(forgetTrashed.status, 200)
  const forgetRejected = await api.call('forget', { method: 'POST', body: { sessionId: forgetId } })
  assert.equal(forgetRejected.status, 409)
  assert.equal(forgetRejected.body.error.code, 'FORGET_NOT_ALLOWED')
  const forgetEntry = await findEntry(home, forgetId)
  await fs.rm(path.join(home, '.session-trash', 'objects', forgetEntry.trashId), {
    recursive: true,
    force: true,
  })
  const forgetSweep = await api.call('cleanup', { method: 'POST' })
  assert.equal(forgetSweep.status, 200)
  const missingState = await api.call('state')
  const missingEntry = missingState.body.entries.find((entry) => entry.sessionId === forgetId)
  assert.equal(missingEntry.state, 'missing')
  assert.equal(missingEntry.canForget, true)
  const forgotten = await api.call('forget', { method: 'POST', body: { sessionId: forgetId } })
  assert.equal(forgotten.status, 200)
  const afterForget = await api.call('state')
  assert.equal(afterForget.body.entries.some((entry) => entry.sessionId === forgetId), false)
  pass('forget only a missing entry, without deleting session files')

  // --- Empty unindexed leftovers can be cleaned --------------------------
  const orphanId = '20260101T000000-orphan01'
  const orphanDir = path.join(home, '.session-trash', 'objects', orphanId)
  await fs.mkdir(orphanDir, { recursive: true })
  await fs.writeFile(path.join(orphanDir, 'meta.json'), '{ broken')
  const orphanCleanup = await api.call('orphans/forget', { method: 'POST' })
  assert.equal(orphanCleanup.status, 200)
  assert.equal(orphanCleanup.body.removed >= 1, true)
  await assert.rejects(fs.stat(orphanDir))
  pass('empty unindexed leftovers are cleaned')

  // --- Permanent purge ----------------------------------------------------
  const purgeTrashed = await api.call('trash', { method: 'POST', body: { sessionId: purgeId } })
  assert.equal(purgeTrashed.status, 200)
  const purgeEntry = await findEntry(home, purgeId)
  const purged = await api.call('purge', { method: 'POST', body: { sessionId: purgeId } })
  assert.equal(purged.status, 200)
  await assert.rejects(fs.stat(path.join(home, '.session-trash', 'objects', purgeEntry.trashId)))
  const afterPurge = await api.call('state')
  assert.equal(afterPurge.body.entries.some((entry) => entry.sessionId === purgeId), false)
  pass('permanent purge removes the object and index entry')

  // --- Delete all permanently --------------------------------------------
  const bulkEntries = []
  for (const id of bulkIds.slice(0, 2)) {
    const bulkTrashed = await api.call('trash', { method: 'POST', body: { sessionId: id } })
    assert.equal(bulkTrashed.status, 200)
    bulkEntries.push(await findEntry(home, id))
  }
  const missingBulkTrashed = await api.call('trash', { method: 'POST', body: { sessionId: bulkIds[2] } })
  assert.equal(missingBulkTrashed.status, 200)
  const missingBulkEntry = await findEntry(home, bulkIds[2])
  await fs.rm(path.join(home, '.session-trash', 'objects', missingBulkEntry.trashId), {
    recursive: true,
    force: true,
  })
  const markMissing = await api.call('cleanup', { method: 'POST' })
  assert.equal(markMissing.status, 200)
  const beforeBulk = await api.call('state')
  assert.equal(beforeBulk.body.entries.find((entry) => entry.sessionId === bulkIds[2]).state, 'missing')
  const bulkPurged = await api.call('purge-all', { method: 'POST' })
  assert.equal(bulkPurged.status, 200)
  assert.deepEqual(bulkPurged.body, { ok: true, purged: 2, forgotten: 1, failed: 0 })
  for (const entry of bulkEntries) {
    await assert.rejects(fs.stat(path.join(home, '.session-trash', 'objects', entry.trashId)))
  }
  const emptiedState = await api.call('state')
  assert.equal(emptiedState.body.entries.length, 0)
  const emptyBulkPurge = await api.call('purge-all', { method: 'POST' })
  assert.equal(emptyBulkPurge.status, 200)
  assert.deepEqual(emptyBulkPurge.body, { ok: true, purged: 0, forgotten: 0, failed: 0 })
  pass('delete-all permanently empties the trash and forgets missing entries')

  // --- 30-day expiry ------------------------------------------------------
  const alphaTrashed = await api.call('trash', { method: 'POST', body: { sessionId: alphaId } })
  assert.equal(alphaTrashed.status, 200)
  const agedAlpha = await ageEntry(home, alphaId, 31)
  const expiryCleanup = await api.call('cleanup', { method: 'POST' })
  assert.equal(expiryCleanup.status, 200)
  assert.equal(expiryCleanup.body.purged, 1)
  assert.equal(expiryCleanup.body.failed, 0)
  await assert.rejects(fs.stat(path.join(home, '.session-trash', 'objects', agedAlpha.trashId)))
  pass('30-day expiry purge')

  // --- Corrupt index protection and rebuild ------------------------------
  const rebuildTrashed = await api.call('trash', { method: 'POST', body: { sessionId: rebuildId } })
  assert.equal(rebuildTrashed.status, 200)
  const trashRoot = path.join(home, '.session-trash')
  await fs.writeFile(path.join(trashRoot, 'trash-index.json'), '{ broken')
  await fs.writeFile(path.join(trashRoot, 'trash-index.json.bak'), '{ also broken')
  const corruptCleanup = await api.call('cleanup', { method: 'POST' })
  assert.equal(corruptCleanup.status, 500)
  assert.equal(corruptCleanup.body.error.code, 'INDEX_CORRUPT')
  const corruptState = await api.call('state')
  assert.equal(corruptState.body.index.status, 'corrupt')
  assert.equal(corruptState.body.entries.length, 0)
  const corruptPreflight = await api.call('preflight', { method: 'POST', body: { sessionId: rebuildId } })
  assert.equal(corruptPreflight.body.eligible, false)
  assert.equal(corruptPreflight.body.code, 'INDEX_CORRUPT')
  const rebuilt = await api.call('rebuild', { method: 'POST' })
  assert.equal(rebuilt.status, 200)
  assert.equal(rebuilt.body.entries, 1)
  const rebuiltState = await api.call('state')
  assert.equal(rebuiltState.body.index.status, 'ok')
  assert.equal(rebuiltState.body.entries[0].sessionId, rebuildId)
  assert.equal(rebuiltState.body.entries[0].state, 'trashed')
  const healthyRebuild = await api.call('rebuild', { method: 'POST' })
  assert.equal(healthyRebuild.status, 409)
  assert.equal(healthyRebuild.body.error.code, 'INDEX_NOT_CORRUPT')
  const rebuiltCleanup = await api.call('cleanup', { method: 'POST' })
  assert.equal(rebuiltCleanup.status, 200)
  assert.equal(rebuiltCleanup.body.failed, 0)
  const rebuiltRestored = await api.call('restore', { method: 'POST', body: { sessionId: rebuildId } })
  assert.equal(rebuiltRestored.status, 200)
  assert.equal(rebuiltRestored.body.session.workspaceReattached, true)
  pass('corrupt-index protection mode + rebuild from meta.json')

  // --- Orphan restore -----------------------------------------------------
  const betaTrashed = await api.call('trash', { method: 'POST', body: { sessionId: betaId } })
  assert.equal(betaTrashed.status, 200)
  await fs.rm(betaProject, { recursive: true, force: true })
  const revealMissingWorkspace = await api.call('reveal', { method: 'POST', body: { sessionId: betaId } })
  assert.equal(revealMissingWorkspace.status, 409)
  assert.equal(revealMissingWorkspace.body.error.code, 'WORKSPACE_MISSING')
  const normalRestore = await api.call('restore', { method: 'POST', body: { sessionId: betaId, mode: 'normal' } })
  assert.equal(normalRestore.status, 409)
  assert.equal(normalRestore.body.error.code, 'WORKSPACE_MISSING')
  const orphanRestore = await api.call('restore', { method: 'POST', body: { sessionId: betaId, mode: 'orphan' } })
  assert.equal(orphanRestore.status, 200)
  assert.equal(orphanRestore.body.session.orphan, true)
  assert.equal(orphanRestore.body.session.workspaceReattached, false)
  assert.equal((await fs.stat(betaDir)).isDirectory(), true)
  const workspaceRegistry = await readWorkspaces(home)
  assert.equal(
    (workspaceRegistry.tables.workspaces['ws-beta']?.sessionIds ?? []).includes(betaId),
    false,
    'orphan restore detaches the session from its workspace registry entry',
  )
  pass('reveal missing-workspace guard + orphan restore with Workspace detach')

  // --- Final invariants ---------------------------------------------------
  const finalState = await api.call('state')
  assert.equal(finalState.body.entries.length, 0)
  assert.equal(finalState.body.index.status, 'ok')
  assert.equal(finalState.body.stats.count, 0)
  assert.deepEqual(await fs.readdir(path.join(home, '.session-trash', 'objects')), [])
  assert.equal((await fs.stat(path.join(home, 'sessions', projectName(orderProject), orderIds[1]))).isDirectory(), true)
  pass('final index/object invariants')

  console.log(`e2e-web regression passed (${runtime.mode} host): ${passedGroups} feature groups`)
} catch (error) {
  failure = error
  console.error(`e2e-web regression failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
} finally {
  if (server !== undefined) {
    await stopServer(server.child)
    if (failure !== null) {
      console.error(`--- dsh web log ---\n${server.log}`)
      if (!keep) console.error(`throwaway home (removed below): ${home}`)
    }
  }
  if (keep) {
    console.log(`kept throwaway home: ${home}`)
  } else {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

if (failure !== null) process.exitCode = 1
