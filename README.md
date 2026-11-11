# dsh-session-trash

[![CI](https://github.com/wangxiaocuo/dsh-session-trash/actions/workflows/ci.yml/badge.svg)](https://github.com/wangxiaocuo/dsh-session-trash/actions/workflows/ci.yml)

简体中文 | [English](./README.en.md)

[GitHub](https://github.com/wangxiaocuo/dsh-session-trash) · [npm](https://www.npmjs.com/package/@wangxiaocuo/dsh-session-trash) · [更新记录](./CHANGELOG.md)

DeepSeek Harness 的会话回收站插件。冷会话可以从侧边栏移出，日志保留在本地；保留期内可以恢复，到期后自动删除日志。面向 DSH 0.2.2-rc.1 的 Desktop 和 Web，Host 和 Client 在同一个包里，不需要构建步骤。

当前状态：功能已实现。CI（GitHub Actions）在 Ubuntu（Node 20/22）和 Windows（Node 22）上跑单元测试、Host 冒烟测试和真实 `dsh web` 端到端测试（Host 由 npm 安装的 DSH runtime 启动）；macOS 另外在真实桌面版 Host 上手动跑通过 e2e。Windows 上依赖 POSIX 权限位的用例会显式跳过。

## 功能

- 侧边栏右键会话，选择「移入回收站」。只有冷会话、没有运行中的 turn、job、subagent 或定时任务时才能移入；会话跑过的隐藏 subagent 子会话会随父会话一起移入、一起恢复。
- 对仍打开的会话、正在运行的会话或含可见子会话的会话，菜单保留一个带原因的「移入回收站」说明项：点开解释为什么暂时不能移入，而不是把菜单项直接隐藏。
- 移入后显示 DSH 共享 Toast，只有「撤销」一个动作。撤销先尝试正常恢复，原工作区不存在时改为孤儿恢复。
- 设置页「回收站」显示标题、Session ID、原工作区、移入时间、剩余天数、大小和状态。列表支持搜索、筛选，每页 50 条。
- 含子会话的条目显示「含 N 个子会话」徽章；恢复和永久删除按整棵树处理，不做部分恢复。
- 行操作包括恢复、恢复为孤儿会话、永久删除、从索引移除、复制 Session ID，以及在 Finder 或资源管理器中显示原工作区。
- 工具栏「永久删除全部」在二次确认后清空回收站：删除所有已移入的会话日志，并把文件缺失的记录移出索引；附件、图片和搜索索引等衍生物不删除。
- 默认保留 30 天，每 6 小时扫描一次；插件激活后和打开回收站页面时也会检查。清理失败按指数退避重试，失败信息显示在页面上。
- 索引原子写入，旧索引保留为 `.bak`。索引和备份都损坏时进入保护模式，拒绝写操作，并可从每个对象的 `meta.json` 重建。
- 重命名、分叉、归档和复制 Session ID 继续使用 DSH 自带的侧边栏菜单，本插件不重复实现。

## 安装

插件发布在 npm（[`@wangxiaocuo/dsh-session-trash`](https://www.npmjs.com/package/@wangxiaocuo/dsh-session-trash)），也可以在「添加插件」里填 GitHub 仓库地址或本地目录。

安装和卸载由当前 profile 的 pnpm 完成。Desktop 自带 pnpm；从源码运行 `dsh web` 时要求 `PATH` 里有 pnpm，从 GitHub 安装还需要 git 和可用的 GitHub 网络。

### 在 DSH 里安装（推荐）

1. 打开侧栏「插件」页，点右上角「添加插件」。
2. 在「包名或地址」里填 `@wangxiaocuo/dsh-session-trash`。要装当前分支最新代码时，改填 `git+https://github.com/wangxiaocuo/dsh-session-trash.git`。
3. 「安装源」保持默认。插件和依赖都从 npm 下载；国内网络可以切到「中国大陆镜像源」，镜像同步可能比官方源晚几分钟。
4. 点「安装」。DSH 先读取包名、简介和版本，再用 pnpm 安装；命令和输出在「查看安装详情」里。
5. 装好后点「立即启用」。提示需要重启时重启 DSH，Web 端刷新页面。右键菜单和设置页「回收站」随后出现。

本地目录安装：先克隆仓库，在目录里执行 `pnpm install`（目录链接形式的 bundle 使用自己的 `node_modules`），再填该目录的绝对路径。

安装失败时先看「查看安装详情」里的 pnpm 输出和 Host 日志路径：

- 未找到相关插件：检查包名拼写，或等镜像同步；也可以改用 Git 地址或本地目录。
- 所有安装源都无法连接：检查网络或代理，或改用本地目录。
- 包没有声明组合包，或路径不是有效的插件包：Git 地址要指向仓库根目录，本地路径要填插件包目录。
- 安装完成但功能没有出现：确认已在插件页启用；未开启 HMR 的 profile 需要重启 DSH，Web 端还要刷新页面。

### 让 Agent 安装

让 Agent 执行其中一条。这个操作需要 `danger-full-access` 或单独批准：

```text
plugin_manager install_bundle  target=@wangxiaocuo/dsh-session-trash
plugin_manager install_bundle  target=git+https://github.com/wangxiaocuo/dsh-session-trash.git
plugin_manager install_bundle  target=/absolute/path/to/dsh-session-trash
```

本机已有克隆目录时直接装目录，可以省一次下载。装有 DSH CLI 的话，`dsh plugin add <同样的 spec>` 等价。

### 手动链接到 profile（开发用）

```bash
git clone https://github.com/wangxiaocuo/dsh-session-trash.git
cd dsh-session-trash
pnpm install
```

```bash
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
pnpm add link:/absolute/path/to/dsh-session-trash
```

把 `@wangxiaocuo/dsh-session-trash` 加入该 profile `package.json` 的 `dsh.profile.bundles`，重启 DSH 加载 Host，刷新页面加载 Client。运行时依赖 `@deepseek-ai/dsh-home-paths@0.2.2-rc.1` 和 `@deepseek-ai/schemastery@3.19.0`。

### 升级和卸载

npm 安装的插件在「插件」页打开「会话回收站」的详情，展开「版本」区块后点「更新」；没有可更新的版本时卸载后重装。Git 安装需要卸载重装才会取到新代码；手动链接的在目录里 `git pull`、`pnpm install`，然后重启 DSH 并刷新页面。

卸载时打开同一个详情，点「卸载」并确认，profile 里的依赖会一并移除；也可以手动从 profile 的 bundles 和依赖中移除后重启。卸载不会删除 `<DSH_HOME>/.session-trash`，需要清理时手动删除该目录。

## 配置

在 profile patch 的插件行中配置：

```yaml
- id: session-trash
  name: '@wangxiaocuo/dsh-session-trash'
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

## 使用

右键冷会话选择「移入回收站」。Toast 消失后，仍可从设置页「回收站」恢复；原工作区目录已不存在时，页面会先确认，确认后会话回到「未分组」。需要清空时点工具栏「永久删除全部」并确认，未过期的条目也会删除。

当前 DSH 版本会把打开过的会话保留为 live agent，直到该 Host 进程结束。会话即使空闲也算 live，此时右键菜单显示的是带原因的说明项、不能移入；需要回收时先重启 DSH，或直接归档。另一个 DSH 实例不会识别这种 live 状态，不要用它绕过限制。

## HTTP API

所有路由位于 `/plugins/dsh-session-trash/api/`，以精确路径注册在 `ctx.webServer` 上。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/state` | 配置、索引状态、条目、统计和清理诊断；打开页面时可能触发一次节流清理 |
| `POST` | `/preflight` | `{ sessionId }` 返回 `{ eligible: true, descendants }` 或 `{ eligible: false, code, message, details? }`；`descendants` 是一并移入的隐藏子会话数 |
| `POST` | `/trash` | `{ sessionId }`，移动整棵会话树（父会话 + 隐藏 subagent 子会话），返回 `{ ok, entry }` |
| `POST` | `/restore` | `{ sessionId, mode: 'normal' \| 'orphan' }` |
| `POST` | `/purge` | `{ sessionId }`，永久删除会话日志 |
| `POST` | `/purge-all` | 无请求体，永久删除回收站中的全部条目；`missing` 记录仅移除索引；返回 `{ ok, purged, forgotten, failed }` |
| `POST` | `/forget` | `{ sessionId }`，仅移除 `missing` 条目的索引记录 |
| `POST` | `/reveal` | `{ sessionId }`，打开原工作区 |
| `POST` | `/cleanup` | 无请求体，手动执行一次清理 |
| `POST` | `/rebuild` | 无请求体，仅在索引保护模式下重建 |

请求需要通过 `ctx.connection.requestRejection()` 和 `ctx.connection.admit()`，`POST` 还要带 `X-DSH-Session-Trash: 1`。请求体使用 `Content-Type: application/json`，上限 64 KiB。响应带 `Cache-Control: no-store`，不返回回收站根目录的绝对路径。

失败响应格式为 `{ ok: false, error: { code, message, details? } }`。预检拒绝码包括 `SESSION_NOT_FOUND`、`ALREADY_TRASHED`、`SESSION_NOT_MATERIALIZED`、`STORAGE_UNSUPPORTED`、`SESSION_SUBAGENT`、`SESSION_HAS_DESCENDANTS`、`SESSION_LINEAGE_UNRESOLVED`、`SESSION_LIVE`、`SESSION_ACTIVE`、`UNSAFE_SESSION_DIR`、`INDEX_CORRUPT` 和 `IO_ERROR`。

恢复和维护拒绝码包括 `TRASH_ENTRY_NOT_FOUND`、`TRASH_STATE_INVALID`、`TRASH_DIR_MISSING`、`RESTORE_TARGET_EXISTS`、`WORKSPACE_MISSING`、`RESTORE_VERIFY_FAILED`、`UNSAFE_RESTORE_PATH`、`FORGET_NOT_ALLOWED`、`REVEAL_UNAVAILABLE`、`REVEAL_FAILED`、`INDEX_CORRUPT`、`INDEX_NOT_CORRUPT`、`LOCKED` 和 `IO_ERROR`。

`/state` 的 `stats.cleanup` 记录上次清理时间、下次清理时间、重试时间、连续失败次数和上次运行摘要。

`/state` 的条目新增 `subagentCount`（一并移入的隐藏子会话数）和 `members`（父会话在前，含 `sessionId`、`origin`、`sizeBytes`）；`sizeBytes`/`fileCount` 是整棵树的总量。`/trash` 返回的 `entry` 使用同一形状。条目还带 `lastErrorCode`（稳定的失败分类，供页面本地化）和 `lastError`（英文原始诊断，只作 tooltip）。

## 数据与恢复

```text
<DSH_HOME>/.session-trash/
  trash-index.json          # 主索引
  trash-index.json.bak      # 上一次成功提交的索引
  .lock                     # 跨进程锁
  objects/
    <trashId>/
      meta.json             # 对象元数据
      session/              # 被移动的父会话目录
      children/
        <sessionId>/        # 一并移入的隐藏 subagent 子会话目录
```

索引通过 `tmp`、`fsync`、`rename` 原子提交，旧版本保留为 `.bak`。启动时和每次清理前，插件会处理未完成的 `trashing`、`restoring`、`purging` 状态：能完成的完成，能回滚的回滚，无法判断的标记为 `missing`，不会删除会话日志。

同文件系统移动使用 `rename`。跨文件系统时先复制到临时目录，校验普通文件数量和字节数，再 rename 发布，最后删除源目录。任一步失败都会清理临时目录并保留源。符号链接按符号链接复制，不跟随。

在 POSIX 文件系统上，回收站目录权限为 `0700`，索引和元数据为 `0600`。锁文件超过 10 分钟未更新时视为陈旧。

索引 schema 为 v2，v1 索引会在启动时自动升级并保留为 `.bak`。旧版本插件读不懂 v2 索引，会进入保护模式；降级前请先清空回收站。

## 限制

- 当前 DSH 版本中，打开过的会话会保持 live 直到 Host 进程结束，因此不会显示「移入回收站」。需要回收时重启 DSH。
- 带可见子会话（非 subagent）的父会话不能回收，只能归档整棵树；subagent 的隐藏子会话随父会话一起移入。
- 整棵树按整体恢复或删除，不做部分恢复：任一成员目录缺失时条目会标记为 `missing`，只能永久删除或从索引移除。
- 孤儿恢复不会重建原工作区目录，也不会重新挂到工作区。
- 归档和置顶状态会跨回收、恢复保留，回收站页面不管理这两个集合。
- 永久删除只删除会话日志。附件、图片、投影缓存和搜索索引不会被删除。
- `/state` 一次返回全部条目摘要，页面在客户端搜索、筛选和分页。
- 没有跨窗口实时推送。另一个窗口的变更要等刷新或窗口重新获得焦点后出现。
- Windows/Linux 的桌面版尚未手动验证；CI 用 npm 安装的 `dsh web` 覆盖真实 Host 行为，但桌面壳 UI 与桌面专属能力（例如「在文件管理器中显示」）仍只在 macOS 上验证。Windows 上依赖 POSIX 权限位的用例会跳过；超过 260 字符的长路径和符号链接复制受系统设置影响，对应用例在不支持时自动跳过。
- macOS 的路径比较按大小写不敏感处理。在大小写敏感的 APFS 卷上，仅大小写不同的两个路径会被视为同一位置。
- 多个 DSH 进程共享同一个 `DSH_HOME` 时，回收站操作通过 `.lock` 串行；进程暂停超过 10 分钟后，锁可能被另一个进程接管。

## 开发

```bash
pnpm install
pnpm test          # 单元测试 + 真实 DOM 组件测试（jsdom）
pnpm typecheck     # tsc --checkJs（当前覆盖 lib/ 和 index.js）
pnpm test:coverage # 覆盖率（CI 的门槛只作用于 lib/**）
pnpm test:smoke    # Host 冒烟测试（真实 Cordis，普通 Node 即可）
npm run test:e2e   # 真实 dsh web 端到端（桌面版或 npm 安装的 DSH）
```

Host 冒烟测试通过 `@deepseek-ai/cordis` 这个 devDependency 装配真实插件上下文，自己创建并清理临时 `DSH_HOME`，不需要桌面版；设置 `DSH_SMOKE_KEEP=1` 可以保留临时目录用于排查。`pnpm test` 通过 `test/run-unit.mjs` 枚举测试文件，不依赖 shell 展开 glob，Windows 和 POSIX shell 行为一致。

验证范围：

| 检查 | 已验证环境 |
|---|---|
| 单元测试、Host 冒烟测试 | CI：Ubuntu Node 20/22、Windows Node 22 |
| 打包内容（`npm pack`） | CI：Ubuntu |
| 覆盖率门槛（`lib/**`，行 85 / 分支 70 / 函数 84） | CI：Ubuntu Node 22 |
| 真实 `dsh web` 端到端（npm 安装的 DSH） | CI：Ubuntu、Windows（Node 22） |
| 真实 `dsh web` 端到端（桌面版） | macOS + DSH 0.2.2-rc.1（手动执行） |

`npm run test:e2e` 会启动真实 `dsh web` Host，在临时 `DSH_HOME` 中跑完整流程。默认按平台在常见安装位置查找桌面版（也可以用 `DSH_ELECTRON` 指定）；设置 `DSH_E2E_DSH_BIN` 指向 npm 安装的 `@deepseek-ai/dsh` 的 `lib/bin.js` 时，改用普通 Node 启动 Host——CI 和 Linux/Windows 都走这条路径，不依赖桌面版。找不到 Host 时打印跳过信息并以 0 退出。依赖 POSIX 权限位的「清理失败」场景在 Windows 上会跳过。设置 `DSH_E2E_KEEP=1` 可以保留临时目录和日志。

### 发布（维护者）

1. 更新 `package.json` 版本和 `CHANGELOG.md`，提交并推送。
2. 打 tag 并推送：`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`。
3. tag 会触发 [release.yml](.github/workflows/release.yml)：跑 typecheck、单测、smoke 和真实 Host e2e，然后 `npm publish --provenance` 并创建 GitHub Release。

发布使用 npm Trusted Publishing（OIDC），不需要 `NPM_TOKEN`：在 npmjs.com 的包设置 → Publishing access → Trusted publishers 里添加仓库 `wangxiaocuo/dsh-session-trash` 和 workflow `release.yml`。如果改用 automation token，取消 release.yml 里 `NODE_AUTH_TOKEN` 的注释并添加同名 secret。

项目结构：

```text
README.md / README.en.md   中文 / English 文档
LICENSE               MIT 许可证
index.js              Host 入口、Config 和服务装配
client.js             Client 界面、侧边栏菜单和 Toast
lib/                  索引、锁、移动、资格判断、清理、HTTP 和状态投影
locale/               插件显示名称和描述
test/                 单测、Host 冒烟测试、真实 dsh web 端到端测试
```

回收站图标使用 DeepSeek Harness 产品图标集中的 `trash-outline` 图形，MIT 许可，© 2026 DeepSeek。项目整体为 MIT 许可，见 [LICENSE](./LICENSE)。
