import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {readonly unknown[] | undefined} left first dependency list.
 * @param {readonly unknown[] | undefined} right second dependency list.
 * @returns {boolean} whether both lists are shallow-equal.
 */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * Build the smallest hook-capable React substitute that can execute the real
 * settings section and settle its async load effect.
 *
 * @returns {object} the React surface plus its render driver.
 */
function createMiniReact() {
  /** @type {unknown[]} */
  let hooks = []
  let hookIndex = 0
  let effectQueue = []
  let dirty = false

  /**
   * @returns {void}
   */
  function schedule() {
    dirty = true
  }

  const React = {
    /**
     * @param {string | Function} type element type.
     * @param {object | null} props element props.
     * @param {...unknown} children child nodes.
     * @returns {object} a plain element tree.
     */
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    /**
     * @param {unknown} initial initial value or initializer.
     * @returns {[unknown, (next: unknown) => void]} state and setter.
     */
    useState(initial) {
      const index = hookIndex
      hookIndex += 1
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        schedule()
      }
      return [hooks[index], set]
    },
    /**
     * @param {unknown} initial initial reference value.
     * @returns {{ current: unknown }} the stable ref.
     */
    useRef(initial) {
      const index = hookIndex
      hookIndex += 1
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    /**
     * @param {Function} callback function to memoize.
     * @param {readonly unknown[] | undefined} deps dependency list.
     * @returns {Function} the stable callback.
     */
    useCallback(callback, deps) {
      const index = hookIndex
      hookIndex += 1
      const previous = hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.callback
      hooks[index] = { callback, deps }
      return callback
    },
    /**
     * @param {Function} effect effect body.
     * @param {readonly unknown[] | undefined} deps dependency list.
     * @returns {void}
     */
    useEffect(effect, deps) {
      const index = hookIndex
      hookIndex += 1
      const previous = hooks[index]
      effectQueue.push({ index, effect, deps, changed: previous === undefined || !sameDeps(previous.deps, deps) })
    },
    /**
     * @param {Function} _subscribe ignored subscriber.
     * @param {Function} getSnapshot current snapshot reader.
     * @returns {unknown} the current snapshot.
     */
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }

  /**
   * @param {Function} Component component whose hooks own this renderer.
   * @returns {object} the rendered element tree.
   */
  function renderOnce(Component) {
    hookIndex = 0
    effectQueue = []
    const tree = Component({})
    for (const record of effectQueue) {
      if (!record.changed) continue
      const previous = hooks[record.index]
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = record.effect()
      hooks[record.index] = { deps: record.deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    }
    return tree
  }

  return {
    React,
    /**
     * Render until no setter fired during the settle window.
     *
     * @param {Function} Component component to render.
     * @param {number} [steps] maximum render passes.
     * @returns {Promise<object>} the settled element tree.
     */
    async settle(Component, steps = 20) {
      let tree = null
      for (let step = 0; step < steps; step += 1) {
        dirty = false
        tree = renderOnce(Component)
        await new Promise((resolve) => setTimeout(resolve, 5))
        if (!dirty) return tree
      }
      return tree
    },
    /**
     * Run every mounted effect cleanup, as unmounting the component would.
     *
     * @returns {void}
     */
    unmount() {
      for (const entry of hooks) {
        if (entry !== null && typeof entry === 'object' && typeof entry.cleanup === 'function') {
          entry.cleanup()
          entry.cleanup = null
        }
      }
    },
  }
}

/**
 * @param {unknown} node element tree node.
 * @param {(element: object) => void} visit visitor.
 * @returns {void}
 */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node === null || typeof node !== 'object' || node.type === undefined) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

/**
 * @param {object} tree rendered tree.
 * @returns {string[]} every string child in document order.
 */
function textOf(tree) {
  const text = []
  walk(tree, (element) => {
    for (const child of element.children) if (typeof child === 'string') text.push(child)
  })
  return text
}

/**
 * @param {unknown} node element tree node.
 * @returns {string} the concatenated text of the subtree in document order.
 */
function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object' || node.type === undefined) return ''
  return node.children.map(textContent).join('')
}

/**
 * @param {object} tree rendered tree.
 * @param {string} label exact button text.
 * @returns {object | undefined} the matching button element.
 */
function buttonByText(tree, label) {
  let found
  walk(tree, (element) => {
    if (found !== undefined) return
    if (element.type !== 'button') return
    if (element.children.includes(label)) found = element
  })
  return found
}

/**
 * @param {object} tree rendered tree.
 * @param {string} kind dialog kind carried in props.
 * @returns {object | undefined} the dialog element.
 */
function dialogOfKind(tree, kind) {
  let found
  walk(tree, (element) => {
    if (found !== undefined) return
    if (typeof element.type === 'function' && element.props.kind === kind && element.props.onConfirm !== undefined) {
      found = element
    }
  })
  return found
}

/**
 * @param {object} tree rendered tree.
 * @returns {object[]} every rendered action-menu element.
 */
function actionMenus(tree) {
  const found = []
  walk(tree, (element) => {
    if (typeof element.type === 'function' && Array.isArray(element.props.items)) found.push(element)
  })
  return found
}

/**
 * @param {object} tree rendered tree.
 * @param {string} className one class token.
 * @returns {object[]} every element carrying that class, in document order.
 */
function elementsByClass(tree, className) {
  const found = []
  walk(tree, (element) => {
    if (typeof element.props.className === 'string' && element.props.className.split(' ').includes(className)) {
      found.push(element)
    }
  })
  return found
}

/**
 * @param {object} tree rendered tree.
 * @param {string} className one class token.
 * @returns {object | undefined} the first element carrying that class.
 */
function elementByClass(tree, className) {
  return elementsByClass(tree, className)[0]
}

/**
 * @param {object} tree rendered tree.
 * @param {string} label accessible name carried in `aria-label`.
 * @returns {object | undefined} the matching input.
 */
function inputByLabel(tree, label) {
  let found
  walk(tree, (element) => {
    if (found !== undefined) return
    if (element.type === 'input' && element.props['aria-label'] === label) found = element
  })
  return found
}

/**
 * @param {object} tree rendered tree.
 * @param {string} value radio input value.
 * @returns {object | undefined} the matching radio input.
 */
function radioByValue(tree, value) {
  let found
  walk(tree, (element) => {
    if (found !== undefined) return
    if (element.type === 'input' && element.props.type === 'radio' && element.props.value === value) found = element
  })
  return found
}

/**
 * @param {object} tree rendered tree.
 * @returns {string[]} visible row titles in document order.
 */
function rowTitles(tree) {
  return elementsByClass(tree, 'dsh-trash__row').map((row) => {
    const title = elementByClass(row, 'dsh-trash__rowTitle')
    return title === undefined ? '' : title.children.join('')
  })
}

/**
 * @param {object} tree rendered tree.
 * @param {string} title row title.
 * @returns {object | undefined} the matching row element.
 */
