import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Minimal React surface: the registered components are never rendered here. */
const ReactStub = {
  createElement(tag, props, ...children) {
    return { tag, props, children }
  },
  useState() {
    throw new Error('the section component is not rendered in this test')
  },
  useEffect() {},
  useCallback(callback) {
    return callback
  },
  useRef() {
    return { current: null }
  },
}

/** Factory captured the first time `client.js` is evaluated. */
let clientFactory

/**
 * Load `client.js` behind a fake module loader and return a fresh module
 * instance. The module body runs once per test process; the factory is reused
 * so each test gets its own window-local state.
 *
 * @returns {Promise<object>} the module exports.
 */
async function loadClientModule() {
  if (clientFactory === undefined) {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load(module) {
          loaded.push(module)
        },
      },
      location: { origin: 'http://127.0.0.1:3080' },
    }
    await import(pathToFileURL(path.resolve('client.js')).href)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, '@wangxiaocuo/dsh-session-trash')
    clientFactory = loaded[0].factory
  }
  return clientFactory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected module ${name}`)
  })
}

/**
 * Build a Client context with the three required services.
 *
 * @param {{ remoteAccess?: object }} [options] optional service overrides.
 * @returns {object} the fake context and captured registrations.
 */
function createClient() {
  const dictionaries = {}
  const slots = []
  const menus = []
  const toasts = []
  const effects = []
  const ctx = {
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
    },
    get(name) {
      return name === 'remoteAccess' ? this.remoteAccess : undefined
    },
    remoteAccess: undefined,
    locale: {
      register(namespace, dicts) {
        dictionaries[namespace] = dicts
        return () => {}
      },
      bind(namespace) {
        return (key) => {
          const dict = dictionaries[namespace]?.zh ?? {}
          return dict[key] ?? key
        }
      },
    },
    slots: {
      inject(_name, factory) {
        factory()
        return () => {}
      },
      register(definition, component) {
        slots.push({ definition, component })
        return () => {}
      },
    },
    contextMenus: {
      register(definition) {
        menus.push(definition)
        return () => {}
      },
      notify(text, success, action) {
        toasts.push({ text, success, action })
      },
    },
  }
  return { ctx, dictionaries, slots, menus, toasts, effects }
}

/**
 * Install a fetch stub routing by pathname.
 *
 * @param {Record<string, { status?: number, body: unknown } | ((options: object) => object)>} routes endpoint answers.
 * @returns {{ calls: { url: string, options: object }[] }} captured calls.
 */
function stubFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname
    const route = routes[pathname]
    calls.push({ url: String(url), options })
    if (route === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND' } }) }
    }
    const answer = typeof route === 'function' ? route(options) : route
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    }
  }
  return { calls }
}

const PREFLIGHT = '/plugins/dsh-session-trash/api/preflight'
const TRASH = '/plugins/dsh-session-trash/api/trash'
const RESTORE = '/plugins/dsh-session-trash/api/restore'

test('the Client contributes the settings section, icons, and session menu', async () => {
  const exported = await loadClientModule()
  assert.deepEqual(exported.inject, ['slots', 'locale', 'contextMenus'])
  assert.equal(typeof exported.apply, 'function')

  const client = createClient()
  exported.apply(client.ctx)
  assert.ok(client.dictionaries.sessionTrash.zh.nav === '回收站')
  assert.ok(client.dictionaries.sessionTrash.en.nav === 'Trash')
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  assert.equal(section.definition.id, 'session-trash')
  assert.equal(section.definition.order, 25)
  assert.equal(section.definition.label(), '回收站')
  const sectionIcon = client.slots.find((entry) => entry.definition.name === 'settings.section.icon')
  assert.equal(sectionIcon.definition.id, 'session-trash')
  const menuIcon = client.slots.find((entry) => entry.definition.name === 'contextMenu.icon')
  assert.equal(menuIcon.definition.key, 'session-trash.move')
  assert.equal(client.menus.length, 1)
  assert.equal(client.menus[0].id, 'session-trash.move')
  assert.equal(client.menus[0].target, 'session')
  assert.equal(client.menus[0].order, 550)
})

test('every Client string has a matching Chinese and English entry', async () => {
  const exported = await loadClientModule()
  const client = createClient()
  exported.apply(client.ctx)
  const { zh, en } = client.dictionaries.sessionTrash
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', `zh.${key} must be a string`)
    assert.notEqual(value, '', `zh.${key} must not be empty`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `en.${key} must be a string`)
    assert.notEqual(value, '', `en.${key} must not be empty`)
  }
})

test('the menu resolves only for an eligible session', async () => {
  const exported = await loadClientModule()
  const client = createClient()
  exported.apply(client.ctx)
  const menu = client.menus[0]

  stubFetch({ [PREFLIGHT]: { body: { eligible: true } } })
  const actions = await menu.resolve({ sessionId: 'session-a', displayTitle: 'Alpha' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'move')
  assert.equal(actions[0].label, '移入回收站')
  assert.deepEqual(actions[0].icon, { key: 'session-trash.move' })
  assert.equal(actions[0].separatorBefore, true)

  stubFetch({ [PREFLIGHT]: { body: { eligible: false, code: 'SESSION_LIVE' } } })
  assert.deepEqual(await menu.resolve({ sessionId: 'session-b', displayTitle: 'Beta' }), [])

  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  assert.deepEqual(await menu.resolve({ sessionId: 'session-c', displayTitle: 'Gamma' }), [])

  client.ctx.remoteAccess = {
    source() {
      return { getSnapshot: () => false, subscribe: () => () => {} }
    },
  }
  assert.deepEqual(await menu.resolve({ sessionId: 'session-d', displayTitle: 'Delta' }), [])
})

test('moving a session shows one undo action and undo restores it', async () => {
  const exported = await loadClientModule()
  const client = createClient()
  exported.apply(client.ctx)
  const menu = client.menus[0]

  const requests = stubFetch({
    [PREFLIGHT]: { body: { eligible: true } },
    [TRASH]: { body: { ok: true, entry: { sessionId: 'session-a', title: 'Alpha' } } },
    [RESTORE]: { body: { ok: true, session: { sessionId: 'session-a', title: 'Alpha', orphan: false, workspaceReattached: true } } },
  })
  const actions = await menu.resolve({ sessionId: 'session-a', displayTitle: 'Alpha' })
  await actions[0].run()

  assert.equal(client.toasts.length, 1)
  const toast = client.toasts[0]
  assert.equal(toast.success, true)
  assert.equal(toast.text, '已将「Alpha」移入回收站')
  assert.equal(toast.action.label, '撤销')
  assert.equal(toast.action.failureLabel, '撤销失败')
  assert.equal(typeof toast.action.run, 'function')
  assert.equal(requests.calls.at(-1).options.method, 'POST')
  assert.equal(requests.calls.at(-1).options.body, JSON.stringify({ sessionId: 'session-a' }))

  await toast.action.run()
  assert.equal(client.toasts.length, 2)
  assert.equal(client.toasts[1].success, true)
  assert.equal(client.toasts[1].text, '已恢复「Alpha」')
  assert.equal(requests.calls.at(-1).options.method, 'POST')
  assert.equal(requests.calls.at(-1).options.body, JSON.stringify({ sessionId: 'session-a', mode: 'normal' }))
  for (const call of requests.calls) {
    assert.equal(call.options.headers['X-DSH-Session-Trash'], '1')
    assert.equal(call.options.credentials, 'same-origin')
  }
})

test('undo retries as an orphan restore when the workspace is gone', async () => {
  const exported = await loadClientModule()
  const client = createClient()
  exported.apply(client.ctx)
  const menu = client.menus[0]

  const modes = []
  const requests = stubFetch({
    [PREFLIGHT]: { body: { eligible: true } },
    [TRASH]: { body: { ok: true, entry: { sessionId: 'session-a', title: 'Alpha' } } },
    [RESTORE]: (options) => {
      const body = JSON.parse(options.body)
      modes.push(body.mode)
      if (body.mode === 'normal') {
        return { status: 409, body: { ok: false, error: { code: 'WORKSPACE_MISSING' } } }
      }
      return {
        body: { ok: true, session: { sessionId: 'session-a', title: 'Alpha', orphan: true, workspaceReattached: false } },
      }
    },
  })
  const actions = await menu.resolve({ sessionId: 'session-a', displayTitle: 'Alpha' })
  await actions[0].run()
  await client.toasts.at(-1).action.run()

  assert.deepEqual(modes, ['normal', 'orphan'])
  assert.equal(client.toasts.at(-1).success, true)
  assert.equal(client.toasts.at(-1).text, '已恢复为孤儿会话「Alpha」')
  assert.equal(requests.calls.filter((call) => call.url.endsWith('/restore')).length, 2)
})

test('a failed move and a missing workspace report localized errors', async () => {
  const exported = await loadClientModule()
  const client = createClient()
  exported.apply(client.ctx)
  const menu = client.menus[0]

  stubFetch({
    [PREFLIGHT]: { body: { eligible: true } },
    [TRASH]: { status: 409, body: { ok: false, error: { code: 'SESSION_ACTIVE' } } },
  })
  const actions = await menu.resolve({ sessionId: 'session-a', displayTitle: 'Alpha' })
  await actions[0].run()
  assert.equal(client.toasts.at(-1).success, false)
  assert.equal(client.toasts.at(-1).text, '这个会话还有正在运行的任务，无法移入回收站。')

  stubFetch({
    [PREFLIGHT]: { body: { eligible: true } },
    [TRASH]: { body: { ok: true, entry: { sessionId: 'session-b', title: 'Beta' } } },
    [RESTORE]: { status: 409, body: { ok: false, error: { code: 'WORKSPACE_MISSING' } } },
  })
  const success = await menu.resolve({ sessionId: 'session-b', displayTitle: 'Beta' })
  await success[0].run()
  await client.toasts.at(-1).action.run()
  assert.equal(client.toasts.at(-1).success, false)
  assert.equal(client.toasts.at(-1).text, '原工作区目录已不存在，暂时无法普通恢复。')
})
