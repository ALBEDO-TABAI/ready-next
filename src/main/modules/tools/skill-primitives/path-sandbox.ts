/**
 * Path sandboxing for the Phase 1 skill primitives.
 *
 * Enforces that `skill_write_artifact` / `skill_read_artifact` can only touch
 * files inside a specific per-skill subtree. Two distinct roots are modelled:
 *
 *   artifactRoot  = <outputsRoot>/<skillId>/       — writable, read-visible
 *   assetRoot     = <managedPath>                  — READ-ONLY for primitives
 *
 * Write primitives always resolve against `artifactRoot`. The `assetRoot`
 * exists so tests / read primitives can surface skill-bundled assets
 * (SKILL.md, README, templates/) without duplicating files into the output
 * dir. Phase 1 only exposes write-to-artifactRoot; asset access is
 * deliberately NOT added — if the model needs to peek at an asset it can use
 * `skill_run_shell` with `cat`. This keeps the write surface as small as
 * possible.
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

import { resolve, sep, isAbsolute, basename } from 'node:path'
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
      | 'absolute_path'
      | 'path_escape'
      | 'symlink_escape'
      | 'reserved_path',
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
