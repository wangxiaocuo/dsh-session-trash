import z from '@deepseek-ai/schemastery'
import { resolveTrashPaths } from './lib/paths.js'
import { TrashStore } from './lib/store.js'
import { createEligibility } from './lib/eligibility.js'
import { createStateService } from './lib/state.js'
import { createTrashService } from './lib/trash-service.js'
import { createCleanupService } from './lib/cleanup.js'
import { registerApi } from './lib/http.js'

/** Host services this plugin cannot work without. */
export const inject = ['sessionPersistence', 'webServer', 'connection', 'sessions', 'agents']

/** Validated plugin configuration; ordinary fields restart the plugin when changed. */
export const Config = z.object({
  retentionDays: z.natural().min(1).max(3650).default(30).description('Days a trashed session is kept before automatic deletion.'),
  sweepIntervalHours: z
    .natural()
    .min(1)
    .max(168)
    .default(6)
    .description('Hours between automatic cleanup sweeps.'),
  enableAutoCleanup: z.boolean().default(true).description('Automatically delete sessions past the retention period.'),
  debug: z.boolean().default(false).description('Emit detailed trash diagnostics.'),
})

/**
 * Build a plain diagnostics sink that never depends on the shape of the
 * harness logger service.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function }} a prefixed diagnostics sink.
 */
function createLogger(ctx) {
  const prefix = 'dsh-session-trash'
  let sink = null
  try {
    const factory = ctx.get('logger')
    if (typeof factory === 'function') {
      const instance = factory(prefix)
      if (instance !== null && instance !== undefined && typeof instance.info === 'function') sink = instance
    } else if (factory !== null && factory !== undefined && typeof factory.info === 'function') {
      sink = factory
    }
  } catch {
    sink = null
  }
  const emit = (level, args) => {
    if (sink !== null && typeof sink[level] === 'function') {
      sink[level](...args)
      return
    }
    const method = level === 'debug' ? 'log' : level
    console[method](`[${prefix}]`, ...args)
  }
  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    debug: (...args) => emit('debug', args),
  }
}

/**
 * Register the trash services, its state projection, the HTTP API, crash
 * recovery, and the retention sweep.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} config validated plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = createLogger(ctx)
  const scoped = config.debug ? logger : { ...logger, debug: () => {} }
  const paths = resolveTrashPaths()
  const store = new TrashStore({ root: paths.root, logger: scoped })
  const eligibility = createEligibility({ ctx, store, logger: scoped })
  const trashService = createTrashService({
    ctx,
    store,
    eligibility,
    config,
    logger: scoped,
    paths,
  })
  const cleanupService = createCleanupService({
    ctx,
    trashService,
    config,
    logger: scoped,
  })
  const stateService = createStateService({
    store,
    config,
    trashRootDisplay: paths.display,
    nextSweepAt: () => cleanupService.nextSweepAt(),
    cleanup: () => cleanupService.diagnostics(),
  })

  ctx.effect(() => () => cleanupService.stop(), 'session-trash: cleanup disposal')

  const ready = store
    .init()
    .then(async (summary) => {
      logger.info(
        `trash root ready at ${paths.display}; retention ${config.retentionDays}d, sweep every ${config.sweepIntervalHours}h; index ${summary.status}, ${store.entries().length} entries`,
      )
      try {
        const recovery = await trashService.recover()
        if (recovery.changed > 0) {
          logger.info(
            `startup recovery settled ${recovery.changed} entries (${recovery.completed} completed, ${recovery.rolledBack} rolled back, ${recovery.missing} missing)`,
          )
        }
      } catch (error) {
        logger.error(
          `startup trash recovery failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        )
      }
      cleanupService.start()
      return summary
    })
    .catch((error) => {
      logger.error(`trash root initialization failed at ${paths.display}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      throw error
    })
  ready.catch(() => {})

  registerApi({ ctx, eligibility, stateService, trashService, cleanupService, ready, config, logger: scoped })
}
