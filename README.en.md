# dsh-session-trash

[简体中文](./README.md) | English

[GitHub](https://github.com/wangxiaocuo/dsh-session-trash) · [npm](https://www.npmjs.com/package/@wangxiaocuo/dsh-session-trash)

A session trash for DeepSeek Harness. Move cold sessions out of the sidebar without deleting their logs, restore them within the retention window, or delete the logs permanently. Built for DSH 0.2.2-rc.1 on Desktop and Web. Host and Client ship in one package, with no build step.

Status: feature complete. CI (GitHub Actions) runs the unit and Host smoke tests on Ubuntu (Node 20/22) and Windows (Node 22); macOS has run the end-to-end suite against a real DSH Host. The Windows and Linux DSH Hosts have not been verified manually yet, and Windows skips the cases that rely on POSIX permission bits.

## Features

- Right-click a session in the sidebar and choose "Move to trash". It is available for cold sessions with no running turn, job, subagent, or scheduled task; hidden subagent children move with their parent and are restored together.
- For sessions that are still open, still running work, or own visible child sessions, the menu keeps a labelled explanatory "Move to trash" item that states why the move is unavailable instead of hiding the entry entirely.
- After the move, the shared DSH Toast offers one action: Undo. Undo tries a normal restore first and falls back to an orphan restore when the original workspace is gone.
- The Trash page in Settings shows title, Session ID, original workspace, trashed date, remaining days, size, and status. The list supports search, filters, and paging at 50 rows per page.
- Row actions include restore, restore as orphan, permanent deletion, removal from the index, copying the Session ID, and revealing the original workspace in Finder or Explorer.
- The toolbar's "Delete all permanently" empties the whole trash after one confirmation: it deletes every trashed session log and drops file-missing records from the index. Attachments, images, and search-index rows are not deleted.
- Cleanup keeps entries for 30 days by default and runs every 6 hours. It also runs shortly after activation and when the Trash page opens. Failed cleanup runs are retried with exponential backoff, and the page shows the failure.
- The index is committed atomically and the previous index is kept as `.bak`. If both the index and the backup are unreadable, the plugin enters protection mode and can rebuild the index from each object's `meta.json`.
- Rename, fork, archive, and copy Session ID stay in the shipped DSH sidebar menu. The plugin does not reimplement them.

## Installation

The plugin is published on npm ([`@wangxiaocuo/dsh-session-trash`](https://www.npmjs.com/package/@wangxiaocuo/dsh-session-trash)); the plugin dialog also accepts a GitHub address or a local directory.

Installation and removal use the current profile's pnpm. Desktop bundles pnpm; a `dsh web` started from source needs pnpm on `PATH`, and installing from GitHub also needs git and working access to GitHub.

### Install from DSH (recommended)

1. Open the **Plugins** panel in the sidebar and click **Add plugin**.
2. In **Package name or address**, enter `@wangxiaocuo/dsh-session-trash`. To install the latest code on the current branch, enter `git+https://github.com/wangxiaocuo/dsh-session-trash.git` instead.
3. Leave the **Registry** at its default. The plugin and its dependencies come from npm; on a slow network, switch to **Mainland China mirror**. The mirror can lag the official registry by a few minutes.
4. Click **Install**. DSH resolves the package name, description, and version, then runs pnpm. The command and output are under **Show install details**.
5. Click **Enable now** when it finishes. Restart DSH if prompted and refresh the page in the Web app. The context menu and the Trash settings page appear afterwards.

Local directory: clone the repository, run `pnpm install` in the directory (a directory-link bundle uses its own `node_modules`), then enter the absolute path of that directory.

If an install fails, start with the pnpm output and the Host log path under **Show install details**:

- No such plugin was found: check the spelling, wait for the mirror, or install from a Git address or local directory instead.
- No registry could be reached: check the network or proxy, or install from a local directory.
- The package declares no bundle, or the path is not a valid plugin package: the Git address must point at the repository root, and a local path must be the package directory.
- The install finished but nothing shows up: make sure the bundle is enabled on the Plugins page; a profile without HMR needs a DSH restart, and the Web client needs a page refresh.

### Let the agent install it

Ask the agent to run one of these. The operation needs `danger-full-access` or a separate approval:

```text
plugin_manager install_bundle  target=@wangxiaocuo/dsh-session-trash
plugin_manager install_bundle  target=git+https://github.com/wangxiaocuo/dsh-session-trash.git
plugin_manager install_bundle  target=/absolute/path/to/dsh-session-trash
```

Installing the directory saves a download when a clone already exists. With the DSH CLI installed, `dsh plugin add <the same spec>` is equivalent.

### Link into a profile manually (development)

```bash
git clone https://github.com/wangxiaocuo/dsh-session-trash.git
cd dsh-session-trash
pnpm install
```

```bash
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
pnpm add link:/absolute/path/to/dsh-session-trash
```

Then add `@wangxiaocuo/dsh-session-trash` to `dsh.profile.bundles` in that profile's `package.json`, restart DSH to load the Host, and refresh the page to load the Client. Runtime dependencies are `@deepseek-ai/dsh-home-paths@0.2.2-rc.1` and `@deepseek-ai/schemastery@3.19.0`.

### Upgrade and uninstall

For an npm install, open Session trash on the Plugins panel and click **Update** in the **Versions** section; when no newer version is offered, uninstall and install again. A Git install only picks up new code after reinstallation. For a manual link, run `git pull` and `pnpm install` in the directory, restart DSH, then refresh the page.

To uninstall, open the same detail page, click **Uninstall**, and confirm; the profile dependency is removed. You can also remove it from the profile bundles and dependencies by hand and restart. Uninstalling does not delete `<DSH_HOME>/.session-trash`; delete that directory manually when its logs are no longer needed.

## Configuration

Configure the plugin row in the profile patch:

```yaml
- id: session-trash
  name: '@wangxiaocuo/dsh-session-trash'
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

Right-click a cold session and choose "Move to trash". After the Toast disappears, open Settings, then Trash, and restore the session. If the original workspace directory is gone, the page asks for confirmation and restores the session as an orphan under "Ungrouped". To empty the trash at once, use "Delete all permanently" in the toolbar and confirm; entries that have not expired are deleted too.

Trash rows that own hidden subagent children show a badge with the child count; restore and permanent deletion always cover the whole tree.

The current DSH version keeps a live agent for a session after it is opened, until the Host process exits. An idle session is still live, so the menu item stays hidden. Restart DSH before trashing it, or archive it. A second DSH instance does not detect a session that is live in another process, so do not use one to bypass this check.

## HTTP API

All routes live under `/plugins/dsh-session-trash/api/` and are registered as exact routes on `ctx.webServer`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/state` | Config, index state, entries, stats, and cleanup diagnostics; may schedule a throttled page-open cleanup |
| `POST` | `/preflight` | `{ sessionId }` returns `{ eligible: true, descendants }` or `{ eligible: false, code, message, details? }`; `descendants` is the number of hidden children that move along |
| `POST` | `/trash` | `{ sessionId }`; moves the whole session tree (parent plus hidden subagent children) and returns `{ ok, entry }` |
| `POST` | `/restore` | `{ sessionId, mode: 'normal' \| 'orphan' }` |
| `POST` | `/purge` | `{ sessionId }`; permanently deletes the session log |
| `POST` | `/purge-all` | No body; permanently deletes every entry in the trash, dropping `missing` index records only; returns `{ ok, purged, forgotten, failed }` |
| `POST` | `/forget` | `{ sessionId }`; removes only a `missing` index entry |
| `POST` | `/reveal` | `{ sessionId }`; opens the original workspace |
| `POST` | `/cleanup` | No body; runs one cleanup sweep |
| `POST` | `/rebuild` | No body; rebuilds the index only in protection mode |

Requests must pass `ctx.connection.requestRejection()` and `ctx.connection.admit()`. `POST` requests also carry `X-DSH-Session-Trash: 1`. JSON bodies use `Content-Type: application/json` and are limited to 64 KiB. Responses use `Cache-Control: no-store` and never expose the absolute trash root.

Failures use `{ ok: false, error: { code, message, details? } }`. Preflight refusals include `SESSION_NOT_FOUND`, `ALREADY_TRASHED`, `SESSION_NOT_MATERIALIZED`, `STORAGE_UNSUPPORTED`, `SESSION_SUBAGENT`, `SESSION_HAS_DESCENDANTS`, `SESSION_LINEAGE_UNRESOLVED`, `SESSION_LIVE`, `SESSION_ACTIVE`, `UNSAFE_SESSION_DIR`, `INDEX_CORRUPT`, and `IO_ERROR`.

Restore and maintenance refusals include `TRASH_ENTRY_NOT_FOUND`, `TRASH_STATE_INVALID`, `TRASH_DIR_MISSING`, `RESTORE_TARGET_EXISTS`, `WORKSPACE_MISSING`, `RESTORE_VERIFY_FAILED`, `UNSAFE_RESTORE_PATH`, `FORGET_NOT_ALLOWED`, `REVEAL_UNAVAILABLE`, `REVEAL_FAILED`, `INDEX_CORRUPT`, `INDEX_NOT_CORRUPT`, `LOCKED`, and `IO_ERROR`.

`/state.stats.cleanup` reports the last cleanup attempt, the next sweep, a pending retry, consecutive failures, and the last run summary.

`/state` entries gain `subagentCount` (hidden children moved along) and `members` (parent first, each with `sessionId`, `origin`, and `sizeBytes`); `sizeBytes`/`fileCount` cover the whole tree. The `entry` returned by `/trash` uses the same shape.

## Storage and recovery

```text
<DSH_HOME>/.session-trash/
  trash-index.json          # authoritative index
  trash-index.json.bak      # previous committed index
  .lock                     # cross-process lock
  objects/
    <trashId>/
      meta.json             # object metadata
      session/              # the moved parent session directory
      children/
        <sessionId>/        # hidden subagent child directory moved along
```

The index is committed atomically with `tmp`, `fsync`, and `rename`, and the previous commit is kept as `.bak`. On activation and before every sweep, the plugin settles unfinished `trashing`, `restoring`, and `purging` entries. It completes what can be completed, rolls back what can be rolled back, marks uncertain cases as `missing`, and never deletes a session log during that recovery pass.

A same-filesystem move uses `rename`. A cross-filesystem move copies into a temporary directory, verifies regular-file count and byte count, publishes with `rename`, then removes the source. Any failure cleans up the temporary directory and keeps the source. Symlinks are copied as symlinks, not followed.

On POSIX filesystems, the trash root uses `0700` permissions and the index and metadata files use `0600`. A lock older than 10 minutes is treated as stale.

The index schema is v2; a v1 index is upgraded automatically on startup and preserved as `.bak`. Older plugin releases cannot read v2 and enter protection mode, so empty the trash before downgrading.

## Limitations

- The current DSH version keeps an opened session live until the Host process exits. The context menu then shows the explanatory item instead of an actionable move; restart DSH before trashing it.
- Parent sessions with visible (non-subagent) children cannot be trashed on their own; archive the whole tree instead. Hidden subagent children move with their parent.
- A trashed tree is restored or deleted as a whole; there is no partial restore. If any member directory is missing, the entry is marked `missing` and can only be purged or forgotten.
- Orphan restore never recreates the original workspace directory and never reattaches the session to a workspace.
- Archive and pin state survive trash and restore. The Trash page does not manage either set.
- Permanent deletion removes the session log only. Attachments, images, projection-cache rows, and search-index rows are not deleted.
- `/state` returns all entry summaries in one response. Search, filtering, and paging happen in the Client.
- There is no cross-window live push. Another window's change appears after a refresh or when the window regains focus.
- The Windows and Linux DSH Hosts have not been verified manually; CI covers unit and Host smoke tests only. On Windows, cases that rely on POSIX permission bits are skipped, and long paths over 260 characters / symlink copying depend on system configuration (the related tests skip themselves when unsupported).
- macOS path comparison is case-insensitive. On a case-sensitive APFS volume, paths that differ only by case are treated as the same location.
- Multiple DSH processes sharing one `DSH_HOME` serialize trash operations through `.lock`. A process paused for more than 10 minutes can lose the lock to another process.

## Development

```bash
pnpm install
pnpm test          # unit tests
pnpm test:smoke    # Host smoke test (real Cordis, plain Node)
npm run test:e2e   # real dsh web end-to-end (needs the desktop app)
```

The Host smoke test wires the plugin into a real Cordis context through the `@deepseek-ai/cordis` devDependency, creates its own temporary `DSH_HOME`, and removes it afterwards; it does not need the desktop app. Set `DSH_SMOKE_KEEP=1` to keep the temporary home for debugging. `pnpm test` enumerates the test files through `test/run-unit.mjs`, so it does not depend on shell glob expansion and behaves the same on Windows and POSIX shells.

What CI verifies:

| Check | Verified environment |
|---|---|
| Unit tests, Host smoke test | CI: Ubuntu Node 20/22, Windows Node 22 |
| Package contents (`npm pack`) | CI: Ubuntu |
| Real `dsh web` end to end | macOS + DSH 0.2.2-rc.1 (run manually) |

`npm run test:e2e` boots a real `dsh web` Host in a temporary `DSH_HOME` and runs the full flow. It discovers the desktop app in the platform's usual install locations, or uses `DSH_ELECTRON`; when no desktop app is found it prints a skip message and exits 0. The cleanup-failure scenario that relies on POSIX permission bits is skipped on Windows. Set `DSH_E2E_KEEP=1` to keep the temporary home and logs.

Project layout:

```text
README.md / README.en.md   Chinese / English docs
LICENSE              MIT license
index.js              Host entry, Config, and service wiring
client.js             Client UI, sidebar menu, and Toast
lib/                  index, lock, moves, eligibility, cleanup, HTTP, and state
locale/               plugin display names and descriptions
test/                 unit tests, Host smoke test, real dsh web e2e
```

The trash icon uses the `trash-outline` artwork from the DeepSeek Harness product icon set, MIT licensed, © 2026 DeepSeek. The project itself is MIT licensed; see [LICENSE](./LICENSE).
