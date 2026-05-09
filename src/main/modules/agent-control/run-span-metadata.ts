/**
 * Per-run span metadata keys (frozen).
 *
 * Stage R W5.1 — observability foundation. These keys describe a single
 * agent turn / run and are consumed by per-run span emitters and (later)
 * by token-attribution accounting in Stage S.
 *
 * Keys are deliberately decoupled from §6.11 TOOL_ERROR_METRICS: that
 * registry is for tool-error metric *names*; this is a per-run metadata
 * key set used as span fields. Adding a key here MUST update the constant
 * and pass `check-run-span-metadata-keys-frozen.cjs`.
 */
export const RUN_SPAN_METADATA_KEYS = [
  'agent_id',
  'model',
  'capability_class',
  'parent_run_id',
  'task_type',
  'session_id',
] as const

export type RunSpanMetadataKey = typeof RUN_SPAN_METADATA_KEYS[number]

export type RunSpanMetadata = Partial<Record<RunSpanMetadataKey, string | null>>

export function buildRunSpanMetadata(input: Partial<RunSpanMetadata>): RunSpanMetadata {
  const out: RunSpanMetadata = {}
  for (const key of RUN_SPAN_METADATA_KEYS) {
    if (input[key] !== undefined) {
      out[key] = input[key]
    }
  }
  return out
}
