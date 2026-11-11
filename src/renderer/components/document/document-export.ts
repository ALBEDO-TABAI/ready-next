import type { DocTab } from '../../stores/useDocTabs'
import { captureDocumentPreviewHtml } from './document-export-capture'
import { isMarkdownExportableTab, stripTitleExtension } from './document-export-target'

export type DocumentExportKind = 'pdf' | 'md-bundle'
export type DocumentExportOutcome = { status: 'done' } | { status: 'canceled' } | { status: 'error'; error: string }

export { isMarkdownExportableTab }

/** Export the page as a PDF (the rendered page view) or a Markdown bundle with its assets. */
export async function exportDocument(kind: DocumentExportKind, target: DocTab): Promise<DocumentExportOutcome> {
  const documentApi = window.electronAPI?.document
  if (!documentApi?.exportPdf || !documentApi.exportMarkdownBundle) return { status: 'error', error: '导出接口不可用' }
  const suggestedName = stripTitleExtension(target.title)
  const sourcePath = target.path || null
  try {
    const result = kind === 'pdf'
      ? await documentApi.exportPdf({
        html: await captureDocumentPreviewHtml({ content: target.content, notePath: sourcePath, title: suggestedName }),
        suggestedName,
        sourcePath,
      })
      : await documentApi.exportMarkdownBundle({ content: target.content, sourcePath, suggestedName })
    if (result.success) return { status: 'done' }
    if (result.canceled) return { status: 'canceled' }
    return { status: 'error', error: result.error || '导出失败' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[document-export] export failed:', message)
    return { status: 'error', error: message }
  }
}
