/**
 * Real-DOM tests for the interactive Client pieces that the mini-React tests
 * cannot reach: the row ActionMenu and the ConfirmDialog focus/keyboard
 * behavior. Uses jsdom plus real React, with the plugin loaded through the
 * same `window.__ModuleLoader__` contract the harness uses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const CLIENT_PATH = path.resolve('client.js')
const STATE_ROUTE = '/plugins/dsh-session-trash/api/state'
const RESTORE_ROUTE = '/plugins/dsh-session-trash/api/restore'
const PURGE_ROUTE = '/plugins/dsh-session-trash/api/purge'
const REVEAL_ROUTE = '/plugins/dsh-session-trash/api/reveal'
const WORKSPACE_STATUS_ROUTE = '/plugins/dsh-session-trash/api/workspace-status'
const FORGET_ROUTE = '/plugins/dsh-session-trash/api/forget'
const RECLAIM_PREVIEW_ROUTE = '/plugins/dsh-session-trash/api/reclaim/preview'
const RECLAIM_ROUTE = '/plugins/dsh-session-trash/api/reclaim'

const DAY = 86_400_000

/**
 * @param {object} [overrides] entry overrides.
 * @returns {object} one wire entry.
 */
function makeEntry(overrides = {}) {
  const now = Date.now()
  return {
    sessionId: 'session-alpha',
    title: 'Alpha',
    trashedAt: now - 1000,
    expiresAt: now + 20 * DAY,
    originalCwd: '/tmp/demo',
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
    lastErrorCode: null,
    subagentCount: 0,
    members: [{ sessionId: 'session-alpha', origin: null, sizeBytes: 1024 }],
    ...overrides,
  }
}

/**
 * @param {object[]} [entries] wire entries.
 * @returns {object} a `/state` payload.
 */
function statePayload(entries = [makeEntry()]) {
  const now = Date.now()
  return {
    version: 1,
    config: { retentionDays: 30, sweepIntervalHours: 6, enableAutoCleanup: true },
    trashRootDisplay: '$DSH_HOME/.session-trash',
    index: { status: 'ok', updatedAt: now, error: null, unindexed: 0 },
    entries,
    stats: {
      count: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
      nextSweepAt: null,
      cleanup: null,
    },
  }
}

/**
 * @param {object} options harness options.
 * @param {object | Function} [options.payload] `/state` answer.
 * @param {Record<string, object | Function>} [options.routes] extra endpoint answers.
 * @param {object[]} [options.intervals] captures `window.setInterval` registrations.
 * @returns {Promise<object>} the mounted harness.
 */
