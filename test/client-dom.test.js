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
const FORGET_ROUTE = '/plugins/dsh-session-trash/api/forget'

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
 * @returns {Promise<object>} the mounted harness.
 */
async function mount({ payload = statePayload(), routes = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  const { window } = dom
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
    const pathname = new URL(String(url)).pathname
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
    const menuItems = [...menu.querySelectorAll('[role="menuitem"]')]
    assert.ok(menuItems.length >= 4)
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
