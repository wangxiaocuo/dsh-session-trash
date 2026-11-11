/**
 * One trashed item may own several session directories: the visible parent and
 * every hidden `origin: 'subagent'` descendant. These helpers keep the v1
 * single-directory shape readable while the durable index uses the v2
 * `members` array.
 *
 * @module dsh-session-trash/members
 */

/**
 * @typedef {object} Member
 * @property {string} sessionId
 * @property {'subagent' | null} [origin]
 * @property {string} [title]
 * @property {string} [originalSessionDir]
 * @property {string} [originalLogPath]
 * @property {string} [persistenceProjectDirHint]
 * @property {string} [formatStatus]
 * @property {number | null} [sizeBytes]
 * @property {number | null} [fileCount]
 */

/**
 * @typedef {object} TrashEntry
 * @property {string} sessionId
 * @property {string} [trashId]
 * @property {string} [state]
 * @property {string} [title]
 * @property {number} [trashedAt]
 * @property {number} [startedAt]
 * @property {string | null} [originalCwd]
 * @property {boolean} [workspaceExistsAtDeletion]
 * @property {string} [originalSessionDir]
 * @property {string} [originalLogPath]
 * @property {string} [persistenceProjectDirHint]
 * @property {string} [formatStatus]
 * @property {number | null} [sizeBytes]
 * @property {number | null} [fileCount]
 * @property {string | null} [lastError]
 * @property {Member[]} [members]
 */

/**
 * @param {unknown} entry index entry (v1 or v2 shape).
 * @returns {Member | null} the parent member, or null when the entry has no directory data.
 */
export function parentMember(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const record = /** @type {Record<string, any>} */ (entry)
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return null
  return {
    sessionId: record.sessionId,
    origin: null,
    title: typeof record.title === 'string' ? record.title : record.sessionId,
    originalSessionDir: record.originalSessionDir,
    originalLogPath: record.originalLogPath,
    persistenceProjectDirHint: record.persistenceProjectDirHint,
    formatStatus: record.formatStatus,
    sizeBytes: record.sizeBytes,
    fileCount: record.fileCount,
  }
}

/**
 * @param {unknown} entry index entry (v1 or v2 shape).
 * @returns {Member[]} every owned directory, parent first.
 */
export function memberList(entry) {
  if (entry !== null && typeof entry === 'object') {
    const record = /** @type {Record<string, any>} */ (entry)
    if (Array.isArray(record.members) && record.members.length > 0) return record.members
  }
  const parent = parentMember(entry)
  return parent === null ? [] : [parent]
}

/**
 * @param {ReadonlyArray<Partial<Member> | null | undefined>} members member list.
 * @returns {{ sizeBytes: number, fileCount: number }} summed measurable totals.
 */
export function aggregateMetrics(members) {
  let sizeBytes = 0
  let fileCount = 0
  for (const member of members) {
    if (typeof member?.sizeBytes === 'number') sizeBytes += member.sizeBytes
    if (typeof member?.fileCount === 'number') fileCount += member.fileCount
  }
  return { sizeBytes, fileCount }
}

/**
 * Shape-level validation shared by the durable index and object sidecars.
 * Path strictness belongs to the sidecar validator.
 *
 * @param {unknown} member candidate member.
 * @returns {boolean} whether the member carries the required v2 identity.
 */
export function isValidMemberShape(member) {
  if (member === null || typeof member !== 'object' || Array.isArray(member)) return false
  const record = /** @type {Record<string, any>} */ (member)
  if (typeof record.sessionId !== 'string' || record.sessionId === '' || record.sessionId.length > 256) return false
  if (record.origin !== undefined && record.origin !== null && record.origin !== 'subagent') return false
  if (record.title !== undefined && typeof record.title !== 'string') return false
  if (
    record.formatStatus !== undefined &&
    record.formatStatus !== 'current' &&
    record.formatStatus !== 'migration-required'
  ) {
    return false
  }
  if (record.sizeBytes !== undefined && record.sizeBytes !== null && typeof record.sizeBytes !== 'number') return false
  if (record.fileCount !== undefined && record.fileCount !== null && typeof record.fileCount !== 'number') return false
  for (const key of ['originalSessionDir', 'originalLogPath', 'persistenceProjectDirHint']) {
    if (record[key] !== undefined && record[key] !== null && typeof record[key] !== 'string') return false
  }
  return true
}

/**
 * Whether the v2 member list is internally consistent with its parent entry.
 *
 * @param {unknown} entry index entry carrying `members`.
 * @returns {boolean} whether the list is acceptable.
 */
export function isValidMemberList(entry) {
  if (entry === null || typeof entry !== 'object') return false
  const record = /** @type {Record<string, any>} */ (entry)
  const members = record.members
  if (!Array.isArray(members) || members.length === 0 || members.length > 64) return false
  const seen = new Set()
  for (const member of members) {
    if (!isValidMemberShape(member)) return false
    if (seen.has(member.sessionId)) return false
    seen.add(member.sessionId)
  }
  return members[0].sessionId === record.sessionId
}