function rowByTitle(tree, title) {
  return elementsByClass(tree, 'dsh-trash__row').find((row) => {
    const titleNode = elementByClass(row, 'dsh-trash__rowTitle')
    return titleNode !== undefined && titleNode.children.join('') === title
  })
}

/**
 * @param {object} node subtree root.
 * @param {string} label exact button text.
 * @returns {object | undefined} the first matching button below `node`.
 */
function buttonWithin(node, label) {
  let found
  walk(node, (element) => {
    if (found !== undefined) return
    if (element.type === 'button' && element.children.includes(label)) found = element
  })
  return found
}

/**
 * @param {object} tree rendered tree.
 * @param {string} label accessible name carried in `aria-label`.
 * @returns {object | undefined} the matching select element.
 */
function selectByLabel(tree, label) {
  let found
  walk(tree, (element) => {
    if (found !== undefined) return
    if (element.type === 'select' && element.props['aria-label'] === label) found = element
  })
  return found
}

const STATE_ROUTE = '/plugins/dsh-session-trash/api/state'
const PREFLIGHT_ROUTE = '/plugins/dsh-session-trash/api/preflight'
const TRASH_ROUTE = '/plugins/dsh-session-trash/api/trash'
const RESTORE_ROUTE = '/plugins/dsh-session-trash/api/restore'
const PURGE_ROUTE = '/plugins/dsh-session-trash/api/purge'
const PURGE_ALL_ROUTE = '/plugins/dsh-session-trash/api/purge-all'
const REBUILD_ROUTE = '/plugins/dsh-session-trash/api/rebuild'
const CLEANUP_ROUTE = '/plugins/dsh-session-trash/api/cleanup'
const REVEAL_ROUTE = '/plugins/dsh-session-trash/api/reveal'
const FORGET_ROUTE = '/plugins/dsh-session-trash/api/forget'
const SWEEP_ROUTE = '/plugins/dsh-session-trash/api/sweep'
const ORPHANS_ROUTE = '/plugins/dsh-session-trash/api/orphans/forget'

const DAY = 86_400_000

/**
 * @param {object} [overrides] entry overrides.
 * @returns {object} one complete wire entry.
 */
function makeEntry(overrides = {}) {
  const now = Date.now()
  return {
    sessionId: 'session-x',
    title: 'X',
    trashedAt: now - 1000,
    expiresAt: now + 20 * DAY,
    originalCwd: '/tmp/x',
    originalWorkspaceTitle: null,
    workspaceExistsAtDeletion: true,
    workspaceNowExists: true,
    sizeBytes: 1024,
    fileCount: 1,
    formatStatus: 'current',
    state: 'trashed',
    canRestore: true,
    canPurge: true,
    canForget: false,
    requiresOrphanRestore: false,
    lastError: null,
    subagentCount: 0,
    members: [{ sessionId: 'session-x', origin: null, title: null, sizeBytes: 1024 }],
    ...overrides,
  }
}

/**
 * @param {object[]} entries wire entries.
 * @returns {object} a complete `/state` payload.
 */
function statePayloadWith(entries) {
  const payload = statePayload()
  payload.entries = entries
  payload.stats = {
    count: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    nextSweepAt: Date.now() + 3600_000,
  }
  return payload
}

/**
 * @param {object} [overrides] entry overrides.
 * @returns {object} one full `/state` payload.
 */
function statePayload(overrides = {}) {
  const now = Date.now()
  return {
    version: 1,
    config: { retentionDays: 30, sweepIntervalHours: 6, enableAutoCleanup: true },
    trashRootDisplay: '$DSH_HOME/.session-trash',
    index: { status: 'ok', updatedAt: now, error: null, unindexed: 0 },
    entries: [
      {
        sessionId: 'session-alpha',
        title: 'Alpha',
        trashedAt: now - 1000,
        expiresAt: now + 29 * DAY,
        originalCwd: '/tmp/demo',
        originalWorkspaceTitle: null,
        workspaceExistsAtDeletion: true,
        workspaceNowExists: true,
        sizeBytes: 2048,
        fileCount: 2,
        formatStatus: 'current',
        state: 'trashed',
        canRestore: true,
        canPurge: true,
        canForget: false,
        requiresOrphanRestore: false,
        lastError: null,
        subagentCount: 0,
        members: [{ sessionId: 'session-alpha', origin: null, title: null, sizeBytes: 2048 }],
        ...overrides,
      },
    ],
    stats: { count: 1, totalBytes: 2048, nextSweepAt: now + 3600_000 },
  }
}

/**
 * Load the module behind a fake loader and a mini React runtime.
 *
 * @returns {Promise<{ factory: Function, mini: object }>} the client factory and renderer.
 */
async function loadModule() {
  const clientFactory = await (async () => {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load(module) {
          loaded.push(module)
        },
      },
      location: { origin: 'http://127.0.0.1:3080' },
      addEventListener() {},
      removeEventListener() {},
    }
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      activeElement: null,
      body: { appendChild() {}, removeChild() {} },
      execCommand() {
        return true
      },
    }
    await import(`${pathToFileURL(path.resolve('client.js')).href}?render=${Math.random()}`)
    assert.equal(loaded.length, 1)
    return loaded[0].factory
  })()
  const mini = createMiniReact()
  return { factory: clientFactory, mini }
}

/**
 * @param {Function} factory client module factory.
 * @param {object} mini mini React runtime.
 * @param {object} payload `/state` answer.
 * @param {Record<string, object | Function>} [extra] additional endpoint answers.
 * @returns {{ ctx: object, calls: object[], menus: object[], slots: object[], toasts: object[] }} the client harness.
 */
function createClient(factory, mini, payload, extra = {}) {
  const dictionaries = {}
  const slots = []
  const menus = []
  const toasts = []
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url), globalThis.window.location.origin).pathname
    calls.push({ pathname, options })
    let answer
    if (pathname === STATE_ROUTE) answer = typeof payload === 'function' ? payload(calls.length) : { status: 200, body: payload }
    else if (extra[pathname] !== undefined) answer = typeof extra[pathname] === 'function' ? extra[pathname](options) : extra[pathname]
    else answer = { status: 200, body: { ok: true } }
    answer = await answer
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    }
  }
  const locale = {
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
    getSnapshot() {
      return { active: 'zh', revision: 1, locales: [] }
    },
    subscribe() {
      return () => {}
    },
  }
  const ctx = {
    effect(callback) {
      return callback()
    },
    get() {
      return undefined
    },
    locale,
    slots: {
      inject(_name, factoryCallback) {
        factoryCallback()
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
  const module = factory((name) => {
    if (name === 'react') return mini.React
    throw new Error(`unexpected module ${name}`)
  })
  module.apply(ctx)
  return { ctx, calls, menus, slots, toasts }
}

test('the trash page renders rows, badges, and row actions from /state', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload())
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const text = textOf(tree)
  assert.ok(text.includes('Alpha'))
  assert.ok(text.includes('session-alpha'))
  assert.ok(text.includes('恢复'))
  assert.ok(text.includes('回收站目录：$DSH_HOME/.session-trash'))
  assert.ok(text.includes('即将到期') || text.some((value) => value.includes('天后')))
  const workspace = elementByClass(tree, 'dsh-trash__rowWorkspace')
  assert.equal(textContent(workspace), '原工作区: demo')
  assert.equal(workspace.props.title, '/tmp/demo')

  const menus = actionMenus(tree)
  assert.equal(menus.length, 1)
  const labels = menus[0].props.items.map((item) => item.label)
  assert.deepEqual(labels, ['恢复为孤儿会话', '在文件管理器中显示', '复制 Session ID', '永久删除'])
  assert.equal(menus[0].props.items.at(-1).danger, true)
  assert.equal(menus[0].props.label, '「Alpha」的更多操作')
})

