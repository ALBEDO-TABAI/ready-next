/**
 * Stage S W8.1 — L2 layered compactor stub + hook interface.
 *
 * stub-only — not in production path. §6.15 explicitly defers L2
 * implementation; this lands the hook interface so future code (when
 * generation X observed L1 insufficient or user reports forgetting) can
 * wire without re-deriving.
 *
 * Production turn flow continues to use the L1 path inside
 * `layered-compactor.ts` (`createLayeredCompactor()`); the stub here is
 * NOT imported by `turn-engine.ts` and must not be wired into any
 * production-path module. CI gate
 * `scripts/check-l2-stub-not-in-production-path.cjs` enforces this.
 */

export interface SkillBundlePreservePreview {
  preserved: string[]
  truncated: string[]
}

export interface BeforeSummarizationHookContext {
  messages: Array<{ role: string; content: string }>
}

export type BeforeSummarizationHook = (
  ctx: BeforeSummarizationHookContext,
) => SkillBundlePreservePreview

export const noopBeforeSummarizationHook: BeforeSummarizationHook = (
  _ctx,
) => ({ preserved: [], truncated: [] })
