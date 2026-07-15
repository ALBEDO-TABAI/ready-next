import type { ChatAttachment } from './types'
import { useDocTabs } from '../../stores/useDocTabs'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'

export const READY_DOCUMENT_REVEAL_EVENT = 'ready:document-reveal'

export function revealDocumentQuoteAttachment(attachment: ChatAttachment): void {
  if (attachment.source !== 'document-quote') return
  if (!attachment.path || !attachment.path.startsWith('/')) return

  useDocTabs.getState().openTab(attachment.path)
  requestWorkbenchModeOpen('document')
  useDocTabs.getState().setPendingReveal({
    path: attachment.path,
    selection: attachment.selection,
    lineStart: attachment.lineStart,
    lineEnd: attachment.lineEnd,
    sectionTitle: attachment.sectionTitle,
    requestedAt: Date.now(),
  })
  window.dispatchEvent(new CustomEvent(READY_DOCUMENT_REVEAL_EVENT, {
    detail: {
      path: attachment.path,
    },
  }))
}