test('a row shows the recorded workspace title and keeps the full path as the tooltip', async () => {
  const { factory, mini } = await loadModule()
  const now = Date.now()
  const payload = statePayloadWith([
    makeEntry({
      sessionId: 'session-alpha',
      title: 'Alpha',
      originalCwd: '/work/real/deep',
      originalWorkspaceTitle: 'Real Workspace',
      trashedAt: now - 1000,
    }),
    makeEntry({
      sessionId: 'session-beta',
      title: 'Beta',
      originalCwd: '/work/legacy',
      originalWorkspaceTitle: null,
      trashedAt: now - 2000,
    }),
    makeEntry({
      sessionId: 'session-gamma',
      title: 'Gamma',
      originalCwd: null,
      originalWorkspaceTitle: null,
      workspaceExistsAtDeletion: null,
      workspaceNowExists: null,
      trashedAt: now - 3000,
    }),
  ])
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const workspaces = elementsByClass(tree, 'dsh-trash__rowWorkspace')
  assert.deepEqual(workspaces.map(textContent), [
    '原工作区: Real Workspace',
    '原工作区: legacy',
    '原工作区: 未分组',
  ])
  assert.equal(workspaces[0].props.title, '/work/real/deep')
  assert.equal(workspaces[1].props.title, '/work/legacy')
  assert.equal(workspaces[2].props.title, undefined)
})

test('an older payload without workspace or member titles still renders', async () => {
  const { factory, mini } = await loadModule()
  const entry = makeEntry({
    sessionId: 'session-legacy',
    title: 'Legacy',
    originalCwd: '/work/legacy',
    subagentCount: 1,
  })
  delete entry.originalWorkspaceTitle
  entry.members = [
    { sessionId: 'session-legacy', origin: null, sizeBytes: 10 },
    { sessionId: 'session-legacy-child', origin: 'subagent', sizeBytes: 5 },
  ]
  const client = createClient(factory, mini, statePayloadWith([entry]))
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  assert.equal(textContent(elementByClass(tree, 'dsh-trash__rowWorkspace')), '原工作区: legacy')
  assert.equal(textOf(tree).some((value) => value.includes('/work/legacy')), false)

  buttonByText(tree, '展开子会话').props.onClick()
  tree = await mini.settle(section.component)
  assert.deepEqual(elementsByClass(tree, 'dsh-trash__memberTitle'), [])
  assert.ok(textOf(tree).some((value) => value.includes('session-legacy-child')))
})

test('a row shows a sub-session count badge only when the entry has hidden sub-sessions', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayloadWith([
    makeEntry({
      sessionId: 'session-parent',
      title: 'Parent',
      sizeBytes: 7168,
      subagentCount: 3,
      members: [
        { sessionId: 'session-parent', origin: null, sizeBytes: 4096 },
        { sessionId: 'session-parent-child-1', origin: 'subagent', sizeBytes: 1024 },
        { sessionId: 'session-parent-child-2', origin: 'subagent', sizeBytes: 1024 },
        { sessionId: 'session-parent-child-3', origin: 'subagent', sizeBytes: 1024 },
      ],
    }),
    makeEntry({ sessionId: 'session-plain', title: 'Plain', trashedAt: Date.now() - 2000 }),
  ])
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const rows = elementsByClass(tree, 'dsh-trash__row')
  assert.deepEqual(rowTitles(tree), ['Parent', 'Plain'])
  assert.deepEqual(
    elementsByClass(rows[0], 'dsh-trash__badge').map((badge) => badge.children.join('')),
    ['含 3 个子会话'],
  )
  assert.equal(elementByClass(rows[0], 'dsh-trash__badge--info').children.join(''), '含 3 个子会话')
  assert.deepEqual(elementsByClass(rows[1], 'dsh-trash__badge'), [])
  assert.equal(textOf(tree).includes('含 0 个子会话'), false)
})

test('moving a session with cascaded sub-sessions reports the count in the success Toast', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [PREFLIGHT_ROUTE]: { body: { eligible: true } },
    [TRASH_ROUTE]: {
      body: {
        ok: true,
        entry: {
          sessionId: 'session-alpha',
          title: 'Alpha',
          subagentCount: 2,
          members: [
            { sessionId: 'session-alpha', origin: null, sizeBytes: 2048 },
            { sessionId: 'session-alpha-child-1', origin: 'subagent', sizeBytes: 512 },
            { sessionId: 'session-alpha-child-2', origin: 'subagent', sizeBytes: 512 },
          ],
        },
      },
    },
  })
  const menu = client.menus.find((definition) => definition.id === 'session-trash.move')
  assert.ok(menu !== undefined)
  const actions = await menu.resolve({ sessionId: 'session-alpha', displayTitle: 'Alpha' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'move')
  await actions[0].run()
  assert.equal(client.toasts.at(-1).text, '「Alpha」及其 2 个子会话已移入回收站')
  assert.equal(client.toasts.at(-1).success, true)
  assert.equal(client.toasts.at(-1).action.label, '撤销')
})

test('a missing row offers only the index-removal action', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(
    factory,
    mini,
    statePayload({
      state: 'missing',
      canRestore: false,
      canPurge: false,
      canForget: true,
      expiresAt: null,
      lastError: 'The trash copy is missing.',
      lastErrorCode: 'TRASH_COPY_MISSING',
    }),
  )
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const text = textOf(tree)
  assert.ok(text.includes('文件缺失'))
  assert.ok(text.includes('上次错误：回收站里的会话副本缺失。'))
  const rowError = elementByClass(tree, 'dsh-trash__rowError')
  assert.equal(rowError.props.title, 'The trash copy is missing.')
  assert.equal(buttonByText(tree, '恢复'), undefined)
  const labels = actionMenus(tree)[0].props.items.map((item) => item.label)
  assert.deepEqual(labels, ['在文件管理器中显示', '复制 Session ID', '从索引移除'])
})

