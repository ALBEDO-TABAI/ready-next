/**
 * Extract filename from path (cross-platform)
 * Handles both forward slashes (/) and backslashes (\)
 */
export function getFilename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

/**
 * Extract file extension from path
 */
export function getFileExtension(path: string): string {
  const filename = getFilename(path)
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(lastDot + 1) : ''
}
