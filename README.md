# dsh-session-trash

A DeepSeek Harness plugin that adds a **trash** for cold sessions: a session can be
moved out of the sidebar without losing its log, restored within the retention
window, or deleted permanently.

Built for **DSH 0.2.2-rc.1** (Desktop / Web). Host + Client bundle, no build step.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Package skeleton, path resolution, `.session-trash` layout, index + lock, `GET /state`, `POST /preflight`, HTTP auth, settings page shell, sidebar menu gated by preflight | **implemented** |
| 2 | `POST /trash`, `POST /restore` (normal), shared Toast with undo, `api-session/removed/added`, startup crash recovery | **implemented** |
| 3 | Orphan restore, `POST /purge`, `POST /forget`, `POST /cleanup`, `POST /rebuild`, retention sweep, index reconciliation/rebuild, full trash list with row actions | **implemented** |
| 4 | Trash page polish: search, workspace/expiry filters, 50-row paging, results summary, no-results state, a11y labels, i18n copy, Finder reveal | **implemented** |
| 5 | Cross-platform and failure hardening, cleanup retry + diagnostics, end-to-end acceptance, final docs | **implemented** |

Phase 5 adds:

- **Filesystem hardening.** Transient rename/remove sharing violations are retried;
  a cross-filesystem copy publishes through a verified temporary sibling and removes
  it on every failure path, including disk full; path identity is compared
  case-insensitively on macOS/Windows; Windows reserved device names and trailing
  dots/spaces are rejected as session-directory segments.
- **Cleanup retry and diagnostics.** A failed automatic sweep, or a sweep that
  reports failed purges, is retried with exponential backoff (1 minute, doubling,
  capped at one hour). `/state` exposes the last attempt/success, next sweep, retry
  time, consecutive failures, and last run summary. The Trash page shows a warning
  banner with a “Retry now” action when the last run left failures or threw.
- **Robustness tests.** Large directories, `ENOSPC`, permission failures, symlink
  preservation, concurrent trash requests, a session becoming live during the move,
  cleanup retry/backoff, and a damaged-index write failure.
- **Real-DSH end-to-end acceptance.** `npm run test:e2e` boots the actual `dsh web`
  host from the desktop runtime in a throwaway home and drives the entire sequence:
  trash → undo → trash again → 30-day expiry purge → orphan restore.

## What it adds

- **Sidebar → right-click a session → “Move to trash”.** The item is hidden unless
  the Host preflight says the session is a cold, materialized JSONL session with no
  children and no running work. Choosing it moves the whole session directory into
  the trash and shows the shared Toast with one action: **Undo**.
- **Undo.** The Toast action calls `POST /restore`. A normal restore is tried first;
  if the original workspace directory is gone, the Client retries once with
  `mode: 'orphan'` automatically. The log returns to its original project directory
  and the session becomes visible again. Normal restores also restore the Workspace
  order (detach → attach → insert before the old sibling, or append).
