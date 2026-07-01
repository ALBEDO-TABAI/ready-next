/**
 * Build the user-facing notice shown after an internal file-tree move. A move can be
 * refused because the destination already holds a same-named file (collision) or because
 * the OS-level move failed for another reason. Either way the move must never fail
 * silently — this returns the message to surface, or null when everything moved.
 *
 * Collisions take priority in the message since they are the actionable, common case.
 */
export function buildMoveBlockedNotice(input: {
  dirName: string
  collided: readonly string[]
  failed: readonly string[]
}): string | null {
  const { dirName, collided, failed } = input
  if (collided.length === 1) return `「${dirName}」中已存在同名文件「${collided[0]}」，未移动`
  if (collided.length > 1) return `「${dirName}」中已存在 ${collided.length} 个同名文件，未移动`
  if (failed.length === 1) return `移动「${failed[0]}」失败`
  if (failed.length > 1) return `移动 ${failed.length} 个文件失败`
  return null
}
