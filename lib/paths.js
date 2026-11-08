import path from 'node:path'
import { resolveDshHome, dshHomePath, dshHomeDisplay } from '@deepseek-ai/dsh-home-paths'
import { TrashError } from './errors.js'

/** Trash directory name under the DSH home. */
export const TRASH_DIRNAME = '.session-trash'

/**
 * Resolve every trash path from the harness home.
 *
 * The host refuses to activate when the shared path library cannot produce an
 * absolute home, so no caller falls back to an environment guess of its own.
 *
 * @returns {{ home: string, root: string, display: string }} resolved absolute paths plus the symbolic display form.
 */
export function resolveTrashPaths() {
  let home
  try {
    home = resolveDshHome()
  } catch (cause) {
    throw new TrashError(
      'HOME_UNRESOLVED',
      `Cannot resolve the DeepSeek Harness home: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (typeof home !== 'string' || home === '' || !path.isAbsolute(home)) {
    throw new TrashError(
      'HOME_UNRESOLVED',
      '@deepseek-ai/dsh-home-paths resolved a non-absolute harness home; the trash plugin refuses to activate.',
    )
  }
  const root = dshHomePath(TRASH_DIRNAME)
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TrashError('HOME_UNRESOLVED', '@deepseek-ai/dsh-home-paths did not produce an absolute trash root.')
  }
  const homeLabel = dshHomeDisplay(home)
  const display = `${homeLabel === undefined || homeLabel === null || homeLabel === '' ? home : homeLabel}/${TRASH_DIRNAME}`
  return { home, root, display }
}
