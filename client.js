window.__ModuleLoader__.load({
  id: '@wangxiaocuo/dsh-session-trash',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sessionTrash'
    const CSRF_HEADER = 'X-DSH-Session-Trash'
    const MENU_ID = 'session-trash.move'
    const SECTION_ID = 'session-trash'
    const PREFLIGHT_TIMEOUT_MS = 800
    /** Hard budget for one trash write request. */
    const MUTATION_TIMEOUT_MS = 30_000
    /** Hard budget for one `/state` read. */
    const STATE_TIMEOUT_MS = 15_000
    const DAY_MS = 86_400_000
    /** Rows per page in the trash list. */
    const PAGE_SIZE = 50
    /** A row counts as “expiring soon” from this many days before expiry. */
    const EXPIRING_DAYS = 3
    /** Filter identifiers in their sidebar order. */
    const FILTERS = ['all', 'workspace-exists', 'workspace-missing', 'expiring']
    /** Sort options in their menu order. */
    const SORT_OPTIONS = [
      { value: 'trashed', key: 'sortTrashed' },
      { value: 'title', key: 'sortTitle' },
      { value: 'size', key: 'sortSize' },
      { value: 'expires', key: 'sortExpires' },
    ]
    /** Locale keys for each filter label. */
    const FILTER_LABEL_KEYS = {
      all: 'filterAll',
      'workspace-exists': 'filterWorkspaceExists',
      'workspace-missing': 'filterWorkspaceMissing',
      expiring: 'filterExpiring',
    }
    /**
     * Preflight refusals the user can act on themselves. Those keep a visible
     * menu entry that explains the refusal instead of hiding it.
     */
    /** Host `lastErrorCode` values mapped to owner-facing messages. */
    const LAST_ERROR_KEYS = {
      TRASH_COPY_MISSING: 'lastErrorTrashCopyMissing',
      TRASH_COPY_MISSING_MEMBERS: 'lastErrorTrashCopyMissingMembers',
      TRASH_OBJECT_MISSING: 'lastErrorTrashObjectMissing',
      PURGE_FAILED: 'lastErrorPurgeFailed',
      RESTORE_INVISIBLE: 'lastErrorRestoreInvisible',
      MOVE_UNSETTLED: 'lastErrorMoveUnsettled',
      SOURCE_CONFLICT: 'lastErrorSourceConflict',
      INDEX_WRITE_FAILED: 'lastErrorIndexWriteFailed',
      IO_ERROR: 'lastErrorIo',
    }

    const MOVE_BLOCKED_KEYS = {
      SESSION_LIVE: { label: 'moveBlockedLive', toast: 'blockedLiveToast' },
      SESSION_ACTIVE: { label: 'moveBlockedActive', toast: 'blockedActiveToast' },
      SESSION_HAS_DESCENDANTS: {
        label: 'moveBlockedDescendants',
        toast: 'blockedDescendantsToast',
      },
    }

    /** Open trash views subscribe here so one successful mutation refreshes them all. */
    const revisionListeners = new Set()
    /** Cross-window channel name; same-origin tabs refresh each other. */
    const REVISION_CHANNEL_NAME = 'dsh-session-trash/revision'
    /** Lazily created BroadcastChannel shared by every view in this tab. */
    let revisionChannel = null
    let revisionChannelTried = false

    /**
     * Open the cross-window revision channel once, when the platform supports it.
     * @returns {void}
     */
    function ensureRevisionChannel() {
      if (revisionChannelTried) return
      revisionChannelTried = true
      const Ctor = typeof window === 'undefined' ? undefined : window.BroadcastChannel
      if (typeof Ctor !== 'function') return
      try {
        revisionChannel = new Ctor(REVISION_CHANNEL_NAME)
        revisionChannel.addEventListener('message', (event) => {
          if (event === null || event === undefined) return
          const data = event.data
          if (data === null || typeof data !== 'object') return
          if (data.type === 'revision') notifyRevisionListeners()
        })
      } catch {
        revisionChannel = null
      }
    }

    /**
     * @returns {void}
     */
    function notifyRevisionListeners() {
      for (const listener of [...revisionListeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-session-trash] revision listener failed', error)
        }
      }
    }

    /**
     * Notify every mounted trash view in this tab and across same-origin tabs.
     * @returns {void}
     */
    function bumpRevision() {
      ensureRevisionChannel()
      notifyRevisionListeners()
      if (revisionChannel === null) return
      try {
        revisionChannel.postMessage({ type: 'revision' })
      } catch {
        // A closed channel must never break the mutation that triggered it.
      }
    }

    /**
     * @param {() => void} listener refresh callback.
     * @returns {() => void} unsubscribe.
     */
    function subscribeRevision(listener) {
      ensureRevisionChannel()
      revisionListeners.add(listener)
      return () => {
        revisionListeners.delete(listener)
      }
    }

    const zh = {
      nav: '回收站',
      title: '回收站',
      subtitle: '已删除的会话会在这里保留 {days} 天，到期后自动永久删除。',
      refresh: '刷新',
      retry: '重试',
      cleanupExpired: '清理已过期',
      cleaning: '正在清理…',
      statsCountOne: '{count} 个会话',
      statsCountOther: '{count} 个会话',
      statsSize: '日志 {size}',
      logSize: '日志 {size}',
      logSizeHint: '仅会话日志，不含附件和图片',
      storageSummary: '本机会话数据 {total}：日志 {logs} · 附件 {attachments} · 缓存 {cache}',
      storageSweepable: '可清扫 {size}',
      storageOrphan: '其中 {size} 无引用',
      storageScanPartial: '引用扫描不完整',
      storageScanUnavailable: '引用扫描不可用',
      storageIndexPartial: '附件统计不完整',
      searchLabel: '搜索回收站',
      searchPlaceholder: '搜索标题、Session ID 或原始工作区',
      searchClear: '清除搜索',
      resultsCount: '显示 {shown} / {total} 个会话',
      selectRow: '选择「{title}」',
      selectAll: '全选本页可选会话',
      selectedCount: '已选择 {count} 个会话',
      clearSelection: '取消选择',
      batchRestore: '恢复选中',
      batchRestoring: '正在恢复…',
      batchRestoreDoneOne: '已恢复 {count} 个会话',
      batchRestoreDoneOther: '已恢复 {count} 个会话',
      batchRestorePartial: '已恢复 {restored} 个会话，{failed} 个失败',
      sortLabel: '排序方式',
      sortTrashed: '按移入时间（最新在前）',
      sortTitle: '按标题',
      sortSize: '按大小（最大在前）',
      sortExpires: '按到期时间（最早在前）',
      expandMembers: '展开子会话',
      collapseMembers: '收起子会话',
      memberParent: '父会话',
      memberSubagent: '子会话',
      filterLabel: '筛选回收站',
      filterAll: '全部',
      filterWorkspaceExists: '工作区仍存在',
      filterWorkspaceMissing: '工作区缺失',
      filterExpiring: '即将到期',
      filterResults: '已筛选出 {count} 个会话',
      noResultsTitle: '没有匹配的会话',
      noResultsBody: '试试其他关键词，或清除搜索和筛选条件。',
      clearFilters: '清除筛选',
      paginationLabel: '回收站分页',
      previousPage: '上一页',
      nextPage: '下一页',
      pageInfo: '第 {page} / {total} 页',
      pageAnnouncement: '第 {page} 页，共 {total} 页',
      nextSweep: '下次自动清理：{date}',
      nextSweepUnknown: '下次自动清理：打开页面时检查',
      autoCleanupOff: '自动清理已关闭',
      autoCleanupBanner: '自动清理已关闭；过期会话不会自动删除，仍可手动永久删除。',
      emptyTitle: '回收站为空',
      emptyBody: '在侧边栏右键会话，选择「移入回收站」。',
      loading: '正在加载…',
      errorNetwork: '无法连接到回收站服务。',
      errorTimeout: '请求超时，请重试。',
      errorUnauthorized: '连接已失效，请刷新页面。',
      errorForbidden: '当前身份无权访问回收站。',
      errorGeneric: '回收站加载失败。',
      corruptBanner: '回收站索引损坏，已进入保护模式。现有会话不会被自动修改。',
      recoveredBanner: '回收站索引已从备份恢复。',
      unindexedBanner: '回收站目录中有 {count} 个未索引对象，插件不会自动删除它们。',
      orphansClean: '清理空目录',
      orphansTitle: '清理空的无主对象？',
      orphansBody: '只删除回收站中不含会话日志的残留目录；可能含日志的无主对象会保留。',
      orphansConfirm: '清理空目录',
      orphansDoneOne: '已清理 {count} 个空的无主对象',
      orphansDoneOther: '已清理 {count} 个空的无主对象',
      orphansNone: '没有可安全清理的空目录',
      rebuild: '尝试重建索引',
      rebuilding: '正在重建…',
      rebuildDone: '索引已重建，共 {count} 个条目',
      rebuildDoneUnindexed: '索引已重建，共 {count} 个条目；{unindexed} 个未索引对象已保留',
      listLabel: '已删除的会话',
      noWorkspace: '未分组',
      workspaceLabel: '原工作区:',
      unknownWorkspace: '未知工作区',
      trashedAtLabel: '移入时间',
      notScheduled: '不参与自动清理',
      expiresOn: '将于 {date} 清理',
      badgeMissing: '文件缺失',
      badgeWorkspaceMissing: '工作区缺失',
      badgeMigration: '需要迁移',
      badgeExpiring: '即将到期',
      badgeExpired: '已过期',
      badgeSubagentsOne: '含 {count} 个子会话',
      badgeSubagentsOther: '含 {count} 个子会话',
      stateTrashing: '正在移入…',
      stateRestoring: '正在恢复…',
      statePurging: '正在删除…',
      actionRestore: '恢复',
      actionRestoreFor: '恢复「{title}」',
      actionMoreFor: '「{title}」的更多操作',
      actionRestoreOrphan: '恢复为孤儿会话',
      actionReveal: '在文件管理器中显示',
      actionRevealDisabled: '原工作区已不存在',
      actionCopyId: '复制 Session ID',
      actionForget: '从索引移除',
      actionPurge: '永久删除',
      dialogCancel: '取消',
      orphanTitle: '原工作区不存在',
      orphanBody: '「{path}」已不存在。恢复为孤儿会话后，会话会出现在「未分组」，不会自动创建目录。',
      orphanConfirm: '恢复为孤儿会话',
      purgeTitle: '永久删除「{title}」的会话日志？',
      purgeBody: '此操作不可撤销。会话日志和投影缓存会一并删除；附件和图片会保留，搜索索引会在下次搜索时自动剔除该会话。',
      purgeConfirm: '永久删除',
      purgeAll: '永久删除全部',
      purgingAll: '正在删除…',
      purgeAllTitle: '永久删除回收站中的全部 {count} 个会话？',
      purgeAllBody: '此操作不可撤销。会话日志和投影缓存会一并删除；附件和图片会保留，搜索索引会在下次搜索时自动剔除这些会话。',
      purgeAllConfirm: '全部永久删除',
      purgeAllDoneOne: '已永久删除 {count} 个会话，释放 {size}',
      purgeAllDoneOther: '已永久删除 {count} 个会话，释放 {size}',
      purgeAllDonePlainOne: '已永久删除 {count} 个会话',
      purgeAllDonePlainOther: '已永久删除 {count} 个会话',
      purgeAllNone: '回收站中没有可删除的会话',
      purgeAllPartial: '批量删除完成：成功 {removed} 个，失败 {failed} 个，释放 {size}。',
      purgeAllPartialPlain: '批量删除完成：成功 {removed} 个，失败 {failed} 个。',
      forgetTitle: '从回收站列表移除这条缺失记录？',
      forgetBody: '不会删除任何文件；仅移除索引中的这条记录。',
      forgetConfirm: '从索引移除',
      cleanupDoneOne: '已清理 {count} 个过期会话',
      cleanupDoneOther: '已清理 {count} 个过期会话',
      cleanupNone: '没有需要清理的过期会话',
      cleanupFailedBannerOne: '上次自动清理有 {count} 个会话未能删除。',
      cleanupFailedBannerOther: '上次自动清理有 {count} 个会话未能删除。',
      cleanupErrorBanner: '上次自动清理失败，请稍后在本页重试。',
      cleanupFailed: '清理失败：还有 {failed} 个过期会话没有删除。',
      cleanupPartial: '已清理 {purged} 个过期会话，{failed} 个没有删除。',
      cleanupRetryAt: '将在 {time} 自动重试。',
      cleanupRetryNow: '立即重试',
      copySuccess: '已复制 Session ID',
      copyFailed: '无法复制 Session ID，请手动复制',
      revealSuccess: '已在文件管理器中显示原工作区',
      revealFailed: '无法打开原工作区',
      lastErrorLabel: '上次错误：{message}',
      lastErrorTrashCopyMissing: '回收站里的会话副本缺失。',
      lastErrorTrashCopyMissingMembers: '回收站里的部分子会话副本缺失。',
      lastErrorTrashObjectMissing: '回收站对象目录缺失。',
      lastErrorPurgeFailed: '会话日志删除失败。',
      lastErrorRestoreInvisible: '恢复后会话存储没有识别到该会话。',
      lastErrorMoveUnsettled: '会话已移动，但会话存储仍报告它存在。',
      lastErrorSourceConflict: '原会话目录与回收站副本同时存在，两者都已保留。',
      lastErrorIndexWriteFailed: '回收站索引写入失败。',
      lastErrorIo: '文件操作失败。',
      footnote: '回收站目录：{path}',
      move: '移入回收站',
      moveBlockedLive: '移入回收站（会话已打开）',
      moveBlockedActive: '移入回收站（有任务在运行）',
      moveBlockedDescendants: '移入回收站（含可见子会话）',
      undo: '撤销',
      undoFailed: '撤销失败',
      trashSuccess: '已将「{title}」移入回收站',
      trashSuccessTreeOne: '「{title}」及其 {count} 个子会话已移入回收站',
      trashSuccessTreeOther: '「{title}」及其 {count} 个子会话已移入回收站',
      blockedLiveToast: '该会话已在本机打开。DSH 目前不会释放已打开的会话，请重启 DSH 后再移入回收站。',
      blockedActiveToast: '该会话还有正在运行的任务或子代理，等它停下来后再移入回收站。',
      blockedDescendantsToast: '该会话包含可见的子会话，只能使用 DSH 自带的「归档」整棵会话树。',
      restoreSuccess: '已恢复「{title}」',
      restoreOrphanSuccess: '已恢复为孤儿会话「{title}」',
      purgeSuccess: '已永久删除「{title}」，释放 {size}',
      purgeSuccessUnknown: '已永久删除「{title}」',
      forgetSuccess: '已从回收站列表移除',
      errorLive: '这个会话正在使用中，无法移入回收站。',
      errorActive: '这个会话还有正在运行的任务，无法移入回收站。',
      errorSubagent: '子代理会话不能单独移入回收站。',
      errorDescendants: '这个会话还有子会话，请改为归档整棵会话树。',
      errorNotMaterialized: '这个会话还没有可移动的日志。',
      errorStorage: '当前会话存储后端不支持回收站。',
      errorAlreadyTrashed: '这个会话已经在回收站里了。',
      errorNotFound: '会话不存在或已被移除。',
      errorTrashNotFound: '回收站中未找到该会话。',
      errorLocked: '另一个回收站操作正在进行，请稍后再试。',
      errorTrashMissing: '回收站中的会话日志已缺失。',
      errorRestoreTarget: '原位置已有同名目录，无法恢复。',
      errorWorkspaceMissing: '原工作区目录已不存在，暂时无法普通恢复。',
      errorRestoreVerify: '恢复后会话存储不可见，已回滚。',
      errorIndexCorrupt: '回收站索引损坏，已进入保护模式。',
      errorIndexOk: '回收站索引可正常读取，无需重建。',
      errorForgetNotAllowed: '只有文件缺失的记录可以从索引移除。',
      errorRevealUnavailable: '当前环境无法打开文件管理器。',
      errorRevealFailed: '无法打开原工作区。',
      errorIo: '文件操作失败，请稍后重试。',
    }

    const en = {
      nav: 'Trash',
      title: 'Trash',
      subtitle: 'Deleted sessions stay here for {days} days and are then permanently deleted.',
      refresh: 'Refresh',
      retry: 'Retry',
      cleanupExpired: 'Delete expired',
      cleaning: 'Cleaning…',
      statsCountOne: '{count} session',
      statsCountOther: '{count} sessions',
      statsSize: 'Logs {size}',
      logSize: 'Log {size}',
      logSizeHint: 'Session logs only; attachments and images are not included.',
      storageSummary: 'Session data on this device: {total} — logs {logs} · attachments {attachments} · cache {cache}',
      storageSweepable: '{size} sweepable',
      storageOrphan: '{size} unreferenced',
      storageScanPartial: 'reference scan incomplete',
      storageScanUnavailable: 'reference scan unavailable',
      storageIndexPartial: 'attachment stats incomplete',
      searchLabel: 'Search the trash',
      searchPlaceholder: 'Search title, Session ID, or original workspace',
      searchClear: 'Clear search',
      resultsCount: 'Showing {shown} of {total} sessions',
      selectRow: 'Select “{title}”',
      selectAll: 'Select all selectable sessions on this page',
      selectedCount: 'Selected: {count} sessions',
      clearSelection: 'Clear selection',
      batchRestore: 'Restore selected',
      batchRestoring: 'Restoring…',
      batchRestoreDoneOne: 'Restored {count} session',
      batchRestoreDoneOther: 'Restored {count} sessions',
      batchRestorePartial: 'Restored {restored}; {failed} failed',
      sortLabel: 'Sort by',
      sortTrashed: 'Newest trashed first',
      sortTitle: 'Title',
      sortSize: 'Largest first',
      sortExpires: 'Expiring soonest first',
      expandMembers: 'Show sub-sessions',
      collapseMembers: 'Hide sub-sessions',
      memberParent: 'Parent',
      memberSubagent: 'Sub-session',
      filterLabel: 'Filter the trash',
      filterAll: 'All',
      filterWorkspaceExists: 'Workspace exists',
      filterWorkspaceMissing: 'Workspace missing',
      filterExpiring: 'Expiring soon',
      filterResults: '{count} sessions shown',
      noResultsTitle: 'No matching sessions',
      noResultsBody: 'Try a different keyword, or clear the search and filters.',
      clearFilters: 'Clear filters',
      paginationLabel: 'Trash pagination',
      previousPage: 'Previous page',
      nextPage: 'Next page',
      pageInfo: 'Page {page} of {total}',
      pageAnnouncement: 'Page {page} of {total}',
      nextSweep: 'Next automatic cleanup: {date}',
      nextSweepUnknown: 'Next automatic cleanup: checked when this page opens',
      autoCleanupOff: 'Automatic cleanup is off',
      autoCleanupBanner: 'Automatic cleanup is off. Expired sessions are kept until you delete them.',
      emptyTitle: 'Trash is empty',
      emptyBody: 'Right-click a session in the sidebar and choose “Move to trash”.',
      loading: 'Loading…',
      errorNetwork: 'Could not reach the trash service.',
      errorTimeout: 'The request timed out. Try again.',
      errorUnauthorized: 'Your connection expired. Reload the page.',
      errorForbidden: 'You do not have access to the trash.',
      errorGeneric: 'Could not load the trash.',
      corruptBanner: 'The trash index is damaged, so protection mode is on. No session is changed automatically.',
      recoveredBanner: 'The trash index was recovered from its backup.',
      unindexedBanner: 'The trash directory holds {count} unindexed objects. The plugin will not delete them.',
      orphansClean: 'Clean empty leftovers',
      orphansTitle: 'Remove empty unindexed objects?',
      orphansBody: 'Only leftover directories without session logs are removed; unindexed objects that may contain logs are kept.',
      orphansConfirm: 'Clean empty objects',
      orphansDoneOne: 'Removed {count} empty unindexed object',
      orphansDoneOther: 'Removed {count} empty unindexed objects',
      orphansNone: 'No empty leftovers to clean',
      rebuild: 'Try rebuilding the index',
      rebuilding: 'Rebuilding…',
      rebuildDone: 'Index rebuilt with {count} entries',
      rebuildDoneUnindexed: 'Index rebuilt with {count} entries; {unindexed} unindexed objects were kept',
      listLabel: 'Deleted sessions',
      noWorkspace: 'Ungrouped',
      workspaceLabel: 'Original workspace:',
      unknownWorkspace: 'Unknown workspace',
      trashedAtLabel: 'Trashed',
      notScheduled: 'Not scheduled for cleanup',
      expiresOn: 'Auto-deletes on {date}',
      badgeMissing: 'Log missing',
      badgeWorkspaceMissing: 'Workspace missing',
      badgeMigration: 'Migration required',
      badgeExpiring: 'Expiring soon',
      badgeExpired: 'Expired',
      badgeSubagentsOne: '{count} sub-session',
      badgeSubagentsOther: '{count} sub-sessions',
      stateTrashing: 'Moving…',
      stateRestoring: 'Restoring…',
      statePurging: 'Deleting…',
      actionRestore: 'Restore',
      actionRestoreFor: 'Restore “{title}”',
      actionMoreFor: 'More actions for “{title}”',
      actionRestoreOrphan: 'Restore as orphan',
      actionReveal: 'Show in file manager',
      actionRevealDisabled: 'The original workspace no longer exists',
      actionCopyId: 'Copy Session ID',
      actionForget: 'Remove from index',
      actionPurge: 'Delete permanently',
      dialogCancel: 'Cancel',
      orphanTitle: 'Original workspace is missing',
      orphanBody: '“{path}” no longer exists. An orphan restore puts the session back under “Ungrouped” and never recreates the directory.',
      orphanConfirm: 'Restore as orphan',
      purgeTitle: 'Permanently delete the session log for “{title}”?',
      purgeBody: 'This cannot be undone. The session log and its projection-cache record are deleted; attachments and images are kept, and the search index drops the session on its next search.',
      purgeConfirm: 'Delete permanently',
      purgeAll: 'Delete all permanently',
      purgingAll: 'Deleting…',
      purgeAllTitle: 'Permanently delete all {count} sessions in the trash?',
      purgeAllBody: 'This cannot be undone. The session logs and their projection-cache records are deleted; attachments and images are kept, and the search index drops these sessions on its next search.',
      purgeAllConfirm: 'Delete all permanently',
      purgeAllDoneOne: 'Permanently deleted {count} session, freeing {size}',
      purgeAllDoneOther: 'Permanently deleted {count} sessions, freeing {size}',
      purgeAllDonePlainOne: 'Permanently deleted {count} session',
      purgeAllDonePlainOther: 'Permanently deleted {count} sessions',
      purgeAllNone: 'No sessions to delete',
      purgeAllPartial: 'Bulk delete finished: {removed} removed, {failed} failed, {size} freed.',
      purgeAllPartialPlain: 'Bulk delete finished: {removed} removed, {failed} failed.',
      forgetTitle: 'Remove this missing record from the trash list?',
      forgetBody: 'No file is deleted; only this index record is removed.',
      forgetConfirm: 'Remove from index',
      cleanupDoneOne: 'Deleted {count} expired session',
      cleanupDoneOther: 'Deleted {count} expired sessions',
      cleanupNone: 'No expired sessions to delete',
      cleanupFailedBannerOne: 'The last automatic cleanup could not delete {count} expired session.',
      cleanupFailedBannerOther: 'The last automatic cleanup could not delete {count} expired sessions.',
      cleanupErrorBanner: 'The last automatic cleanup failed. Retry from this page later.',
      cleanupFailed: 'Cleanup could not delete {failed} of the expired sessions.',
      cleanupPartial: 'Cleanup deleted {purged}; {failed} could not be deleted.',
      cleanupRetryAt: 'Next retry: {time}.',
      cleanupRetryNow: 'Retry now',
      copySuccess: 'Session ID copied',
      copyFailed: 'Could not copy the Session ID. Copy it manually.',
      revealSuccess: 'Revealed the original workspace in the file manager',
      revealFailed: 'Could not open the original workspace',
      lastErrorLabel: 'Last error: {message}',
      lastErrorTrashCopyMissing: 'The stored copy of this session is missing from the trash.',
      lastErrorTrashCopyMissingMembers: 'Some sub-session copies are missing from the trash.',
      lastErrorTrashObjectMissing: 'The trash object directory is missing.',
      lastErrorPurgeFailed: 'The session log could not be deleted.',
      lastErrorRestoreInvisible: 'Session storage did not report the restored session.',
      lastErrorMoveUnsettled: 'The session was moved, but session storage still reports it.',
      lastErrorSourceConflict: 'The original session directory and the trash copy both exist; both were kept.',
      lastErrorIndexWriteFailed: 'The trash index could not be written.',
      lastErrorIo: 'A file operation failed.',
      footnote: 'Trash directory: {path}',
      move: 'Move to trash',
      moveBlockedLive: 'Move to trash (session is open)',
      moveBlockedActive: 'Move to trash (work is running)',
      moveBlockedDescendants: 'Move to trash (has visible sub-sessions)',
      undo: 'Undo',
      undoFailed: 'Could not undo',
      trashSuccess: 'Moved “{title}” to the trash',
      trashSuccessTreeOne: '“{title}” and its single sub-session were moved to the trash',
      trashSuccessTreeOther: '“{title}” and its {count} sub-sessions were moved to the trash',
      blockedLiveToast: 'This session is open in DSH. DSH does not release opened sessions yet; restart DSH, then move it to the trash.',
      blockedActiveToast: 'This session still has running work; wait for it to stop, then move it to the trash.',
      blockedDescendantsToast: 'This session has visible child sessions; use the built-in Archive action for the whole tree instead.',
      restoreSuccess: 'Restored “{title}”',
      restoreOrphanSuccess: 'Restored “{title}” as an orphan session',
      purgeSuccess: 'Permanently deleted “{title}” and freed {size}',
      purgeSuccessUnknown: 'Permanently deleted “{title}”',
      forgetSuccess: 'Removed from the trash list',
      errorLive: 'This session is in use and cannot be moved to the trash.',
      errorActive: 'This session still has running work.',
      errorSubagent: 'A subagent session cannot be trashed on its own.',
      errorDescendants: 'This session still has child sessions; archive the whole tree instead.',
      errorNotMaterialized: 'This session has no stored log yet.',
      errorStorage: 'The current session storage backend is not supported.',
      errorAlreadyTrashed: 'This session is already in the trash.',
      errorNotFound: 'This session no longer exists.',
      errorTrashNotFound: 'That session is no longer in the trash.',
      errorLocked: 'Another trash operation is in progress. Try again in a moment.',
      errorTrashMissing: 'The stored session log is missing from the trash.',
      errorRestoreTarget: 'A directory already exists at the original location.',
      errorWorkspaceMissing: 'The original workspace directory no longer exists, so a normal restore is not possible.',
      errorRestoreVerify: 'Session storage could not see the restored session; the move was rolled back.',
      errorIndexCorrupt: 'The trash index is damaged, so protection mode is on.',
      errorIndexOk: 'The trash index is readable and does not need a rebuild.',
      errorForgetNotAllowed: 'Only records whose log is missing can be removed from the index.',
      errorRevealUnavailable: 'This environment cannot open a file manager.',
      errorRevealFailed: 'Could not open the original workspace.',
      errorIo: 'A file operation failed. Try again.',
    }

    /**
     * Replace `{name}` placeholders without relying on locale interpolation.
     * @param {string} template localized text.
     * @param {Record<string, unknown>} values replacement values.
     * @returns {string} formatted text.
     */
    function format(template, values) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        values !== undefined && values[key] !== undefined ? String(values[key]) : match,
      )
    }

    /**
     * Pick the grammatical singular/plural locale form for a count.
     *
     * @param {(key: string) => string} t bound translator.
     * @param {string} key base locale key (without the One/Other suffix).
     * @param {number} count item count.
     * @param {Record<string, unknown>} [values] extra placeholders.
     * @returns {string} the formatted text.
     */
    function countText(t, key, count, values = {}) {
      const template = t(`${key}${count === 1 ? 'One' : 'Other'}`)
      return format(template, { ...values, count })
    }

    /**
     * Compare two trash entries for the selected sort order.
     *
     * @param {any} left first entry.
     * @param {any} right second entry.
     * @param {string} sortKey active sort identifier.
     * @param {string | undefined} locale active locale.
     * @returns {number} comparator result.
     */
    function compareEntries(left, right, sortKey, locale) {
      const titleOf = (entry) => (typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.sessionId)
      if (sortKey === 'title') return String(titleOf(left)).localeCompare(String(titleOf(right)), locale)
      if (sortKey === 'size') return (Number(right.sizeBytes) || 0) - (Number(left.sizeBytes) || 0)
      if (sortKey === 'expires') {
        const leftAt = typeof left.expiresAt === 'number' ? left.expiresAt : Number.POSITIVE_INFINITY
        const rightAt = typeof right.expiresAt === 'number' ? right.expiresAt : Number.POSITIVE_INFINITY
        return leftAt - rightAt
      }
      return (right.trashedAt ?? 0) - (left.trashedAt ?? 0)
    }

    /**
     * Read the readable workspace name of a trashed entry. Older Host payloads
     * omit `originalWorkspaceTitle`, so the basename of `originalCwd` is the
     * fallback.
     *
     * @param {object} entry wire entry.
     * @returns {string} the workspace name, or an empty string when unknown.
     */
    function workspaceName(entry) {
      const title = typeof entry.originalWorkspaceTitle === 'string' ? entry.originalWorkspaceTitle.trim() : ''
      if (title !== '') return title
      const cwd = typeof entry.originalCwd === 'string' ? entry.originalCwd.replace(/[\\/]+$/, '') : ''
      const separator = Math.max(cwd.lastIndexOf('/'), cwd.lastIndexOf('\\'))
      return cwd.slice(separator + 1)
    }

    /**
     * @param {number | null | undefined} bytes raw byte count.
     * @returns {string} a compact human-readable size, or an em dash when unknown.
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
      if (bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
      return `${rounded} ${units[unit]}`
    }

    /**
     * @param {object | null | undefined} locale locale service snapshot source.
     * @returns {string | undefined} the active BCP 47 locale tag.
     */
    function activeLocale(locale) {
      try {
        const snapshot = typeof locale?.getSnapshot === 'function' ? locale.getSnapshot() : undefined
        return typeof snapshot?.active === 'string' ? snapshot.active : undefined
      } catch {
        return undefined
      }
    }

    /**
     * @param {number | null | undefined} timestamp epoch milliseconds.
     * @param {string | undefined} locale active locale tag.
     * @param {boolean} [withTime] include the time of day.
     * @returns {string} a locale-aware date, or an em dash for a missing value.
     */
    function formatDate(timestamp, locale, withTime = false) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '—'
      try {
        return new Intl.DateTimeFormat(
          locale,
          withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
        ).format(new Date(timestamp))
      } catch {
        return new Date(timestamp).toISOString().slice(0, 10)
      }
    }

    /**
     * @param {number} days day offset from now.
     * @param {string | undefined} locale active locale tag.
     * @returns {string} a relative day phrase.
     */
    function relativeDays(days, locale) {
      try {
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
      } catch {
        return `${days}d`
      }
    }

    /**
     * @param {object} entry wire entry.
     * @param {string | undefined} locale active locale tag.
     * @param {number} now current timestamp.
     * @returns {{ days: number | null, text: string }} remaining retention facts.
     */
    function remaining(entry, locale, now) {
      if (entry.state !== 'trashed' || typeof entry.expiresAt !== 'number') {
        return { days: null, text: '' }
      }
      const days = Math.ceil((entry.expiresAt - now) / DAY_MS)
      return { days, text: days <= 0 ? '' : relativeDays(days, locale) }
    }

    /**
     * Call one endpoint of this plugin's Host API.
     *
     * The path stays a literal inside the `fetch` call rather than being built
     * from a constant: a capability scan can only tell that a request stays on
     * this origin when the argument is a path-locked literal, and it counts a
     * variable as outbound. Keep the literal equal to `API_PREFIX` in
     * `lib/http.js`.
     *
     * @param {string} pathname endpoint name below the API prefix.
     * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options] request options.
     * @returns {Promise<{ status: number, ok: boolean, payload: any }>} the decoded response.
     */
    async function requestJson(pathname, options = {}) {
      const { method = 'GET', body, signal } = options
      const headers = { [CSRF_HEADER]: '1' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetch(`/plugins/dsh-session-trash/api/${pathname}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return { status: response.status, ok: response.ok, payload }
    }

    /**
     * @param {number} status HTTP status.
     * @param {{ error?: { code?: string } } | null} payload decoded error body.
     * @param {(key: string) => string} t bound translator.
     * @returns {string} localized failure text.
     */
    function describeFailure(status, payload, t) {
      if (status === 401) return t('errorUnauthorized')
      if (status === 403) return t('errorForbidden')
      const code = payload !== null && payload !== undefined && payload.error !== undefined ? payload.error.code : undefined
      if (status === 500 && code === 'INDEX_CORRUPT') return t('corruptBanner')
      return code === undefined ? t('errorGeneric') : `${t('errorGeneric')} (${code})`
    }

    /** Stable Host error codes mapped to owner-facing action messages. */
    const ACTION_ERROR_KEYS = {
      SESSION_NOT_FOUND: 'errorNotFound',
      SESSION_LIVE: 'errorLive',
      SESSION_ACTIVE: 'errorActive',
      SESSION_SUBAGENT: 'errorSubagent',
      SESSION_HAS_DESCENDANTS: 'errorDescendants',
      SESSION_NOT_MATERIALIZED: 'errorNotMaterialized',
      STORAGE_UNSUPPORTED: 'errorStorage',
      ALREADY_TRASHED: 'errorAlreadyTrashed',
      LOCKED: 'errorLocked',
      TRASH_DIR_MISSING: 'errorTrashMissing',
      TRASH_ENTRY_NOT_FOUND: 'errorTrashNotFound',
      TRASH_STATE_INVALID: 'errorTrashNotFound',
      RESTORE_TARGET_EXISTS: 'errorRestoreTarget',
      WORKSPACE_MISSING: 'errorWorkspaceMissing',
      RESTORE_VERIFY_FAILED: 'errorRestoreVerify',
      MOVE_VERIFY_FAILED: 'errorRestoreVerify',
      MOVE_CONFLICT: 'errorIo',
      INDEX_CORRUPT: 'errorIndexCorrupt',
      INDEX_NOT_CORRUPT: 'errorIndexOk',
      INDEX_WRITE_FAILED: 'errorIo',
      FORGET_NOT_ALLOWED: 'errorForgetNotAllowed',
      REVEAL_UNAVAILABLE: 'errorRevealUnavailable',
      REVEAL_FAILED: 'errorRevealFailed',
      UNSAFE_SESSION_DIR: 'errorIo',
      UNSAFE_RESTORE_PATH: 'errorIo',
      IO_ERROR: 'errorIo',
    }

    /**
     * Translate one failed mutation into a concise localized message.
     *
     * @param {number} status HTTP status.
     * @param {{ error?: { code?: string } } | null} payload decoded error body.
     * @param {(key: string) => string} t bound translator.
     * @returns {string} localized failure text.
     */
    function describeActionFailure(status, payload, t) {
      if (status === 401) return t('errorUnauthorized')
      if (status === 403) return t('errorForbidden')
      const code = payload !== null && payload !== undefined && payload.error !== undefined ? payload.error.code : undefined
      const key = code === undefined ? undefined : ACTION_ERROR_KEYS[code]
      return key === undefined ? t('errorIo') : t(key)
    }

    /**
     * @param {string} sessionId session whose eligibility to ask for.
     * @param {AbortSignal} [outerSignal] cancellation from the menu occurrence.
     * @returns {Promise<{ eligible: boolean, code?: string, message?: string, details?: unknown } | null>} the verdict, or null when unknown.
     */
    async function preflight(sessionId, outerSignal) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS)
      const forward = () => controller.abort()
      if (outerSignal !== undefined) outerSignal.addEventListener('abort', forward, { once: true })
      try {
        const { status, ok, payload } = await requestJson('preflight', {
          method: 'POST',
          body: { sessionId },
          signal: controller.signal,
        })
        if (!ok || payload === null || typeof payload.eligible !== 'boolean') {
          if (status === 401 || status === 403) return { eligible: false, code: 'FORBIDDEN' }
          return null
        }
        return payload
      } catch {
        return null
      } finally {
        clearTimeout(timer)
        if (outerSignal !== undefined) outerSignal.removeEventListener('abort', forward)
      }
    }

    /**
     * @param {string} text text to copy.
     * @returns {Promise<boolean>} whether the clipboard accepted the text.
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall back to a hidden textarea below.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        area.remove()
        return copied
      } catch {
        return false
      }
    }

    /**
     * Trash artwork copied verbatim from the DeepSeek Harness product icon set
     * (`trash-outline`, regular weight, MIT © 2026 DeepSeek), so the menu entry
     * matches the shipped “Delete workspace” glyph instead of a look-alike.
     */
    const TRASH_PATHS = [
      'M1.28149 3.88831H14.7187',
      'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
      'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
      'M6.44946 6.98926V11.1238',
      'M9.55054 6.98926V11.1238',
    ]

    /**
     * @param {{ size?: number, active?: boolean }} props icon presentation.
     * @returns {import('react').ReactElement} the trash glyph.
     */
    function TrashGlyph(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1,
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flex: 'none' },
        },
        TRASH_PATHS.map((d, index) => h('path', { key: index, d })),
      )
    }

    /**
     * @param {{ size?: number }} props icon presentation.
     * @returns {import('react').ReactElement} a vertical ellipsis glyph.
     */
    function MoreGlyph(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flex: 'none' },
        },
        [3, 8, 13].map((cy) => h('circle', { key: cy, cx: 8, cy, r: 1.15 })),
      )
    }

    /**
     * @param {{ size?: number }} props icon presentation.
     * @returns {import('react').ReactElement} a magnifier glyph.
     */
    function SearchGlyph(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flex: 'none' },
        },
        [
          h('circle', { key: 'circle', cx: 7, cy: 7, r: 4.25 }),
          h('path', { key: 'handle', d: 'M10.25 10.25L13.5 13.5' }),
        ],
      )
    }

    /**
     * @param {{ size?: number }} props icon presentation.
     * @returns {import('react').ReactElement} a diagonal cross glyph.
     */
    function CloseGlyph(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flex: 'none' },
        },
        [h('path', { key: 'a', d: 'M4.5 4.5L11.5 11.5' }), h('path', { key: 'b', d: 'M11.5 4.5L4.5 11.5' })],
      )
    }

    const STYLES = `
      .dsh-trash { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 760px; margin: 0 auto; padding: 8px 0 48px; color: var(--dsw-alias-label-primary); }
      .dsh-trash__header { display: flex; flex-direction: column; gap: 6px; }
      .dsh-trash__title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
      .dsh-trash__subtitle { margin: 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh-trash__toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 12px; }
      .dsh-trash__storage { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); opacity: 0.9; }
      .dsh-trash__stats { font-size: 13px; color: var(--dsw-alias-label-secondary); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
      .dsh-trash__dot { opacity: 0.5; }
      .dsh-trash__toolbarActions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .dsh-trash__controls { display: flex; flex-direction: column; gap: 10px; }
      .dsh-trash__searchRow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
      .dsh-trash__search { position: relative; display: flex; align-items: center; flex: 1 1 260px; min-width: 200px; }
      .dsh-trash__searchGlyph { position: absolute; left: 10px; display: inline-flex; color: var(--dsw-alias-label-tertiary); pointer-events: none; }
      .dsh-trash__searchInput { box-sizing: border-box; width: 100%; height: 34px; padding: 0 32px 0 30px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 1.5; outline: none; }
      .dsh-trash__searchInput::placeholder { color: var(--dsw-alias-label-dimmed); }
      .dsh-trash__searchInput::-webkit-search-cancel-button { appearance: none; }
      .dsh-trash__searchInput:focus { border-color: var(--dsw-alias-state-business-primary); }
      .dsh-trash__searchInput:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
      .dsh-trash__searchClear { position: absolute; right: 5px; width: 22px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
      .dsh-trash__searchClear:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-trash__searchClear:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
      .dsh-trash__resultsCount { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
      .dsh-trash__filters { display: flex; flex-wrap: wrap; gap: 6px; }
      .dsh-trash__filterOption { position: relative; display: inline-flex; }
      .dsh-trash__filterInput { position: absolute; width: 1px; height: 1px; margin: 0; padding: 0; opacity: 0; pointer-events: none; }
      .dsh-trash__filterLabel { display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.4; white-space: nowrap; cursor: pointer; transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }
      .dsh-trash__filterLabel:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-trash__filterInput:checked + .dsh-trash__filterLabel { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-active); }
      .dsh-trash__filterInput:focus-visible + .dsh-trash__filterLabel { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .dsh-trash__button { appearance: none; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-sm); padding: 6px 12px; font-size: 13px; line-height: 1.4; font-family: inherit; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
      .dsh-trash__button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-trash__button:disabled { opacity: 0.5; cursor: default; }
      .dsh-trash__button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .dsh-trash__button--danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); }
      .dsh-trash__button--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
      .dsh-trash__panel { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
      .dsh-trash__empty { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; color: var(--dsw-alias-label-secondary); padding: 48px 20px; }
      .dsh-trash__emptyGlyph { color: var(--dsw-alias-state-idle-primary); }
      .dsh-trash__emptyTitle { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dsh-trash__emptyBody { font-size: 13px; line-height: 1.6; max-width: 340px; margin: 0; }
      .dsh-trash__banner { display: flex; align-items: flex-start; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); padding: 10px 12px; font-size: 13px; line-height: 1.5; }
      .dsh-trash__banner--error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .dsh-trash__banner--warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
      .dsh-trash__banner--info { color: var(--dsw-alias-label-secondary); }
      .dsh-trash__bannerText { flex: 1 1 auto; min-width: 0; }
      .dsh-trash__skeletons { display: flex; flex-direction: column; gap: 8px; padding: 14px; }
      .dsh-trash__skeleton { height: 64px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-skeleton); }
      .dsh-trash__list { list-style: none; margin: 0; padding: 0; }
      .dsh-trash__pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dsh-trash__pageInfo { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .dsh-trash__pageButtons { display: flex; align-items: center; gap: 6px; }
      .dsh-trash__emptyAction { margin-top: 2px; }
      .dsh-trash__row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dsh-trash__row:last-child { border-bottom: none; }
      .dsh-trash__row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-trash__rowMain { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
      .dsh-trash__rowTitleLine { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
      .dsh-trash__rowTitle { font-size: 14px; font-weight: 500; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
      .dsh-trash__badge { font-size: 11px; line-height: 1.4; border-radius: 999px; padding: 1px 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dsh-trash__badge--warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
      .dsh-trash__badge--danger { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
      .dsh-trash__badge--info { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
      .dsh-trash__rowId { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .dsh-trash__rowMeta { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); min-width: 0; }
      .dsh-trash__rowWorkspace { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 100%; }
      .dsh-trash__rowWorkspaceLabel { color: var(--dsw-alias-label-tertiary); }
      .dsh-trash__rowFacts { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
      .dsh-trash__rowError { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
      .dsh-trash__rowActions { flex: none; display: flex; align-items: center; gap: 6px; padding-top: 2px; }
      .dsh-trash__menuWrap { position: relative; display: inline-flex; }
      .dsh-trash__iconButton { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
      .dsh-trash__menu { position: fixed; z-index: 1100; min-width: 210px; max-width: 280px; max-height: min(320px, calc(100vh - 24px)); overflow-y: auto; padding: 4px; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); box-shadow: var(--dsw-elevation-prominent); }
      .dsh-trash__menuItem { appearance: none; display: block; width: 100%; text-align: left; background: none; border: none; color: var(--dsw-alias-label-primary); padding: 7px 10px; border-radius: var(--dsw-radius-sm); font-family: inherit; font-size: 13px; line-height: 1.4; cursor: pointer; }
      .dsh-trash__menuItem:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-trash__menuItem:disabled { opacity: 0.45; cursor: default; }
      .dsh-trash__menuItem:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
      .dsh-trash__menuItem--danger { color: var(--dsw-alias-state-error-primary); }
      .dsh-trash__menuSeparator { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l1); }
      .dsh-trash__footnote { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0; }
      .dsh-trash__overlay { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur, none); }
      .dsh-trash__dialog { width: min(440px, 100%); background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-lg); box-shadow: var(--dsw-elevation-prominent); padding: 20px; color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 12px; }
      .dsh-trash__dialogTitle { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
      .dsh-trash__dialogBody { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .dsh-trash__dialogActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .dsh-trash__srOnly { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      .dsh-trash__controlsRight { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin-left: auto; }
      .dsh-trash__selectAll { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
      .dsh-trash__selectAllInput { width: 14px; height: 14px; margin: 0; flex: none; accent-color: var(--dsw-alias-state-business-primary); }
      .dsh-trash__sort { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh-trash__sortLabel { white-space: nowrap; }
      .dsh-trash__sortSelect { height: 28px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; }
      .dsh-trash__sortSelect:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
      .dsh-trash__rowCheck { width: 15px; height: 15px; margin: 3px 0 0; flex: none; accent-color: var(--dsw-alias-state-business-primary); }
      .dsh-trash__batch { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); }
      .dsh-trash__batchCount { margin-right: auto; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh-trash__membersWrap { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
      .dsh-trash__membersToggle { appearance: none; align-self: flex-start; border: none; background: none; padding: 0; color: var(--dsw-alias-state-business-primary); font: inherit; font-size: 12.5px; line-height: 1.5; cursor: pointer; }
      .dsh-trash__membersToggle:hover { text-decoration: underline; }
      .dsh-trash__membersToggle:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .dsh-trash__members { list-style: none; margin: 0; padding: 0 0 0 10px; display: flex; flex-direction: column; gap: 4px; border-left: 2px solid var(--dsw-alias-border-l1); }
      .dsh-trash__member { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh-trash__memberKind { color: var(--dsw-alias-label-tertiary); }
      .dsh-trash__memberTitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 320px; }
      .dsh-trash__memberId { font-family: var(--dsw-font-mono, monospace); word-break: break-all; }
      .dsh-trash__memberSize { margin-left: auto; color: var(--dsw-alias-label-tertiary); }

      @media (max-width: 560px) {
        .dsh-trash__row { flex-direction: column; }
        .dsh-trash__rowActions { align-self: flex-end; }
      }
    `

    /**
     * @param {object} locale locale service.
     * @returns {number} the current locale revision, re-rendering on language changes.
     */
    function useLocaleRevision(locale) {
      const subscribe = React.useCallback(
        (listener) => {
          if (typeof locale?.subscribe !== 'function') return () => {}
          return locale.subscribe(listener)
        },
        [locale],
      )
      const snapshot = React.useCallback(() => {
        try {
          const value = typeof locale?.getSnapshot === 'function' ? locale.getSnapshot() : undefined
          return value !== null && value !== undefined && typeof value.revision === 'number' ? value.revision : 0
        } catch {
          return 0
        }
      }, [locale])
      return React.useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    /**
     * Narrow popup menu built from plain React so the settings page does not
     * depend on internal DSH primitives.
     *
     * @param {{ label: string, items: object[], disabled?: boolean }} props menu presentation.
     * @returns {import('react').ReactElement} the trigger and its open menu.
     */
    function ActionMenu({ label, items, disabled }) {
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const wrapRef = React.useRef(null)
      const buttonRef = React.useRef(null)
      const menuRef = React.useRef(null)

      // A pending write disables the trigger; closing the open menu prevents a
      // stale item from starting a second mutation.
      React.useEffect(() => {
        if (disabled === true) setOpen(false)
      }, [disabled])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Tab') {
            // Let focus leave the menu naturally; just stop leaving it open.
            setOpen(false)
            return
          }
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          if (buttonRef.current !== null) buttonRef.current.focus()
        }
        const onViewportChange = () => setOpen(false)
        const onScroll = (event) => {
          if (event.target === menuRef.current) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onViewportChange)
        window.addEventListener('scroll', onScroll, true)
        const first = menuRef.current === null ? null : menuRef.current.querySelector('[role="menuitem"]')
        if (first !== null && typeof first.focus === 'function') first.focus()
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onViewportChange)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [open])

      /**
       * Open the menu below the trigger, or above it when the viewport is
       * short. Fixed coordinates escape the settings pane's scroll clipping.
       *
       * @returns {void}
       */
      const toggleMenu = () => {
        if (disabled === true) return
        if (open) {
          setOpen(false)
          return
        }
        let next = { top: 8, right: 8 }
        const button = buttonRef.current
        if (button !== null && typeof button.getBoundingClientRect === 'function') {
          const rect = button.getBoundingClientRect()
          const estimatedHeight = Math.min(items.length, 6) * 34 + 16
          const opensUp = rect.bottom + estimatedHeight + 8 > window.innerHeight
          next = {
            right: Math.max(8, window.innerWidth - rect.right),
            ...(opensUp
              ? { bottom: Math.max(8, window.innerHeight - rect.top + 4) }
              : { top: rect.bottom + 4 }),
          }
        }
        setPosition(next)
        setOpen(true)
      }

      /**
       * @param {import('react').KeyboardEvent} event menu key event.
       * @returns {void}
       */
      const navigate = (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const nodes =
          menuRef.current === null
            ? []
            : [...menuRef.current.querySelectorAll('[role="menuitem"]')].filter((node) => !node.disabled)
        if (nodes.length === 0) return
        event.preventDefault()
        const index = nodes.indexOf(document.activeElement)
        const next =
          event.key === 'ArrowDown'
            ? (index + 1 + nodes.length) % nodes.length
            : (index <= 0 ? nodes.length : index) - 1
        nodes[next].focus()
      }

      return h(
        'div',
        { className: 'dsh-trash__menuWrap', ref: wrapRef },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-trash__button dsh-trash__iconButton',
            'aria-label': label,
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            disabled: disabled === true,
            ref: buttonRef,
            onClick: toggleMenu,
          },
          h(MoreGlyph),
        ),
        open
          ? h(
              'div',
              {
                className: 'dsh-trash__menu',
                role: 'menu',
                'aria-label': label,
                ref: menuRef,
                style: position ?? undefined,
                onKeyDown: navigate,
              },
              items.map((item, index) =>
                h(
                  React.Fragment,
                  { key: item.key },
                  item.separatorBefore === true && index > 0
                    ? h('div', { className: 'dsh-trash__menuSeparator', role: 'separator' })
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      className: `dsh-trash__menuItem${item.danger === true ? ' dsh-trash__menuItem--danger' : ''}`,
                      disabled: item.disabled === true,
                      title: item.title,
                      'aria-label': item.ariaLabel,
                      onClick: () => {
                        setOpen(false)
                        if (buttonRef.current !== null && typeof buttonRef.current.focus === 'function') {
                          buttonRef.current.focus()
                        }
                        item.onSelect()
                      },
                    },
                    item.label,
                  ),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * Modal confirmation with a focus trap and focus restoration.
     *
     * @param {{
     *   kind: 'orphan' | 'purge' | 'forget' | 'purgeAll',
     *   entry?: object,
     *   count?: number,
     *   t: (key: string) => string,
     *   onCancel: () => void,
     *   onConfirm: () => void,
     * }} props dialog content and handlers.
     * @returns {import('react').ReactElement} the dialog overlay.
     */
    function ConfirmDialog({ kind, entry, count, t, onCancel, onConfirm, fallbackRef }) {
      const dialogRef = React.useRef(null)
      const cancelRef = React.useRef(null)
      const titleId = `dsh-trash-dialog-title-${kind}`
      const bodyId = `dsh-trash-dialog-body-${kind}`

      React.useEffect(() => {
        const previous = document.activeElement
        if (cancelRef.current !== null) cancelRef.current.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
            return
          }
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const nodes = [...dialogRef.current.querySelectorAll('button, [href], input, select, textarea')].filter(
            (node) => !node.disabled,
          )
          if (nodes.length === 0) return
          const first = nodes[0]
          const last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && typeof previous.focus === 'function' && previous.isConnected !== false) {
            previous.focus()
            return
          }
          const fallback = fallbackRef === null || fallbackRef === undefined ? null : fallbackRef.current
          if (fallback !== null && typeof fallback.focus === 'function') fallback.focus()
        }
      }, [onCancel])

      const title =
        entry !== undefined && entry.title !== undefined && entry.title !== '' ? entry.title : (entry?.sessionId ?? '')
      let heading = ''
      let body = ''
      let confirmLabel = ''
      if (kind === 'orphan') {
        heading = t('orphanTitle')
        body = format(t('orphanBody'), { path: entry.originalCwd ?? t('unknownWorkspace') })
        confirmLabel = t('orphanConfirm')
      } else if (kind === 'purge') {
        heading = format(t('purgeTitle'), { title })
        body = t('purgeBody')
        confirmLabel = t('purgeConfirm')
      } else if (kind === 'purgeAll') {
        heading = format(t('purgeAllTitle'), { count })
        body = t('purgeAllBody')
        confirmLabel = t('purgeAllConfirm')
      } else if (kind === 'orphans') {
        heading = t('orphansTitle')
        body = t('orphansBody')
        confirmLabel = t('orphansConfirm')
      } else {
        heading = t('forgetTitle')
        body = t('forgetBody')
        confirmLabel = t('forgetConfirm')
      }

      return h(
        'div',
        {
          className: 'dsh-trash__overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          {
            className: 'dsh-trash__dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            'aria-describedby': bodyId,
            ref: dialogRef,
          },
          h('h3', { className: 'dsh-trash__dialogTitle', id: titleId }, heading),
          h('p', { className: 'dsh-trash__dialogBody', id: bodyId }, body),
          h(
            'div',
            { className: 'dsh-trash__dialogActions' },
            h('button', { type: 'button', className: 'dsh-trash__button', onClick: onCancel, ref: cancelRef }, t('dialogCancel')),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-trash__button${
                  kind === 'purge' || kind === 'purgeAll' ? ' dsh-trash__button--danger' : ''
                }`,
                onClick: onConfirm,
              },
              confirmLabel,
            ),
          ),
        ),
      )
    }

    /**
     * @param {object} ctx plugin context.
     * @param {(key: string) => string} t bound translator.
     * @returns {import('react').FunctionComponent} the Trash settings section.
     */
    function createSection(ctx, t) {
      return function TrashSection() {
        useLocaleRevision(ctx.locale)
        const locale = activeLocale(ctx.locale)
        const [view, setView] = React.useState({ status: 'loading', data: null, error: null })
        const [pendingRows, setPendingRows] = React.useState(() => new Set())
        const [rowErrors, setRowErrors] = React.useState({})
        const [dialog, setDialog] = React.useState(null)
        const [cleaning, setCleaning] = React.useState(false)
        const [rebuilding, setRebuilding] = React.useState(false)
        const [purgingAll, setPurgingAll] = React.useState(false)
        const [forgettingOrphans, setForgettingOrphans] = React.useState(false)
        const [announcement, setAnnouncement] = React.useState('')
        const [clock, setClock] = React.useState(() => Date.now())
        const [query, setQuery] = React.useState('')
        const [filter, setFilter] = React.useState('all')
        const [page, setPage] = React.useState(1)
        const [selectedIds, setSelectedIds] = React.useState(() => new Set())
        const [sortKey, setSortKey] = React.useState('trashed')
        const [expandedRows, setExpandedRows] = React.useState(() => new Set())
        const [batchRestoring, setBatchRestoring] = React.useState(false)
        const abortRef = React.useRef(null)
        const searchRef = React.useRef(null)
        const panelRef = React.useRef(null)
        /** False once the section unmounts, so late responses stay silent. */
        const aliveRef = React.useRef(true)
        /** Number of writes in flight; the section allows only one at a time. */
        const activeWritesRef = React.useRef(0)
        /** Abort scopes of in-flight writes, all cancelled on unmount. */
        const writeScopesRef = React.useRef(new Set())
        /** The page-open sweep is requested once per mounted section. */
        const pageSweepRef = React.useRef(false)
        const closeDialog = React.useCallback(() => setDialog(null), [])

        /**
         * Claim the single write slot. A second click while one mutation is in
         * flight is ignored, so two rows can never race the Host lock.
         *
         * @returns {boolean} whether the write may proceed.
         */
        function beginWrite() {
          if (!aliveRef.current || activeWritesRef.current > 0) return false
          activeWritesRef.current += 1
          return true
        }

        /**
         * @returns {void}
         */
        function endWrite() {
          activeWritesRef.current = Math.max(0, activeWritesRef.current - 1)
        }

        /**
         * @param {string} sessionId row whose write is now pending.
         * @returns {void}
         */
        function markRowPending(sessionId) {
          setPendingRows((previous) => {
            if (previous.has(sessionId)) return previous
            const next = new Set(previous)
            next.add(sessionId)
            return next
          })
        }

        /**
         * @param {string} sessionId row whose write settled.
         * @returns {void}
         */
        function clearRowPending(sessionId) {
          setPendingRows((previous) => {
            if (!previous.has(sessionId)) return previous
            const next = new Set(previous)
            next.delete(sessionId)
            return next
          })
        }

        /**
         * @param {string} sessionId row whose owner-facing error is resolved.
         * @returns {void}
         */
        function clearRowError(sessionId) {
          setRowErrors((previous) => {
            if (!(sessionId in previous)) return previous
            const next = { ...previous }
            delete next[sessionId]
            return next
          })
        }

        /**
         * Open an abort scope for one write. It is cancelled by a hard timeout
         * and by the unmount cleanup, so a stuck request can never wedge the
         * page or outlive the settings section.
         *
         * @returns {{ signal: AbortSignal, timedOut: () => boolean, aborted: () => boolean, cancel: () => void, close: () => void }} the scope.
         */
        function openWriteScope() {
          const controller = new AbortController()
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
          }, MUTATION_TIMEOUT_MS)
          const scope = {
            signal: controller.signal,
            timedOut: () => timedOut,
            aborted: () => controller.signal.aborted,
            cancel: () => controller.abort(),
            close: () => {
              clearTimeout(timer)
              writeScopesRef.current.delete(scope)
            },
          }
          writeScopesRef.current.add(scope)
          return scope
        }

        /**
         * Send one write request, returning a discriminated transport outcome
         * instead of throwing, so every caller localizes failures the same way.
         *
         * @param {string} pathname endpoint below the API prefix.
         * @param {object} [body] JSON request body.
         * @returns {Promise<
         *   | { kind: 'response', status: number, ok: boolean, payload: any }
         *   | { kind: 'timeout' }
         *   | { kind: 'cancelled' }
         *   | { kind: 'network' }
         * >} the outcome.
         */
        async function sendMutationOnce(pathname, body) {
          const scope = openWriteScope()
          try {
            const { status, ok, payload } = await requestJson(pathname, { method: 'POST', body, signal: scope.signal })
            return { kind: 'response', status, ok, payload }
          } catch {
            if (scope.timedOut()) return { kind: 'timeout' }
            if (scope.aborted()) return { kind: 'cancelled' }
            return { kind: 'network' }
          } finally {
            scope.close()
          }
        }

        /**
         * Send one write request. A LOCKED answer means the Host rejected the
         * call before touching anything, so it is safe to retry once after a
         * short jitter instead of surfacing a spurious failure.
         *
         * @param {string} pathname endpoint below the API prefix.
         * @param {object} [body] JSON request body.
         * @returns {Promise<any>} the outcome, see {@link sendMutationOnce}.
         */
        async function sendMutation(pathname, body) {
          let outcome = await sendMutationOnce(pathname, body)
          if (outcome.kind === 'response' && outcome.ok === false) {
            const code =
              outcome.payload !== null && outcome.payload !== undefined && outcome.payload.error !== undefined
                ? outcome.payload.error.code
                : undefined
            if (code === 'LOCKED') {
              await new Promise((resolve) => setTimeout(resolve, 350 + Math.floor(Math.random() * 350)))
              outcome = await sendMutationOnce(pathname, body)
            }
          }
          return outcome
        }

        /**
         * @param {'timeout' | 'network'} kind transport failure.
         * @returns {string} the localized message to show.
         */
        function transportMessage(kind) {
          return kind === 'timeout' ? t('errorTimeout') : t('errorNetwork')
        }

        const load = React.useCallback(() => {
          if (abortRef.current !== null) abortRef.current.abort()
          const controller = new AbortController()
          abortRef.current = controller
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
          }, STATE_TIMEOUT_MS)
          setView((previous) => ({
            status: previous.data === null ? 'loading' : 'refreshing',
            data: previous.data,
            error: null,
          }))
          requestJson('state', { signal: controller.signal })
            .then(({ status, ok, payload }) => {
              if (controller.signal.aborted) return
              if (!ok || payload === null) {
                setView((previous) => ({
                  status: 'error',
                  data: previous.data,
                  error: describeFailure(status, payload, t),
                }))
                return
              }
              setView({ status: 'ready', data: payload, error: null })
              setRowErrors({})
              // Read-only /state never deletes; ask the Host for the throttled
              // maintenance sweep explicitly, once per mounted page.
              if (!pageSweepRef.current) {
                pageSweepRef.current = true
                requestJson('sweep', { method: 'POST' }).catch(() => {})
              }
            })
            .catch(() => {
              if (controller.signal.aborted) {
                if (timedOut) {
                  setView((previous) => ({ status: 'error', data: previous.data, error: t('errorTimeout') }))
                }
                return
              }
              setView((previous) => ({ status: 'error', data: previous.data, error: t('errorNetwork') }))
            })
            .finally(() => clearTimeout(timer))
        }, [])

        React.useEffect(() => {
          load()
          return () => {
            if (abortRef.current !== null) abortRef.current.abort()
          }
        }, [load])

        React.useEffect(() => subscribeRevision(load), [load])

        React.useEffect(
          () => () => {
            aliveRef.current = false
            for (const scope of [...writeScopesRef.current]) scope.cancel()
            writeScopesRef.current.clear()
          },
          [],
        )

        React.useEffect(() => {
          const refresh = () => load()
          const onVisibility = () => {
            if (document.visibilityState === 'visible') refresh()
          }
          window.addEventListener('focus', refresh)
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }, [load])

        // Keep relative expiry text honest on a page left open for a long time.
        React.useEffect(() => {
          if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return undefined
          const handle = window.setInterval(() => setClock(Date.now()), 60_000)
          return () => {
            if (typeof window.clearInterval === 'function') window.clearInterval(handle)
          }
        }, [])

        const data = view.data
        const entries = data !== null && Array.isArray(data.entries) ? [...data.entries] : []
        entries.sort((left, right) => compareEntries(left, right, sortKey, locale))
        const retentionDays =
          data !== null && data.config !== undefined && typeof data.config.retentionDays === 'number'
            ? data.config.retentionDays
            : 30
        const autoCleanupEnabled =
          data === null || data.config === undefined || data.config.enableAutoCleanup !== false
        const totalBytes = data !== null && data.stats !== undefined ? data.stats.totalBytes : 0
        const nextSweepAt = data !== null && data.stats !== undefined ? data.stats.nextSweepAt : null
        const cleanupInfo =
          data !== null && data.stats !== undefined && data.stats.cleanup !== undefined && data.stats.cleanup !== null
            ? data.stats.cleanup
            : null
        const cleanupFailed =
          cleanupInfo !== null && cleanupInfo.lastRun !== null && cleanupInfo.lastRun !== undefined
            ? typeof cleanupInfo.lastRun.failed === 'number'
              ? cleanupInfo.lastRun.failed
              : 0
            : 0
        const cleanupRetryAt =
          cleanupInfo !== null && typeof cleanupInfo.retryAt === 'number' ? cleanupInfo.retryAt : null
        const cleanupError =
          cleanupInfo !== null &&
          cleanupInfo.lastRun !== null &&
          cleanupInfo.lastRun !== undefined &&
          typeof cleanupInfo.lastRun.error === 'string' &&
          cleanupInfo.lastRun.error !== ''
            ? cleanupInfo.lastRun.error
            : null
        const loading = view.status === 'loading'
        const refreshing = view.status === 'refreshing'
        const readsBusy = loading || refreshing
        const pendingCount =
          pendingRows.size +
          (cleaning ? 1 : 0) +
          (purgingAll ? 1 : 0) +
          (rebuilding ? 1 : 0) +
          (forgettingOrphans ? 1 : 0) +
          (batchRestoring ? 1 : 0)
        /** Any write (row action or maintenance) is in flight. */
        const mutationBusy = pendingCount > 0
        const corrupt = data !== null && data.index !== undefined && data.index.status === 'corrupt'
        const recovered = data !== null && data.index !== undefined && data.index.status === 'recovered'
        const unindexed = data !== null && data.index !== undefined && typeof data.index.unindexed === 'number' ? data.index.unindexed : 0
        const now = clock
        const normalizedQuery = query.trim().toLowerCase()

        /**
         * @param {object} entry wire entry.
         * @returns {boolean} whether the entry matches the search text.
         */
        function matchesQuery(entry) {
          if (normalizedQuery === '') return true
          const memberTitles = (Array.isArray(entry.members) ? entry.members : []).map((member) =>
            member !== null && typeof member === 'object' ? member.title : undefined,
          )
          const candidates = [
            entry.title,
            entry.sessionId,
            entry.originalCwd,
            entry.originalWorkspaceTitle,
            ...memberTitles,
          ]
          return candidates.some(
            (value) => typeof value === 'string' && value.toLowerCase().includes(normalizedQuery),
          )
        }

        /**
         * @param {object} entry wire entry.
         * @param {string} [selected] filter to test; defaults to the active one.
         * @returns {boolean} whether the entry matches the selected filter.
         */
        function matchesFilter(entry, selected = filter) {
          if (selected === 'workspace-exists') return entry.originalCwd !== null && entry.workspaceNowExists === true
          if (selected === 'workspace-missing') return entry.originalCwd !== null && entry.workspaceNowExists === false
          if (selected === 'expiring') {
            const retention = remaining(entry, locale, now)
            return retention.days !== null && retention.days <= EXPIRING_DAYS
          }
          return true
        }

        const filteredEntries = entries.filter((entry) => matchesQuery(entry) && matchesFilter(entry))
        const pageCount = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE))
        const currentPage = Math.min(Math.max(1, page), pageCount)
        React.useEffect(() => {
          if (page > pageCount) setPage(pageCount)
        }, [page, pageCount])
        const pageStart = (currentPage - 1) * PAGE_SIZE
        const visibleEntries = filteredEntries.slice(pageStart, pageStart + PAGE_SIZE)
        const filtersActive = normalizedQuery !== '' || filter !== 'all'
        const pageSelectable = visibleEntries.filter((entry) => isSelectable(entry))
        const selectedEntries = entries.filter((entry) => selectedIds.has(entry.sessionId) && isSelectable(entry))
        const allPageSelected =
          pageSelectable.length > 0 && pageSelectable.every((entry) => selectedIds.has(entry.sessionId))

        /**
         * @returns {void} focus the search field when it is mounted.
         */
        function focusSearch() {
          if (searchRef.current !== null && typeof searchRef.current.focus === 'function') {
            searchRef.current.focus()
          }
        }

        /**
         * @returns {void} reset both the search text and the filter.
         */
        function clearFilters() {
          setQuery('')
          setFilter('all')
          setPage(1)
          focusSearch()
        }

        /**
         * @param {number} next desired page number.
         * @returns {void}
         */
        function goToPage(next) {
          const target = Math.min(Math.max(1, next), pageCount)
          if (target === currentPage) return
          setPage(target)
          announce(format(t('pageAnnouncement'), { page: target, total: pageCount }))
          if (panelRef.current !== null && typeof panelRef.current.scrollIntoView === 'function') {
            panelRef.current.scrollIntoView({ block: 'nearest' })
          }
        }

        /**
         * @param {object} entry wire entry.
         * @returns {boolean} whether this row can join a batch restore.
         */
        function isSelectable(entry) {
          return entry.canRestore === true && entry.requiresOrphanRestore !== true
        }

        /**
         * @param {string} sessionId selected row identity.
         * @returns {void}
         */
        function toggleSelected(sessionId) {
          setSelectedIds((previous) => {
            const next = new Set(previous)
            if (next.has(sessionId)) next.delete(sessionId)
            else next.add(sessionId)
            return next
          })
        }

        /**
         * @param {boolean} checked whether the page should be selected.
         * @returns {void}
         */
        function togglePageSelection(checked) {
          setSelectedIds((previous) => {
            const next = new Set(previous)
            for (const entry of pageSelectable) {
              if (checked) next.add(entry.sessionId)
              else next.delete(entry.sessionId)
            }
            return next
          })
        }

        /**
         * @returns {void}
         */
        function clearSelection() {
          setSelectedIds(new Set())
        }

        /**
         * @param {string} sessionId row whose member list is toggled.
         * @returns {void}
         */
        function toggleExpanded(sessionId) {
          setExpandedRows((previous) => {
            const next = new Set(previous)
            if (next.has(sessionId)) next.delete(sessionId)
            else next.add(sessionId)
            return next
          })
        }

        /**
         * Restore every selected row, one Host request at a time. Failures are
         * collected per row and summarized in one Toast.
         *
         * @returns {Promise<void>} completion of the operation.
         */
        async function performBatchRestore() {
          if (!beginWrite()) return
          const targets = selectedEntries.slice()
          setBatchRestoring(true)
          let restored = 0
          let failed = 0
          try {
            for (const entry of targets) {
              if (!aliveRef.current) return
              const outcome = await sendMutation('restore', { sessionId: entry.sessionId, mode: 'normal' })
              if (!aliveRef.current || outcome.kind === 'cancelled') return
              if (outcome.kind !== 'response') {
                failed += 1
                recordRowError(entry, transportMessage(outcome.kind))
                continue
              }
              if (!outcome.ok) {
                failed += 1
                recordRowError(entry, describeActionFailure(outcome.status, outcome.payload, t))
                continue
              }
              restored += 1
              clearRowError(entry.sessionId)
            }
            if (!aliveRef.current) return
            bumpRevision()
            clearSelection()
            const message =
              failed === 0
                ? countText(t, 'batchRestoreDone', restored)
                : format(t('batchRestorePartial'), { restored, failed })
            ctx.contextMenus.notify(message, failed === 0)
            announce(message)
          } finally {
            endWrite()
            if (aliveRef.current) setBatchRestoring(false)
          }
        }

        /**
         * @param {object} entry wire entry.
         * @param {string} message localized failure text.
         * @returns {void}
         */
        function recordRowError(entry, message) {
          setRowErrors((previous) => ({ ...previous, [entry.sessionId]: message }))
        }

        function fail(entry, message) {
          recordRowError(entry, message)
          ctx.contextMenus.notify(message, false)
        }

        /**
         * @param {string} text localized announcement text.
         * @returns {void}
         */
        function announce(text) {
          setAnnouncement(text)
        }

        /**
         * @param {object} entry wire entry.
         * @param {'normal' | 'orphan'} mode restore mode.
         * @returns {Promise<void>} completion of the operation.
         */
        async function performRestore(entry, mode) {
          if (!beginWrite()) return
          markRowPending(entry.sessionId)
          try {
            const outcome = await sendMutation('restore', { sessionId: entry.sessionId, mode })
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              fail(entry, transportMessage(outcome.kind))
              return
            }
            if (!outcome.ok) {
              const code =
                outcome.payload !== null && outcome.payload !== undefined && outcome.payload.error !== undefined
                  ? outcome.payload.error.code
                  : undefined
              if (mode === 'normal' && code === 'WORKSPACE_MISSING') {
                setDialog({ kind: 'orphan', entry })
                return
              }
              fail(entry, describeActionFailure(outcome.status, outcome.payload, t))
              return
            }
            const session = outcome.payload !== null && outcome.payload !== undefined ? outcome.payload.session : undefined
            const orphan = session !== null && session !== undefined ? session.orphan === true : mode === 'orphan'
            const title =
              session !== null && session !== undefined && typeof session.title === 'string' && session.title !== ''
                ? session.title
                : entry.title
            clearRowError(entry.sessionId)
            const message = format(t(orphan ? 'restoreOrphanSuccess' : 'restoreSuccess'), { title })
            bumpRevision()
            ctx.contextMenus.notify(message, true)
            announce(message)
          } finally {
            endWrite()
            if (aliveRef.current) clearRowPending(entry.sessionId)
          }
        }

        /**
         * @param {object} entry wire entry.
         * @returns {Promise<void>} completion of the operation.
         */
        async function performPurge(entry) {
          if (!beginWrite()) return
          markRowPending(entry.sessionId)
          try {
            const outcome = await sendMutation('purge', { sessionId: entry.sessionId })
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              fail(entry, transportMessage(outcome.kind))
              return
            }
            if (!outcome.ok) {
              fail(entry, describeActionFailure(outcome.status, outcome.payload, t))
              return
            }
            clearRowError(entry.sessionId)
            const payload = outcome.payload
            const freedBytes =
              payload !== null && payload !== undefined && typeof payload.freedBytes === 'number'
                ? payload.freedBytes
                : null
            const message =
              freedBytes === null || freedBytes <= 0
                ? format(t('purgeSuccessUnknown'), { title: entry.title })
                : format(t('purgeSuccess'), { title: entry.title, size: formatBytes(freedBytes) })
            bumpRevision()
            ctx.contextMenus.notify(message, true)
            announce(message)
          } finally {
            endWrite()
            if (aliveRef.current) clearRowPending(entry.sessionId)
          }
        }

        /**
         * @param {object} entry missing wire entry.
         * @returns {Promise<void>} completion of the operation.
         */
        async function performForget(entry) {
          if (!beginWrite()) return
          markRowPending(entry.sessionId)
          try {
            const outcome = await sendMutation('forget', { sessionId: entry.sessionId })
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              fail(entry, transportMessage(outcome.kind))
              return
            }
            if (!outcome.ok) {
              fail(entry, describeActionFailure(outcome.status, outcome.payload, t))
              return
            }
            clearRowError(entry.sessionId)
            bumpRevision()
            ctx.contextMenus.notify(t('forgetSuccess'), true)
            announce(t('forgetSuccess'))
          } finally {
            endWrite()
            if (aliveRef.current) clearRowPending(entry.sessionId)
          }
        }

        /**
         * @param {object} entry wire entry.
         * @returns {Promise<void>} completion of the operation.
         */
        async function performReveal(entry) {
          if (!beginWrite()) return
          markRowPending(entry.sessionId)
          try {
            const outcome = await sendMutation('reveal', { sessionId: entry.sessionId })
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              fail(entry, transportMessage(outcome.kind))
              return
            }
            if (!outcome.ok) {
              fail(entry, describeActionFailure(outcome.status, outcome.payload, t))
              return
            }
            clearRowError(entry.sessionId)
            ctx.contextMenus.notify(t('revealSuccess'), true)
            announce(t('revealSuccess'))
          } finally {
            endWrite()
            if (aliveRef.current) clearRowPending(entry.sessionId)
          }
        }

        /**
         * @param {object} entry wire entry.
         * @returns {Promise<void>} completion of the operation.
         */
        async function performCopy(entry) {
          const copied = await copyText(entry.sessionId)
          if (!aliveRef.current) return
          ctx.contextMenus.notify(copied ? t('copySuccess') : t('copyFailed'), copied)
          announce(copied ? t('copySuccess') : t('copyFailed'))
        }

        /**
         * @returns {Promise<void>} completion of the operation.
         */
        async function runCleanup() {
          if (!beginWrite()) return
          setCleaning(true)
          try {
            const outcome = await sendMutation('cleanup')
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              ctx.contextMenus.notify(transportMessage(outcome.kind), false)
              return
            }
            if (!outcome.ok) {
              ctx.contextMenus.notify(describeActionFailure(outcome.status, outcome.payload, t), false)
              return
            }
            const payload = outcome.payload
            const purged = payload !== null && payload !== undefined && typeof payload.purged === 'number' ? payload.purged : 0
            const failed = payload !== null && payload !== undefined && typeof payload.failed === 'number' ? payload.failed : 0
            let message
            if (failed > 0 && purged > 0) message = format(t('cleanupPartial'), { purged, failed })
            else if (failed > 0) message = format(t('cleanupFailed'), { failed })
            else message = purged > 0 ? countText(t, 'cleanupDone', purged) : t('cleanupNone')
            bumpRevision()
            ctx.contextMenus.notify(message, failed === 0)
            announce(message)
          } finally {
            endWrite()
            if (aliveRef.current) setCleaning(false)
          }
        }

        /**
         * Permanently delete every entry in the trash.
         *
         * @returns {Promise<void>} completion of the operation.
         */
        async function performPurgeAll() {
          if (!beginWrite()) return
          setPurgingAll(true)
          try {
            const outcome = await sendMutation('purge-all')
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              ctx.contextMenus.notify(transportMessage(outcome.kind), false)
              return
            }
            if (!outcome.ok) {
              ctx.contextMenus.notify(describeActionFailure(outcome.status, outcome.payload, t), false)
              return
            }
            const payload = outcome.payload
            const purged = payload !== null && payload !== undefined && typeof payload.purged === 'number' ? payload.purged : 0
            const forgotten =
              payload !== null && payload !== undefined && typeof payload.forgotten === 'number' ? payload.forgotten : 0
            const failed = payload !== null && payload !== undefined && typeof payload.failed === 'number' ? payload.failed : 0
            const removed = purged + forgotten
            const freedBytes =
              payload !== null && payload !== undefined && typeof payload.freedBytes === 'number'
                ? payload.freedBytes
                : null
            const size = formatBytes(freedBytes)
            const knownSize = typeof freedBytes === 'number' && freedBytes > 0
            let message
            if (failed > 0) {
              message = knownSize
                ? format(t('purgeAllPartial'), { removed, failed, size })
                : format(t('purgeAllPartialPlain'), { removed, failed })
            } else if (removed > 0) {
              message = countText(
                t,
                knownSize ? 'purgeAllDone' : 'purgeAllDonePlain',
                removed,
                knownSize ? { size } : {},
              )
            } else {
              message = t('purgeAllNone')
            }
            bumpRevision()
            ctx.contextMenus.notify(message, failed === 0)
            announce(message)
          } finally {
            endWrite()
            if (aliveRef.current) setPurgingAll(false)
          }
        }

        /**
         * @returns {Promise<void>} completion of the operation.
         */
        async function runRebuild() {
          if (!beginWrite()) return
          setRebuilding(true)
          try {
            const outcome = await sendMutation('rebuild')
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              ctx.contextMenus.notify(transportMessage(outcome.kind), false)
              return
            }
            if (!outcome.ok) {
              ctx.contextMenus.notify(describeActionFailure(outcome.status, outcome.payload, t), false)
              return
            }
            const payload = outcome.payload
            const count = payload !== null && payload !== undefined && typeof payload.entries === 'number' ? payload.entries : 0
            const unindexedCount =
              payload !== null && payload !== undefined && typeof payload.unindexed === 'number' ? payload.unindexed : 0
            const message =
              unindexedCount > 0
                ? format(t('rebuildDoneUnindexed'), { count, unindexed: unindexedCount })
                : format(t('rebuildDone'), { count })
            bumpRevision()
            ctx.contextMenus.notify(message, true)
            announce(message)
          } finally {
            endWrite()
            if (aliveRef.current) setRebuilding(false)
          }
        }

        /**
         * Remove empty unindexed object directories. They contain no session
         * log, only leftover plugin metadata, so this is safe to offer.
         *
         * @returns {Promise<void>} completion of the operation.
         */
        async function performPurgeOrphans() {
          if (!beginWrite()) return
          setForgettingOrphans(true)
          try {
            const outcome = await sendMutation('orphans/forget')
            if (!aliveRef.current || outcome.kind === 'cancelled') return
            if (outcome.kind !== 'response') {
              ctx.contextMenus.notify(transportMessage(outcome.kind), false)
              return
            }
            if (!outcome.ok) {
              ctx.contextMenus.notify(describeActionFailure(outcome.status, outcome.payload, t), false)
              return
            }
            const payload = outcome.payload
            const removed =
              payload !== null && payload !== undefined && typeof payload.removed === 'number' ? payload.removed : 0
            const message = removed > 0 ? countText(t, 'orphansDone', removed) : t('orphansNone')
            bumpRevision()
            ctx.contextMenus.notify(message, removed > 0)
            announce(message)
          } finally {
            endWrite()
            if (aliveRef.current) setForgettingOrphans(false)
          }
        }

        /**
         * @param {object} entry wire entry.
         * @param {string} key menu identity.
         * @returns {object} one menu item.
         */
        function menuItem(entry, key) {
          if (key === 'orphan') {
            return {
              key: 'orphan',
              label: t('actionRestoreOrphan'),
              onSelect: () => setDialog({ kind: 'orphan', entry }),
            }
          }
          if (key === 'reveal') {
            const available = entry.originalCwd !== null && entry.workspaceNowExists === true
            return {
              key: 'reveal',
              label: t('actionReveal'),
              disabled: !available,
              title: available ? entry.originalCwd : t('actionRevealDisabled'),
              ariaLabel: available ? undefined : `${t('actionReveal')} — ${t('actionRevealDisabled')}`,
              onSelect: () => {
                void performReveal(entry)
              },
            }
          }
          if (key === 'copy') {
            return {
              key: 'copy',
              label: t('actionCopyId'),
              onSelect: () => {
                void performCopy(entry)
              },
            }
          }
          if (key === 'forget') {
            return {
              key: 'forget',
              label: t('actionForget'),
              separatorBefore: true,
              onSelect: () => setDialog({ kind: 'forget', entry }),
            }
          }
          return {
            key: 'purge',
            label: t('actionPurge'),
            danger: true,
            separatorBefore: true,
            onSelect: () => setDialog({ kind: 'purge', entry }),
          }
        }

        /**
         * @param {object} entry wire entry.
         * @returns {object[]} the row's menu items.
         */
        function menuItemsFor(entry) {
          const keys = []
          if (entry.canRestore === true) keys.push('orphan')
          keys.push('reveal', 'copy')
          if (entry.canForget === true) keys.push('forget')
          if (entry.canPurge === true) keys.push('purge')
          return keys.map((key) => menuItem(entry, key))
        }

        /**
         * @param {object} entry wire entry.
         * @returns {object[]} status badges for one row.
         */
        function badgesFor(entry) {
          const badges = []
          if (entry.state === 'missing') {
            badges.push({ key: 'missing', label: t('badgeMissing'), tone: 'danger' })
          } else if (entry.state === 'trashing') {
            badges.push({ key: 'trashing', label: t('stateTrashing'), tone: 'info' })
          } else if (entry.state === 'restoring') {
            badges.push({ key: 'restoring', label: t('stateRestoring'), tone: 'info' })
          } else if (entry.state === 'purging') {
            badges.push({ key: 'purging', label: t('statePurging'), tone: 'info' })
          }
          if (entry.originalCwd !== null && entry.workspaceNowExists === false) {
            badges.push({ key: 'workspace', label: t('badgeWorkspaceMissing'), tone: 'warn' })
          }
          if (entry.formatStatus === 'migration-required') {
            badges.push({ key: 'migration', label: t('badgeMigration'), tone: 'warn' })
          }
          const subagentCount = entry.subagentCount ?? 0
          if (subagentCount > 0) {
            badges.push({
              key: 'subagents',
              label: countText(t, 'badgeSubagents', subagentCount),
              tone: 'info',
            })
          }
          const retention = remaining(entry, locale, now)
          if (retention.days !== null && retention.days <= 3) {
            badges.push({
              key: 'expiring',
              label: retention.days <= 0 ? t('badgeExpired') : t('badgeExpiring'),
              tone: 'warn',
            })
          }
          return badges
        }

        /**
         * @param {object} entry wire entry.
         * @returns {string} the localized retention sentence for one row.
         */
        function retentionText(entry) {
          if (entry.state !== 'trashed' || typeof entry.expiresAt !== 'number') return t('notScheduled')
          const retention = remaining(entry, locale, now)
          if (retention.days === null || retention.days <= 0) return t('badgeExpired')
          return `${retention.text} · ${format(t('expiresOn'), { date: formatDate(entry.expiresAt, locale) })}`
        }

        const header = h(
          'header',
          { className: 'dsh-trash__header', key: 'header' },
          h('h2', { className: 'dsh-trash__title' }, t('title')),
          h('p', { className: 'dsh-trash__subtitle' }, format(t('subtitle'), { days: retentionDays })),
        )

        const banners = []
        if (corrupt) {
          banners.push(
            h(
              'div',
              { className: 'dsh-trash__banner dsh-trash__banner--warn', role: 'status', key: 'corrupt' },
              h(TrashGlyph, { size: 16 }),
              h('span', { className: 'dsh-trash__bannerText' }, t('corruptBanner')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-trash__button',
                  onClick: () => {
                    void runRebuild()
                  },
                  disabled: loading || mutationBusy,
                },
                rebuilding ? t('rebuilding') : t('rebuild'),
              ),
            ),
          )
        } else if (recovered) {
          banners.push(
            h(
              'div',
              { className: 'dsh-trash__banner dsh-trash__banner--warn', role: 'status', key: 'recovered' },
              h('span', { className: 'dsh-trash__bannerText' }, t('recoveredBanner')),
            ),
          )
        }
        if (unindexed > 0) {
          banners.push(
            h(
              'div',
              { className: 'dsh-trash__banner dsh-trash__banner--info', role: 'status', key: 'unindexed' },
              h('span', { className: 'dsh-trash__bannerText' }, format(t('unindexedBanner'), { count: unindexed })),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-trash__button',
                  onClick: () => setDialog({ kind: 'orphans' }),
                  disabled: loading || mutationBusy,
                },
                t('orphansClean'),
              ),
            ),
          )
        }
        if (!autoCleanupEnabled) {
          banners.push(
            h(
              'div',
              { className: 'dsh-trash__banner dsh-trash__banner--info', role: 'status', key: 'auto-cleanup' },
              h('span', { className: 'dsh-trash__bannerText' }, t('autoCleanupBanner')),
            ),
          )
        }
        if (cleanupFailed > 0 || cleanupError !== null) {
          const retryText =
            cleanupRetryAt !== null ? format(t('cleanupRetryAt'), { time: formatDate(cleanupRetryAt, locale, true) }) : ''
          const cleanupMessage =
            cleanupFailed > 0 ? countText(t, 'cleanupFailedBanner', cleanupFailed) : t('cleanupErrorBanner')
          banners.push(
            h(
              'div',
              { className: 'dsh-trash__banner dsh-trash__banner--warn', role: 'status', key: 'cleanup-failed' },
              h(TrashGlyph, { size: 16 }),
              h(
                'span',
                { className: 'dsh-trash__bannerText', title: cleanupError ?? undefined },
                cleanupMessage,
                retryText === '' ? null : ` ${retryText}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-trash__button',
                  onClick: () => {
                    void runCleanup()
                  },
                  disabled: loading || mutationBusy || corrupt,
                },
                cleaning ? t('cleaning') : t('cleanupRetryNow'),
              ),
            ),
          )
        }
        if (view.error !== null) {
          banners.push(
            h(
              'div',
              { className: 'dsh-trash__banner dsh-trash__banner--error', role: 'alert', key: 'error' },
              h('span', { className: 'dsh-trash__bannerText' }, view.error),
              h('button', { type: 'button', className: 'dsh-trash__button', onClick: load }, t('retry')),
            ),
          )
        }

        const statsText = autoCleanupEnabled
          ? nextSweepAt !== null && nextSweepAt !== undefined
            ? format(t('nextSweep'), { date: formatDate(nextSweepAt, locale, true) })
            : t('nextSweepUnknown')
          : t('autoCleanupOff')

        const toolbar =
          data === null
            ? null
            : h(
                'div',
                { className: 'dsh-trash__toolbar', key: 'toolbar' },
                h(
                  'span',
                  { className: 'dsh-trash__stats' },
                  countText(t, 'statsCount', entries.length),
                  h('span', { className: 'dsh-trash__dot', 'aria-hidden': true }, '·'),
                  format(t('statsSize'), { size: formatBytes(totalBytes) }),
                  h('span', { className: 'dsh-trash__dot', 'aria-hidden': true }, '·'),
                  statsText,
                ),
                h(
                  'div',
                  { className: 'dsh-trash__toolbarActions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-trash__button',
                      onClick: () => {
                        void runCleanup()
                      },
                      disabled: loading || mutationBusy || corrupt,
                    },
                    cleaning ? t('cleaning') : t('cleanupExpired'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-trash__button',
                      onClick: load,
                      disabled: loading || refreshing,
                      'aria-busy': refreshing ? 'true' : 'false',
                    },
                    t('refresh'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-trash__button dsh-trash__button--danger',
                      onClick: () => setDialog({ kind: 'purgeAll', count: entries.length }),
                      disabled: loading || mutationBusy || corrupt || entries.length === 0,
                    },
                    purgingAll ? t('purgingAll') : t('purgeAll'),
                  ),
                ),
              )

        const storage =
          data !== null && data !== undefined && data.storage !== null && typeof data.storage === 'object'
            ? data.storage
            : null
        const attachmentBytes = formatBytes(storage?.attachments?.bytes)
        const attachmentScan = storage?.attachments?.scan
        const orphanBytes =
          typeof storage?.attachments?.orphanBytes === 'number' ? storage.attachments.orphanBytes : null
        let attachmentLabel = attachmentBytes
        if (orphanBytes !== null && orphanBytes > 0) {
          attachmentLabel += `（${format(t('storageOrphan'), { size: formatBytes(orphanBytes) })}）`
        } else if (storage?.attachments?.complete === false) {
          attachmentLabel += `（${t('storageIndexPartial')}）`
        } else if (attachmentScan?.status === 'partial') {
          attachmentLabel += `（${t('storageScanPartial')}）`
        } else if (attachmentScan?.status === 'unavailable') {
          attachmentLabel += `（${t('storageScanUnavailable')}）`
        }
        const storageLine =
          storage === null || !(Number(storage.totalBytes) > 0)
            ? null
            : h(
                'div',
                { className: 'dsh-trash__storage', key: 'storage' },
                format(t('storageSummary'), {
                  total: formatBytes(storage.totalBytes),
                  logs: formatBytes(
                    (Number(storage.sessionLogs?.bytes) || 0) + (Number(storage.trashLogs?.bytes) || 0),
                  ),
                  attachments: attachmentLabel,
                  cache: formatBytes(
                    (Number(storage.attachmentCache?.bytes) || 0) +
                      (Number(storage.projectionCache?.bytes) || 0),
                  ),
                }),
                Number(storage.projectionCache?.sweepableBytes) > 0
                  ? ` · ${format(t('storageSweepable'), { size: formatBytes(storage.projectionCache.sweepableBytes) })}`
                  : null,
              )

        const controls =
          entries.length === 0
            ? null
            : h(
                'div',
                { className: 'dsh-trash__controls', key: 'controls' },
                h(
                  'div',
                  { className: 'dsh-trash__searchRow' },
                  h(
                    'div',
                    { className: 'dsh-trash__search' },
                    h('span', { className: 'dsh-trash__searchGlyph' }, h(SearchGlyph, { size: 14 })),
                    h('input', {
                      type: 'search',
                      className: 'dsh-trash__searchInput',
                      value: query,
                      placeholder: t('searchPlaceholder'),
                      'aria-label': t('searchLabel'),
                      autoComplete: 'off',
                      spellCheck: false,
                      ref: searchRef,
                      onChange: (event) => {
                        setQuery(event.target.value)
                        setPage(1)
                      },
                      onKeyDown: (event) => {
                        if (event.key !== 'Escape' || query === '') return
                        event.preventDefault()
                        setQuery('')
                        setPage(1)
                      },
                    }),
                    query === ''
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-trash__searchClear',
                            'aria-label': t('searchClear'),
                            title: t('searchClear'),
                            onClick: () => {
                              setQuery('')
                              setPage(1)
                              focusSearch()
                            },
                          },
                          h(CloseGlyph, { size: 11 }),
                        ),
                  ),
                  h(
                    'div',
                    { className: 'dsh-trash__controlsRight' },
                    filtersActive
                      ? h(
                          'span',
                          { className: 'dsh-trash__resultsCount' },
                          format(t('resultsCount'), { shown: filteredEntries.length, total: entries.length }),
                        )
                      : null,
                    h(
                      'label',
                      { className: 'dsh-trash__selectAll' },
                      h('input', {
                        type: 'checkbox',
                        className: 'dsh-trash__selectAllInput',
                        checked: allPageSelected,
                        'aria-label': t('selectAll'),
                        disabled: pageSelectable.length === 0 || loading || mutationBusy || corrupt,
                        onChange: (event) => togglePageSelection(event.target.checked),
                      }),
                      h('span', null, t('selectAll')),
                    ),
                    h(
                      'label',
                      { className: 'dsh-trash__sort' },
                      h('span', { className: 'dsh-trash__sortLabel' }, t('sortLabel')),
                      h(
                        'select',
                        {
                          className: 'dsh-trash__sortSelect',
                          value: sortKey,
                          'aria-label': t('sortLabel'),
                          onChange: (event) => {
                            setSortKey(event.target.value)
                            setPage(1)
                          },
                        },
                        SORT_OPTIONS.map((option) => h('option', { value: option.value, key: option.value }, t(option.key))),
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsh-trash__filters', role: 'radiogroup', 'aria-label': t('filterLabel') },
                  FILTERS.map((value) =>
                    h(
                      'label',
                      { className: 'dsh-trash__filterOption', key: value },
                      h('input', {
                        type: 'radio',
                        className: 'dsh-trash__filterInput',
                        name: 'dsh-trash-filter',
                        value,
                        checked: filter === value,
                        onChange: () => {
                          setFilter(value)
                          setPage(1)
                          const matches = entries.filter((entry) => matchesQuery(entry) && matchesFilter(entry, value)).length
                          announce(format(t('filterResults'), { count: matches }))
                        },
                      }),
                      h('span', { className: 'dsh-trash__filterLabel' }, t(FILTER_LABEL_KEYS[value])),
                    ),
                  ),
                ),
              )

        const batchBar =
          selectedEntries.length === 0
            ? null
            : h(
                'div',
                { className: 'dsh-trash__batch', key: 'batch', role: 'region', 'aria-label': format(t('selectedCount'), { count: selectedEntries.length }) },
                h('span', { className: 'dsh-trash__batchCount' }, format(t('selectedCount'), { count: selectedEntries.length })),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-trash__button',
                    onClick: () => {
                      void performBatchRestore()
                    },
                    disabled: loading || mutationBusy || corrupt,
                  },
                  batchRestoring ? t('batchRestoring') : t('batchRestore'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-trash__button',
                    onClick: clearSelection,
                    disabled: batchRestoring,
                  },
                  t('clearSelection'),
                ),
              )

        let panelBody
        if (view.status === 'loading') {
          panelBody = h(
            'div',
            { className: 'dsh-trash__skeletons' },
            h('span', { className: 'dsh-trash__srOnly', role: 'status' }, t('loading')),
            [0, 1, 2, 3].map((index) => h('div', { className: 'dsh-trash__skeleton', key: index, 'aria-hidden': true })),
          )
        } else if (entries.length === 0) {
          panelBody = h(
            'div',
            { className: 'dsh-trash__empty' },
            h('span', { className: 'dsh-trash__emptyGlyph' }, h(TrashGlyph, { size: 28 })),
            h('div', { className: 'dsh-trash__emptyTitle' }, t('emptyTitle')),
            h('div', { className: 'dsh-trash__emptyBody' }, t('emptyBody')),
          )
        } else if (filteredEntries.length === 0) {
          panelBody = h(
            'div',
            { className: 'dsh-trash__empty' },
            h('span', { className: 'dsh-trash__emptyGlyph' }, h(SearchGlyph, { size: 28 })),
            h('div', { className: 'dsh-trash__emptyTitle' }, t('noResultsTitle')),
            h('div', { className: 'dsh-trash__emptyBody' }, t('noResultsBody')),
            h(
              'button',
              { type: 'button', className: 'dsh-trash__button dsh-trash__emptyAction', onClick: clearFilters },
              t('clearFilters'),
            ),
          )
        } else {
          panelBody = h(
            'ul',
            { className: 'dsh-trash__list', 'aria-label': t('listLabel') },
            visibleEntries.map((entry) => {
              const rowBusy = pendingRows.has(entry.sessionId)
              const rowError = rowErrors[entry.sessionId]
              const lastErrorCode = typeof entry.lastErrorCode === 'string' ? entry.lastErrorCode : null
              const lastErrorText =
                typeof entry.lastError === 'string' && entry.lastError !== ''
                  ? t(LAST_ERROR_KEYS[lastErrorCode] ?? 'lastErrorIo')
                  : null
              const error = rowError ?? lastErrorText
              const errorTitle = rowError === undefined && typeof entry.lastError === 'string' ? entry.lastError : undefined
              const title = entry.title !== undefined && entry.title !== '' ? entry.title : entry.sessionId
              const originalCwd =
                typeof entry.originalCwd === 'string' && entry.originalCwd !== '' ? entry.originalCwd : null
              const workspace = workspaceName(entry)
              return h(
                'li',
                { className: 'dsh-trash__row', key: entry.sessionId, 'aria-busy': rowBusy ? 'true' : 'false' },
                isSelectable(entry)
                  ? h('input', {
                      type: 'checkbox',
                      className: 'dsh-trash__rowCheck',
                      checked: selectedIds.has(entry.sessionId),
                      'aria-label': format(t('selectRow'), { title }),
                      disabled: rowBusy || mutationBusy || corrupt || loading,
                      onChange: () => toggleSelected(entry.sessionId),
                    })
                  : null,
                h(
                  'div',
                  { className: 'dsh-trash__rowMain' },
                  h(
                    'div',
                    { className: 'dsh-trash__rowTitleLine' },
                    h('span', { className: 'dsh-trash__rowTitle', title }, title),
                    badgesFor(entry).map((badge) =>
                      h('span', { className: `dsh-trash__badge dsh-trash__badge--${badge.tone}`, key: badge.key }, badge.label),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dsh-trash__rowMeta' },
                    h('code', { className: 'dsh-trash__rowId', title: entry.sessionId }, entry.sessionId),
                    h('span', { className: 'dsh-trash__dot', 'aria-hidden': true }, '·'),
                    h(
                      'span',
                      {
                        className: 'dsh-trash__rowWorkspace',
                        title: originalCwd ?? undefined,
                      },
                      h('span', { className: 'dsh-trash__rowWorkspaceLabel' }, t('workspaceLabel')),
                      ' ',
                      workspace === '' ? t('noWorkspace') : workspace,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dsh-trash__rowFacts' },
                    h('span', null, `${t('trashedAtLabel')}: ${formatDate(entry.trashedAt, locale, true)}`),
                    h('span', { className: 'dsh-trash__dot', 'aria-hidden': true }, '·'),
                    h('span', null, retentionText(entry)),
                    h('span', { className: 'dsh-trash__dot', 'aria-hidden': true }, '·'),
                    h('span', { title: t('logSizeHint') }, format(t('logSize'), { size: formatBytes(entry.sizeBytes) })),
                  ),
                  entry.subagentCount > 0
                    ? h(
                        'div',
                        { className: 'dsh-trash__membersWrap' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-trash__membersToggle',
                            'aria-expanded': expandedRows.has(entry.sessionId) ? 'true' : 'false',
                            onClick: () => toggleExpanded(entry.sessionId),
                          },
                          expandedRows.has(entry.sessionId) ? t('collapseMembers') : t('expandMembers'),
                        ),
                        expandedRows.has(entry.sessionId)
                          ? h(
                              'ul',
                              { className: 'dsh-trash__members' },
                              (Array.isArray(entry.members) ? entry.members : []).map((member) => {
                                const memberTitle =
                                  typeof member.title === 'string' && member.title.trim() !== ''
                                    ? member.title.trim()
                                    : ''
                                return h(
                                  'li',
                                  { className: 'dsh-trash__member', key: member.sessionId },
                                  h(
                                    'span',
                                    { className: 'dsh-trash__memberKind' },
                                    member.origin === 'subagent' ? t('memberSubagent') : t('memberParent'),
                                  ),
                                  memberTitle === '' || memberTitle === member.sessionId
                                    ? null
                                    : h('span', { className: 'dsh-trash__memberTitle', title: memberTitle }, memberTitle),
                                  h('code', { className: 'dsh-trash__memberId' }, member.sessionId),
                                  h('span', { className: 'dsh-trash__memberSize' }, formatBytes(member.sizeBytes)),
                                )
                              }),
                            )
                          : null,
                      )
                    : null,
                  error !== null && error !== undefined && error !== ''
                    ? h(
                        'div',
                        { className: 'dsh-trash__rowError', role: 'status', title: errorTitle },
                        format(t('lastErrorLabel'), { message: error }),
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'dsh-trash__rowActions' },
                  entry.canRestore === true
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-trash__button',
                          'aria-label': format(t('actionRestoreFor'), { title }),
                          disabled: rowBusy || mutationBusy || corrupt || loading,
                          onClick: () => {
                            if (entry.requiresOrphanRestore === true) setDialog({ kind: 'orphan', entry })
                            else void performRestore(entry, 'normal')
                          },
                        },
                        t('actionRestore'),
                      )
                    : null,
                  h(ActionMenu, {
                    label: format(t('actionMoreFor'), { title }),
                    items: menuItemsFor(entry),
                    disabled: rowBusy || mutationBusy || corrupt || loading,
                  }),
                ),
              )
            }),
          )
        }

        const pagination =
          pageCount > 1
            ? h(
                'nav',
                { className: 'dsh-trash__pagination', 'aria-label': t('paginationLabel'), key: 'pagination' },
                h(
                  'span',
                  { className: 'dsh-trash__pageInfo' },
                  format(t('pageInfo'), { page: currentPage, total: pageCount }),
                ),
                h(
                  'div',
                  { className: 'dsh-trash__pageButtons' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-trash__button',
                      disabled: currentPage <= 1,
                      onClick: () => goToPage(currentPage - 1),
                    },
                    t('previousPage'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-trash__button',
                      disabled: currentPage >= pageCount,
                      onClick: () => goToPage(currentPage + 1),
                    },
                    t('nextPage'),
                  ),
                ),
              )
            : null

        const panel =
          data === null && view.status === 'error'
            ? null
            : h(
                'section',
                {
                  className: 'dsh-trash__panel',
                  key: 'panel',
                  ref: panelRef,
                  tabIndex: -1,
                  'aria-busy': readsBusy ? 'true' : 'false',
                },
                panelBody,
                pagination,
              )

        const footnote =
          data !== null && typeof data.trashRootDisplay === 'string'
            ? h('p', { className: 'dsh-trash__footnote', key: 'footnote' }, format(t('footnote'), { path: data.trashRootDisplay }))
            : null

        const dialogNode =
          dialog === null
            ? null
            : h(ConfirmDialog, {
                kind: dialog.kind,
                entry: dialog.entry,
                count: dialog.count,
                t,
                onCancel: closeDialog,
                fallbackRef: panelRef,
                onConfirm: () => {
                  const current = dialog
                  setDialog(null)
                  if (current.kind === 'orphan') void performRestore(current.entry, 'orphan')
                  else if (current.kind === 'purge') void performPurge(current.entry)
                  else if (current.kind === 'purgeAll') void performPurgeAll()
                  else if (current.kind === 'orphans') void performPurgeOrphans()
                  else void performForget(current.entry)
                },
              })

        return h(
          'div',
          { className: 'dsh-trash' },
          h('style', { key: 'styles' }, STYLES),
          header,
          banners,
          toolbar,
          storageLine,
          controls,
          batchBar,
          panel,
          footnote,
          h('div', { className: 'dsh-trash__srOnly', role: 'status', 'aria-live': 'polite' }, announcement),
          dialogNode,
        )
      }
    }

    return {
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-trash: locale')
        const t = ctx.locale.bind(NS)
        const TrashSection = createSection(ctx, t)

        /**
         * Move one session into the trash and offer the shared Toast's single
         * undo action.
         *
         * @param {string} sessionId session to trash.
         * @param {string} [fallbackTitle] row title shown before the Host answers.
         * @returns {Promise<void>} completion of the click handler.
         */
        async function runTrash(sessionId, fallbackTitle) {
          try {
            const { status, ok, payload } = await requestJson('trash', {
              method: 'POST',
              body: { sessionId },
            })
            if (!ok) {
              ctx.contextMenus.notify(describeActionFailure(status, payload, t), false)
              return
            }
            bumpRevision()
            const responseEntry = payload !== null && payload !== undefined ? payload.entry : undefined
            const responseTitle = responseEntry !== null && responseEntry !== undefined ? responseEntry.title : undefined
            const title =
              typeof responseTitle === 'string' && responseTitle !== ''
                ? responseTitle
                : typeof fallbackTitle === 'string' && fallbackTitle !== ''
                  ? fallbackTitle
                  : sessionId
            const subagentCount =
              responseEntry !== null && responseEntry !== undefined && typeof responseEntry.subagentCount === 'number'
                ? responseEntry.subagentCount
                : 0
            const message =
              subagentCount > 0
                ? countText(t, 'trashSuccessTree', subagentCount, { title })
                : format(t('trashSuccess'), { title })
            ctx.contextMenus.notify(message, true, {
              label: t('undo'),
              run: () => undoTrash(sessionId, title),
              failureLabel: t('undoFailed'),
            })
          } catch {
            ctx.contextMenus.notify(t('errorNetwork'), false)
          }
        }

        /**
         * Restore one session from the shared Toast. Normal restore is tried
         * first; a missing workspace silently retries once as an orphan restore,
         * so the Toast action never opens a dialog.
         *
         * @param {string} sessionId session to restore.
         * @param {string} [fallbackTitle] title captured when the Toast appeared.
         * @returns {Promise<void>} completion of the action.
         */
        async function undoTrash(sessionId, fallbackTitle) {
          try {
            let answer = await requestJson('restore', {
              method: 'POST',
              body: { sessionId, mode: 'normal' },
            })
            if (!answer.ok) {
              const code =
                answer.payload !== null && answer.payload !== undefined && answer.payload.error !== undefined
                  ? answer.payload.error.code
                  : undefined
              if (code === 'WORKSPACE_MISSING') {
                answer = await requestJson('restore', {
                  method: 'POST',
                  body: { sessionId, mode: 'orphan' },
                })
              }
            }
            if (!answer.ok) {
              ctx.contextMenus.notify(describeActionFailure(answer.status, answer.payload, t), false)
              return
            }
            bumpRevision()
            const session = answer.payload !== null && answer.payload !== undefined ? answer.payload.session : undefined
            const restoredTitle =
              session !== null && session !== undefined && typeof session.title === 'string' && session.title !== ''
                ? session.title
                : typeof fallbackTitle === 'string' && fallbackTitle !== ''
                  ? fallbackTitle
                  : sessionId
            const orphan = session !== null && session !== undefined && session.orphan === true
            ctx.contextMenus.notify(format(t(orphan ? 'restoreOrphanSuccess' : 'restoreSuccess'), { title: restoredTitle }), true)
          } catch {
            ctx.contextMenus.notify(t('errorNetwork'), false)
          }
        }

        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                { name: 'settings.section', id: SECTION_ID, order: 25, label: () => t('nav'), locale: NS },
                TrashSection,
              ),
            ),
          'session-trash: settings section',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('settings.section.icon', () =>
              ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID }, TrashGlyph),
            ),
          'session-trash: settings section icon',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('contextMenu.icon', () =>
              ctx.slots.register({ name: 'contextMenu.icon', key: MENU_ID }, TrashGlyph),
            ),
          'session-trash: menu icon',
        )

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: MENU_ID,
              target: 'session',
              order: 550,
              observe(target) {
                const sources = [ctx.locale]
                const remoteAccess = ctx.get('remoteAccess')
                if (
                  remoteAccess !== undefined &&
                  remoteAccess !== null &&
                  typeof remoteAccess.source === 'function' &&
                  target !== null &&
                  typeof target === 'object' &&
                  typeof target.sessionId === 'string'
                ) {
                  try {
                    const source = remoteAccess.source('session', target.sessionId, 'session/rename')
                    if (source !== null && source !== undefined && typeof source.subscribe === 'function') {
                      sources.push(source)
                    }
                  } catch {
                    // Permission sources are optional; resolution still re-checks.
                  }
                }
                return sources
              },
              async resolve(target, signal) {
                const sessionId = target !== null && typeof target === 'object' ? target.sessionId : undefined
                const displayTitle = target !== null && typeof target === 'object' ? target.displayTitle : undefined
                if (typeof sessionId !== 'string' || sessionId === '') return []
                const remoteAccess = ctx.get('remoteAccess')
                if (remoteAccess !== undefined && remoteAccess !== null && typeof remoteAccess.source === 'function') {
                  try {
                    const access = remoteAccess.source('session', sessionId, 'session/rename')
                    if (access !== null && access !== undefined && typeof access.getSnapshot === 'function' && access.getSnapshot() !== true) {
                      return []
                    }
                  } catch {
                    // Access sources are advisory here; the Host API still enforces owner-only access.
                  }
                }
                const verdict = await preflight(sessionId, signal)
                if (verdict === null) return []
                if (verdict.eligible !== true) {
                  const blocked = typeof verdict.code === 'string' ? MOVE_BLOCKED_KEYS[verdict.code] : undefined
                  if (blocked === undefined) return []
                  return [
                    {
                      id: 'move-refused',
                      label: t(blocked.label),
                      icon: { key: MENU_ID },
                      separatorBefore: true,
                      run: () => ctx.contextMenus.notify(t(blocked.toast), false),
                    },
                  ]
                }
                return [
                  {
                    id: 'move',
                    label: t('move'),
                    icon: { key: MENU_ID },
                    separatorBefore: true,
                    run: () => runTrash(sessionId, typeof displayTitle === 'string' ? displayTitle : ''),
                  },
                ]
              },
            }),
          'session-trash: move menu',
        )
      },
    }
  },
})
