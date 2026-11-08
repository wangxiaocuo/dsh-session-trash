# dsh-session-trash

[简体中文](./README.md) | English

English translation of [README.md](./README.md).

A session trash for DeepSeek Harness. Move cold sessions out of the sidebar without deleting their logs, restore them within the retention window, or delete the logs permanently. Built for DSH 0.2.2-rc.1 on Desktop and Web. Host and Client ship in one package, with no build step.

Status: feature complete and covered by the regression suite. macOS has been verified against a real DSH Host. Windows and Linux path, lock, and retry rules have unit coverage but have not been run on those systems.

## Features

- Right-click a session in the sidebar and choose "Move to trash". The item appears only for cold sessions with no persisted children and no running turn, job, subagent, or scheduled task.
- After the move, the shared DSH Toast offers one action: Undo. Undo tries a normal restore first and falls back to an orphan restore when the original workspace is gone.
- The Trash page in Settings shows title, Session ID, original workspace, trashed date, remaining days, size, and status. The list supports search, filters, and paging at 50 rows per page.
- Row actions include restore, restore as orphan, permanent deletion, removal from the index, copying the Session ID, and revealing the original workspace in Finder or Explorer.
- Cleanup keeps entries for 30 days by default and runs every 6 hours. It also runs shortly after activation and when the Trash page opens. Failed cleanup runs are retried with exponential backoff, and the page shows the failure.
- The index is committed atomically and the previous index is kept as `.bak`. If both the index and the backup are unreadable, the plugin enters protection mode and can rebuild the index from each object's `meta.json`.
- Rename, fork, archive, and copy Session ID stay in the shipped DSH sidebar menu. This plugin does not reimplement them.

## Installation

From the directory that contains this package:

```text
plugin_manager install_bundle  target=<absolute path to this directory>
```

A bundle installed as a directory link uses its own `node_modules`, so run `pnpm install` in the package directory before installing the bundle.

For local development, link the package into a profile:

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/absolute/path/to/dsh-session-trash
```

Then add `dsh-session-trash` to `dsh.profile.bundles` in that profile's `package.json`. Restart Desktop to load the Host, then refresh the page to load the Client.

Runtime dependencies are `@deepseek-ai/dsh-home-paths@0.2.2-rc.1` and `@deepseek-ai/schemastery@3.19.0`.

To uninstall, remove `dsh-session-trash` from the profile bundles and dependencies, then restart Desktop. Uninstalling does not delete `<DSH_HOME>/.session-trash`; remove that directory manually when its session logs are no longer needed.

## Configuration

Configure the plugin row in the profile patch:

```yaml
- id: session-trash
  name: dsh-session-trash
  config:
    retentionDays: 30        # 1-3650
    sweepIntervalHours: 6    # 1-168
    enableAutoCleanup: true
    debug: false
```

| Field | Default | Range | Description |
|---|---|---|---|
| `retentionDays` | `30` | 1-3650 | Days a trashed session is kept before automatic deletion |
| `sweepIntervalHours` | `6` | 1-168 | Hours between automatic cleanup sweeps |
| `enableAutoCleanup` | `true` | boolean | When false, cleanup no longer deletes expired entries automatically |
| `debug` | `false` | boolean | Emit detailed diagnostic logs |

Defaults apply when `config` is omitted. Invalid values reject activation instead of falling back to defaults. Changing an ordinary field restarts the plugin.

## Usage

Right-click a cold session and choose "Move to trash". After the Toast disappears, open Settings, then Trash, and restore the session. If the original workspace directory is gone, the page asks for confirmation and restores the session as an orphan under "Ungrouped".

The current DSH version keeps a live agent for a session after it is opened, until the Host process exits. A session is still live even when idle, so the menu item stays hidden. Restart DSH before trashing it, or archive it instead. A second DSH instance does not detect a session that is live in another process, so do not use one to bypass this check.

## HTTP API

All routes live under `/plugins/dsh-session-trash/api/` and are registered as exact routes on `ctx.webServer`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/state` | Config, index state, entries, stats, and cleanup diagnostics; may schedule a throttled page-open cleanup |
| `POST` | `/preflight` | `{ sessionId }` returns `{ eligible: true }` or `{ eligible: false, code, message }` |
| `POST` | `/trash` | `{ sessionId }`; moves the session directory |
| `POST` | `/restore` | `{ sessionId, mode: 'normal' \| 'orphan' }` |
| `POST` | `/purge` | `{ sessionId }`; permanently deletes the session log |
| `POST` | `/forget` | `{ sessionId }`; removes only a `missing` index entry |
| `POST` | `/reveal` | `{ sessionId }`; opens the original workspace |
| `POST` | `/cleanup` | No body; runs one cleanup sweep |
| `POST` | `/rebuild` | No body; rebuilds the index only in protection mode |