test('restoring a trashed row posts normal mode and shows a success Toast', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [RESTORE_ROUTE]: {
      body: { ok: true, session: { sessionId: 'session-alpha', title: 'Alpha', orphan: false, workspaceReattached: true } },
    },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const restore = buttonByText(tree, '恢复')
  assert.ok(restore !== undefined)
  restore.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = client.calls.find((entry) => entry.pathname === RESTORE_ROUTE)
  assert.ok(call !== undefined)
  assert.equal(call.options.method, 'POST')
  assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-alpha', mode: 'normal' })
  assert.equal(client.toasts.at(-1).text, '已恢复「Alpha」')
  assert.equal(client.toasts.at(-1).success, true)
})

test('a missing workspace opens the orphan dialog before restoring', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(
    factory,
    mini,
    statePayload({ workspaceNowExists: false, requiresOrphanRestore: true }),
    {
      [RESTORE_ROUTE]: {
        body: { ok: true, session: { sessionId: 'session-alpha', title: 'Alpha', orphan: true, workspaceReattached: false } },
      },
    },
  )
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  assert.ok(textOf(tree).includes('工作区缺失'))
  const reveal = actionMenus(tree)[0].props.items.find((item) => item.key === 'reveal')
  assert.equal(reveal.disabled, true)
  assert.equal(reveal.ariaLabel, '在文件管理器中显示 — 原工作区已不存在')
  buttonByText(tree, '恢复').props.onClick()
  const afterClick = await mini.settle(section.component)
  const dialog = dialogOfKind(afterClick, 'orphan')
  assert.ok(dialog !== undefined)
  assert.ok(dialog.props.entry.originalCwd === '/tmp/demo')
  assert.equal(client.calls.filter((entry) => entry.pathname === RESTORE_ROUTE).length, 0)

  dialog.props.onConfirm()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = client.calls.find((entry) => entry.pathname === RESTORE_ROUTE)
  assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-alpha', mode: 'orphan' })
  assert.equal(client.toasts.at(-1).text, '已恢复为孤儿会话「Alpha」')
})

test('purging from the row menu asks for confirmation before deleting', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [PURGE_ROUTE]: { body: { ok: true, sessionId: 'session-alpha' } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const menus = actionMenus(tree)
  const purge = menus[0].props.items.find((item) => item.key === 'purge')
  purge.onSelect()
  const afterSelect = await mini.settle(section.component)
  const dialog = dialogOfKind(afterSelect, 'purge')
  assert.ok(dialog !== undefined)
  assert.equal(client.calls.filter((entry) => entry.pathname === PURGE_ROUTE).length, 0)
  dialog.props.onConfirm()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = client.calls.find((entry) => entry.pathname === PURGE_ROUTE)
  assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-alpha' })
  assert.equal(client.toasts.at(-1).text, '已永久删除「Alpha」')
})

test('the delete-all toolbar button asks for confirmation before purging the trash', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [PURGE_ALL_ROUTE]: { body: { ok: true, purged: 1, forgotten: 0, failed: 0 } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const purgeAll = buttonByText(tree, '永久删除全部')
  assert.ok(purgeAll !== undefined)
  purgeAll.props.onClick()
  const afterClick = await mini.settle(section.component)
  const dialog = dialogOfKind(afterClick, 'purgeAll')
  assert.ok(dialog !== undefined)
  assert.equal(dialog.props.count, 1)
  assert.equal(client.calls.filter((entry) => entry.pathname === PURGE_ALL_ROUTE).length, 0)

  dialog.props.onConfirm()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = client.calls.find((entry) => entry.pathname === PURGE_ALL_ROUTE)
  assert.ok(call !== undefined)
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.body, undefined)
  assert.equal(client.toasts.at(-1).text, '已永久删除 1 个会话')
  assert.equal(client.toasts.at(-1).success, true)
})

test('a partially failed delete-all reports both the removed and failed counts', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [PURGE_ALL_ROUTE]: { status: 200, body: { ok: true, purged: 1, forgotten: 0, failed: 1 } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  buttonByText(tree, '永久删除全部').props.onClick()
  const afterClick = await mini.settle(section.component)
  const dialog = dialogOfKind(afterClick, 'purgeAll')
  assert.ok(dialog !== undefined)
  dialog.props.onConfirm()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.toasts.at(-1).text, '批量删除完成：成功 1 个，失败 1 个。')
  assert.equal(client.toasts.at(-1).success, false)
  assert.equal(client.toasts.at(-1).success, false)
})

test('a corrupt index shows the recovery banner and rebuilds on demand', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayload()
  payload.index = { status: 'corrupt', updatedAt: 1, error: 'broken', unindexed: 0 }
  payload.entries = []
  payload.stats = { count: 0, totalBytes: 0, nextSweepAt: null }
  const client = createClient(factory, mini, payload, {
    [REBUILD_ROUTE]: { body: { ok: true, entries: 2, unindexed: 1 } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  assert.ok(textOf(tree).includes('回收站索引损坏，已进入保护模式。现有会话不会被自动修改。'))
  const rebuild = buttonByText(tree, '尝试重建索引')
  assert.ok(rebuild !== undefined)
  rebuild.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.calls.filter((entry) => entry.pathname === REBUILD_ROUTE).length, 1)
  assert.equal(client.toasts.at(-1).text, '索引已重建，共 2 个条目；1 个未索引对象已保留')
})

test('the empty trash renders its guidance copy', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayload()
  payload.entries = []
  payload.stats = { count: 0, totalBytes: 0, nextSweepAt: null }
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const text = textOf(tree)
  assert.ok(text.includes('回收站为空'))
  assert.ok(text.includes('在侧边栏右键会话，选择「移入回收站」。'))
  assert.equal(inputByLabel(tree, '搜索回收站'), undefined)
  const purgeAll = buttonByText(tree, '永久删除全部')
  assert.ok(purgeAll !== undefined)
  assert.equal(purgeAll.props.disabled, true)
})

test('a first-load failure shows only the error banner and retries into the list', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, (callCount) =>
    callCount === 1
      ? { status: 401, body: { ok: false, error: { code: 'FORBIDDEN' } } }
      : { status: 200, body: statePayload() },
  )
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  let text = textOf(tree)
  assert.ok(text.includes('连接已失效，请刷新页面。'))
  assert.ok(!text.includes('回收站为空'))
  assert.equal(inputByLabel(tree, '搜索回收站'), undefined)
  const retry = buttonByText(tree, '重试')
  assert.ok(retry !== undefined)

  retry.props.onClick()
  tree = await mini.settle(section.component)
  text = textOf(tree)
  assert.deepEqual(rowTitles(tree), ['Alpha'])
  assert.ok(inputByLabel(tree, '搜索回收站') !== undefined)
  assert.ok(!text.includes('连接已失效，请刷新页面。'))
})

