/** How a Codex thread binding came to hold its history (`codex_thread_bindings.thread_materialization_kind`). */
export type CodexThreadMaterializationKind = 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'

/**
 * `legacy` is the column default every binding received when Ready began recording materialization; bindings created
 * since then always name their kind. Those older conversations keep continuing on their threads, but they carry no
 * inherited contract digest, accepted-prefix coverage or recorded user-input origins, so every check that reads those
 * records treats them as starting from an unrecorded boundary.
 */
export function codexThreadPredatesMaterializationRecords(kind: CodexThreadMaterializationKind): boolean {
  return kind === 'legacy'
}

/** A thread that begins its own lineage: it has no history source binding to inherit from or to walk back to. */
export function codexThreadStartsLineage(kind: CodexThreadMaterializationKind): boolean {
  return kind === 'legacy' || kind === 'fresh_start'
}
