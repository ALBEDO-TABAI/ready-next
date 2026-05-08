/**
 * Stage Q (Stage 11) — Skill resumability triple-fence helper.
 *
 * Single source of truth for "is this run resumable?"
 *
 * Two forms:
 *   - `canResumeShape(handle)`        — pure shape check, no fs probe
 *   - `canResumeWithFs(handle, fs?)`  — shape + fs.statSync().isFile/Directory
 *
 * Renderer MUST NOT import either function — UI consumes the
 * pre-computed `projection.canResume` field that main derives at
 * `runtime.listTaskProjections()` / `runtime.getTaskProjection()`.
 *
 * §6.24 / Stage Q contract C1+C2.
 */
import { statSync } from 'node:fs'

export interface ResumeHandle {
  childRunId?: string | null
  detachedTaskId?: string | null
  outputDir?: string | null
  runStatePath?: string | null
}

export interface FsExistenceProbe {
  isFile(path: string): boolean
  isDirectory(path: string): boolean
}

export const defaultFsExistenceProbe: FsExistenceProbe = {
  isFile(path: string): boolean {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Pure shape check — no filesystem probe.
 *
 * A handle is "resume-shaped" iff at least one of:
 *   - `childRunId` is non-empty
 *   - `detachedTaskId` is non-empty
 *   - both `outputDir` AND `runStatePath` are non-empty strings
 *
 * `taskRunId`, `skillId`, `taskId` alone DO NOT qualify — they are
 * historical anchors, not resume entry points (see Stage Q audit §1.1
 * Lifecycle handle definition was too wide).
 */
export function canResumeShape(handle: ResumeHandle | null | undefined): boolean {
  if (!handle) return false
  if (nonEmpty(handle.childRunId)) return true
  if (nonEmpty(handle.detachedTaskId)) return true
  return nonEmpty(handle.outputDir) && nonEmpty(handle.runStatePath)
}

/**
 * Shape + filesystem probe.
 *
 * On top of `canResumeShape`, when only the path-pair branch matched
 * (no childRunId / detachedTaskId), we additionally require:
 *   - `outputDir` resolves to an actual directory
 *   - `runStatePath` resolves to an actual file
 *
 * `existsSync` is intentionally NOT used: a stray file at the outputDir
 * path or a directory at the runStatePath path must not pass.
 */
export function canResumeWithFs(
  handle: ResumeHandle | null | undefined,
  fs: FsExistenceProbe = defaultFsExistenceProbe,
): boolean {
  if (!canResumeShape(handle)) return false
  if (nonEmpty(handle!.childRunId) || nonEmpty(handle!.detachedTaskId)) return true
  return fs.isDirectory(handle!.outputDir!) && fs.isFile(handle!.runStatePath!)
}
