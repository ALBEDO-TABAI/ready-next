/**
 * HTML → PDF rendering for the document 导出 button.
 *
 * The renderer captures the live NotePreview DOM into a standalone HTML
 * document (styles inlined, interactive chrome stripped); this module loads
 * that document in a hidden BrowserWindow and prints it with Chromium's
 * printToPDF so the exported PDF keeps Ready's reading layout.
 *
 * The hidden window is sandboxed (no preload, no node), never shown, and is
 * destroyed in every exit path. Local images keep working because the
 * `local-file://` protocol handler is registered on the default session.
 */
import { BrowserWindow } from 'electron'
import { writeFile, unlink } from 'fs/promises'
import { join } from 'path'

/** Hard cap before we print whatever has rendered (protects hung embeds). */
const RENDER_READY_TIMEOUT_MS = 12_000

/**
 * In-page readiness probe: wait for fonts and every image, then leave a
 * settle tail for srcdoc widget iframes and other async embeds. Resolves —
 * never rejects — so a broken image can't wedge the export.
 */
const READINESS_SCRIPT = `(() => new Promise((resolve) => {
  const settle = () => setTimeout(() => resolve(true), 700)
  const images = Array.from(document.images).map((img) => (
    img.complete
      ? Promise.resolve()
      : new Promise((done) => {
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
        })
  ))
  const fonts = document.fonts && document.fonts.ready
    ? document.fonts.ready.catch(() => {})
    : Promise.resolve()
  Promise.all([...images, fonts]).then(settle, settle)
}))()`

export interface RenderHtmlToPdfOptions {
  html: string
  /** Directory for the transient HTML file (app temp path). */
  tempDir: string
}

export async function renderHtmlToPdfBuffer(options: RenderHtmlToPdfOptions): Promise<Buffer> {
  const tempHtmlPath = join(
    options.tempDir,
    `ready-doc-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`,
  )
  await writeFile(tempHtmlPath, options.html, 'utf-8')

  const window = new BrowserWindow({
    show: false,
    width: 860,
    height: 1400,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  try {
    // The document is self-contained; any navigation attempt is unexpected.
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    await window.loadFile(tempHtmlPath)

    await Promise.race([
      window.webContents.executeJavaScript(READINESS_SCRIPT, true).catch(() => true),
      new Promise((resolve) => setTimeout(resolve, RENDER_READY_TIMEOUT_MS)),
    ])

    return await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      landscape: false,
      preferCSSPageSize: false,
      // Inches. ~14mm sides, slightly deeper bottom so pages breathe.
      margins: { top: 0.55, bottom: 0.62, left: 0.55, right: 0.55 },
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
    void unlink(tempHtmlPath).catch(() => {
      // silent-catch: transient export HTML in the temp dir; OS cleanup covers leftovers.
    })
  }
}
