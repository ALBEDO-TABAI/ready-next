import { createHash } from 'node:crypto'

/**
 * Stage R W2.1 — stable tool-call args normalization + hashing.
 *
 * Used by the turn-engine repetition-detection ring buffer to give a
 * deterministic argsHash regardless of how the model JSON-serialized
 * tool arguments. Object keys are sorted recursively; arrays preserve
 * order; primitives pass through unchanged.
 */
export function normalizeToolCallArgs(args: unknown): unknown {
  if (args === null || typeof args !== 'object') return args
  if (Array.isArray(args)) return args.map(normalizeToolCallArgs)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(args as Record<string, unknown>).sort()) {
    sorted[key] = normalizeToolCallArgs((args as Record<string, unknown>)[key])
  }
  return sorted
}

/**
 * Returns a stable `<toolName>:<canonicalJSON>` key. Useful for
 * dedup / ring-buffer-equality checks where two callsites with the
 * same logical args but different key order must compare equal.
 */
export function stableToolKey(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(normalizeToolCallArgs(args))}`
}

/**
 * Returns a 16-hex-char sha256 digest summarising a sequence of
 * tool calls. Order-sensitive — identical calls in a different order
 * produce a different digest.
 */
export function hashToolCalls(calls: Array<{ name: string; args: unknown }>): string {
  const serialized = calls.map((c) => stableToolKey(c.name, c.args)).join('|')
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16)
}

/**
 * Convenience: hash a single tool call's normalised args. Replaces
 * ad-hoc `createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 16)`
 * call sites where two semantically-identical objects with different
 * key orders previously produced different hashes.
 */
export function hashToolCallArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeToolCallArgs(args ?? null))).digest('hex').slice(0, 16)
}
