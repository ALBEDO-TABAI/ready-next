/**
 * Shared reference-skill SKILL.md reader (P2-2).
 *
 * The L2 inline cap and the doc-candidate order live here so BOTH the reference-skill
 * context injector (`skill-context-orchestrator.tryInlineReferenceSkillDoc`) and the
 * model-side `use_skill` activation tool read the methodology through one contract —
 * same candidates, same 12K cap, same truncation flag. Pure fs read, no metrics/IO
 * side effects (callers that need failure telemetry keep their own wrapper).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cap on inlined reference-skill text (Phase 2: 6K → 12K to fit real-world SKILL.md
 * methodology sections, e.g. video-copy-analyzer ~9KB). Larger docs are truncated;
 * split long rails into references/ readable via `skill_read_artifact`.
 */
export const REFERENCE_SKILL_INLINE_CAP_CHARS = 12_000

/** Candidate methodology files, highest priority first. */
export const REFERENCE_SKILL_DOC_CANDIDATES: ReadonlyArray<string> = ['SKILL.md', 'README.md', 'README.zh-CN.md']

/**
 * Read the first existing methodology doc under `managedPath`, capped at `cap` chars.
 * Returns `null` when the directory is missing or no candidate is readable (best-effort;
 * a permission error on one candidate falls through to the next, then to null).
 */
export function readReferenceSkillDocCapped(
  managedPath: string | undefined,
  cap: number = REFERENCE_SKILL_INLINE_CAP_CHARS,
): { text: string; basename: string; truncated: boolean } | null {
  if (!managedPath || !existsSync(managedPath)) return null
  for (const basename of REFERENCE_SKILL_DOC_CANDIDATES) {
    const absPath = join(managedPath, basename)
    if (!existsSync(absPath)) continue
    try {
      const raw = readFileSync(absPath, 'utf-8')
      const truncated = raw.length > cap
      return { text: truncated ? raw.slice(0, cap) : raw, basename, truncated }
    } catch {
      // best-effort: try the next candidate, then fall through to null.
      continue
    }
  }
  return null
}
