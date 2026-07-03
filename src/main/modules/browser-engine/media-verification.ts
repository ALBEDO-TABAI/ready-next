/**
 * P1-W5 (2026-07-03, web-access W5 closeout) — media download verification.
 *
 * "Found a URL" is not completion (web-access §2.5); neither is "the HTTP
 * request returned 200". Real verification here is deterministic and honest:
 * the saved file must exist on disk with non-zero bytes. ffprobe codec/duration
 * proof is intentionally NOT claimed — the tool description previously advertised
 * ffprobe that no code ran. When a probe runtime is wired later it can extend
 * this result; until then the method is `file_bytes`, never `ffprobe`.
 */
import { statSync } from 'node:fs'

export interface DownloadResultLike {
  success?: unknown
  path?: unknown
  url?: unknown
}

export interface MediaByteCheck {
  path: string
  bytes: number
  ok: boolean
}

export interface MediaVerificationResult {
  /** method is `file_bytes` — never `ffprobe` unless a probe actually ran. */
  method: 'file_bytes' | 'none'
  ok: boolean
  checked: number
  nonZero: number
  /** Paths that reported success but are missing or zero-byte on disk. */
  invalidPaths: string[]
  checks: MediaByteCheck[]
}

function fileBytes(path: string, statFn: (p: string) => { size: number }): number {
  try {
    return Math.max(0, Number(statFn(path).size) || 0)
  } catch {
    return -1 // missing / unreadable
  }
}

/**
 * Verify every result marked success has a real, non-empty file on disk.
 * `statFn` is injectable for tests; defaults to fs.statSync.
 */
export function verifyDownloadedMedia(
  results: ReadonlyArray<DownloadResultLike>,
  options: { statFn?: (path: string) => { size: number } } = {},
): MediaVerificationResult {
  const statFn = options.statFn ?? ((p: string) => statSync(p))
  const successWithPath = results.filter(
    (item) => item.success === true && typeof item.path === 'string' && String(item.path).trim(),
  )
  if (successWithPath.length === 0) {
    return { method: 'none', ok: false, checked: 0, nonZero: 0, invalidPaths: [], checks: [] }
  }
  const checks: MediaByteCheck[] = successWithPath.map((item) => {
    const path = String(item.path)
    const bytes = fileBytes(path, statFn)
    return { path, bytes, ok: bytes > 0 }
  })
  const invalidPaths = checks.filter((check) => !check.ok).map((check) => check.path)
  const nonZero = checks.filter((check) => check.ok).length
  return {
    method: 'file_bytes',
    // Completion requires EVERY claimed-success file to be present + non-empty.
    ok: invalidPaths.length === 0 && nonZero > 0,
    checked: checks.length,
    nonZero,
    invalidPaths,
    checks,
  }
}
