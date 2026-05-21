// Stage V V2.2a — rss-engine engine deps composition root.
//
// `EngineDeps` is the SUPERSET of everything any extracted rss-engine IPC
// channel group might need. Each group declares its OWN per-group deps
// interface that is a SUBSET of `EngineDeps` (or, more precisely, of the
// fields the group's handlers actually touch).
//
// Why not pass `EngineDeps` straight into every group?
//   1. Tests for a group should stub only what the group needs — passing
//      the whole engine drags in the repository + diagnostics + rsshub
//      manager for handlers that just call one repo method.
//   2. Group-local deps act as a contract: reading a group file shows you
//      the exact handler surface area without scanning the host's wiring.
//   3. Future moves (e.g. lifting a group out of rss-engine entirely) are
//      mechanical — copy the group + its deps interface; no implicit
//      coupling via god-deps.
//
// As groups are extracted in V2.2b … V2.2n this file grows. V2.2a added
// the SourceGroup surface (repository + mock flag + the `addSource`
// initial-fetch core). V2.2b adds the ItemGroup surface (item mapper +
// mock-item fixture for `rss:getItems` mock-mode dispatch).
import type { RSSRepository } from '../../repositories/rss-repository'

/**
 * Shape returned by `addSourceCore` so the IPC handler can forward either
 * a populated success response or a normalised error response without
 * importing the host's `createSuccessResponse` / `createErrorResponse`
 * helpers (those are still owned by `ipc-handler.ts` and applied around
 * the core result).
 */
export type AddSourceCoreResult =
  | {
      ok: true
      data: {
        id: string
        platform: string
        name: string
        itemCount: number
        warning?: string
      }
    }
  | { ok: false; error: string }

/** Input payload for `addSourceCore`, mirrored from the IPC channel. */
export interface AddSourceCoreInput {
  name?: string
  url: string
  group?: string
}

/**
 * Composition root. V2.2a populates only the SourceGroup-relevant fields;
 * later V2.2 sub-stages extend this interface as their groups need new
 * deps.
 *
 * Optional fields are FORBIDDEN here — if a future group can run without a
 * dep, that dep belongs in the group's per-group deps interface (also
 * optional there), NOT here.
 */
export interface EngineDeps {
  /** Whether the engine is running in mock mode (no SQLite, no scrapers). */
  readonly useMock: boolean
  /** SQLite-backed RSS repository. */
  getRSSRepository(): RSSRepository
  /** Map a DB source row → renderer-facing API shape. */
  mapSourceToAPI(source: unknown): unknown
  /** Map a draft-store source summary → renderer-facing API shape. */
  mapDraftStoreSourceToAPI(source: unknown): unknown
  /**
   * Execute the full `addSource` initial-fetch pipeline (platform detect →
   * rsshub warmup → scrape → DB persist → route-diagnostics record). The
   * host owns the implementation so the group never imports the scraper /
   * rsshub-manager / browser-controller chain directly.
   */
  addSourceCore(input: AddSourceCoreInput): Promise<AddSourceCoreResult>
  /** Mock-mode payload returned by `rss:getSources` when `useMock` is true. */
  readonly mockSources: ReadonlyArray<unknown>
  /**
   * Map a DB item row → renderer-facing API shape. Used by `rss:getItems`.
   * Lifted into deps so ItemGroup never imports the host's DB row types or
   * the host's `mapDBItemToAPI` helper directly.
   */
  mapItemToAPI(item: unknown): unknown
  /**
   * Mock-mode payload returned by `rss:getItems` when `useMock` is true.
   * Each entry MUST expose a `sourceId` so the handler can filter by source
   * the same way the real repository query would.
   */
  readonly mockItems: ReadonlyArray<{ sourceId: string; [key: string]: unknown }>
}
