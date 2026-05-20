/**
 * Stage U PR U4.1b — wire contract for task-projection IPC payloads.
 *
 * Canonical home for renderer-facing task-projection types. Renderer
 * consumes these via:
 *   - `electronAPI.agent.listTaskProjections(scopeId)` returning an
 *     array of records (Stage U U4.3 will derive the renderer type from
 *     this module instead of the hand-written copy in electron.d.ts)
 *   - `agent:taskProjectionsChanged` push event payload, defined here
 *     and consumed by both preload (forward) and renderer
 *     (`useAgent.ts` refresh trigger)
 *
 * Why "wire" matters: main is allowed to use richer internal types
 * (TaskProjectionRecord-internal with stricter sub-type unions), but
 * the serialized form crossing the preload boundary must match this
 * module's shape exactly. Hand-duplicating the shape in
 * electron.d.ts (today) and in main (run-contracts.ts) lets the two
 * drift; U4.1b–U4.3 retire that hazard one type at a time.
 *
 * Migration sequence:
 *   - U4.1b (this PR) — TaskProjectionChangeEvent only (zero sub-type
 *     dependencies, single ipc-handler import, smallest blast radius)
 *   - U4.1c — TaskProjectionRecord + minimum sub-types (TaskStep,
 *     TaskBudget, …) inline-defined as wire-stable string unions
 *   - U4.3 — renderer types switch from hand-written `*Data` aliases
 *     to direct imports from this module
 */

/**
 * Reason channel for the `agent:taskProjectionsChanged` push event.
 * Renderer only needs to know "something changed"; reason is kept for
 * observability and future fine-grained patch optimization.
 */
export type TaskProjectionChangeReason = 'create' | 'update' | 'delete' | 'supersede'

/**
 * Payload of the `agent:taskProjectionsChanged` push event.
 *
 * Emitted by `TaskProjectionRepository` on every successful
 * create/update/delete, forwarded verbatim by claude-bridge ipc-handler.
 * Renderer uses `scopeId` to decide whether to refetch projections
 * (`changedTaskIds` and `reason` are observability fields).
 */
export interface TaskProjectionChangeEvent {
  scopeId: string
  changedTaskIds: string[]
  reason: TaskProjectionChangeReason
}
