/**
 * Boot-time orphan reaper — pure core. No `electron` import so this module is
 * safely importable from tests run under `tsx --test`. The thin Electron
 * wrapper lives in `boot-reaper.ts`.
 *
 * Mirrors `scripts/cleanup-orphans.sh` (3 patterns):
 *   - ready_sidecar/main.py
 *   - <userData>/puppeteer-cache/chrome
 *   - rsshub-worker.mjs
 *
 * Safety rules:
 *   - Only kills processes whose parent is launchd (ppid === 1) — i.e. truly
 *     orphaned. If the parent is alive, another Ready instance may own the
 *     process; leave it alone.
 *   - Never kills self.
 *   - Windows: skipped (pgrep not available); TODO use taskkill /fi.
 */
import { execFileSync as nodeExecFileSync } from 'node:child_process'

export interface ReapedProcess { pid: number; pattern: string }

export interface ReapOrphansResult {
  reaped: ReapedProcess[]
  errors: string[]
  skipped?: 'unsupported_platform'
}

export interface ReapOptions {
  /** Override the puppeteer-cache directory used in the chrome pattern. */
  puppeteerCachePath: string
  /** Test seam for child_process.execFileSync. */
  execFileSync?: typeof nodeExecFileSync
  /** Test seam for the current pid. */
  currentPid?: number
  /** Test seam for the current platform. */
  platform?: NodeJS.Platform
  /** Test seam for kill. Returns void on success, throws on failure. */
  killProcess?: (pid: number, signal: NodeJS.Signals | number) => void
  /** Optional logger; defaults to console.log. */
  logger?: (msg: string) => void
}

export function reapOrphansCore(opts: ReapOptions): ReapOrphansResult {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') {
    // TODO: Windows equivalent via `taskkill /fi "IMAGENAME eq python.exe"` etc.
    return { reaped: [], errors: [], skipped: 'unsupported_platform' }
  }

  const exec = opts.execFileSync ?? nodeExecFileSync
  const myPid = opts.currentPid ?? process.pid
  const kill = opts.killProcess ?? ((pid, signal) => { process.kill(pid, signal) })
  const log = opts.logger ?? ((msg) => { console.log(msg) })

  const errors: string[] = []
  const reaped: ReapedProcess[] = []

  const patterns: Array<{ name: string; pattern: string }> = [
    { name: 'ready_sidecar', pattern: 'ready_sidecar/main.py' },
    { name: 'puppeteer_chrome', pattern: `${opts.puppeteerCachePath}/chrome` },
    { name: 'rsshub_worker', pattern: 'rsshub-worker.mjs' },
  ]

  for (const { name, pattern } of patterns) {
    let stdout: string
    try {
      stdout = exec('pgrep', ['-f', pattern], { encoding: 'utf-8' }) as string
    } catch (err) {
      // pgrep returns exit 1 when no matches; treat as no-op.
      const msg = err instanceof Error ? err.message : String(err)
      const status = (err as { status?: number } | null)?.status
      if (status === 1 || /exit code 1/i.test(msg) || /Command failed/i.test(msg)) {
        continue
      }
      errors.push(`pgrep ${pattern}: ${msg}`)
      continue
    }

    const pids = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n))

    for (const pid of pids) {
      if (pid === myPid) continue

      let ppid: number
      try {
        const ppidOut = exec('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8' }) as string
        ppid = Number(ppidOut.trim())
      } catch {
        // ps failed (process already died); skip.
        continue
      }

      if (!Number.isFinite(ppid)) continue
      if (ppid !== 1) {
        // Parent still alive → another Ready instance owns it. Don't touch.
        continue
      }

      try {
        kill(pid, 'SIGKILL')
        reaped.push({ pid, pattern: name })
        log(`[boot-reaper] killed orphan ${name} pid=${pid} ppid=${ppid}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`kill ${pid} (${name}): ${msg}`)
      }
    }
  }

  return { reaped, errors }
}
