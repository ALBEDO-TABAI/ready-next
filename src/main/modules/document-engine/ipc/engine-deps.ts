// Stage V V2.3a — document-engine engine deps composition root.
//
// `EngineDeps` is the SUPERSET of everything any extracted document-engine
// IPC channel group might need. Each group declares its OWN per-group deps
// interface that is a SUBSET of `EngineDeps` (or, more precisely, of the
// fields the group's handlers actually touch).
//
// Why not pass `EngineDeps` straight into every group?
//   1. Tests for a group should stub only what the group needs — passing
//      the whole engine drags in the marks repository + dialog helpers +
//      parser bindings for handlers that just call one repo method.
//   2. Group-local deps act as a contract: reading a group file shows you
//      the exact handler surface area without scanning the host's wiring.
//   3. Future moves (e.g. lifting a group out of document-engine entirely)
//      are mechanical — copy the group + its deps interface; no implicit
//      coupling via god-deps.
//
// As groups are extracted in V2.3b … V2.3n this file grows. V2.3a populates
// only the MarkGroup-relevant fields (mock flag + marks repository
// factory). Later sub-stages will append file-I/O hook, binary detector,
// dialog window resolver, parser handles, workspace schema constants, etc.
import type { DocumentMarksRepository } from '../document-marks-repository'

/**
 * Composition root. V2.3a populates only the MarkGroup-relevant fields;
 * later V2.3 sub-stages extend this interface as their groups need new
 * deps.
 *
 * Optional fields are FORBIDDEN here — if a future group can run without a
 * dep, that dep belongs in the group's per-group deps interface (also
 * optional there), NOT here.
 */
export interface EngineDeps {
  /** Whether the engine is running in mock mode (no SQLite, no dialogs). */
  readonly useMock: boolean
  /**
   * Construct a fresh `DocumentMarksRepository` bound to the current SQLite
   * connection. The host owns the actual `getDatabase().getRawDb()` lookup
   * + `new DocumentMarksRepository(rawDb)` so the group never imports the
   * database module directly; throwing `database_unavailable` here surfaces
   * the same error the inline handler used.
   */
  getDocumentMarksRepository(): DocumentMarksRepository
}