test('search narrows the list by title, Session ID, or workspace', async () => {
  const { factory, mini } = await loadModule()
  const now = Date.now()
  const payload = statePayloadWith([
    makeEntry({ sessionId: 'session-alpha', title: 'Refactor login', originalCwd: '/work/login', trashedAt: now - 1000 }),
    makeEntry({ sessionId: 'session-beta', title: 'Fix navbar', originalCwd: '/work/site', trashedAt: now - 2000 }),
    makeEntry({ sessionId: 'session-gamma', title: 'Docs', originalCwd: '/work/legacy', trashedAt: now - 3000 }),
  ])
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Refactor login', 'Fix navbar', 'Docs'])
  assert.equal(inputByLabel(tree, '搜索回收站').props.placeholder, '搜索标题、Session ID 或原始工作区')

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'NAVBAR' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Fix navbar'])
  assert.ok(textOf(tree).includes('显示 1 / 3 个会话'))

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'session-gamma' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Docs'])

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: '/work/legacy' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Docs'])

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'refactor login' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Refactor login'])

  const clear = elementByClass(tree, 'dsh-trash__searchClear')
  assert.ok(clear !== undefined)
  assert.equal(clear.props['aria-label'], '清除搜索')
  clear.props.onClick()
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Refactor login', 'Fix navbar', 'Docs'])
  assert.equal(inputByLabel(tree, '搜索回收站').props.value, '')
})

test('search matches the recorded workspace title and member conversation titles', async () => {
  const { factory, mini } = await loadModule()
  const now = Date.now()
  const payload = statePayloadWith([
    makeEntry({
      sessionId: 'session-alpha',
      title: 'Alpha',
      originalCwd: '/work/alpha',
      originalWorkspaceTitle: 'Design System',
      trashedAt: now - 1000,
    }),
    makeEntry({
      sessionId: 'session-beta',
      title: 'Beta',
      originalCwd: '/work/beta',
      subagentCount: 1,
      members: [
        { sessionId: 'session-beta', origin: null, title: 'Beta', sizeBytes: 10 },
        { sessionId: 'session-beta-child', origin: 'subagent', title: 'Fix flaky test', sizeBytes: 5 },
      ],
      trashedAt: now - 2000,
    }),
  ])
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'design system' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Alpha'])

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'FLAKY' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Beta'])

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'work/beta' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Beta'])
})

test('workspace and expiry filters narrow the list', async () => {
  const { factory, mini } = await loadModule()
  const now = Date.now()
  const payload = statePayloadWith([
    makeEntry({
      sessionId: 'session-alpha',
      title: 'Alpha',
      originalCwd: '/work/alpha',
      workspaceNowExists: true,
      expiresAt: now + 20 * DAY,
      trashedAt: now - 1000,
    }),
    makeEntry({
      sessionId: 'session-beta',
      title: 'Beta',
      originalCwd: '/work/gone',
      workspaceNowExists: false,
      requiresOrphanRestore: true,
      expiresAt: now + 20 * DAY,
      trashedAt: now - 2000,
    }),
    makeEntry({
      sessionId: 'session-gamma',
      title: 'Gamma',
      originalCwd: null,
      workspaceExistsAtDeletion: null,
      workspaceNowExists: null,
      expiresAt: now + 2 * DAY,
      trashedAt: now - 3000,
    }),
  ])
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  assert.equal(radioByValue(tree, 'all').props.checked, true)

  radioByValue(tree, 'workspace-missing').props.onChange()
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Beta'])
  assert.equal(radioByValue(tree, 'workspace-missing').props.checked, true)
  assert.ok(textOf(tree).includes('已筛选出 1 个会话'))

  radioByValue(tree, 'workspace-exists').props.onChange()
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Alpha'])

  radioByValue(tree, 'expiring').props.onChange()
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Gamma'])

  radioByValue(tree, 'all').props.onChange()
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Alpha', 'Beta', 'Gamma'])
})

test('the list pages 50 rows at a time and returns to page one when searching', async () => {
  const { factory, mini } = await loadModule()
  const now = Date.now()
  const entries = Array.from({ length: 55 }, (_, index) =>
    makeEntry({
      sessionId: `session-${String(index).padStart(2, '0')}`,
      title: `Session ${index}`,
      trashedAt: now - index * 1000,
    }),
  )
  const client = createClient(factory, mini, statePayloadWith(entries))
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  assert.equal(elementsByClass(tree, 'dsh-trash__row').length, 50)
  assert.deepEqual(rowTitles(tree).slice(0, 2), ['Session 0', 'Session 1'])
  assert.ok(textOf(tree).includes('第 1 / 2 页'))
  assert.equal(buttonByText(tree, '上一页').props.disabled, true)
  assert.equal(buttonByText(tree, '下一页').props.disabled, false)
  assert.equal(elementByClass(tree, 'dsh-trash__pagination').props['aria-label'], '回收站分页')

  buttonByText(tree, '下一页').props.onClick()
  tree = await mini.settle(section.component)
  assert.equal(elementsByClass(tree, 'dsh-trash__row').length, 5)
  assert.deepEqual(rowTitles(tree), ['Session 50', 'Session 51', 'Session 52', 'Session 53', 'Session 54'])
  assert.ok(textOf(tree).includes('第 2 / 2 页'))
  assert.equal(buttonByText(tree, '下一页').props.disabled, true)
  assert.equal(buttonByText(tree, '上一页').props.disabled, false)

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'session-5' } })
  tree = await mini.settle(section.component)
  assert.equal(elementsByClass(tree, 'dsh-trash__row').length, 5)
  assert.equal(elementByClass(tree, 'dsh-trash__pagination'), undefined)
})

test('a search with no matches offers to clear the filters', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload())
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  const rowCountBefore = elementsByClass(tree, 'dsh-trash__row').length

  inputByLabel(tree, '搜索回收站').props.onChange({ target: { value: 'zzz' } })
  tree = await mini.settle(section.component)
  assert.equal(elementsByClass(tree, 'dsh-trash__row').length, 0)
  assert.ok(textOf(tree).includes('没有匹配的会话'))
  const clear = buttonByText(tree, '清除筛选')
  assert.ok(clear !== undefined)

  clear.props.onClick()
  tree = await mini.settle(section.component)
  assert.equal(elementsByClass(tree, 'dsh-trash__row').length, rowCountBefore)
  assert.equal(inputByLabel(tree, '搜索回收站').props.value, '')
  assert.equal(radioByValue(tree, 'all').props.checked, true)
})

test('the settings page stylesheet uses theme tokens rather than literal colours', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload())
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  let css = ''
  walk(tree, (element) => {
    if (element.type === 'style') css = element.children.join('')
  })
  assert.ok(css.length > 0)
  assert.ok(css.includes('var(--dsw-alias-'))
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/)
})

test('the page exposes accessible names for search, filters, and row actions', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload())
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)

  assert.equal(inputByLabel(tree, '搜索回收站').props['aria-label'], '搜索回收站')
  let group
  walk(tree, (element) => {
    if (element.props.role === 'radiogroup') group = element
  })
  assert.ok(group !== undefined)
  assert.equal(group.props['aria-label'], '筛选回收站')
  assert.deepEqual(
    elementsByClass(tree, 'dsh-trash__filterLabel').map((label) => label.children.join('')),
    ['全部', '工作区仍存在', '工作区缺失', '即将到期'],
  )
  assert.equal(radioByValue(tree, 'all').props.checked, true)

  const restore = buttonByText(tree, '恢复')
  assert.ok(restore !== undefined)
  assert.equal(restore.props['aria-label'], '恢复「Alpha」')
  assert.equal(actionMenus(tree)[0].props.label, '「Alpha」的更多操作')
})