Requests must pass `ctx.connection.requestRejection()` and `ctx.connection.admit()`. `POST` requests also carry `X-DSH-Session-Trash: 1`. JSON bodies use `Content-Type: application/json` and are limited to 64 KiB. Responses use `Cache-Control: no-store` and never expose the absolute trash root.

Failures use `{ ok: false, error: { code, message, details? } }`. Preflight refusals include `SESSION_NOT_FOUND`, `ALREADY_TRASHED`, `SESSION_NOT_MATERIALIZED`, `STORAGE_UNSUPPORTED`, `SESSION_SUBAGENT`, `SESSION_HAS_DESCENDANTS`, `SESSION_LINEAGE_UNRESOLVED`, `SESSION_LIVE`, `SESSION_ACTIVE`, `UNSAFE_SESSION_DIR`, `INDEX_CORRUPT`, and `IO_ERROR`.

Restore and maintenance refusals include `TRASH_ENTRY_NOT_FOUND`, `TRASH_STATE_INVALID`, `TRASH_DIR_MISSING`, `RESTORE_TARGET_EXISTS`, `WORKSPACE_MISSING`, `RESTORE_VERIFY_FAILED`, `UNSAFE_RESTORE_PATH`, `FORGET_NOT_ALLOWED`, `REVEAL_UNAVAILABLE`, `REVEAL_FAILED`, `INDEX_CORRUPT`, `INDEX_NOT_CORRUPT`, `LOCKED`, and `IO_ERROR`.

`/state.stats.cleanup` reports the last cleanup attempt, the next sweep, a pending retry, consecutive failures, and the last run summary.

## Storage and recovery

```text
<DSH_HOME>/.session-trash/
  trash-index.json          # authoritative index
  trash-index.json.bak      # previous committed index
  .lock                     # cross-process lock
  objects/
    <trashId>/
      meta.json             # object metadata
      session/              # the moved session directory
```

The index is committed atomically with `tmp`, `fsync`, and `rename`, and the previous commit is kept as `.bak`. On activation and before every sweep, the plugin settles unfinished `trashing`, `restoring`, and `purging` entries. It completes what can be completed, rolls back what can be rolled back, marks uncertain cases as `missing`, and never deletes a session log during that recovery pass.

A same-filesystem move uses `rename`. A cross-filesystem move copies into a temporary directory, verifies regular-file count and byte count, publishes with `rename`, then removes the source. Any failure cleans up the temporary directory and keeps the source. Symlinks are copied as symlinks, not followed.

On POSIX filesystems, the trash root uses `0700` permissions and the index and metadata files use `0600`. A lock older than 10 minutes is treated as stale.

## Limitations

- The current DSH version keeps an opened session live until the Host process exits. The "Move to trash" item stays hidden for such a session. Restart DSH before trashing it.
- Parent sessions with persisted children and subagent sessions cannot be trashed on their own. Archive the whole tree instead.
- Orphan restore never recreates the original workspace directory and never reattaches the session to a workspace.
- Archive and pin state survive trash and restore. The Trash page does not manage either set.
- Permanent deletion removes the session log only. Attachments, images, projection-cache rows, and search-index rows are not deleted.
- `/state` returns all entry summaries in one response. Search, filtering, and paging happen in the Client.
- There is no cross-window live push. Another window's change appears after a refresh or when the window regains focus.
- Windows and Linux have not been run on real hosts. On Windows, long paths over 260 characters and symlink copying depend on system configuration.
- macOS path comparison is case-insensitive. On a case-sensitive APFS volume, paths that differ only by case are treated as the same location.
- Multiple DSH processes sharing one `DSH_HOME` serialize trash operations through `.lock`. A process paused for more than 10 minutes can lose the lock to another process.

## Development

```bash
pnpm install
pnpm test
npm run test:e2e
```

`npm run test:e2e` boots a real `dsh web` Host in a temporary `DSH_HOME` and runs the full flow. It uses `/Applications/DeepSeek Harness.app` by default; set `DSH_ELECTRON` to another Electron executable. Set `DSH_E2E_KEEP=1` to keep the temporary home and logs.

The Host smoke test needs a separate temporary `DSH_HOME`:

```bash
DSH_HOME=$(mktemp -d) ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/smoke-host.mjs
```

Project layout:

```text
index.js              Host entry, Config, and service wiring
client.js             Client UI, sidebar menu, and Toast
lib/                  index, lock, moves, eligibility, cleanup, HTTP, and state
locale/               plugin display names and descriptions
test/                 unit tests, Host smoke test, real dsh web e2e
```

The trash icon uses the `trash-outline` artwork from the DeepSeek Harness product icon set, MIT licensed, © 2026 DeepSeek.
