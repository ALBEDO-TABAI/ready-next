/**
 * Offscreen preview capture for the document 导出 button (PDF path).
 *
 * PDF export must keep Ready's reading surface, so instead of re-rendering
 * markdown with a second engine we render the real `NotePreview` component
 * into an offscreen host, wait for async pieces (images, mermaid, widget
 * iframes) to settle, then serialize the DOM plus the app's live CSS into a
 * standalone HTML document. The main process prints that document in a
 * hidden window (`document-engine/export/pdf-renderer.ts`).
 *
 * Capture is mode-independent: it works even while the user is in edit
 * mode, and always renders read-only (no preview-edit affordances).
 */
import { createRoot } from 'react-dom/client'
import NotePreview from './NotePreview'
import {
  buildExportHtmlDocument,
  collectLiveStyleSheetText,
  transformPreviewDomForExport,
} from './document-export-html'
// Raw style insurance: the collected CSSOM is the primary style source; if
// stylesheet access ever fails (e.g. packaged file:// origin quirks), these
// keep the core reading surface styled. Order stays index.css-faithful
// (tokens before markdown), and both precede collected CSS so live rules win.
import themeTokensCssRaw from '../../styles/theme-tokens.css?raw'
import markdownCssRaw from '../../styles/markdown.css?raw'

/** ≈ A4 usable width at 96dpi with ~14mm side margins. */
const EXPORT_CONTENT_WIDTH_PX = 680
const CAPTURE_SETTLE_TIMEOUT_MS = 8_000
const CAPTURE_POLL_INTERVAL_MS = 150
/** Extra tail so srcdoc widget iframes finish hydrating + resizing. */
const CAPTURE_ASYNC_EMBED_TAIL_MS = 900

export interface DocumentExportCaptureOptions {
  content: string
  notePath: string | null
  title: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isCaptureSettled(host: HTMLElement): boolean {
  if (!host.querySelector('.note-preview-shell')) return false
  const images = Array.from(host.querySelectorAll('img'))
  if (images.some((img) => !img.complete)) return false
  if (host.querySelector('.note-preview-mermaid__loading')) return false
  return true
}

async function waitForCaptureSettled(host: HTMLElement): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < CAPTURE_SETTLE_TIMEOUT_MS) {
    if (isCaptureSettled(host)) break
    await sleep(CAPTURE_POLL_INTERVAL_MS)
  }
  if (host.querySelector('iframe.document-widget-frame, .note-preview-mermaid')) {
    await sleep(CAPTURE_ASYNC_EMBED_TAIL_MS)
  }
}

/**
 * Render the document's preview offscreen and capture it as a standalone
 * HTML document ready for `document:exportPdf`.
 */
export async function captureDocumentPreviewHtml(options: DocumentExportCaptureOptions): Promise<string> {
  const host = document.createElement('div')
  host.className = 'ready-document-export-capture-host'
  host.style.cssText = [
    'position:fixed',
    'left:-100000px',
    'top:0',
    `width:${EXPORT_CONTENT_WIDTH_PX}px`,
    'pointer-events:none',
    'opacity:0',
    'z-index:-1',
  ].join(';')
  document.body.appendChild(host)
  const root = createRoot(host)

  try {
    root.render(<NotePreview content={options.content} notePath={options.notePath} />)
    await waitForCaptureSettled(host)

    const shell = host.querySelector('.note-preview-shell')
    if (!(shell instanceof HTMLElement)) {
      throw new Error('preview_capture_failed')
    }
    const clone = shell.cloneNode(true) as HTMLElement
    transformPreviewDomForExport(clone)

    return buildExportHtmlDocument({
      title: options.title,
      bodyHtml: clone.outerHTML,
      baseCss: `${themeTokensCssRaw}\n${markdownCssRaw}`,
      collectedCss: collectLiveStyleSheetText(document),
      darkTheme: document.documentElement.dataset.theme === 'dark',
    })
  } finally {
    root.unmount()
    host.remove()
  }
}
