// Stage V V2.3a/V2.3b/V2.3d — document-engine engine deps composition root.
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
// As groups are extracted in V2.3b … V2.3n this file grows. V2.3a populated
// the MarkGroup surface (mock flag + marks repository factory). V2.3b adds
// the FileIoGroup surface (document write-index hook getter + editable text
// writer + dialog/shell facades + workspace validation context). V2.3d adds
// the WorkspaceGroup surface (save/open dialog facades narrowed to the
// workspace-file payload + a home-directory probe for the default-path
// hint). V2.3e adds the ParserGroup surface (lazy mammoth/xlsx module
// getters + the epub-to-markdown importer; the write-index hook is shared
// with FileIoGroup since the ebook importer fans `index.md` back into the
// same search-engine pipeline as `document:write`).
import type { BrowserWindow, WebContents } from 'electron'
import type { DocumentMarksRepository } from '../document-marks-repository'
import type { DocumentWriteIndexHook } from '../ipc-handler'
import type { WorkspaceValidationResult } from '../../../../shared/workspace-validation'

/**
 * Shape of an open-folder dialog result the FileIoGroup consumes. Mirror of
 * Electron's `OpenDialogReturnValue` narrowed to the two fields the handler
 * reads (`canceled` + `filePaths`).
 */
export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

/**
 * Shape of an open-folder dialog options object the FileIoGroup passes
 * through. Mirror of Electron's `OpenDialogOptions` narrowed to the two
 * fields the host wires (`properties`, `title`). `properties` is a mutable
 * array so the value passes through to Electron's `dialog.showOpenDialog`
 * without a structural copy.
 */
export interface OpenFolderDialogOptions {
  properties: Array<'openDirectory'>
  title: string
}

/**
 * Result of the host-owned `saveDocumentWithDialog` helper. Mirror of the
 * exact return shape declared inline in `ipc-handler.ts` so the group can
 * forward it verbatim.
 */
export interface SaveDocumentWithDialogResult {
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
  errorCode?: string
  max?: number
  actual?: number
}

export interface SaveAsPayload {
  content?: string
  contentBase64?: string
  suggestedName?: string
  defaultPath?: string | null
}

/**
 * Shape of a save-workspace dialog options object the WorkspaceGroup passes
 * through to `dialog.showSaveDialog`. Mirror of Electron's `SaveDialogOptions`
 * narrowed to the three fields the handler wires (`title`, `defaultPath`,
 * `filters`).
 */
export interface SaveWorkspaceDialogOptions {
  title: string
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

/**
 * Shape of a save-workspace dialog return value the WorkspaceGroup consumes.
 * Mirror of Electron's `SaveDialogReturnValue` narrowed to the two fields
 * the handler reads (`canceled` + `filePath`).
 */
export interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

/**
 * Shape of an open-file dialog options object the WorkspaceGroup passes
 * through to `dialog.showOpenDialog`. Distinct from `OpenFolderDialogOptions`
 * because the workspace-import flow opens FILES (single `.json`), not
 * directories, and ships a file-extension filter set.
 */
export interface OpenWorkspaceFileDialogOptions {
  title: string
  properties: Array<'openFile'>
  filters: Array<{ name: string; extensions: string[] }>
}

/**
 * Composition root. V2.3a populates the MarkGroup-relevant fields; V2.3b
 * extends it with FileIoGroup deps (mock flag is shared). Later V2.3
 * sub-stages will append further surfaces as their groups need new deps.
 *
 * Optional fields are FORBIDDEN here — if a future group can run without a
 * dep, that dep belongs in the group's per-group deps interface (also
 * optional there), NOT here.
 */
export interface EngineDeps {
  /** Whether the engine is running in mock mode (no SQLite, no dialogs). */
  readonly useMock: boolean
  /** Host-owned document trash root under app userData. */
  getDocumentTrashRoot(): string
  /**
   * Construct a fresh `DocumentMarksRepository` bound to the current SQLite
   * connection. The host owns the actual `getDatabase().getRawDb()` lookup
   * + `new DocumentMarksRepository(rawDb)` so the group never imports the
   * database module directly; throwing `database_unavailable` here surfaces
   * the same error the inline handler used.
   */
  getDocumentMarksRepository(): DocumentMarksRepository

  // --- V2.3b — FileIoGroup deps ---

