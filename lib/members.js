/**
 * One trashed item may own several session directories: the visible parent and
 * every hidden `origin: 'subagent'` descendant. These helpers keep the v1
 * single-directory shape readable while the durable index uses the v2
 * `members` array.
 *
 * @module dsh-session-trash/members
 */

/**
 * @param {unknown} entry index entry (v1 or v2 shape).
 * @returns {object|null} the parent member, or null when the entry has no directory data.
 */
export function parentMember(entry) {
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return null
  return {
    sessionId: entry.sessionId,
    origin: null,
    title: typeof entry.title === 'string' ? entry.title : entry.sessionId,
    originalSessionDir: entry.originalSessionDir,
    originalLogPath: entry.originalLogPath,
    persistenceProjectDirHint: entry.persistenceProjectDirHint,
    formatStatus: entry.formatStatus,
    sizeBytes: entry.sizeBytes,
    fileCount: entry.fileCount,
  }
}

/**
 * @param {unknown} entry index entry (v1 or v2 shape).
 * @returns {object[]} every owned directory, parent first.
 */
export function memberList(entry) {
  if (entry !== null && typeof entry === 'object' && Array.isArray(entry.members) && entry.members.length > 0) {
    return entry.members
  }
  const parent = parentMember(entry)
  return parent === null ? [] : [parent]
}

/**
 * @param {readonly object[]} members member list.
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
  if (typeof member.sessionId !== 'string' || member.sessionId === '' || member.sessionId.length > 256) return false
  if (member.origin !== undefined && member.origin !== null && member.origin !== 'subagent') return false
  if (member.title !== undefined && typeof member.title !== 'string') return false
  if (member.formatStatus !== undefined && member.formatStatus !== 'current' && member.formatStatus !== 'migration-required') {
    return false
  }
  if (member.sizeBytes !== undefined && member.sizeBytes !== null && typeof member.sizeBytes !== 'number') return false
  if (member.fileCount !== undefined && member.fileCount !== null && typeof member.fileCount !== 'number') return false
  for (const key of ['originalSessionDir', 'originalLogPath', 'persistenceProjectDirHint']) {
    if (member[key] !== undefined && member[key] !== null && typeof member[key] !== 'string') return false
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
  if (!Array.isArray(entry.members) || entry.members.length === 0 || entry.members.length > 64) return false
  const seen = new Set()
  for (const member of entry.members) {
    if (!isValidMemberShape(member)) return false
    if (seen.has(member.sessionId)) return false
    seen.add(member.sessionId)
  }
  return entry.members[0].sessionId === entry.sessionId
}