- **Settings → Trash.** A full list of trashed sessions with title, Session ID,
  original workspace, trashed date, remaining days, size, status badges, and row
  actions:
  - **Search and filters** — search title, Session ID, or original workspace, then
    narrow the list to all entries, a workspace that still exists, a missing
    workspace, or entries expiring within three days. The list pages at 50 rows.
  - **Restore** — normal restore. When the workspace is missing, an orphan
    confirmation dialog opens instead.
  - **Restore as orphan** — always available for a trashed row; restores the log
    and detaches the Workspace so the session appears under “Ungrouped”.
  - **Delete permanently** — confirmed, danger-coloured; removes the session log
    directory and the index entry. Not reversible.
  - **Remove from index** — only for a `missing` row; removes only the index record
    (plus the plugin's own `meta.json` when it is the last file) and never deletes a
    session log.
  - **Copy Session ID** — clipboard with a textarea fallback.
  - **Show original workspace** — only when the directory still exists; runs the
    Host's native reveal through `sessionController.openWorkspacePath`.
- **Retention cleanup.** The Host sweeps once shortly after activation and then
  every `sweepIntervalHours`; opening the Trash page also schedules a throttled
  sweep. Entries past `retentionDays` are deleted without a dialog, as configured.
  The page shows the next sweep and each row's auto-delete date. A failed sweep is
  retried sooner than the next interval and its failure is shown as a page warning.
- **`<DSH_HOME>/.session-trash`.** Index, backup, cross-process lock, object
  directories, and per-object metadata. Created on activation with `0700`
  permissions; index and metadata files are `0600`.

The plugin deliberately does **not** reimplement rename, fork, archive, or
“copy session ID”; those stay in the shipped sidebar menu. The trash page has its
own copy action because the original session row is gone.

## Configuration

Configured through the plugin row in the profile patch:

```yaml
- id: session-trash
  name: dsh-session-trash
  config:
    retentionDays: 30        # 1–3650
    sweepIntervalHours: 6    # 1–168
    enableAutoCleanup: true
    debug: false
```

Defaults apply when `config` is omitted. Invalid values reject activation instead of
falling back silently. Ordinary fields restart the plugin when changed, so the new
retention window applies to the next sweep. `enableAutoCleanup: false` stops
scheduled expiry deletion and automatic retries; manual “Delete permanently” and
“Delete expired” still work.

## HTTP API

All routes live under `/plugins/dsh-session-trash/api/` and are registered as exact
routes on `ctx.webServer`.

| Method | Path | Phase | Purpose |
|---|---|---|---|
| `GET` | `/state` | 1/5 | Config, index summary, entries, stats, cleanup diagnostics; may schedule a page-open sweep |
| `POST` | `/preflight` | 1 | `{ sessionId }` → `{ eligible: true }` or `{ eligible: false, code, message }` |
| `POST` | `/trash` | 2 | `{ sessionId }` → `{ ok: true, entry }`; moves the session directory |
| `POST` | `/restore` | 2/3 | `{ sessionId, mode: 'normal' \| 'orphan' }` → `{ ok: true, session }` |
| `POST` | `/purge` | 3 | `{ sessionId }` → `{ ok: true, sessionId }`; permanent deletion |
| `POST` | `/forget` | 3 | `{ sessionId }` → `{ ok: true, sessionId }`; missing entries only, no file deletion |
| `POST` | `/reveal` | 3 | `{ sessionId }` → `{ ok: true, opened: true }`; reveals the original workspace |
| `POST` | `/cleanup` | 3/5 | No body → `{ ok: true, purged, failed, settled, cleanup }`; manual sweep |
| `POST` | `/rebuild` | 3 | No body → `{ ok: true, entries, unindexed }`; only while the index is in protection mode |

Every request must:

1. pass `ctx.connection.requestRejection()` (trusted Host/Origin, browser auth),
2. pass `ctx.connection.admit()` with `principal.kind === 'owner'`,
3. carry `X-DSH-Session-Trash: 1` on `POST`,
4. use `Content-Type: application/json` with a body of at most 64 KiB when a body is read.

A request with any other method is answered `405` with `Allow` naming the accepted
method. Failures use `{ ok: false, error: { code, message, details? } }`; responses
are `Cache-Control: no-store`. The absolute trash root is never returned — only
`dshHomeDisplay()` plus `/.session-trash`.

`/state.stats` now carries:

```json
{
  "count": 1,
  "totalBytes": 184320,
  "failedEntries": 0,
  "nextSweepAt": 1762600000000,
  "cleanup": {
    "enabled": true,
    "timerBacked": true,
    "lastAttemptAt": 1762580000000,
    "lastSuccessAt": 1762580000000,
    "nextSweepAt": 1762601600000,
    "retryAt": null,
    "consecutiveFailures": 0,
    "lastRun": {
      "at": 1762580000000,
      "reason": "interval",
      "purged": 0,
      "failed": 0,
      "settled": 0,
      "allowPurge": true,
      "durationMs": 4,
      "error": null
    }
  }
}
```

`failedEntries` counts index entries whose `lastError` is set. `retryAt` is non-null
while a backoff retry is pending. `lastRun.error` is set when the sweep threw;
`lastRun.failed` counts per-entry purge failures during an otherwise completed sweep.

### Preflight refusals

`SESSION_NOT_FOUND`, `ALREADY_TRASHED`, `SESSION_NOT_MATERIALIZED`,
`STORAGE_UNSUPPORTED`, `SESSION_SUBAGENT`, `SESSION_HAS_DESCENDANTS`,
`SESSION_LINEAGE_UNRESOLVED`, `SESSION_LIVE`, `SESSION_ACTIVE`,
`UNSAFE_SESSION_DIR`, `INDEX_CORRUPT`, `IO_ERROR`.

A refusal is a normal `200` answer with `eligible: false`; the menu hides the item
and never shows a disabled entry. Network errors, timeouts, and unknown answers also
hide the item.

### Restore and maintenance refusals

`TRASH_ENTRY_NOT_FOUND`, `TRASH_STATE_INVALID`, `TRASH_DIR_MISSING`,
`RESTORE_TARGET_EXISTS`, `WORKSPACE_MISSING`, `RESTORE_VERIFY_FAILED`,
`UNSAFE_RESTORE_PATH`, `FORGET_NOT_ALLOWED`, `REVEAL_UNAVAILABLE`, `REVEAL_FAILED`,
`INDEX_CORRUPT`, `INDEX_NOT_CORRUPT`, `LOCKED`, `IO_ERROR`.

## Disk layout

```
<DSH_HOME>/.session-trash/
  trash-index.json          # authoritative index
  trash-index.json.bak      # previous committed index
  .lock                     # cross-process mutex ({ pid, host, startedAt })
  objects/
    <trashId>/
      meta.json             # written before the session directory moves
      session/              # the moved session directory (log + session.lock)
```

The index is written atomically (`tmp` → `fsync` → `rename`) and the previous
commit is preserved as `.bak`. A failed write removes its temporary file and leaves
the previous commit intact. A corrupt index with an unusable backup puts the plugin
into protection mode: it refuses new trash operations, cleanup, restores, and
permanent deletion, and reports the problem in the settings page. The page then
offers **Try rebuilding the index**, which scans `objects/*/meta.json`, validates
each sidecar, and writes a new index. Directories without a usable sidecar are
reported as unindexed and are never deleted automatically.

On activation and before every sweep the Host reconciles the index with the object
directories: unindexed objects with valid metadata are imported, entries whose
object directory vanished are marked `missing`, and a `missing` entry whose object
reappears is restored to `trashed`. It then settles unfinished `trashing`,
`restoring`, and `purging` entries: it completes a move whose copy landed, rolls
back a move whose source is intact, restores a session whose directory is back,
retries a pending purge, and marks a genuinely lost log as `missing` without
deleting anything else.

A session moves as one directory. A same-filesystem `rename` is preferred; on
`EXDEV` the plugin copies into a temporary sibling, verifies regular-file count
and byte count, publishes with a rename, then removes the source. Symlinks are
copied as symlinks and never dereferenced. The temporary sibling is removed on
every failure path, so an `ENOSPC` or permission error never leaves a half-copied
object behind.

## Cross-platform and failure behavior

- **Transient rename/remove failures** (`EPERM`, `EACCES`, `EBUSY`, `ENOTEMPTY`,
  `EMFILE`, `ENFILE`, `EAGAIN`) are retried with a short increasing delay. Windows
  and antivirus-heavy volumes commonly return these for a momentarily open handle.
- **Path identity** is lowercased for comparison on macOS and Windows. Containment
  checks (`isInside`, trash object removal, restore target parent) and the
  `sessionDir`/project-dir equality check use the same rule. On a case-sensitive
  APFS volume, two paths that differ only by case are treated as the same location.
- **Windows segments.** A session-directory segment may not be a reserved device
  name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), end in a dot or
  space, or contain control characters.