  /**
   * Read the current (mutable) document write-index hook the host installs
   * via `setDocumentWriteIndexHook`. The handler invokes it after a
   * successful `document:write` so the search-engine indexer can refresh.
   * Returns `null` when no hook is registered.
   */
  getDocumentWriteIndexHook(): DocumentWriteIndexHook | null
  /**
   * Write editable text content to a path with the host's binary/docx
   * guards. Lifted to a dep so the group never imports the docx/text
   * write helpers directly.
   */
  writeDocumentEditableText(filePath: string, content: string): Promise<{ success: boolean; error?: string }>
  /**
   * Host-owned save dialog flow (window resolution + size guards + actual
   * write). Returns the structured result `document:saveAs` forwards
   * verbatim.
   */
  saveDocumentWithDialog(
    payload: SaveAsPayload,
    parentWindow: BrowserWindow | null,
  ): Promise<SaveDocumentWithDialogResult>
  /**
   * Resolve the active BrowserWindow used as dialog parent. The host owns
   * the focused/all-windows fallback chain.
   */
  resolveDialogWindow(parentWindow: BrowserWindow | null): BrowserWindow | null
  /** Wrap `BrowserWindow.fromWebContents` so the group does not import electron at runtime. */
  getBrowserWindowFromWebContents(sender: WebContents): BrowserWindow | null
  /** Wrap `dialog.showOpenDialog` for the openFolder channel. */
  showOpenDialog(window: BrowserWindow, options: OpenFolderDialogOptions): Promise<OpenDialogResult>
  /** Wrap `shell.showItemInFolder` so the group does not import electron at runtime. */
  showItemInFolder(targetPath: string): void
  /** Wrap `shell.openPath` so the group does not import electron at runtime. */
  openShellPath(targetPath: string): Promise<string>
  /**
   * Validate a candidate workspace root path. Lifted to a dep so the
   * group does not bake in the home directory or the `accessSync` probe.
   */
  validateWorkspaceRoot(picked: string): WorkspaceValidationResult

  // --- V2.3d — WorkspaceGroup deps ---

  /**
   * Wrap `dialog.showSaveDialog` for the workspace-export channel. Distinct
   * from the FileIoGroup's `showOpenDialog` facade because the workspace
   * export flow needs a SAVE dialog with a structured filter set.
   */
  showSaveWorkspaceDialog(
    window: BrowserWindow,
    options: SaveWorkspaceDialogOptions,
  ): Promise<SaveDialogResult>
  /**
   * Wrap `dialog.showOpenDialog` for the workspace-import channel. The
   * narrowed options shape (`openFile` + filters) deliberately differs from
   * `OpenFolderDialogOptions` so the type system catches accidental cross
   * wiring (workspace import is a FILE picker, not a folder picker).
   */
  showOpenWorkspaceFileDialog(
    window: BrowserWindow,
    options: OpenWorkspaceFileDialogOptions,
  ): Promise<OpenDialogResult>
  /**
   * Resolve the OS home directory. Lifted to a dep so the group does not
   * import `os` at runtime; the host owns the actual `homedir()` call so
   * tests can pin a deterministic path without touching real env.
   */
  getHomeDirectory(): string

  // --- V2.3e — ParserGroup deps ---

  /**
   * Resolve the lazy-loaded `mammoth` module the docx parser uses. The
   * host owns the singleton cache (`mammothLib`) and the `try/catch import`
   * fallback that returns `null` when the optional dep is not installed,
   * so the group never imports `mammoth` directly. Returning `null` lets
   * the handler surface the structured `LIBRARY_NOT_INSTALLED` error
   * verbatim.
   */
  getMammothModule(): Promise<typeof import('mammoth') | null>
  /**
   * Resolve the lazy-loaded `xlsx` (SheetJS) module the xlsx parser uses.
   * Mirrors `getMammothModule` — host-owned singleton cache + null-on-miss
   * so the handler can return `LIBRARY_NOT_INSTALLED` without importing
   * `xlsx` itself.
   */
  getXlsxModule(): Promise<typeof import('xlsx') | null>
  /**
   * Convert an EPUB (or other supported ebook archive) at `sourcePath` to
   * on-disk markdown + assets. Lifted to a dep so the group does not
   * import `./ebook-importer` directly; the host owns the actual
   * `importEpubAsMarkdown(sourcePath)` call. The return shape is the same
   * structured result the renderer already consumes.
   */
  importEbookAsMarkdown(sourcePath: string): Promise<{
    success: boolean
    indexPath?: string
    outputDir?: string
    assetCount?: number
    warnings?: string[]
    error?: string
    errorCode?: string
  }>
}
