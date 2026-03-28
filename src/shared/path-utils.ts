/**
 * Normalize file path for URL construction
 * Converts Windows backslashes to forward slashes
 */
export function normalizePathForUrl(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

/**
 * Extract basename from path (cross-platform)
 */
export function pathBasename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

/**
 * Extract file extension from path
 */
export function pathExtension(path: string): string {
  const basename = pathBasename(path)
  const lastDot = basename.lastIndexOf('.')
  return lastDot > 0 ? basename.slice(lastDot + 1) : ''
}
