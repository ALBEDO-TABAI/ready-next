/**
 * Stable identifier for the filesystem search-source adapter.
 *
 * This is the key under which `SearchEngine.reindexAllSources` writes the FS
 * pass's result into `perSource`. It's the SAME string as
 * `FileSystemAdapter.sourceType` (see `src/main/modules/search-engine/adapters.ts`)
 * and is shared because the renderer-side reducer
 * (`src/renderer/components/layout/reindex-response-reducer.ts`) also has to
 * inspect `perSource[FS_SOURCE_TYPE]?.error` defensively: even when the
 * envelope says `ok:true`, a failed FS pass leaves the error here and must
 * be surfaced as a root-level failure rather than a per-source warning.
 *
 * Living here lets both sides import the same constant so a future rename
 * trips type errors instead of silently breaking the reducer's branch.
 */
export const FS_SOURCE_TYPE = 'document'
