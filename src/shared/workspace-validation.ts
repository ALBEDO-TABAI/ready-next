/**
 * Workspace root validation — shared between main process and renderer.
 *
 * Background: bb529f1 introduced an FTS5 file index that, on first launch,
 * defaulted the workspace root to `os.homedir()`. On a populated home this
 * triggered indexing of hundreds of thousands of files. Per user decision Q2,
 * the default workspace is now empty: the user MUST explicitly pick a folder,
 * and that pick must NOT be a system / personal-data root that would re-trigger
 * the same broad scan.
 *
 * This module is intentionally pure (no Node fs / electron deps) so both layers
 * can import it. The optional `accessCheck` callback lets the main process plug
 * in an `fs.accessSync(path, R_OK)` probe; the renderer omits it.
 */

export type WorkspaceValidationReason =
  | 'empty'
  | 'not_absolute'
  | 'too_short'
  | 'forbidden_system_root'
  | 'forbidden_user_root'
  | 'forbidden_drive_root'
  | 'forbidden_personal_dir'
  | 'no_read_permission'

export interface WorkspaceValidationResult {
  ok: boolean
  reason?: WorkspaceValidationReason
  message?: string
}

export interface ValidateWorkspaceRootOptions {
  /** Optional read-permission probe; main process can supply fs.accessSync. */
  accessCheck?: (path: string) => boolean
  /**
   * Optional override for the user's home directory. The renderer cannot read
   * `os.homedir()` directly, so the main process can pass it through (e.g.
   * `/Users/alice`). Without it we still reject `/Users/<x>` patterns purely
   * structurally.
   */
  homeDir?: string
}

/**
 * Forbidden absolute roots — exact match (after normalization).
 * These are too broad and would cause the indexer to scan the user's entire
 * machine / user directory.
 */
const FORBIDDEN_EXACT_ROOTS: ReadonlyArray<string> = [
  '/',
  '/Users',
  '/Users/Shared',
  '/home',
  '/root',
  '/tmp',
  '/var',
  '/etc',
  '/usr',
  '/opt',
  '/private',
  '/System',
  '/Library',
  '/Applications',
  '/bin',
  '/sbin',
]

/**
 * Personal directory leaves that, when combined with a user home prefix
 * (e.g. `~/Library`, `~/Desktop`), should be rejected at the root level.
 * Sub-directories are allowed (`~/Library/Caches/myapp` is fine; `~/Library`
 * is not).
 */
const FORBIDDEN_HOME_LEAVES: ReadonlyArray<string> = [
  'Library',
  'Desktop',
  'Documents',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Public',
  '.Trash',
  '.cache',
  '.config',
  '.local',
  '.ssh',
]

/**
 * Strip trailing slashes (but keep root `/`) and collapse repeated slashes.
 * Does NOT resolve `..` — callers are expected to pass an already-canonical
 * absolute path from the OS file picker.
 */
function normalizePath(input: string): string {
  if (!input) return input
  // Collapse double-slashes
  let p = /^[A-Za-z]:[\\/]/.test(input) ? input.replace(/\\/g, '/') : input
  p = p.replace(/\/{2,}/g, '/')
  // Strip trailing slash unless this is the root '/'
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p
}

function isAbsolutePath(path: string): boolean {
  if (!path) return false
  // Unix absolute path
  if (path.startsWith('/')) return true
  // Windows: C:\ or C:/
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  return false
}

function pathSegmentCount(path: string): number {
  // After normalization, count non-empty segments.
  // '/Users/alice/Documents/X' -> ['', 'Users', 'alice', 'Documents', 'X'] -> 4
  return path.split(/[/\\]/).filter((seg) => seg.length > 0).length
}

function isWindowsDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(path)
}

function isVolumesRoot(path: string): boolean {
  // /Volumes itself, or a single child like /Volumes/MyDrive (a whole external drive)
  if (path === '/Volumes') return true
  return /^\/Volumes\/[^/]+$/.test(path)
}

/**
 * Validate a candidate workspace root.
 *
 * Pass criteria:
 *   - Absolute path
 *   - Not one of the forbidden system / user roots
 *   - Not a whole drive (`/Volumes/MyDrive`, `C:\`)
 *   - At least 4 path components (e.g. `/Users/alice/Documents/projects`)
 *     so that we never index a top-level personal dir like `~/Documents`
 *   - If `accessCheck` is supplied: must have read permission
 *
 * Reject reasons map to user-facing messages so callers can show them as-is.
 */