test('failed automatic cleanup shows a warning banner and retries on demand', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayloadWith([makeEntry({ title: 'Alpha' })])
  const now = Date.now()
  payload.stats.cleanup = {
    enabled: true,
    timerBacked: true,
    lastAttemptAt: now - 1000,
    lastSuccessAt: now - 1000,
    nextSweepAt: now + 3600_000,
    retryAt: now + 60_000,
    consecutiveFailures: 1,
    lastRun: {
      at: now - 1000,
      reason: 'interval',
      purged: 0,
      failed: 2,
      settled: 0,
      allowPurge: true,
      durationMs: 5,
      error: null,
    },
  }
  const client = createClient(factory, mini, payload, {
    [CLEANUP_ROUTE]: { body: { ok: true, purged: 0, failed: 0, settled: 0 } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const text = textOf(tree)
  assert.ok(text.some((value) => value.includes('上次自动清理有 2 个会话未能删除')))
  assert.ok(text.some((value) => value.includes('将在')))
  const retry = buttonByText(tree, '立即重试')
  assert.ok(retry !== undefined)
  retry.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.calls.filter((entry) => entry.pathname === CLEANUP_ROUTE).length, 1)
})

test('a healthy cleanup run renders no failure banner', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayload()
  payload.stats.cleanup = {
    enabled: true,
    timerBacked: true,
    lastAttemptAt: Date.now() - 1000,
    lastSuccessAt: Date.now() - 1000,
    nextSweepAt: Date.now() + 3600_000,
    retryAt: null,
    consecutiveFailures: 0,
    lastRun: { at: Date.now() - 1000, reason: 'interval', purged: 0, failed: 0, settled: 0, durationMs: 1, error: null },
  }
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  assert.equal(textOf(tree).some((value) => value.includes('上次自动清理有')), false)
})

test('a thrown automatic cleanup shows its error in the warning banner', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayload()
  payload.stats.cleanup = {
    enabled: true,
    timerBacked: true,
    lastAttemptAt: Date.now() - 1000,
    lastSuccessAt: null,
    nextSweepAt: Date.now() + 3600_000,
    retryAt: Date.now() + 60_000,
    consecutiveFailures: 1,
    lastRun: {
      at: Date.now() - 1000,
      reason: 'interval',
      purged: 0,
      failed: 0,
      settled: 0,
      allowPurge: true,
      durationMs: 3,
      error: 'index unavailable',
    },
  }
  const client = createClient(factory, mini, payload, {
    [CLEANUP_ROUTE]: { body: { ok: true, purged: 0, failed: 0, settled: 0 } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const text = textOf(tree)
  assert.ok(text.some((value) => value.includes('上次自动清理失败，请稍后在本页重试。')))
  let errorBanner
  walk(tree, (element) => {
    if (errorBanner === undefined && element.props.title === 'index unavailable') errorBanner = element
  })
  assert.ok(errorBanner !== undefined)
  const retry = buttonByText(tree, '立即重试')
  assert.ok(retry !== undefined)
  retry.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.calls.filter((entry) => entry.pathname === CLEANUP_ROUTE).length, 1)
})

test('copying a Session ID writes the clipboard and reports success', async () => {
  const { factory, mini } = await loadModule()
  let copied = null
  const originalNavigator = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { async writeText(value) { copied = value } } },
  })
  try {
    const client = createClient(factory, mini, statePayload())
    const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
    const tree = await mini.settle(section.component)
    const copy = actionMenus(tree)[0].props.items.find((item) => item.key === 'copy')
    copy.onSelect()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(copied, 'session-alpha')
    assert.equal(client.toasts.at(-1).text, '已复制 Session ID')
    assert.equal(client.toasts.at(-1).success, true)
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
  }
})

test('revealing the original workspace posts the session and reports success', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [REVEAL_ROUTE]: { body: { ok: true, opened: true } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const reveal = actionMenus(tree)[0].props.items.find((item) => item.key === 'reveal')
  assert.equal(reveal.disabled, false)
  reveal.onSelect()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = client.calls.find((entry) => entry.pathname === REVEAL_ROUTE)
  assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-alpha' })
  assert.equal(client.toasts.at(-1).text, '已在文件管理器中显示原工作区')
})

test('forgetting a missing record asks for confirmation and removes it', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(
    factory,
    mini,
    statePayload({
      state: 'missing',
      canRestore: false,
      canPurge: false,
      canForget: true,
      expiresAt: null,
      lastError: 'The trash copy is missing.',
    }),
    { [FORGET_ROUTE]: { body: { ok: true, sessionId: 'session-alpha' } } },
  )
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const forget = actionMenus(tree)[0].props.items.find((item) => item.key === 'forget')
  forget.onSelect()
  const afterSelect = await mini.settle(section.component)
  const dialog = dialogOfKind(afterSelect, 'forget')
  assert.ok(dialog !== undefined)
  assert.equal(client.calls.filter((entry) => entry.pathname === FORGET_ROUTE).length, 0)
  dialog.props.onConfirm()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = client.calls.find((entry) => entry.pathname === FORGET_ROUTE)
  assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-alpha' })
  assert.equal(client.toasts.at(-1).text, '已从回收站列表移除')
})

test('a row write blocks every other write until its own request settles', async (t) => {
  const { factory, mini } = await loadModule()
  const now = Date.now()
  const payload = statePayloadWith([
    makeEntry({ sessionId: 'session-alpha', title: 'Alpha', trashedAt: now - 1000 }),
    makeEntry({ sessionId: 'session-beta', title: 'Beta', trashedAt: now - 2000 }),
  ])
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  t.after(() => release({ status: 500, body: { ok: false } }))
  const client = createClient(factory, mini, payload, { [RESTORE_ROUTE]: () => pending })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)

  buttonWithin(rowByTitle(tree, 'Alpha'), '恢复').props.onClick()
  tree = await mini.settle(section.component)
  const restoreCalls = () => client.calls.filter((entry) => entry.pathname === RESTORE_ROUTE).length
  assert.equal(restoreCalls(), 1)
  assert.equal(buttonWithin(rowByTitle(tree, 'Alpha'), '恢复').props.disabled, true)
  assert.equal(buttonWithin(rowByTitle(tree, 'Beta'), '恢复').props.disabled, true)
  const menus = actionMenus(tree)
  assert.equal(menus[0].props.disabled, true)
  assert.equal(buttonByText(tree, '清理已过期').props.disabled, true)
  assert.equal(buttonByText(tree, '永久删除全部').props.disabled, true)

  // A programmatic second click must be ignored instead of racing the Host lock.
  buttonWithin(rowByTitle(tree, 'Beta'), '恢复').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(restoreCalls(), 1)
  assert.equal(client.toasts.length, 0)

  release({ status: 200, body: { ok: true, session: { sessionId: 'session-alpha', title: 'Alpha', orphan: false } } })
  tree = await mini.settle(section.component)
  assert.equal(client.toasts.at(-1).text, '已恢复「Alpha」')
  assert.equal(client.toasts.at(-1).success, true)
  // The pending gate belongs to the finished request, so both rows recover.
  assert.equal(buttonWithin(rowByTitle(tree, 'Alpha'), '恢复').props.disabled, false)
  assert.equal(buttonWithin(rowByTitle(tree, 'Beta'), '恢复').props.disabled, false)
})