async function mount({ payload = statePayload(), routes = {}, intervals } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  const { window } = dom
  if (Array.isArray(intervals)) {
    let nextId = 0
    window.setInterval = (callback, delay) => {
      nextId += 1
      intervals.push({ id: nextId, callback, delay })
      return nextId
    }
    window.clearInterval = () => {}
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: window.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Element = window.Element
  globalThis.Node = window.Node
  globalThis.Event = window.Event
  globalThis.MouseEvent = window.MouseEvent
  globalThis.KeyboardEvent = window.KeyboardEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url), window.location.href).pathname
    calls.push({ pathname, options })
    let answer
    if (pathname === STATE_ROUTE) {
      answer = typeof payload === 'function' ? payload(calls) : { status: 200, body: payload }
    } else if (routes[pathname] !== undefined) {
      answer = typeof routes[pathname] === 'function' ? routes[pathname](options) : routes[pathname]
    } else {
      answer = { status: 200, body: { ok: true } }
    }
    answer = await answer
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    }
  }

  const loaded = []
  window.__ModuleLoader__ = {
    load(module) {
      loaded.push(module)
    },
  }
  await import(`${pathToFileURL(CLIENT_PATH).href}?dom=${Math.random()}`)
  assert.equal(loaded.length, 1)

  const dictionaries = {}
  const slots = []
  const toasts = []
  const locale = {
    register(namespace, dicts) {
      dictionaries[namespace] = dicts
      return () => {}
    },
    bind(namespace) {
      return (key) => dictionaries[namespace]?.zh?.[key] ?? key
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
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() {
      return undefined
    },
    locale,
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
      register() {
        return () => {}
      },
      notify(text, success, action) {
        toasts.push({ text, success, action })
      },
    },
  }
  const module = loaded[0].factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected module ${name}`)
  })
  module.apply(ctx)
  const section = slots.find((entry) => entry.definition.name === 'settings.section')
  assert.ok(section !== undefined)

  const container = window.document.getElementById('root')
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(section.component))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  return {
    window,
    document: window.document,
    container,
    calls,
    toasts,
    /**
     * @returns {Promise<void>} unmount the tree and close the DOM.
     */
    async dispose() {
      await act(async () => {
        root.unmount()
      })
      dom.window.close()
    },
  }
}

/**
 * @param {object} window jsdom window.
 * @param {object} element event target.
 * @returns {object} the dispatched click event.
 */
function click(window, element) {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
  element.dispatchEvent(event)
  return event
}

/**
 * @param {object} window jsdom window.
 * @param {object} element event target.
 * @param {string} keyName key value.
 * @param {{ shiftKey?: boolean }} [options] modifier state.
 * @returns {object} the dispatched keydown event.
 */
function keydown(window, element, keyName, options = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  element.dispatchEvent(event)
  return event
}

/**
 * @param {object} container DOM root.
 * @param {string} label accessible name.
 * @returns {object | undefined} the element.
 */
function byAriaLabel(container, label) {
  return [...container.querySelectorAll('[aria-label]')].find(
    (element) => element.getAttribute('aria-label') === label,
  )
}

/**
 * @param {object} container DOM root.
 * @param {string} text exact text content.
 * @returns {object | undefined} the matching button.
 */
function buttonByText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
}

test('the reclaim dialog previews, requires the phrase, and deletes', async () => {
  const payload = statePayload()
  payload.storage = {
    measuredAt: Date.now(),
    totalBytes: 9 * 1024 * 1024,
    sessionLogs: { count: 1, bytes: 1024 * 1024 },
    trashLogs: { count: 1, bytes: 1024 },
    attachments: {
      files: 2,
      bytes: 6 * 1024 * 1024,
      complete: true,
      referencedBytes: 5 * 1024 * 1024,
      orphanBytes: 1024 * 1024,
      eligibleOrphanBytes: 1024 * 1024,
      unclassifiedBytes: 0,
      scan: { status: 'complete', at: Date.now(), scannedFiles: 2, failedFiles: 0, failedDirs: 0, tornFiles: 0 },
    },
    attachmentCache: { files: 0, bytes: 0 },
    projectionCache: { records: 0, bytes: 0, sweepableRecords: 0, sweepableBytes: 0 },
  }
  const harness = await mount({
    payload,
    routes: {
      [RECLAIM_PREVIEW_ROUTE]: {
        body: {
          ok: true,
          eligible: true,
          plan: {
            id: 'plan-1',
            createdAt: Date.now(),
            expiresAt: Date.now() + 900_000,
            totals: { hashes: 1, bytes: 1024 },
            byStore: { objects: 1, fileObjects: 0, files: 0, requestImages: 0, unknown: 0 },
            scan: { status: 'complete', at: Date.now(), scannedFiles: 2, failedFiles: 0, failedDirs: 0, tornFiles: 0 },
          },
        },
      },
      [RECLAIM_ROUTE]: {
        body: { ok: true, planId: 'plan-1', deleted: { hashes: 1, bytes: 1024 }, skipped: [], failed: [], stale: false },
      },
    },
  })
  const originalSetTimeout = globalThis.setTimeout
  const delays = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (typeof delay === 'number') delays.push(delay)
    return originalSetTimeout(callback, delay, ...args)
  }
  try {
    const { container, document, window, calls, toasts } = harness
    const open = buttonByText(container, '清理无引用附件…')
    assert.ok(open !== undefined)
    await act(async () => {
      click(window, open)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog !== null)
    assert.ok(dialog.textContent.includes('将删除 1 个附件对象，释放 1 KB。'))
    // A full-viewport overlay must declare its own macOS window-drag region.
    assert.equal(dialog.closest('.dsh-trash__overlay')?.getAttribute('data-window-drag-exclude'), 'true')
    const input = dialog.querySelector('.dsh-trash__reclaimInput')
    assert.ok(input !== null)
    const confirm = buttonByText(dialog, '永久删除')
    assert.equal(confirm.disabled, true)
    // React 19 in jsdom does not expose the removed test-utils Simulate API;
    // invoke the controlled input's handler directly to exercise the state.
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'))
    assert.ok(reactPropsKey !== undefined)
    await act(async () => {
      input[reactPropsKey].onChange({ target: { value: '删除附件' } })
    })
    const updatedDialog = document.querySelector('[role="dialog"]')
    const enabled = buttonByText(updatedDialog, '永久删除')
    assert.equal(enabled.disabled, false)
    await act(async () => {
      click(window, enabled)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const call = calls.find((entry) => entry.pathname === RECLAIM_ROUTE)
    assert.ok(call !== undefined)
    assert.deepEqual(JSON.parse(call.options.body), {
      planId: 'plan-1',
      confirmation: 'delete-unreferenced-attachments',
    })
    assert.ok(toasts.at(-1).text.includes('已删除 1 个无引用附件，释放 1 KB'))
    assert.ok(delays.includes(120_000))
  } finally {
    globalThis.setTimeout = originalSetTimeout
    await harness.dispose()
  }
})

test('the row menu handles arrow keys, Tab, outside clicks, and Escape', async () => {
  const harness = await mount()
  try {
    const { container, document } = harness
    const trigger = byAriaLabel(container, '「Alpha」的更多操作')
    assert.ok(trigger !== undefined)
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')

    await act(async () => {
      click(harness.window, trigger)
    })
    const menu = container.querySelector('[role="menu"]')
    assert.ok(menu !== null)
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    // The fixed-positioned popup declares its own macOS window-drag region.
    assert.equal(menu.getAttribute('data-window-drag-exclude'), 'true')
    const menuItems = [...menu.querySelectorAll('[role="menuitem"]')]
    assert.equal(menuItems.length, 3)
    assert.equal(document.activeElement, menuItems[0])

    await act(async () => {
      keydown(harness.window, menuItems[0], 'ArrowDown')
    })
    assert.equal(document.activeElement, menuItems[1])
    await act(async () => {
      keydown(harness.window, menuItems[1], 'ArrowUp')
    })
    assert.equal(document.activeElement, menuItems[0])

    // Escape closes the menu, returns focus to the trigger, and does not bubble
    // into the settings modal that hosts this section.
    let bubbled = false
    const listener = () => {
      bubbled = true
    }
    document.addEventListener('keydown', listener)
    await act(async () => {
      keydown(harness.window, document.activeElement, 'Escape')
    })
    document.removeEventListener('keydown', listener)
    assert.equal(bubbled, false)
    assert.equal(container.querySelector('[role="menu"]'), null)
    assert.equal(document.activeElement, trigger)

    // Tab closes the open menu and leaves the default focus movement alone.
    await act(async () => {
      click(harness.window, trigger)
    })
    assert.ok(container.querySelector('[role="menu"]') !== null)
    let tabEvent
    await act(async () => {
      tabEvent = keydown(harness.window, document.activeElement, 'Tab')
    })
    assert.equal(tabEvent.defaultPrevented, false)
    assert.equal(container.querySelector('[role="menu"]'), null)

    // A pointer press outside the menu closes it as well.
    await act(async () => {
      click(harness.window, trigger)
    })
    assert.ok(container.querySelector('[role="menu"]') !== null)
    await act(async () => {
      harness.window.document.body.dispatchEvent(
        new harness.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      )
    })
    assert.equal(container.querySelector('[role="menu"]'), null)
  } finally {
    await harness.dispose()
  }
})

test('the confirm dialog traps focus, closes on Escape, and restores the opener', async () => {
  const harness = await mount({
    routes: {
      [PURGE_ROUTE]: { status: 200, body: { ok: true, sessionId: 'session-alpha' } },
    },
  })
  try {
    const { container, document } = harness
    const trigger = byAriaLabel(container, '「Alpha」的更多操作')
    await act(async () => {
      click(harness.window, trigger)
    })
    const purgeItem = [...container.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent.trim() === '永久删除',
    )
    assert.ok(purgeItem !== undefined)
    await act(async () => {
      click(harness.window, purgeItem)
    })

    const dialog = container.querySelector('[role="dialog"]')
    assert.ok(dialog !== null)
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(dialog.closest('.dsh-trash__overlay')?.getAttribute('data-window-drag-exclude'), 'true')
    const cancel = buttonByText(dialog, '取消')
    const confirm = [...dialog.querySelectorAll('button')].at(-1)
    assert.equal(document.activeElement, cancel)

    await act(async () => {
      confirm.focus()
      keydown(harness.window, confirm, 'Tab')
    })
    assert.equal(document.activeElement, cancel)

    await act(async () => {
      keydown(harness.window, cancel, 'Tab', { shiftKey: true })
    })
    assert.equal(document.activeElement, confirm)

    await act(async () => {
      keydown(harness.window, document.activeElement, 'Escape')
    })
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.equal(document.activeElement, trigger)

    // Confirming closes the dialog and reports the deletion through the shared Toast.
    await act(async () => {
      click(harness.window, trigger)
    })
    const reopenPurge = [...container.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent.trim() === '永久删除',
    )
    await act(async () => {
      click(harness.window, reopenPurge)
    })
    const reopened = container.querySelector('[role="dialog"]')
    const confirmAgain = [...reopened.querySelectorAll('button')].at(-1)
    await act(async () => {
      click(harness.window, confirmAgain)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.equal(harness.toasts.at(-1).text, '已永久删除「Alpha」')
    assert.equal(harness.toasts.at(-1).success, true)
  } finally {
    await harness.dispose()
  }
})

test('the orphan confirmation only claims the workspace is missing when the Host says so', async () => {
  const harness = await mount({
    payload: statePayload([makeEntry({ workspaceNowExists: false, requiresOrphanRestore: true })]),
    routes: {
      [RESTORE_ROUTE]: (options) => {
        const body = JSON.parse(options.body)
        if (body.mode === 'normal') {
          return { status: 409, body: { ok: false, error: { code: 'WORKSPACE_MISSING' } } }
        }
        return {
          status: 200,
          body: {
            ok: true,
            session: { sessionId: 'session-alpha', title: 'Alpha', orphan: true, workspaceReattached: false },
          },
        }
      },
    },
  })
  try {
    const { container, window, calls, toasts } = harness
    const trigger = byAriaLabel(container, '「Alpha」的更多操作')
    await act(async () => {
      click(window, trigger)
    })
    const orphan = [...container.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent.trim() === '恢复为孤儿会话',
    )
    assert.ok(orphan !== undefined)
    await act(async () => {
      click(window, orphan)
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const dialog = container.querySelector('[role="dialog"]')
    assert.ok(dialog !== null)
    assert.ok(dialog.textContent.includes('原工作区不存在'))
    assert.ok(dialog.textContent.includes('「/tmp/demo」已不存在'))

    const confirm = [...dialog.querySelectorAll('button')].at(-1)
    await act(async () => {
      click(window, confirm)
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.deepEqual(
      calls.filter((call) => call.pathname === RESTORE_ROUTE).map((call) => JSON.parse(call.options.body).mode),
      ['normal', 'orphan'],
    )
    assert.equal(toasts.at(-1).text, '已恢复为孤儿会话「Alpha」')
  } finally {
    await harness.dispose()
  }
})

test('the row menu does not offer orphan restore while the workspace still exists', async () => {
  const harness = await mount()
  try {
    const { container, window } = harness
    const trigger = byAriaLabel(container, '「Alpha」的更多操作')
    await act(async () => {
      click(window, trigger)
    })
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())
    assert.deepEqual(labels, ['在文件管理器中显示', '复制 Session ID', '永久删除'])
    assert.equal(labels.includes('恢复为孤儿会话'), false)
    assert.equal(container.querySelector('[role="dialog"]'), null)
  } finally {
    await harness.dispose()
  }
})

test('a workspace removed from DSH uses removed wording and still offers orphan restore', async () => {
  const harness = await mount({
    payload: statePayload([
      makeEntry({
        originalCwd: '/tmp/beadify',
        workspaceNowExists: true,
        workspaceRegistered: false,
        workspaceAvailable: false,
        workspaceStatus: 'unregistered',
        requiresOrphanRestore: true,
      }),
    ]),
    routes: {
      [RESTORE_ROUTE]: (options) => {
        const body = JSON.parse(options.body)
        if (body.mode === 'normal') {
          return { status: 409, body: { ok: false, error: { code: 'WORKSPACE_UNREGISTERED' } } }
        }
        return {
          status: 200,
          body: {
            ok: true,
            session: { sessionId: 'session-alpha', title: 'Alpha', orphan: true, workspaceReattached: false },
          },
        }
      },
    },
  })
  try {
    const { container, window, calls, toasts } = harness
    assert.ok(container.textContent.includes('工作区已移除'))
    const restore = buttonByText(container, '恢复')
    assert.ok(restore !== undefined)
    await act(async () => {
      click(window, restore)
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const dialog = container.querySelector('[role="dialog"]')
    assert.ok(dialog !== null)
    assert.ok(dialog.textContent.includes('原工作区已移除'))
    assert.ok(dialog.textContent.includes('仍在磁盘上'))
    assert.equal(dialog.textContent.includes('已不存在'), false)

    const confirm = [...dialog.querySelectorAll('button')].at(-1)
    await act(async () => {
      click(window, confirm)
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.deepEqual(
      calls.filter((call) => call.pathname === RESTORE_ROUTE).map((call) => JSON.parse(call.options.body).mode),
      ['normal', 'orphan'],
    )
    assert.equal(toasts.at(-1).text, '已恢复为孤儿会话「Alpha」')
  } finally {
    await harness.dispose()
  }
})

test('the visible page refreshes workspace availability without reloading /state', async () => {
  const intervals = []
  const harness = await mount({
    payload: statePayload([
      makeEntry({
        workspaceNowExists: true,
        workspaceRegistered: true,
        workspaceAvailable: true,
        workspaceStatus: 'available',
        requiresOrphanRestore: false,
      }),
    ]),
    routes: {
      [WORKSPACE_STATUS_ROUTE]: {
        status: 200,
        body: {
          entries: [
            {
              sessionId: 'session-alpha',
              workspaceNowExists: true,
              workspaceRegistered: false,
              workspaceAvailable: false,
              workspaceStatus: 'unregistered',
              requiresOrphanRestore: true,
            },
          ],
        },
      },
    },
    intervals,
  })
  try {
    const { container, window, document, calls } = harness
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    assert.equal(container.textContent.includes('工作区已移除'), false)

    const poll = intervals.find((entry) => entry.delay === 10000)
    assert.ok(poll !== undefined)
    await act(async () => {
      poll.callback()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.ok(container.textContent.includes('工作区已移除'))

    const trigger = byAriaLabel(container, '「Alpha」的更多操作')
    await act(async () => {
      click(window, trigger)
    })
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())
    assert.ok(labels.includes('恢复为孤儿会话'))
    assert.equal(calls.filter((call) => call.pathname === STATE_ROUTE).length, 1)
  } finally {
    await harness.dispose()
  }
})
