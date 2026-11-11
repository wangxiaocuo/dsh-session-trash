# Changelog

本文件记录这个插件的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 回收站页支持按移入时间、标题、大小、到期时间排序，可勾选多个条目批量恢复（只含工作区仍存在的条目），并支持全选当前页。
- 含子会话的条目可以展开查看成员列表（父/子会话 ID 与大小）。
- 同源浏览器标签页通过 `BroadcastChannel` 实时同步回收站变更，不再需要切换焦点或手动刷新。

### Changed

- 类型收紧：`members.js` 的 `Member`/`TrashEntry` 与 `state.js` 的状态投影形状改为具体类型。

## [0.6.5] - 2026-11-11

### Added

- 回收站页可以清理不含会话日志的空无主对象（`POST /orphans/forget`）；可能含日志的无主对象继续保留，供人工处理。
- CI 增加 `lib/**` 覆盖率门槛（行 85 / 分支 70 / 函数 84）和 README 的 CI badge。
- 新增 tag 触发的 release workflow：typecheck、单测、smoke、真实 Host e2e 通过后 `npm publish --provenance` 并创建 GitHub Release；使用 npm Trusted Publishing，无需 `NPM_TOKEN`。

### Changed

- `GET /state` 改为纯只读；页面打开时由客户端显式调用 `POST /sweep` 触发节流维护，读请求不再可能触发永久删除。
- 锁竞争：Host 在报 `LOCKED` 前短暂重试，客户端对 `LOCKED` 自动重试一次；`trash()` 的 lineage/preflight 移到锁外，缩短持锁时间。
- 收紧 `lib/errors.js` 和 `lib/fsops.js` 的类型（`any` 换成 `unknown` 与具体形状）。

### Tests

- 覆盖页面维护扫描（成功/节流/失败）、空无主对象清理、锁重试和客户端 LOCKED 重试。

## [0.6.4] - 2026-11-11

### Added

- e2e 支持 `DSH_E2E_DSH_BIN` 启动 npm 安装的 `@deepseek-ai/dsh` web Host，不再依赖桌面版；Linux/Windows 也能跑真实 Host 端到端测试。
- CI 新增真实 Host e2e job（Ubuntu + Windows），失败时输出 check annotations。
- 新增 `pnpm typecheck`（`tsc --checkJs`，先覆盖 `lib/` 和 `index.js`）并接入 CI；DSH 服务通过 `types/dsh-context.d.ts` 的 ambient 声明提供类型。
- 新增 jsdom + 真实 React 渲染测试（`test/client-dom.test.js`），覆盖行菜单的方向键/Escape/Tab/外点关闭，以及确认对话框的焦点陷阱和焦点恢复。

### Fixed

- ActionMenu：Escape 不再冒泡到宿主设置弹层；Tab 会关闭菜单并让焦点自然移动；分隔符使用 `role="separator"`。
- ConfirmDialog：打开它的行或按钮被移除后，焦点回退到列表面板，不再丢到 `body`。

## [0.6.3] - 2026-11-11

### Added

- `/state` 的条目新增稳定的 `lastErrorCode`，页面据此把失败原因本地化；`lastError` 保留英文原始诊断，只用作 tooltip。
- 新增本 CHANGELOG，并把它包含在 npm 包里。

### Changed

- 中文界面不再直接显示 Host 的英文诊断；「在 Finder 中显示」改为平台中性的「在文件管理器中显示」。
- 英文界面使用正确的单复数（会话数、子会话数、清理/删除数量）。
- 清理结果区分部分失败与全部失败，失败时使用失败 Toast 并给出数量。
- 到期倒计时每分钟刷新；条目的数据变少时页码自动收敛。
- 生成 `/state` 时，同一原始工作区只探测一次，而不是每个条目各探测一次。
- 未知大小显示为 `—`，不再显示 `0 B`。

### Fixed

- 恢复、永久删除、从索引移除或显示工作区成功后，清除该行残留的旧错误提示。
- 跨设备复制后源目录删除失败时，HTTP 错误不再返回源路径/回收站绝对路径；错误 `details` 只暴露白名单字段（`code`、`phase`、`sessionId`、`metrics` 等）。
- 跨设备复制校验现在比较符号链接数量，能发现复制过程中被静默丢弃的符号链接。

### Tests

- 新增 wire 错误脱敏、`lastErrorCode` 映射、工作区探测去重、清理部分失败、行错误清除、未知大小和符号链接校验的回归测试。

## [0.6.2] - 2026-11-11

### Fixed

- 客户端写操作串行化：同一时间只允许一个写请求，行级 pending 状态独立清理，程序化重复点击会被忽略。
- 写请求 30 秒、`/state` 15 秒硬超时；设置页卸载时取消在途请求，超时显示本地化文案。
- 后台刷新不再禁用行操作；`ActionMenu` 在变为禁用时自动关闭。

### Tests / CI

- 测试入口改为跨平台的 `test/run-unit.mjs`（不依赖 shell glob）。
- CI 增加 Windows（Node 22）矩阵，并把单元测试失败输出转成 check annotations。
- e2e 支持跨平台发现桌面版，Windows 上跳过依赖 POSIX 权限位的清理失败场景。

### Docs

- README 用可核对的验证矩阵替代原先无法验证的跨平台表述。

## [0.6.1] - 2026-11-11

### Fixed

- Host 冒烟测试改为普通 Node 可运行：索引版本断言改为读取 `INDEX_VERSION`，不再硬编码；Cordis 来自 `@deepseek-ai/cordis` devDependency；自己创建并清理临时 `DSH_HOME`。

### Performance

- 批量删除/清理改为批量提交索引：200 条目的永久删除从 400 次索引提交、约 70 MB 写入降到 2 次提交、约 0.4 MB。
- 启动恢复复用 reconcile 的探测结果，并对成员目录并行探测；单个条目变化时只重写它自己的 `meta.json`。

### Added

- GitHub Actions CI（单元测试、冒烟测试、覆盖率、打包内容检查）。

## [0.6.0] - 2026-11-09

### Added

- 隐藏的 subagent 子会话随父会话一起移入回收站、一起恢复；含子会话的条目显示数量徽章。
- 生成组合包并以 `@wangxiaocuo/dsh-session-trash` 发布。

### Changed

- **BREAKING**：索引 schema 升级为 v2（条目携带 `members`）；旧版本插件无法读取 v2 索引，会进入保护模式。降级前请先清空回收站。

## [0.5.1] - 2026-11-09

### Added

- 回收站工具栏的「永久删除全部」与二次确认；`missing` 记录只移出索引，不删除会话文件。

[0.6.5]: https://github.com/wangxiaocuo/dsh-session-trash/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/wangxiaocuo/dsh-session-trash/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/wangxiaocuo/dsh-session-trash/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/wangxiaocuo/dsh-session-trash/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/wangxiaocuo/dsh-session-trash/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/wangxiaocuo/dsh-session-trash/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/wangxiaocuo/dsh-session-trash/releases/tag/v0.5.1