test('protection mode blocks row writes but keeps the rebuild action available', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayload()
  payload.index = { status: 'corrupt', updatedAt: 1, error: 'broken', unindexed: 0 }
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  assert.equal(buttonWithin(rowByTitle(tree, 'Alpha'), '恢复').props.disabled, true)
  assert.equal(actionMenus(tree)[0].props.disabled, true)
  assert.equal(buttonByText(tree, '清理已过期').props.disabled, true)
  assert.equal(buttonByText(tree, '永久删除全部').props.disabled, true)
  assert.equal(buttonByText(tree, '尝试重建索引').props.disabled, false)
})

test('a maintenance write disables the other maintenance actions', async (t) => {
  const { factory, mini } = await loadModule()
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  t.after(() => release({ status: 500, body: { ok: false } }))
  const client = createClient(factory, mini, statePayload(), { [CLEANUP_ROUTE]: () => pending })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)

  buttonByText(tree, '清理已过期').props.onClick()
  tree = await mini.settle(section.component)
  assert.equal(buttonByText(tree, '正在清理…').props.disabled, true)
  assert.equal(buttonByText(tree, '永久删除全部').props.disabled, true)
  // Refreshing is a read; it stays available while the write runs.
  assert.equal(buttonByText(tree, '刷新').props.disabled, false)

  release({ status: 200, body: { ok: true, purged: 0, failed: 0 } })
  tree = await mini.settle(section.component)
  assert.equal(client.toasts.at(-1).text, '没有需要清理的过期会话')
  assert.equal(buttonByText(tree, '永久删除全部').props.disabled, false)
})

