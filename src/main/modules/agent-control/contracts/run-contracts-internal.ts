/**
 * Stage U PR U4.1 — main-internal contracts holding pen (skeleton).
 *
 * This module is the eventual home for every export currently in
 * `run-contracts.ts` that is NOT consumed across the preload boundary
 * (TurnEngineSession, TaskBudget, ToolSnapshot, SkillRunContract, …).
 *
 * U4.1a created this holding pen so subsequent contracts can move here without
 * widening the preload-visible `run-contracts.ts` surface. See the
 * classification table at
 * `docs/superpowers/plans/U4.1-run-contracts-export-classification.md`
 * for the planned destination of every run-contracts.ts export.
 *
 * Once U4.1d completes, the `check-wire-contract-isolation.cjs` gate
 * will fence `src/preload/` and `src/renderer/` from importing this
 * file.
 */

export type AbortInitiator =
  | 'user_stop'
  | 'preempted'
  | 'timeout'
  | 'host_unavailable'
  | 'budget'
  | 'error'
  | 'manual_suspend'
  | 'process_exit'
