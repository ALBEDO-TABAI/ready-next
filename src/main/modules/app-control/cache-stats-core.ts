/**
 * Cache statistics + cleanup — pure core. No `electron` import so this module
 * is safely importable from tests run under `tsx --test`. The Electron-coupled
 * IPC wrapper lives in `cache-stats-ipc.ts`.
 *
 * Real cache directories under `~/Library/Application Support/ready/`:
 *   - `Code Cache/`        — Chromium code cache (V8 compiled scripts)
 *   - `Cache/`             — Electron HTTP cache
 *   - `puppeteer-cache/`   — Puppeteer downloaded Chromium binary
 *   - `Shared Dictionary/` — Compression dictionaries (Brotli)
 *
 * Plus the ambient `~/.cache/puppeteer` (outside userData) — not covered
 * here because deleting it forces a full Chrome re-download.
 */
import {
  statSync as nodeStatSync,
  readdirSync as nodeReaddirSync,
  rmSync as nodeRmSync,
  existsSync as nodeExistsSync,
  type Dirent,
} from 'node:fs'
import { join } from 'node:path'

export interface CacheStats {
  codeCacheBytes: number
  cacheBytes: number
  puppeteerCacheBytes: number
  sharedCacheBytes: number
}

export interface CacheClearResult {
  clearedBytes: number
  errors: string[]
}

interface FsSeams {
  statSync: typeof nodeStatSync
  readdirSync: typeof nodeReaddirSync
  rmSync: typeof nodeRmSync
  existsSync: typeof nodeExistsSync
}

const DEFAULT_FS: FsSeams = {
  statSync: nodeStatSync,
  readdirSync: nodeReaddirSync,
  rmSync: nodeRmSync,
  existsSync: nodeExistsSync,
}

/** Subdirectory names (relative to userData). Case-sensitive on Linux/macOS APFS. */
export const CACHE_DIR_NAMES = {
  codeCache: 'Code Cache',
  cache: 'Cache',
  puppeteerCache: 'puppeteer-cache',
  sharedCache: 'Shared Dictionary',
} as const

/**
 * Walk a directory recursively and sum size of all regular files.
 * - Missing dirs return 0 (not an error — fresh installs).
 * - Per-file errors (perm denied, broken symlink) are silently skipped.
 * - Symlinks are NOT followed (use lstat-equivalent — `withFileTypes` returns
 *   the link itself, not the target, which is what we want).
 */
export function walkDirSize(rootPath: string, fs: Partial<FsSeams> = {}): number {
  const seams: FsSeams = { ...DEFAULT_FS, ...fs }
  if (!seams.existsSync(rootPath)) return 0

  let total = 0
  const stack: string[] = [rootPath]

  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = seams.readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          const st = seams.statSync(full)
          total += st.size
        } catch {
          // perm denied, broken link, etc. — skip.
        }
      }
      // Symlinks (entry.isSymbolicLink()) are skipped — we don't follow them.
    }
  }

  return total
}

/**
 * Aggregate cache sizes for the four known subdirectories under userData.
 * Pure function — give it `userDataPath` and it walks from there.
 */
export function getCacheStatsCore(
  userDataPath: string,
  fs: Partial<FsSeams> = {},
): CacheStats {
  return {
    codeCacheBytes: walkDirSize(join(userDataPath, CACHE_DIR_NAMES.codeCache), fs),
    cacheBytes: walkDirSize(join(userDataPath, CACHE_DIR_NAMES.cache), fs),
    puppeteerCacheBytes: walkDirSize(join(userDataPath, CACHE_DIR_NAMES.puppeteerCache), fs),
    sharedCacheBytes: walkDirSize(join(userDataPath, CACHE_DIR_NAMES.sharedCache), fs),
  }
}

export interface CacheClearOptions {
  /** Path to userData (where the cache subdirs live). */
  userDataPath: string
  /** When true, ALSO delete `puppeteer-cache/` (forces Chrome re-download). */
  includePuppeteer?: boolean
  /** Async hook for `session.defaultSession.clearCache()`; tests can stub. */
  clearChromiumCache?: () => Promise<void>
  /** Test seams. */
  fs?: Partial<FsSeams>
  /** Logger (defaults to console.log). */
  logger?: (msg: string) => void
}

/**
 * Clear cache directories and the Electron Chromium cache. Returns the
 * total bytes cleared (best-effort — measured BEFORE deletion) and a list
 * of per-directory error messages. Errors do not abort other directories.
 *
 * Always cleared:
 *   - `Code Cache/`
 *   - `Cache/`
 *   - `Shared Dictionary/`
 *   - Electron Chromium cache via `clearChromiumCache()`
 *
 * Conditionally cleared (`includePuppeteer === true`):
 *   - `puppeteer-cache/`  (warning: triggers Chrome re-download next run)
 */
export async function clearCacheCore(opts: CacheClearOptions): Promise<CacheClearResult> {
  const seams: FsSeams = { ...DEFAULT_FS, ...(opts.fs ?? {}) }
  const log = opts.logger ?? ((msg) => { console.log(msg) })

  const errors: string[] = []
  let clearedBytes = 0

  const targets: Array<{ name: string; relPath: string }> = [
    { name: 'codeCache', relPath: CACHE_DIR_NAMES.codeCache },
    { name: 'cache', relPath: CACHE_DIR_NAMES.cache },
    { name: 'sharedCache', relPath: CACHE_DIR_NAMES.sharedCache },
  ]
  if (opts.includePuppeteer) {
    targets.push({ name: 'puppeteerCache', relPath: CACHE_DIR_NAMES.puppeteerCache })
  }

  for (const { name, relPath } of targets) {
    const full = join(opts.userDataPath, relPath)
    if (!seams.existsSync(full)) {
      log(`[cache-clear] skip ${name} (not present)`)
      continue
    }
    let sizeBefore = 0
    try {
      sizeBefore = walkDirSize(full, seams)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`measure ${name}: ${msg}`)
    }
    try {
      seams.rmSync(full, { recursive: true, force: true })
      clearedBytes += sizeBefore
      log(`[cache-clear] removed ${name} (${sizeBefore} bytes)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`rm ${name}: ${msg}`)
    }
  }

  if (opts.clearChromiumCache) {
    try {
      await opts.clearChromiumCache()
      log('[cache-clear] cleared Chromium session cache')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`session.clearCache: ${msg}`)
    }
  }

  return { clearedBytes, errors }
}

// Quota — persistence-only contract (Phase 1).
// Chromium cache cannot be hard-bounded via Electron API; we persist the
// user's choice and surface it in the UI, but do not enforce eviction yet.
// TODO(D1-quota): wire eviction once we measure real growth patterns.
export type CacheQuotaOption = '256MB' | '1GB' | '5GB' | 'unlimited'

export const CACHE_QUOTA_BYTES: Record<CacheQuotaOption, number> = {
  '256MB': 256 * 1024 * 1024,
  '1GB': 1024 * 1024 * 1024,
  '5GB': 5 * 1024 * 1024 * 1024,
  unlimited: Number.POSITIVE_INFINITY,
}

export const DEFAULT_CACHE_QUOTA: CacheQuotaOption = '1GB'

export function isValidCacheQuotaOption(value: string): value is CacheQuotaOption {
  return value === '256MB' || value === '1GB' || value === '5GB' || value === 'unlimited'
}
