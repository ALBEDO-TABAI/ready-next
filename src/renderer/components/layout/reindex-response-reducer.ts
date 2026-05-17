/**
 * Pure reducer for the per-root reindex response shape returned by the
 * `document:reindexWorkspace` / `document:reindexAllSources` IPCs.
 *
 * Why this exists as its own module: the renderer's runReindex flow has to
 * tell apart FOUR failure shapes that can all be wrapped in `success: true`:
 *
 *   1. IPC transport error  → `response.success === false`
 *   2. No data returned     → `response.data === undefined`
 *   3. Top-level engine failure → `response.data.ok === false` (FS pass
 *      failed or aborted, so nothing trustable got committed)
 *   4. Defensive: FS pass failed but envelope still reports `ok: true` —
 *      `perSource[FS_SOURCE_TYPE].error` is populated. This is malformed
 *      (the engine should have set `ok: false`) but we MUST still catch it
 *      so a future engine bug or stale fixture cannot trick the panel into
 *      persisting a "successful" IndexStatus on a root whose file tree never
 *      actually indexed. Per-source errors on the SHARED adapters
 *      (bookmark / RSS / calendar / agent) are a separate kind and stay a
 *      non-blocking warning — they do not invalidate the FS index.
 *
 * Exported separately so unit tests can pin every branch without standing
 * up a React tree.
 */
import { FS_SOURCE_TYPE } from '../../../shared/search-source-types'

export interface ReindexRootOutcome {
  /** Sum of `indexed + skipped` across this root's reindex pass. */
  docCount: number
  /**
   * Did the ROOT itself index cleanly? I.e. did the FS tree under this root
   * get a valid pass? True even when `error` is also populated — that case is
   * "FS succeeded but a shared adapter (RSS / bookmark / calendar / agent)
   * failed during all-sources", which leaves the root's file index intact and
   * trustworthy; the caller should still count this root as a success and
   * surface the adapter error as a non-blocking warning.
   *
   * False means the root contributed nothing trustable — the panel must not
   * persist a "successful" IndexStatus on its behalf.
   */
  rootIndexed: boolean
  /** Populated when ANY layer failed. `null` only if every layer was clean. */
  error: string | null
}

// We intentionally redeclare the response shapes here as structural types
// rather than importing the global electron.d.ts symbols, so this module can
// be unit-tested under node:test without dragging in the renderer ambient
// declarations.
interface AdapterReindexResult {
  indexed: number
  skipped: number
  removed?: number
  scanned?: number
  error?: string
}
interface ReindexAllSourcesData {
  ok: boolean
  perSource: Record<string, AdapterReindexResult | undefined>
  elapsedMs?: number
}
interface ReindexWorkspaceData {
  ok: boolean
  indexed?: number
  skipped?: number
  error?: string
}
interface ReindexResponseEnvelope<T> {
  success: boolean
  data?: T
  error?: string
}

export type ReindexResponseKind = 'all-sources' | 'fs-only'

export function reduceReindexResponse(
  root: string,
  response: ReindexResponseEnvelope<ReindexAllSourcesData | ReindexWorkspaceData> | undefined,
  kind: ReindexResponseKind,
): ReindexRootOutcome {
  if (!response?.success || !response.data) {
    return {
      docCount: 0,
      rootIndexed: false,
      error: response?.error || `索引失败: ${root}`,
    }
  }
  if (kind === 'all-sources') {
    const data = response.data as ReindexAllSourcesData
    if (!data.ok) {
      // Top-level ok=false means the FS pass failed; shared adapters are
      // skipped or aborted alongside it. No docs got committed for this root.
      return { docCount: 0, rootIndexed: false, error: `索引失败: ${root}` }
    }
    // Defensive root-failure check: even when the envelope says ok=true,
    // `perSource[FS_SOURCE_TYPE].error` may be populated by a future engine
    // bug or a stale response shape. The FS adapter's failure invalidates
    // the per-root index, so we treat it as a root failure regardless of
    // the top-level flag.
    const fsResult = data.perSource[FS_SOURCE_TYPE]
    if (fsResult?.error) {
      return {
        docCount: 0,
        rootIndexed: false,
        error: `索引失败 ${root}: ${fsResult.error}`,
      }
    }
    let docCount = 0
    const subErrors: string[] = []
    for (const [sourceType, result] of Object.entries(data.perSource)) {
      if (sourceType === FS_SOURCE_TYPE) {
        // The FS source's counts are still trustworthy (we just verified its
        // error field is empty above), so accumulate without warning text.
        docCount += (result?.indexed ?? 0) + (result?.skipped ?? 0)
        continue
      }
      if (result?.error) subErrors.push(`${root}/${sourceType}: ${result.error}`)
      docCount += (result?.indexed ?? 0) + (result?.skipped ?? 0)
    }
    // FS pass succeeded; we mark the root as indexed even if a shared
    // adapter (RSS / bookmark / calendar / agent) blew up — its failure does
    // not invalidate the per-root FS index.
    return {
      docCount,
      rootIndexed: true,
      error: subErrors.length > 0 ? subErrors.join('; ') : null,
    }
  }
  // fs-only path: only the FS adapter ran. There's no perSource map.
  const data = response.data as ReindexWorkspaceData
  if (!data.ok) {
    return {
      docCount: 0,
      rootIndexed: false,
      error: `索引失败 ${root}: ${data.error ?? '未知错误'}`,
    }
  }
  return {
    docCount: (data.indexed ?? 0) + (data.skipped ?? 0),
    rootIndexed: true,
    error: null,
  }
}
