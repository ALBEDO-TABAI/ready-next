/**
 * Stage U PR U1.5 — single source for `read_skill` visibility normalization.
 *
 * CLAUDE.md §3 mandates: "reference/advisory skill 以内联 SKILL.md 为主,
 * read_skill 归一为 internal". Prior to U1.5 the rule lived in two
 * `normalizeReferenceReadSkillVisibility` functions
 * (`custom-skill-registry.ts` + `skill-compiler.ts`) plus a hand-rolled
 * inline branch in `custom-skill-registry.ts:432-438`. Three copies will
 * drift; this helper is the only place that may decide the visibility of
 * the auto-generated `read_skill` action, and `check-read-skill-visibility-
 * single-source.cjs` enforces that no other file in
 * `src/main/modules/skills-runtime/` co-locates the `read_skill` literal
 * with `visibility: 'internal'`.
 *
 * skillKind taxonomy:
 *   - 'runtime'   → executable skills (python/node/shell). `read_skill` is
 *                   a real callable for the LLM; the manifest-declared
 *                   visibility is honored verbatim.
 *   - 'reference' → SKILL.md-only skills. The orchestrator inlines the
 *                   document via `tryInlineReferenceSkillDoc`; the
 *                   `read_skill` tool only exists for the legacy tool-call
 *                   fallback and must NOT be exposed to the model.
 *   - 'advisory'  → executionMode === 'advisory'. Same inlining contract
 *                   as 'reference'; the read_skill tool must stay hidden.
 */

import type { SkillActionVisibility } from '../../../shared/skill-execution-types'

export type ReadSkillVisibilityKind = 'runtime' | 'reference' | 'advisory'

export function normalizeReadSkillVisibility(
  skillKind: ReadSkillVisibilityKind,
  currentVisibility: SkillActionVisibility | undefined,
): SkillActionVisibility {
  if (skillKind === 'reference' || skillKind === 'advisory') return 'internal'
  return currentVisibility === 'internal' ? 'internal' : 'public'
}