- **Disk full.** A cross-device copy that fails with `ENOSPC` removes its temporary
  tree and keeps the source; the API reports `IO_ERROR` with `details.code` and
  `details.phase`.
- **Permissions.** A read-only trash root fails at object creation with `IO_ERROR`
  and `phase: "create-object"`; the source session is untouched. A read-only
  destination parent fails the rename with `phase: "rename"`.
- **Concurrency.** Mutations run through one in-process serial queue and the disk
  `.lock`. The lock carries `{ pid, host, startedAt }`, refreshes every 60 seconds
  for long copies, and is considered stale after 10 minutes. Concurrent trash
  requests for different sessions both complete; a second request for the same
  session sees the moved log and fails cleanly.
- **Live race.** The Host re-checks `sessions.get`/`agents.get` immediately before
  the move while holding the lock. If the session became live in the gap, the
  prepared trash object is rolled back and `SESSION_LIVE` is returned.
- **Stale lock takeover.** Removing a stale lock is retried; if it still cannot be
  removed, the operation reports `LOCKED` instead of leaking a raw filesystem error.

## Retention, retries, and permanent deletion

- `expiresAt = trashedAt + retentionDays * 86_400_000`; the sweep deletes entries at
  or past that instant.
- Cleanup runs after activation (10 s delay), every `sweepIntervalHours`, and on a
  throttled page open (one hour, or `sweepIntervalHours` when `ctx.timer` is absent).
- A scheduled sweep that throws, or that reports failed purges, increments
  `consecutiveFailures` and schedules a retry after `min(1 min × 2^(n−1), 1 h)`.
  A manual cleanup that fails is recorded in diagnostics but does not schedule an
  automatic retry. A manual cleanup requested while an automatic sweep is running
  waits for it and then runs its own sweep with purge permission.
