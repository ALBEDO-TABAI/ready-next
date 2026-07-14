import type { WebContents } from 'electron'
import type { DocumentIndexChangedEvent } from '../../../../shared/document-index-events'

export function publishDocumentIndexChanged(
  sender: Pick<WebContents, 'isDestroyed' | 'send'>,
  event: Omit<DocumentIndexChangedEvent, 'completedAt'>,
): void {
  if (sender.isDestroyed()) return
  sender.send('document:indexChanged', {
    ...event,
    completedAt: Date.now(),
  } satisfies DocumentIndexChangedEvent)
}
