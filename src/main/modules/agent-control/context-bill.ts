import { logAgentMetric } from './metrics'

/**
 * Context bill (EP1-X4) — per-turn accounting of how many bytes each prompt
 * section contributes to the assembled context. Records byte counts and
 * truncation facts ONLY; never the content itself (privacy). Used to make
 * injection size measurable so later phases (task index, knowledge index)
 * can prove they reduced contamination rather than asserting it.
 */

export interface ContextBillSectionInput {
  /** Stable section key, e.g. 'L0', 'L1_summary', 'L2_triggers'. */
  section: string
  /** The exact content string injected for this section. */
  text: string
}

export interface ContextBillPayload {
  scopeId: string
  /** Byte spend per section key (UTF-8). Empty sections omitted. */
  sections: Record<string, number>
  /** Sum of all section bytes. */
  total: number
  /** Section keys whose injected text was truncated this turn. */
  truncations: string[]
}

/** Marker appended by prompt-assembly `clip()` when a section overflows budget. */
const TRUNCATION_MARKER = '...[truncated]'

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Pure accounting. Sums UTF-8 byte length per section (same-key sections
 * accumulate), totals them, and flags any section whose injected text carries
 * the budget truncation marker. Empty/whitespace-free-empty sections are
 * skipped so the bill reflects only what was actually injected.
 */
export function buildContextBill(
  scopeId: string,
  sections: ReadonlyArray<ContextBillSectionInput>,
): ContextBillPayload {
  const sectionBytes: Record<string, number> = {}
  const truncations: string[] = []
  let total = 0
  for (const { section, text } of sections) {
    if (!text) continue
    const bytes = utf8Bytes(text)
    sectionBytes[section] = (sectionBytes[section] ?? 0) + bytes
    total += bytes
    if (text.includes(TRUNCATION_MARKER)) {
      truncations.push(section)
    }
  }
  return { scopeId, sections: sectionBytes, total, truncations }
}

/** Emit the bill through the shared metrics sink (one `context_bill` row). */
export function emitContextBill(payload: ContextBillPayload): void {
  logAgentMetric('context_bill', {
    scopeId: payload.scopeId,
    sections: payload.sections,
    total: payload.total,
    truncations: payload.truncations,
  })
}
