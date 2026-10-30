import { realpathSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'

export class ReadyNextDataIsolationError extends Error {
  readonly code = 'READY_NEXT_DAILY_DATA_FORBIDDEN'

  constructor(path: string) {
    super(`Ready Next cannot use daily Ready data: ${path}. Choose a separate READY_USER_DATA_DIR and READY_DB_PATH.`)
    this.name = 'ReadyNextDataIsolationError'
  }
}

// Resolve the nearest existing ancestor too: a new database below a directory
// symlink must not bypass isolation just because the database does not exist yet.
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(canonicalPath(parent), basename(absolute))
  }
}

// extraProtectedDirs can only add protection (real-Electron checks protect a
// throwaway folder); the daily Ready directory is always protected.
export function assertReadyNextDataIsolation(
  userData: string,
  databasePath: string,
  home: string,
  extraProtectedDirs: readonly string[] = [],
): void {
  const protectedDirs = [join(home, 'Library', 'Application Support', 'Ready'), ...extraProtectedDirs].map(canonicalPath)
  for (const path of [userData, databasePath]) {
    const target = canonicalPath(path)
    if (protectedDirs.some(dir => target === dir || target.startsWith(dir + sep))) {
      throw new ReadyNextDataIsolationError(path)
    }
  }
}
