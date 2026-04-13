import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Get cross-platform log file path in system temp directory
 */
export function getLogPath(filename: string): string {
  return join(tmpdir(), filename)
}

/**
 * Get platform-appropriate 'which' command
 * - macOS/Linux: 'which'
 * - Windows: 'where'
 */
export function getWhichCommand(): string {
  return process.platform === 'win32' ? 'where' : 'which'
}
