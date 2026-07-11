/**
 * Document export IPC contracts (top-bar 导出 button):
 *   document:exportPdf             — print the captured preview HTML to PDF
 *   document:exportMarkdownBundle  — zip the markdown + its local media assets
 *
 * Shared between main (document-engine/ipc/export-group.ts), preload and the
 * renderer export button so all three layers agree on one shape.
 */

export interface DocumentExportPdfPayload {
  /** Standalone HTML document captured from the live preview renderer. */
  html: string
  /** Base name (no extension) suggested in the save dialog. */
  suggestedName?: string
  /** Absolute path of the source document — anchors the save dialog directory. */
  sourcePath?: string | null
}

export interface DocumentExportMarkdownBundlePayload {
  /** Current document text (tab content — includes unsaved edits). */
  content: string
  /** Absolute path of the source document; null for untitled drafts. */
  sourcePath?: string | null
  /** Base name (no extension) suggested in the save dialog. */
  suggestedName?: string
}

export type DocumentExportResult =
  | {
      success: true
      path: string
      /** exportMarkdownBundle only: media files packed into assets/. */
      assetCount?: number
      /** exportMarkdownBundle only: referenced local files that were missing. */
      missingAssetCount?: number
    }
  | {
      success: false
      canceled?: boolean
      error?: string
    }

/** Sanity ceiling for the captured preview HTML (guards the IPC channel). */
export const DOCUMENT_EXPORT_HTML_MAX_BYTES = 32 * 1024 * 1024
