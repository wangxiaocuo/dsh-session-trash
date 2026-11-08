/** Delay before the first automatic sweep after activation. */
export const ACTIVATION_SWEEP_DELAY_MS = 10_000

/** How long a page-open sweep waits before triggering another one. */
export const PAGE_OPEN_THROTTLE_MS = 60 * 60 * 1000

/** First delay after a failed sweep; doubled on every further consecutive failure. */
export const CLEANUP_RETRY_BASE_MS = 60 * 1000

/** Upper bound for the automatic retry delay. */
export const CLEANUP_RETRY_MAX_MS = 60 * 60 * 1000

/** Result returned after the service was stopped. */
const STOPPED_RESULT = Object.freeze({ purged: 0, failed: 0, settled: 0 })

/**
 * @param {unknown} error arbitrary failure.
 * @returns {string} a concise message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} error arbitrary failure.
 * @returns {string} a bounded diagnostic message for `/state`.
 */
function errorText(error) {
  const message = messageOf(error)
  return message.length > 500 ? `${message.slice(0, 497)}...` : message
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @returns {{ interval: Function, timeout: Function } | undefined} the timer service, when composed.
 */
function resolveTimer(ctx) {
  let timer
  try {
    timer = typeof ctx.get === 'function' ? ctx.get('timer') : undefined
  } catch {
    timer = undefined
  }
  if (timer !== null && timer !== undefined && typeof timer.interval === 'function' && typeof timer.timeout === 'function') {
    return timer
  }
  if (typeof ctx.interval === 'function' && typeof ctx.timeout === 'function') {
    return { interval: ctx.interval.bind(ctx), timeout: ctx.timeout.bind(ctx) }
  }
  return undefined
}

/**
 * Schedule the retention sweep. Automatic cleanup runs once shortly after
 * activation and then every `sweepIntervalHours`; when the timer service is
 * absent it degrades to activation + trash-page open. A scheduled sweep that
 * fails, or that reports failed purges, is retried with exponential backoff so
 * a transient sharing violation does not wait for the next full interval.
 * Manual cleanup is always available and never gated by `enableAutoCleanup`.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   trashService: { sweep: (options: { allowPurge: boolean, now: number, reason: string }) => Promise<object> },
 *   config: { sweepIntervalHours: number, enableAutoCleanup: boolean },
 *   logger: { info: Function, warn: Function, error: Function, debug: Function },
 * }} deps host services and the configured cadence.
 * @returns {{
 *   start: () => void,
 *   stop: () => void,
 *   runNow: (options?: { manual?: boolean, reason?: string }) => Promise<object>,
 *   maybeSweepOnPageOpen: () => void,
 *   nextSweepAt: () => number | null,
 *   lastSweepAt: () => number,
 *   diagnostics: () => object,
 * }} the cleanup service.
 */
export function createCleanupService({ ctx, trashService, config, logger }) {
  const intervalMs = config.sweepIntervalHours * 60 * 60 * 1000
  const timer = resolveTimer(ctx)
  let lastAttemptAt = 0
  let lastSuccessAt = 0
  let lastRun = null
  let scheduledAt = null
  let retryAt = null
  let consecutiveFailures = 0
  let inFlight = null
  let started = false
  let stopped = false
  let disposeActivation = null
  let disposeInterval = null
  let disposeRetry = null

  /**
   * @param {unknown} error sweep failure.
   * @returns {void}
   */
  function report(error) {
    logger.warn(`automatic trash cleanup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  }

  /**
   * @returns {void}
   */
  function clearRetry() {
    const dispose = disposeRetry
    disposeRetry = null
    retryAt = null
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch (error) {
      logger.debug(`cannot dispose the trash cleanup retry timer: ${messageOf(error)}`)
    }
  }

  /**
   * Schedule one backoff retry after a failed automatic sweep.
   *
   * @param {string} reason failure trigger for diagnostics.
   * @returns {void}
   */
  function scheduleRetry(reason) {
    if (stopped || !config.enableAutoCleanup) return
    clearRetry()
    const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 8)
    const delay = Math.min(CLEANUP_RETRY_BASE_MS * 2 ** exponent, CLEANUP_RETRY_MAX_MS)
    retryAt = Date.now() + delay
    const fire = () => {
      retryAt = null
      disposeRetry = null
      void runNow({ reason: 'retry' }).catch(report)
    }
    if (timer !== undefined) {
      disposeRetry = ctx.effect(() => timer.timeout(fire, delay), 'session-trash: cleanup retry')
    } else {
      const handle = setTimeout(fire, delay)
      handle.unref?.()
      disposeRetry = () => clearTimeout(handle)
    }
    logger.warn(
      `trash cleanup (${reason}) will retry in ${Math.round(delay / 1000)}s after ${consecutiveFailures} consecutive failure(s)`,
    )
  }

  /**
   * Run one sweep, joining an in-flight sweep instead of queuing another. A
   * manual request waits for the in-flight sweep and then runs its own purge,
   * because an automatic sweep may have been started with `allowPurge: false`.
   *
   * @param {{ manual?: boolean, reason?: string }} [options] manual trigger and diagnostic label.
   * @returns {Promise<object>} the sweep summary.
   */
  async function runNow(options = {}) {
    if (stopped) return { ...STOPPED_RESULT }
    const manual = options.manual === true
    while (inFlight !== null) {
      if (!manual) return inFlight
      await inFlight.catch(() => {})
    }
    const reason = options.reason ?? (manual ? 'manual' : 'scheduled')
    const startedAt = Date.now()
    inFlight = (async () => {
      const allowPurge = manual || config.enableAutoCleanup
      try {
        let result
        try {
          result = await trashService.sweep({ allowPurge, now: Date.now(), reason })
        } catch (error) {
          lastAttemptAt = Date.now()
          lastRun = {
            at: lastAttemptAt,
            reason,
            purged: 0,
            failed: 0,
            settled: 0,
            allowPurge,
            durationMs: lastAttemptAt - startedAt,
            error: errorText(error),
          }
          consecutiveFailures += 1
          logger.error(`trash cleanup (${reason}) failed after ${lastRun.durationMs}ms: ${messageOf(error)}`)
          if (!manual) scheduleRetry(reason)
          throw error
        }
        lastAttemptAt = Date.now()
        lastSuccessAt = lastAttemptAt
        lastRun = {
          at: lastAttemptAt,
          reason,
          purged: typeof result.purged === 'number' ? result.purged : 0,
          failed: typeof result.failed === 'number' ? result.failed : 0,
          settled: typeof result.changed === 'number' ? result.changed : 0,
          allowPurge,
          durationMs: lastAttemptAt - startedAt,
          error: null,
        }
        if (lastRun.failed > 0) {
          consecutiveFailures += 1
          logger.warn(
            `trash cleanup (${reason}) finished with ${lastRun.failed} failed purge(s) after ${lastRun.durationMs}ms`,
          )
          if (!manual) scheduleRetry(reason)
        } else {
          consecutiveFailures = 0
          clearRetry()
          if (lastRun.purged > 0 || lastRun.settled > 0) {
            logger.info(
              `trash cleanup (${reason}) purged ${lastRun.purged} expired sessions, settled ${lastRun.settled} entries in ${lastRun.durationMs}ms`,
            )
          } else {
            logger.debug(`trash cleanup (${reason}) found nothing to do in ${lastRun.durationMs}ms`)
          }
        }
        return result
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  /**
   * @returns {void}
   */
  function scheduleInterval() {
    if (stopped || timer === undefined || !config.enableAutoCleanup) return
    if (disposeInterval !== null) return
    disposeInterval = ctx.effect(
      () =>
        timer.interval(() => {
          scheduledAt = Date.now() + intervalMs
          void runNow({ reason: 'interval' }).catch(report)
        }, intervalMs),
      'session-trash: retention sweep',
    )
  }

  /**
   * @returns {number | null} the soonest scheduled automatic sweep, preferring a retry.
   */
  function computeNextSweepAt() {
    if (!config.enableAutoCleanup) return null
    if (retryAt !== null) return retryAt
    return timer === undefined ? null : scheduledAt
  }

  return {
    /**
     * Schedule the activation sweep. Automatic cleanup is skipped when disabled;
     * crash recovery has already run by this point either way.
     *
     * @returns {void}
     */
    start() {
      if (started || stopped) return
      started = true
      if (!config.enableAutoCleanup) {
        scheduledAt = null
        return
      }
      scheduledAt = timer === undefined ? null : Date.now() + ACTIVATION_SWEEP_DELAY_MS
      const fire = () => {
        void runNow({ reason: 'activation' })
          .catch(report)
          .finally(() => {
            if (stopped || !config.enableAutoCleanup) return
            scheduledAt = timer === undefined ? null : Date.now() + intervalMs
            scheduleInterval()
          })
      }
      if (timer !== undefined) {
        disposeActivation = ctx.effect(() => timer.timeout(fire, ACTIVATION_SWEEP_DELAY_MS), 'session-trash: activation sweep')
      } else {
        const handle = setTimeout(fire, ACTIVATION_SWEEP_DELAY_MS)
        handle.unref?.()
        disposeActivation = () => clearTimeout(handle)
      }
    },

    /**
     * Stop every scheduled sweep and retry, and ignore later triggers.
     *
     * @returns {void}
     */
    stop() {
      stopped = true
      if (typeof disposeActivation === 'function') disposeActivation()
      if (typeof disposeInterval === 'function') disposeInterval()
      clearRetry()
      disposeActivation = null
      disposeInterval = null
    },

    runNow,

    /**
     * Trigger a throttled background sweep when the trash page opens. The
     * timer-backed composition uses a one-hour throttle; without a timer the
     * configured sweep interval throttles instead.
     *
     * @returns {void}
     */
    maybeSweepOnPageOpen() {
      if (stopped) return
      const throttle = timer === undefined || !config.enableAutoCleanup ? intervalMs : PAGE_OPEN_THROTTLE_MS
      if (lastAttemptAt !== 0 && Date.now() - lastAttemptAt <= throttle) return
      void runNow({ reason: 'page-open' }).catch(report)
    },

    /**
     * @returns {number | null} the next scheduled automatic sweep, when one exists.
     */
    nextSweepAt() {
      return computeNextSweepAt()
    },

    /**
     * @returns {number} the last succeeded sweep timestamp, or zero.
     */
    lastSweepAt() {
      return lastSuccessAt
    },

    /**
     * Read-only cleanup diagnostics for `/state` and the settings page.
     *
     * @returns {object} a JSON-safe diagnostic snapshot.
     */
    diagnostics() {
      return {
        enabled: config.enableAutoCleanup,
        timerBacked: timer !== undefined,
        lastAttemptAt: lastAttemptAt === 0 ? null : lastAttemptAt,
        lastSuccessAt: lastSuccessAt === 0 ? null : lastSuccessAt,
        nextSweepAt: computeNextSweepAt(),
        retryAt,
        consecutiveFailures,
        lastRun: lastRun === null ? null : { ...lastRun },
      }
    },
  }
}
