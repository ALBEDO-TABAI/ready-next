/**
 * Path sandboxing for the Phase 1 skill primitives.
 *
 * Enforces that `skill_write_artifact` / `skill_read_artifact` can only touch
 * files inside a specific per-skill subtree. Two distinct roots are modelled:
 *
 *   artifactRoot  = <outputsRoot>/<skillId>/       — writable, read-visible
 *   assetRoot     = <managedPath>                  — READ-ONLY for primitives
 *
 * Write primitives always resolve against `artifactRoot`. Read primitives may
 * also resolve against `assetRoot` so a skill can consult bundled assets
 * (SKILL.md, README, templates/) without copying them into the output dir.
 *
 * Path validation strategy:
 *   1. Reject `null` / empty / non-string relativePath early.
 *   2. Reject absolute paths and paths starting with `../` components.
 *   3. `path.resolve(root, rel)` — normalizes `..` inside.
 *   4. After resolve, require the resolved path to live under the root
 *      (startsWith(root + path.sep) OR equal root).
 *   5. If the resolved path exists AND is a symlink target, resolve the real
 *      path and recheck (`fs.realpathSync.native`) to block symlink escapes.
 *   6. Block writing to any of the reserved manifest-style filenames.
 *
 * This module is PURE (no electron / runtime-manager imports) so tests can
 * exercise it directly under `tsx --test`. Callers inject the resolved root
 * paths. Dependency injection happens in skill-primitives/root-resolver.ts.
 */

import { resolve, sep, isAbsolute, basename, relative } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * Reserved filenames that the write primitive refuses to overwrite. We compare
 * case-insensitively because macOS (APFS) and Windows (NTFS) are typically
 * case-insensitive — otherwise a model could create `skill.md` on macOS and
 * inadvertently shadow the real `SKILL.md` at read time. Linux is strictly
 * case-sensitive; on Linux the lowercase check is a defense-in-depth over-match
 * that still rejects `Skill.md`, which the model shouldn't be creating either.
 */
export const RESERVED_FILE_NAMES = new Set<string>([
  'SKILL.md',
  'ready-skill.json',
  'skill.workflow.json',
  'MANIFEST.json',
])

const RESERVED_FILE_NAMES_LOWER = new Set<string>(
  Array.from(RESERVED_FILE_NAMES).map((n) => n.toLowerCase()),
)

export class PathSandboxError extends Error {
  constructor(
    public readonly reason:
      | 'empty_path'
      | 'home_path'
      | 'absolute_path'
      | 'path_escape'
      | 'symlink_escape'
      | 'reserved_path'
      | 'no_root_match',
    message: string,
  ) {
    super(message)
    this.name = 'PathSandboxError'
  }
}

function assertNonEmpty(relativePath: unknown): string {
  if (typeof relativePath !== 'string') {
    throw new PathSandboxError('empty_path', 'relativePath must be a non-empty string')
  }
  const trimmed = relativePath.trim()
  if (trimmed.length === 0) {
    throw new PathSandboxError('empty_path', 'relativePath must be a non-empty string')
  }
  return trimmed
}

function assertNotHomePath(rel: string): void {
  if (rel === '~' || rel.startsWith('~/') || rel.startsWith('~\\')) {
    throw new PathSandboxError(
      'home_path',
      'relativePath must not use ~/; use a path relative to the skill artifact root',
    )
  }
}

function assertNotAbsolute(rel: string): void {
  if (isAbsolute(rel)) {
    throw new PathSandboxError('absolute_path', `relativePath must not be absolute: ${rel}`)
  }
  // Windows drive/UNC are also absolute — `path.isAbsolute` handles them on win32.
}

function normalizedStartsWithRoot(absPath: string, absRoot: string): boolean {
  const rootWithSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep
  return absPath === absRoot || absPath.startsWith(rootWithSep)
}

/**
 * Canonicalize a root path — if the root exists on disk, run it through
 * `realpath` so subsequent startsWith checks work even when the caller passed
 * a path containing symlinks (e.g. macOS `/tmp` → `/private/tmp`). When the
 * root doesn't exist yet, fall back to `path.resolve` — the caller will
 * mkdir -p before writing.
 */