- A scheduled sweep settles unfinished states but skips expiry deletion when
  `enableAutoCleanup` is false. Manual cleanup always runs when requested.
- `missing` entries are skipped by the sweep so their recovery clues survive.
- Permanent deletion removes only the session log directory. Attachments, images,
  projection-cache rows, and search-index rows are not deleted; the UI says so in
  the confirmation dialog.

## Installation

From a workspace containing this package:

```text
plugin_manager install_bundle  target=<absolute path to this directory>
```

The bundle patch inserts one Host row (`session-trash`) and the `dsh.client` section
registers the browser module. A local development profile can also link the package
directly:

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/absolute/path/to/dsh-session-trash
```

Then add `dsh-session-trash` to `dsh.profile.bundles` in that profile's
`package.json`. Restart the Desktop app or reopen the profile to load the Host row;
the Client module is picked up from the `dsh.client` manifest on the next page load.

The package declares two dependencies, both pinned to the DSH release it targets:

| Dependency | Version | Why |
|---|---|---|
| `@deepseek-ai/dsh-home-paths` | `0.2.2-rc.1` | required resolution of `$DSH_HOME` / `~/.dsh` |
| `@deepseek-ai/schemastery` | `3.19.0` | builds the plugin `Config` schema |

A bundle installed as a directory link keeps its own `node_modules`, so run
`pnpm install` here before installing the bundle. A bundle unpacked into the
profile could instead resolve these from the Harness installation.

### Uninstall and upgrade

1. Remove `dsh-session-trash` from the profile's `dsh.profile.bundles` and its
   dependencies (or run the plugin manager's remove action).
2. Restart the Desktop app.
3. The plugin never deletes `<DSH_HOME>/.session-trash` on uninstall. Keep it to
   restore the logs later by reinstalling the plugin, or remove it manually once no
   session log in it is needed.

Upgrades are ordinary bundle reinstalls. The index schema is versioned; an
unsupported index version enters protection mode rather than being rewritten.

## Verification

The package has no build step. Run the Node test suite from this directory:

```bash
pnpm install
pnpm test
```

The suite covers the Host service, `Config` schema bounds, index/lock/recovery,
cleanup scheduling/retry, HTTP auth and routing, the real Client section (through a
small hook-capable React substitute), and the Phase 5 hardening cases. It does not
need the desktop app.

The real-Host regression boots the actual `dsh web` host from the installed desktop
runtime in a throwaway DSH home:

```bash
npm run test:e2e
```

It creates a temporary `web` profile that links this package, writes twelve
compressed JSONL sessions and a workspace registry, starts the host on a random
port, mints a browser cookie from the printed launch token, and asserts 13 feature
groups:

1. `GET /state` projection and cleanup diagnostics; the boot HTML registers
   `dsh-session-trash/client.js`.
2. HTTP contract: unauthenticated `401`, missing CSRF `403`, wrong method `405`,
   wrong content type / malformed / oversized body / invalid restore mode `400`.
3. Preflight and trash refusal matrix: missing session, subagent origin, parent
   with a persisted child; refused sessions stay on disk.
4. Trash and Toast-style undo/normal restore with the Workspace reattached.
5. Normal restore keeps the original Workspace sibling order.
6. Reveal guard for an unknown entry.
7. Cleanup failure diagnostics (`purging`, `lastError`, `failed`, consecutive
   failures) and manual recovery; automatic retry/backoff is covered by unit tests.
8. Forget only after an object disappears; the entry becomes `missing` and can be
   removed from the index without deleting session files.
9. Permanent purge removes the object and index entry.
10. 30-day expiry purge through a real sweep.
11. Corrupt-index protection mode (`500 INDEX_CORRUPT`, preflight refusal) and
    rebuild from `meta.json`; a healthy index refuses rebuild with `409`.
12. Reveal missing-workspace guard, orphan restore, and Workspace detach.
13. Final index/object invariants.

Set `DSH_E2E_KEEP=1` to keep the temporary home and the server log; set
`DSH_ELECTRON` to point at another Electron executable.

`test/smoke-host.mjs` is a lower-level Host check against the installed Cordis
runtime. It requires a throwaway `DSH_HOME` and the desktop Electron binary:

```bash
DSH_HOME=$(mktemp -d) ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/smoke-host.mjs
```

It registers the nine routes, drives trash/restore/purge/cleanup/rebuild through
the real route handlers, and verifies the session directory moves, returns, and is
deleted.

## Acceptance checklist (Phase 5)

- [x] Cold session trash, undo, and normal restore with Workspace order.
- [x] Orphan restore after the workspace directory disappears; Workspace detach.
- [x] 30-day expiry purge, manual permanent deletion, `missing` entry handling.
- [x] Index protection mode and rebuild from `meta.json` sidecars.
- [x] Live/active/subagent/descendant sessions never show the menu action; the Host
      rejects them anyway.
- [x] Large directory move and cross-device copy; symlinks are not dereferenced.
- [x] `ENOSPC`, read-only trash root, read-only destination parent, failed index
      write: source and previous state preserved.
- [x] Concurrent trash requests serialize and keep every committed entry.
- [x] A session becoming live during the move rolls back the prepared object.
- [x] Automatic cleanup retry with exponential backoff, diagnostics in `/state`,
      and a settings-page warning banner with a retry action.
- [x] macOS path/lock/rename behavior exercised on this machine.
- [x] Windows path rules (reserved names, trailing dots/spaces, drive and case
      comparison) covered by unit tests.
- [x] Real `dsh web` host end-to-end regression: auth/CSRF/method/body contract,
      preflight refusal matrix, trash/undo, Workspace order, forget, purge, expiry,
      corrupt-index rebuild, reveal guards, and orphan restore.
- [x] README installation, uninstall, known limitations, and recovery boundaries.
- [ ] Real Windows/Linux acceptance run on those operating systems. The code and
      unit tests are hardened for them, but this workspace only has macOS.

## Known limitations (Phase 5)

- **Platform coverage.** macOS is verified end-to-end. Windows and Linux paths,
  lock behavior, and retry rules are implemented and unit-tested, but no real
  Windows or Linux host has been exercised here. Windows long paths over 260
  characters need system long-path support; copying symlinks needs the usual
  Windows privilege.
- **Case-sensitive APFS.** Path identity is compared case-insensitively on macOS.
  On the uncommon case-sensitive APFS volume, two paths differing only by case are
  treated as the same location for containment and restore-parent checks.
- **The whole index is returned by `/state`.** The page filters and pages on the
  client, so a very large trash sends every entry summary in one response (accepted
  for v1).
- **No cross-window live push.** Open trash pages refresh on revision, window focus,
  and visibility change; another window’s mutation appears at the next refresh.
- **Session trees.** Sessions with child sessions, subagent sessions, live sessions,
  and sessions with running work can never be trashed; archive the tree instead.
  Cascading trash is not implemented.
- **Orphan restore** never recreates the original directory, never reattaches the
  Workspace, and does not re-link it if the directory reappears later.
- **Archive and pin state** is preserved across trash/restore. The trash page does
  not manage those sets; an archived session stays archived after restore.
- **Permanent deletion is log-only.** Attachments, images, projection-cache rows,
  and search-index rows survive and are cleaned by DSH later (or not at all). The
  UI calls this “delete the session log”.
- **Missing entries** are never removed automatically by the sweep; the owner must
  use “Remove from index” after confirming the log is gone.
- **Shared `DSH_HOME`.** Multiple DSH processes sharing one home serialize through
  `.lock`; a lock older than 10 minutes can be taken over. If a process is paused
  for longer than that while holding the lock, another process may take over.

## Layout

```
package.json         # bundle manifest, exports, dsh.client
cordis.patch.yml     # inserts the Host row
index.js             # Host apply + Config + service wiring
client.js            # Client module (trash page, context menu, icons)
lib/errors.js        # error codes, wire errors, path-segment guard
lib/paths.js         # @deepseek-ai/dsh-home-paths resolution
lib/store.js         # layout, atomic index, object metadata, cross-process lock
lib/fsops.js         # path identity, retryable rename/remove, directory moves
lib/eligibility.js   # preflight predicate and its cache
lib/inventory.js     # object scan, index reconcile, index rebuild
lib/trash-service.js # trash, restore (normal/orphan), purge, forget, reveal, sweep, recovery
lib/cleanup.js       # retention sweep scheduling, retry/backoff, diagnostics
lib/state.js         # read-only /state projection
lib/http.js          # route registration, auth, JSON shaping
locale/en.json       # plugin display metadata (en)
locale/zh.json       # plugin display metadata (zh)
icon.svg             # package tile: DSH trash artwork on a brand tile
test/                # Node unit tests, Host smoke test, real-dsh web e2e
```

The trash glyph (menu entry, settings navigation, empty state) reproduces the
`trash-outline` artwork from the DeepSeek Harness product icon set, so it matches the
shipped “Delete workspace” icon. That artwork is MIT licensed, © 2026 DeepSeek.