export function validateWorkspaceRoot(
  rawRoot: string | null | undefined,
  options: ValidateWorkspaceRootOptions = {},
): WorkspaceValidationResult {
  if (!rawRoot || typeof rawRoot !== 'string' || rawRoot.trim() === '') {
    return {
      ok: false,
      reason: 'empty',
      message: '请先选择一个工作区目录。',
    }
  }

  const trimmed = rawRoot.trim()

  // Reject literal `~` / `~/` (renderer shouldn't be sending un-expanded tildes,
  // but defend against it).
  if (trimmed === '~' || trimmed === '~/') {
    return {
      ok: false,
      reason: 'forbidden_user_root',
      message: '不能直接使用用户主目录作为工作区。请选择主目录下的某个具体子目录，例如 ~/Documents/MyProject。',
    }
  }

  if (!isAbsolutePath(trimmed)) {
    return {
      ok: false,
      reason: 'not_absolute',
      message: '工作区目录必须是绝对路径。',
    }
  }

  const path = normalizePath(trimmed)

  // Whole-drive rejection (Windows `C:\`)
  if (isWindowsDriveRoot(path)) {
    return {
      ok: false,
      reason: 'forbidden_drive_root',
      message: '不能选择整块硬盘作为工作区，请选择硬盘内的具体子目录。',
    }
  }

  // /Volumes/<single drive>
  if (isVolumesRoot(path)) {
    return {
      ok: false,
      reason: 'forbidden_drive_root',
      message: '不能选择整块挂载卷作为工作区，请选择卷内的具体子目录。',
    }
  }

  // Exact-match system roots
  if (FORBIDDEN_EXACT_ROOTS.includes(path)) {
    return {
      ok: false,
      reason: 'forbidden_system_root',
      message: `不能将 ${path} 设为工作区。这是系统目录，索引它会扫描大量无关文件。`,
    }
  }

  // /Users/<anyone> — block any single-child of /Users (and /home/<x>)
  if (/^\/Users\/[^/]+$/.test(path) || /^\/home\/[^/]+$/.test(path)) {
    return {
      ok: false,
      reason: 'forbidden_user_root',
      message: '不能直接选择用户主目录作为工作区。主目录通常包含数十万文件，索引将耗尽资源。请选择主目录下的某个具体项目子目录。',
    }
  }

  // ~/Library, ~/Desktop, ~/Documents (root level), … via supplied homeDir
  if (options.homeDir) {
    const homeDir = normalizePath(options.homeDir)
    const inWindowsHome = /^[A-Za-z]:\//.test(homeDir)
    const samePath = (a: string, b: string) => inWindowsHome ? a.toLowerCase() === b.toLowerCase() : a === b
    if (samePath(path, homeDir)) {
      return {
        ok: false,
        reason: 'forbidden_user_root',
        message: '不能直接选择用户主目录作为工作区。',
      }
    }
    for (const leaf of FORBIDDEN_HOME_LEAVES) {
      if (samePath(path, `${homeDir}/${leaf}`)) {
        return {
          ok: false,
          reason: 'forbidden_personal_dir',
          message: `不能直接选择 ~/${leaf} 作为工作区，里面通常包含大量无关文件。请选择其下的某个项目子目录。`,
        }
      }
    }
  } else {
    // Without a homeDir we can still catch the structural pattern
    // /Users/<anyone>/<top-level-personal-dir>
    const m = path.match(/^\/Users\/[^/]+\/([^/]+)$/)
    if (m && FORBIDDEN_HOME_LEAVES.includes(m[1])) {
      return {
        ok: false,
        reason: 'forbidden_personal_dir',
        message: `不能直接选择 ~/${m[1]} 作为工作区，里面通常包含大量无关文件。请选择其下的某个项目子目录。`,
      }
    }
  }

  // Component-count guard: < 4 segments means too broad (e.g. /a/b/c).
  // /Users/alice/Documents/projects -> 4 segs, allowed.
  // /Users/alice/Projects           -> 3 segs, rejected.
  // (Note: this catches /opt/foo, /var/bar etc. that aren't in FORBIDDEN_EXACT_ROOTS.)
  const segCount = pathSegmentCount(path)
  if (segCount < 4) {
    return {
      ok: false,
      reason: 'too_short',
      message: '工作区路径过短（少于 4 层目录），可能会包含过多无关文件。请选择一个更具体的项目目录。',
    }
  }

  // Read-permission probe (main process only)
  if (options.accessCheck) {
    try {
      if (!options.accessCheck(path)) {
        return {
          ok: false,
          reason: 'no_read_permission',
          message: '无法读取选择的目录，请检查权限或换一个目录。',
        }
      }
    } catch {
      return {
        ok: false,
        reason: 'no_read_permission',
        message: '无法读取选择的目录，请检查权限或换一个目录。',
      }
    }
  }

  return { ok: true }
}