function canonicalizeRoot(root: string): string {
  const absRoot = resolve(root)
  try {
    return realpathSync.native(absRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return absRoot
    throw error
  }
}

/**
 * Resolve `rel` under `root`, validating against escape attempts.
 * Does NOT create directories; does NOT touch the filesystem except for the
 * optional symlink realpath check when the target already exists.
 */
export function resolveWithinRoot(root: string, rel: string): string {
  const cleanRel = assertNonEmpty(rel)
  assertNotHomePath(cleanRel)
  assertNotAbsolute(cleanRel)

  const canonRoot = canonicalizeRoot(root)
  const absPath = resolve(canonRoot, cleanRel)

  if (!normalizedStartsWithRoot(absPath, canonRoot)) {
    throw new PathSandboxError(
      'path_escape',
      `Resolved path ${absPath} escapes sandbox root ${canonRoot}`,
    )
  }

  // Symlink escape check — only triggers if the resolved path ALREADY exists.
  // realpathSync throws ENOENT when the path is missing; that's fine for the
  // write case (we're about to create the file) because the parent-dir
  // realpath check below catches symlinked directories.
  try {
    const real = realpathSync.native(absPath)
    if (!normalizedStartsWithRoot(real, canonRoot)) {
      throw new PathSandboxError(
        'symlink_escape',
        `Real path ${real} escapes sandbox root ${canonRoot}`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      if (error instanceof PathSandboxError) throw error
      throw error
    }
    // Fall through — path doesn't exist yet, which is normal for writes.
    // Still inspect the deepest existing ancestor to catch symlinked parents
    // (common escape vector: attacker mkdirs a symlink dir inside the sandbox).
    const ancestor = findDeepestExistingAncestor(absPath)
    if (ancestor) {
      try {
        const realAncestor = realpathSync.native(ancestor)
        if (!normalizedStartsWithRoot(realAncestor, canonRoot)) {
          throw new PathSandboxError(
            'symlink_escape',
            `Ancestor directory ${ancestor} resolves outside sandbox root ${canonRoot}`,
          )
        }
      } catch (ancestorErr) {
        if (ancestorErr instanceof PathSandboxError) throw ancestorErr
        if ((ancestorErr as NodeJS.ErrnoException)?.code !== 'ENOENT') throw ancestorErr
        // Race — ancestor disappeared between stat and realpath. Safe to fall through.
      }
    }
  }

  return absPath
}

/**
 * Write helpers primarily receive relative paths, but the model can echo an
 * absolute path previously returned by a write/read result. Accept that path
 * only when it still points inside the writable artifact root, then pass it
 * through the same relative-path validator so reserved names and symlink checks
 * stay identical to `resolveWithinRoot`.
 */
export function resolveWritableWithinRoot(root: string, path: string): string {
  const cleanPath = assertNonEmpty(path)
  if (!isAbsolute(cleanPath)) return resolveWithinRoot(root, cleanPath)

  const canonRoot = canonicalizeRoot(root)
  const absPath = canonicalizeInputAbsPath(resolve(cleanPath))
  if (!normalizedStartsWithRoot(absPath, canonRoot)) {
    throw new PathSandboxError(
      'path_escape',
      `Absolute path ${absPath} is outside writable skill artifact root ${canonRoot}`,
    )
  }
  return resolveWithinRoot(canonRoot, relative(canonRoot, absPath))
}

/**
 * Canonicalize an absolute input path the same way `canonicalizeRoot` does
 * for a sandbox root. If the path itself exists, run realpath; otherwise
 * realpath the deepest existing ancestor and rejoin the missing tail. This
 * keeps symlinked OS tmp dirs (macOS `/var/folders → /private/var/folders`,
 * Linux per-user `/tmp/.X-lock` cases) from looking like sandbox escapes
 * when the model passes the user-visible path back through.
 */
function canonicalizeInputAbsPath(absPath: string): string {
  try {
    return realpathSync.native(absPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  const ancestor = findDeepestExistingAncestor(absPath)
  if (!ancestor) return absPath
  try {
    const realAncestor = realpathSync.native(ancestor)
    const tail = relative(ancestor, absPath)
    return tail ? resolve(realAncestor, tail) : realAncestor
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return absPath
    throw error
  }
}

/**
 * Read helpers can receive absolute paths from previous tool results
 * (notably skill_run_shell overflow logs). Accept them only when they still
 * point inside the same root, then reuse the normal relative-path validator.
 */
export function resolveReadableWithinRoot(root: string, path: string): string {
  const cleanPath = assertNonEmpty(path)
  if (!isAbsolute(cleanPath)) return resolveWithinRoot(root, cleanPath)

  const canonRoot = canonicalizeRoot(root)
  const absPath = canonicalizeInputAbsPath(resolve(cleanPath))
  if (!normalizedStartsWithRoot(absPath, canonRoot)) {
    throw new PathSandboxError(
      'path_escape',
      `Absolute path ${absPath} escapes sandbox root ${canonRoot}`,
    )
  }
  return resolveWithinRoot(canonRoot, relative(canonRoot, absPath))
}

/**
 * Stage 5 — read primitives may operate over multiple sandbox roots: the
 * primary per-skill artifact root plus additional read-only roots derived
 * from the active TurnFrame (active task `outputDir`, parent dir of
 * `runStatePath`, scene-scores dir, delivery-report dir). Iterate roots in
 * order and return the first successful match. If every root rejects with
 * `path_escape`, raise a single `no_root_match` error mentioning every root
 * that was tried — the caller surfaces the list back to the LLM/log so the
 * model knows which roots are currently active. Other reasons (`empty_path`,
 * `absolute_path`, `symlink_escape`, `reserved_path`) bubble up immediately
 * because they are not "wrong root" errors and re-trying against another
 * root would still fail in the same way.
 */
export function resolveReadableWithinAnyRoot(roots: string[], path: string): string {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new PathSandboxError(
      'no_root_match',
      'No sandbox roots configured for read access',
    )
  }
  const attemptedRoots: string[] = []
  let lastPathEscape: PathSandboxError | null = null
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue
    attemptedRoots.push(root)
    try {
      return resolveReadableWithinRoot(root, path)
    } catch (error) {
      if (error instanceof PathSandboxError && error.reason === 'path_escape') {
        // Try the next root.
        lastPathEscape = error
        continue
      }
      throw error
    }
  }
  // If exactly one root was tried, preserve the original `path_escape` error
  // so single-root callers see no behavior change. Multi-root callers (Stage
  // 5+ read-artifact dispatch) get a richer `no_root_match` error that lists
  // every root that was attempted.
  if (attemptedRoots.length <= 1 && lastPathEscape) {
    throw lastPathEscape
  }
  throw new PathSandboxError(
    'no_root_match',
    `Path ${typeof path === 'string' ? path : '(invalid)'} is not inside any of the allowed roots: ${attemptedRoots.join(', ') || '(none)'}`,
  )
}

function findDeepestExistingAncestor(absPath: string): string | null {
  let current = absPath
  // Walk up until `realpath` stops throwing ENOENT.
  // Cap at 64 iterations to avoid pathological inputs.
  for (let i = 0; i < 64; i += 1) {
    const parent = current.split(sep).slice(0, -1).join(sep) || sep
    if (parent === current) return null
    try {
      realpathSync.native(parent)
      return parent
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      current = parent
    }
  }
  return null
}

/**
 * Refuse to write to files that carry skill-manifest semantics, even if the
 * resolved path is legitimately within the sandbox. Applied to write
 * primitives only.
 */
export function assertNotReservedPath(absPath: string): void {
  const leaf = basename(absPath)
  if (RESERVED_FILE_NAMES_LOWER.has(leaf.toLowerCase())) {
    throw new PathSandboxError(
      'reserved_path',
      `Refusing to write reserved file ${leaf}`,
    )
  }
}