test('unmounting the settings section cancels an in-flight write', async (t) => {
  const { factory, mini } = await loadModule()
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  t.after(() => release({ status: 500, body: { ok: false } }))
  const client = createClient(factory, mini, statePayload(), { [RESTORE_ROUTE]: () => pending })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)

  buttonByText(tree, '恢复').props.onClick()
  const call = client.calls.find((entry) => entry.pathname === RESTORE_ROUTE)
  assert.ok(call !== undefined)
  assert.equal(call.options.signal.aborted, false)
  mini.unmount()
  assert.equal(call.options.signal.aborted, true)

  release({ status: 200, body: { ok: true, session: { sessionId: 'session-alpha', title: 'Alpha', orphan: false } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  // A late response after unmount must not toast or write state.
  assert.equal(client.toasts.length, 0)
})

test('a stalled write times out with a localized message and releases the gate', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [RESTORE_ROUTE]: (options) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (options.signal === undefined) return
        if (options.signal.aborted) abort()
        else options.signal.addEventListener('abort', abort, { once: true })
      }),
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  const originalSetTimeout = globalThis.setTimeout
  try {
    // Compress only the request budget; the renderer's settle delay stays short.
    globalThis.setTimeout = (callback, delay, ...args) =>
      originalSetTimeout(callback, typeof delay === 'number' && delay >= 1000 ? 0 : delay, ...args)
    buttonByText(tree, '恢复').props.onClick()
    await new Promise((resolve) => originalSetTimeout(resolve, 40))
    const after = await mini.settle(section.component)
    assert.equal(client.toasts.at(-1).text, '请求超时，请重试。')
    assert.equal(client.toasts.at(-1).success, false)
    assert.equal(buttonByText(after, '恢复').props.disabled, false)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('a cleanup that deletes nothing but fails reports a failure Toast', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload(), {
    [CLEANUP_ROUTE]: { body: { ok: true, purged: 0, failed: 2, settled: 0 } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  buttonByText(tree, '清理已过期').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.toasts.at(-1).text, '清理失败：还有 2 个过期会话没有删除。')
  assert.equal(client.toasts.at(-1).success, false)
})

test('a successful retry clears the failed reveal row error', async () => {
  const { factory, mini } = await loadModule()
  let attempts = 0
  const client = createClient(factory, mini, statePayload(), {
    [REVEAL_ROUTE]: () => {
      attempts += 1
      if (attempts === 1) return { status: 500, body: { ok: false, error: { code: 'REVEAL_FAILED' } } }
      return { status: 200, body: { ok: true, opened: true } }
    },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  const reveal = () => actionMenus(tree)[0].props.items.find((item) => item.key === 'reveal')
  reveal().onSelect()
  tree = await mini.settle(section.component)
  assert.ok(textOf(tree).some((value) => value.includes('上次错误：无法打开原工作区。')))

  reveal().onSelect()
  tree = await mini.settle(section.component)
  assert.equal(client.toasts.at(-1).text, '已在文件管理器中显示原工作区')
  assert.equal(textOf(tree).some((value) => value.includes('上次错误：')), false)
})

test('an entry without a measured size shows an unknown size instead of zero', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayloadWith([makeEntry({ sizeBytes: null })]))
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  assert.ok(textOf(tree).some((value) => value.includes('—')))
})

test('the first successful load asks for one maintenance sweep', async () => {
  const { factory, mini } = await loadModule()
  const client = createClient(factory, mini, statePayload())
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  await mini.settle(section.component)
  assert.equal(client.calls.filter((entry) => entry.pathname === SWEEP_ROUTE).length, 1)
})

test('an unindexed banner offers a safe cleanup for empty leftovers', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayload()
  payload.index = { status: 'ok', updatedAt: Date.now(), error: null, unindexed: 2 }
  const client = createClient(factory, mini, payload, {
    [ORPHANS_ROUTE]: { status: 200, body: { ok: true, removed: 2 } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  assert.ok(textOf(tree).some((value) => value.includes('2 个未索引对象')))
  const clean = buttonByText(tree, '清理空目录')
  assert.ok(clean !== undefined)
  clean.props.onClick()
  const afterClick = await mini.settle(section.component)
  const dialog = dialogOfKind(afterClick, 'orphans')
  assert.ok(dialog !== undefined)
  assert.equal(client.calls.filter((entry) => entry.pathname === ORPHANS_ROUTE).length, 0)
  dialog.props.onConfirm()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = client.calls.find((entry) => entry.pathname === ORPHANS_ROUTE)
  assert.ok(call !== undefined)
  assert.equal(call.options.method, 'POST')
  assert.equal(client.toasts.at(-1).text, '已清理 2 个空的无主对象')
  assert.equal(client.toasts.at(-1).success, true)
})

test('a LOCKED write is retried once before reporting success', async () => {
  const { factory, mini } = await loadModule()
  let attempts = 0
  const client = createClient(factory, mini, statePayload(), {
    [RESTORE_ROUTE]: () => {
      attempts += 1
      if (attempts === 1) return { status: 409, body: { ok: false, error: { code: 'LOCKED' } } }
      return { status: 200, body: { ok: true, session: { sessionId: 'session-alpha', title: 'Alpha', orphan: false } } }
    },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  buttonByText(tree, '恢复').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(client.calls.filter((entry) => entry.pathname === RESTORE_ROUTE).length, 2)
  assert.equal(client.toasts.at(-1).text, '已恢复「Alpha」')
  assert.equal(client.toasts.at(-1).success, true)
})

test('the list can be sorted by title, size, and expiry', async () => {
  const { factory, mini } = await loadModule()
  const now = Date.now()
  const payload = statePayloadWith([
    makeEntry({ sessionId: 'session-beta', title: 'Beta', trashedAt: now - 1000, sizeBytes: 50, expiresAt: now + 30 * DAY }),
    makeEntry({ sessionId: 'session-alpha', title: 'Alpha', trashedAt: now - 2000, sizeBytes: 500, expiresAt: now + 10 * DAY }),
    makeEntry({ sessionId: 'session-gamma', title: 'Gamma', trashedAt: now - 3000, sizeBytes: 5, expiresAt: now + 20 * DAY }),
  ])
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Beta', 'Alpha', 'Gamma'])

  const sort = selectByLabel(tree, '排序方式')
  assert.ok(sort !== undefined)
  sort.props.onChange({ target: { value: 'title' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Alpha', 'Beta', 'Gamma'])

  selectByLabel(tree, '排序方式').props.onChange({ target: { value: 'size' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Alpha', 'Beta', 'Gamma'])

  selectByLabel(tree, '排序方式').props.onChange({ target: { value: 'expires' } })
  tree = await mini.settle(section.component)
  assert.deepEqual(rowTitles(tree), ['Alpha', 'Gamma', 'Beta'])
})

test('rows can be selected and restored as a batch', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayloadWith([
    makeEntry({ sessionId: 'session-alpha', title: 'Alpha' }),
    makeEntry({ sessionId: 'session-beta', title: 'Beta' }),
  ])
  const client = createClient(factory, mini, payload, {
    [RESTORE_ROUTE]: { status: 200, body: { ok: true, session: { sessionId: 'session-alpha', title: 'Alpha' } } },
  })
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)

  const alphaCheck = inputByLabel(tree, '选择「Alpha」')
  assert.ok(alphaCheck !== undefined)
  alphaCheck.props.onChange({ target: { checked: true } })
  tree = await mini.settle(section.component)
  assert.ok(textOf(tree).some((value) => value.includes('已选择 1 个会话')))
  assert.ok(buttonByText(tree, '恢复选中') !== undefined)

  buttonByText(tree, '恢复选中').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const calls = client.calls.filter((entry) => entry.pathname === RESTORE_ROUTE)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId: 'session-alpha', mode: 'normal' })
  assert.equal(client.toasts.at(-1).text, '已恢复 1 个会话')
  assert.equal(client.toasts.at(-1).success, true)

  tree = await mini.settle(section.component)
  assert.equal(textOf(tree).some((value) => value.includes('已选择')), false)

  // Select-all covers every selectable row on the page.
  inputByLabel(tree, '全选本页可选会话').props.onChange({ target: { checked: true } })
  tree = await mini.settle(section.component)
  assert.ok(textOf(tree).some((value) => value.includes('已选择 2 个会话')))
  buttonByText(tree, '取消选择').props.onClick()
  tree = await mini.settle(section.component)
  assert.equal(textOf(tree).some((value) => value.includes('已选择')), false)
})

test('rows whose workspace is gone are not part of a batch selection', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayload({ workspaceNowExists: false, requiresOrphanRestore: true })
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  const tree = await mini.settle(section.component)
  assert.equal(inputByLabel(tree, '选择「Alpha」'), undefined)
  const selectAll = inputByLabel(tree, '全选本页可选会话')
  assert.equal(selectAll.props.disabled, true)
})

test('a sub-session row expands into its member list with conversation titles', async () => {
  const { factory, mini } = await loadModule()
  const payload = statePayloadWith([
    makeEntry({
      sessionId: 'session-parent',
      title: 'Parent',
      subagentCount: 2,
      members: [
        { sessionId: 'session-parent', origin: null, title: 'Parent conversation', sizeBytes: 1024 },
        { sessionId: 'session-parent-child', origin: 'subagent', title: 'Child task', sizeBytes: 512 },
        // A blank title and a title equal to the Session ID are not worth showing.
        { sessionId: 'session-parent-child-2', origin: 'subagent', title: '  ', sizeBytes: 256 },
        { sessionId: 'session-parent-child-3', origin: 'subagent', title: 'session-parent-child-3', sizeBytes: 128 },
      ],
    }),
  ])
  const client = createClient(factory, mini, payload)
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  let tree = await mini.settle(section.component)
  assert.ok(buttonByText(tree, '展开子会话') !== undefined)
  assert.equal(textOf(tree).some((value) => value.includes('session-parent-child')), false)

  buttonByText(tree, '展开子会话').props.onClick()
  tree = await mini.settle(section.component)
  assert.ok(textOf(tree).some((value) => value.includes('session-parent-child')))
  const memberTitles = elementsByClass(tree, 'dsh-trash__memberTitle')
  assert.deepEqual(
    memberTitles.map((node) => node.children.join('')),
    ['Parent conversation', 'Child task'],
  )
  assert.deepEqual(
    memberTitles.map((node) => node.props.title),
    ['Parent conversation', 'Child task'],
  )
  assert.equal(elementsByClass(tree, 'dsh-trash__memberSize').length, 4)
  assert.ok(buttonByText(tree, '收起子会话') !== undefined)
})

test('a revision from another window reloads the trash list', async () => {
  const { factory, mini } = await loadModule()
  const instances = []
  class FakeChannel {
    constructor(name) {
      this.name = name
      this.listeners = []
      this.posted = []
      instances.push(this)
    }
    addEventListener(type, callback) {
      if (type === 'message') this.listeners.push(callback)
    }
    postMessage(data) {
      this.posted.push(data)
    }
    close() {}
  }
  globalThis.window.BroadcastChannel = FakeChannel
  const client = createClient(factory, mini, statePayload())
  const section = client.slots.find((entry) => entry.definition.name === 'settings.section')
  await mini.settle(section.component)
  assert.equal(instances.length, 1)
  const before = client.calls.filter((entry) => entry.pathname === STATE_ROUTE).length
  instances[0].listeners[0]({ data: { type: 'revision' } })
  await mini.settle(section.component)
  assert.equal(client.calls.filter((entry) => entry.pathname === STATE_ROUTE).length, before + 1)
})
