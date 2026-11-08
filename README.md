# dsh-session-trash

[中文](#中文) | [English](#english)

## 中文

DeepSeek Harness 的会话回收站插件。冷会话可以从侧边栏移出，日志保留在本地；在保留期内可以恢复，到期后自动删除日志。面向 DSH 0.2.2-rc.1 的 Desktop 和 Web，Host 和 Client 在同一个包里，不需要构建步骤。

当前状态：功能已实现并通过回归测试。macOS 已完成真实 DSH Host 验证；Windows 和 Linux 的路径、锁、重试规则有单测覆盖，尚未在真实主机上验证。

### 功能

- 在侧边栏右键会话，选择「移入回收站」。只有冷会话、没有持久化子会话、也没有运行中的 turn、job、subagent 或定时任务时，菜单项才会出现。
- 移入后显示 DSH 共享 Toast，只带一个「撤销」动作。撤销会先尝试正常恢复，原工作区不存在时自动改为孤儿恢复。
- 设置页「回收站」显示标题、Session ID、原工作区、移入时间、剩余天数、大小和状态。列表支持搜索、筛选和每页 50 条的分页。
- 行操作包括恢复、恢复为孤儿会话、永久删除、从索引移除、复制 Session ID，以及在 Finder 或资源管理器中显示原工作区。
- 回收站默认保留 30 天，每 6 小时自动扫描一次。插件激活后和打开回收站页面时也会检查。清理失败会按指数退避重试，失败信息显示在页面上。
- 索引写入是原子的，旧索引保留为 `.bak`。索引和备份都损坏时进入保护模式，拒绝写操作，并可从每个回收站对象的 `meta.json` 重建。
- 重命名、分叉、归档、复制 Session ID 继续使用 DSH 自带的侧边栏菜单，本插件不重复实现。

### 安装

从包含本包的目录执行：

```text
plugin_manager install_bundle  target=<absolute path to this directory>
```

目录链接形式的 bundle 会使用自己的 `node_modules`，安装前先在包目录运行 `pnpm install`。

本地开发也可以把包链接到 profile：

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/absolute/path/to/dsh-session-trash
```

然后把 `dsh-session-trash` 加入该 profile `package.json` 的 `dsh.profile.bundles`。重启 Desktop 后加载 Host，刷新页面后加载 Client。

运行时依赖 `@deepseek-ai/dsh-home-paths@0.2.2-rc.1` 和 `@deepseek-ai/schemastery@3.19.0`。

卸载时从 profile 的 bundles 和依赖中移除 `dsh-session-trash`，然后重启 Desktop。卸载不会删除 `<DSH_HOME>/.session-trash`，需要清理时手动删除该目录。

### 配置

在 profile patch 的插件行中配置：

```yaml
- id: session-trash
  name: dsh-session-trash
  config:
    retentionDays: 30        # 1-3650
    sweepIntervalHours: 6    # 1-168
    enableAutoCleanup: true
    debug: false
```

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `retentionDays` | `30` | 1-3650 | 回收站保留天数，到期自动删除 |
| `sweepIntervalHours` | `6` | 1-168 | 自动清理间隔 |
| `enableAutoCleanup` | `true` | boolean | 关闭后仍可手动永久删除，不自动清理 |
| `debug` | `false` | boolean | 输出更详细的诊断日志 |

省略 `config` 时使用默认值。配置值不合法时插件拒绝激活，不会回退到默认值。修改普通字段会重启插件。

### 使用

右键冷会话选择「移入回收站」。Toast 消失后，仍可从设置页的「回收站」恢复。恢复时如果原工作区目录已不存在，页面会先弹出确认，确认后会话回到「未分组」。

当前 DSH 版本会把打开过的会话保留为 live agent，直到该 Host 进程结束。即使它已经空闲，菜单项也不会出现；需要回收时先重启 DSH，或者直接归档。另一个 DSH 实例不会识别这种 live 状态，不要用它绕过限制。

### HTTP API

所有路由位于 `/plugins/dsh-session-trash/api/`，以精确路径（exact route）注册在 `ctx.webServer` 上。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/state` | 配置、索引状态、条目、统计和清理诊断；打开页面时可能触发一次节流清理 |
| `POST` | `/preflight` | `{ sessionId }` 返回 `{ eligible: true }` 或 `{ eligible: false, code, message }` |
| `POST` | `/trash` | `{ sessionId }`，移动会话目录 |
| `POST` | `/restore` | `{ sessionId, mode: 'normal' \| 'orphan' }` |
| `POST` | `/purge` | `{ sessionId }`，永久删除会话日志 |
| `POST` | `/forget` | `{ sessionId }`，仅移除 `missing` 条目的索引记录 |
| `POST` | `/reveal` | `{ sessionId }`，打开原工作区 |
| `POST` | `/cleanup` | 无请求体，手动执行一次清理 |
| `POST` | `/rebuild` | 无请求体，仅在索引保护模式下重建 |

请求需要通过 `ctx.connection.requestRejection()` 和 `ctx.connection.admit()`，`POST` 还要带 `X-DSH-Session-Trash: 1`。读取请求体时使用 `Content-Type: application/json`，上限 64 KiB。响应带 `Cache-Control: no-store`，不会返回回收站根目录的绝对路径。

失败响应格式为 `{ ok: false, error: { code, message, details? } }`。预检拒绝码包括 `SESSION_NOT_FOUND`、`ALREADY_TRASHED`、`SESSION_NOT_MATERIALIZED`、`STORAGE_UNSUPPORTED`、`SESSION_SUBAGENT`、`SESSION_HAS_DESCENDANTS`、`SESSION_LINEAGE_UNRESOLVED`、`SESSION_LIVE`、`SESSION_ACTIVE`、`UNSAFE_SESSION_DIR`、`INDEX_CORRUPT` 和 `IO_ERROR`。

恢复和维护拒绝码包括 `TRASH_ENTRY_NOT_FOUND`、`TRASH_STATE_INVALID`、`TRASH_DIR_MISSING`、`RESTORE_TARGET_EXISTS`、`WORKSPACE_MISSING`、`RESTORE_VERIFY_FAILED`、`UNSAFE_RESTORE_PATH`、`FORGET_NOT_ALLOWED`、`REVEAL_UNAVAILABLE`、`REVEAL_FAILED`、`INDEX_CORRUPT`、`INDEX_NOT_CORRUPT`、`LOCKED` 和 `IO_ERROR`。

`/state` 的 `stats.cleanup` 记录上次清理时间、下次清理时间、重试时间、连续失败次数和上次运行摘要。

### 数据与恢复

```text
<DSH_HOME>/.session-trash/
  trash-index.json          # 主索引
  trash-index.json.bak      # 上一次成功提交的索引
  .lock                     # 跨进程锁
  objects/
    <trashId>/
      meta.json             # 对象元数据
      session/              # 被移动的会话目录
```

索引通过 `tmp`、`fsync`、`rename` 原子提交，旧版本保留为 `.bak`。启动时和每次清理前，插件会处理未完成的 `trashing`、`restoring`、`purging` 状态：能完成的完成，能回滚的回滚，无法判断的标记为 `missing`，不会删除会话日志。

同文件系统移动使用 `rename`。跨文件系统时先复制到临时目录，校验普通文件数量和字节数，再 rename 发布，最后删除源目录。任一步失败都会清理临时目录并保留源。符号链接按符号链接复制，不跟随。

在 POSIX 文件系统上，回收站目录权限为 `0700`，索引和元数据为 `0600`。锁文件超过 10 分钟未更新时视为陈旧。

### 限制

- 当前 DSH 版本中，打开过的会话会保持 live 直到 Host 进程结束，因此不会显示「移入回收站」。需要回收时重启 DSH。
- 带子会话的父会话和 subagent 会话不能单独回收，只能归档整棵树。
- 孤儿恢复不会重建原工作区目录，也不会重新挂到工作区。
- 归档和置顶状态会跨回收、恢复保留，回收站页面不管理这两个集合。
- 永久删除只删除会话日志。附件、图片、投影缓存和搜索索引不会被删除。
- `/state` 一次返回全部条目摘要，页面在客户端搜索、筛选和分页。
- 没有跨窗口实时推送。另一个窗口的变更要等刷新或窗口重新获得焦点后出现。
- Windows 和 Linux 尚未在真实主机上验证。Windows 超过 260 字符的长路径和符号链接复制受系统设置影响。
- macOS 的路径比较按大小写不敏感处理。在大小写敏感的 APFS 卷上，仅大小写不同的两个路径会被视为同一位置。
- 多个 DSH 进程共享同一个 `DSH_HOME` 时，回收站操作通过 `.lock` 串行；进程暂停超过 10 分钟后，锁可能被另一个进程接管。

### 开发

```bash
pnpm install
pnpm test
npm run test:e2e
```

`npm run test:e2e` 会启动真实 `dsh web` Host，在临时 `DSH_HOME` 中跑完整流程。默认使用 `/Applications/DeepSeek Harness.app`，也可以用 `DSH_ELECTRON` 指向其他 Electron 可执行文件。设置 `DSH_E2E_KEEP=1` 可以保留临时目录和日志。

Host 冒烟测试需要单独的临时 `DSH_HOME`：

```bash
DSH_HOME=$(mktemp -d) ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/smoke-host.mjs
```

项目结构：

```text
index.js              Host 入口、Config 和服务装配
client.js             Client 界面、侧边栏菜单和 Toast
lib/                  索引、锁、移动、资格判断、清理、HTTP 和状态投影
locale/               插件显示名称和描述
test/                 单测、Host 冒烟测试、真实 dsh web 端到端测试
```

回收站图标使用 DeepSeek Harness 产品图标集中的 `trash-outline` 图形，MIT 许可，© 2026 DeepSeek。

## English

A session trash for DeepSeek Harness. Move cold sessions out of the sidebar without deleting their logs, restore them within the retention window, or delete the logs permanently. Built for DSH 0.2.2-rc.1 on Desktop and Web. Host and Client ship in one package, with no build step.

Status: feature complete and covered by the regression suite. macOS has been verified against a real DSH Host. Windows and Linux path, lock, and retry rules have unit coverage but have not been run on those systems.

### Features

- Right-click a session in the sidebar and choose "Move to trash". The item appears only for cold sessions with no persisted children and no running turn, job, subagent, or scheduled task.
- After the move, the shared DSH Toast offers one action: Undo. Undo tries a normal restore first and falls back to an orphan restore when the original workspace is gone.
- The Trash page in Settings shows title, Session ID, original workspace, trashed date, remaining days, size, and status. The list supports search, filters, and paging at 50 rows per page.
- Row actions include restore, restore as orphan, permanent deletion, removal from the index, copying the Session ID, and revealing the original workspace in Finder or Explorer.
- Cleanup keeps entries for 30 days by default and runs every 6 hours. It also runs shortly after activation and when the Trash page opens. Failed cleanup runs are retried with exponential backoff, and the page shows the failure.
- The index is committed atomically and the previous index is kept as `.bak`. If both the index and the backup are unreadable, the plugin enters protection mode and can rebuild the index from each object's `meta.json`.
- Rename, fork, archive, and copy Session ID stay in the shipped DSH sidebar menu. This plugin does not reimplement them.

### Installation

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

### Configuration

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

### Usage

Right-click a cold session and choose "Move to trash". After the Toast disappears, open Settings, then Trash, and restore the session. If the original workspace directory is gone, the page asks for confirmation and restores the session as an orphan under "Ungrouped".

The current DSH version keeps a live agent for a session after it is opened, until the Host process exits. A session is still live even when idle, so the menu item stays hidden. Restart DSH before trashing it, or archive it instead. A second DSH instance does not detect a session that is live in another process, so do not use one to bypass this check.

### HTTP API

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

### Storage and recovery

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

### Limitations

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

### Development

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
