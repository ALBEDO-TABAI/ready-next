import { tmpdir } from 'os'
import { join } from 'path'

const TEST_LOG_DIRNAME = 'ready-test-logs'

/**
 * Get cross-platform log file path in system temp directory
 */
export function getLogPath(filename: string): string {
  const root = usesTestLogDirectory() ? join(tmpdir(), TEST_LOG_DIRNAME) : tmpdir()
  return join(root, filename)
}

function usesTestLogDirectory(): boolean {
  return process.env.VITEST === 'true'
    || process.env.NODE_ENV === 'test'
    || process.env.READY_TEST_LOG_ISOLATION === '1'
    || process.env.NODE_TEST_CONTEXT === 'child-v8'
}

/**
 * Get platform-appropriate 'which' command
 * - macOS/Linux: 'which'
 * - Windows: 'where'
 */
export function getWhichCommand(): string {
  return process.platform === 'win32' ? 'where' : 'which'
}
