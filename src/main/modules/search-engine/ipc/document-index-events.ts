import { syncDateMentionIndex } from '../../calendar-engine/date-mentions/index-events'
import type { WebContents } from 'electron'
import type {
  DocumentIndexChangedEvent,
  DocumentWatcherFailedEvent,
} from '../../../../shared/document-index-events'

export function publishDocumentIndexChanged(
  sender: Pick<WebContents, 'isDestroyed' | 'send'>,
  event: Omit<DocumentIndexChangedEvent, 'completedAt'>,
): void {
  syncDateMentionIndex(event)
  if (sender.isDestroyed()) return
  sender.send('document:indexChanged', {
    ...event,
    completedAt: Date.now(),
  } satisfies DocumentIndexChangedEvent)
}

export function publishDocumentWatcherFailed(
  sender: Pick<WebContents, 'isDestroyed' | 'send'>,
  event: DocumentWatcherFailedEvent,
): void {
  if (sender.isDestroyed()) return
  sender.send('document:watcherFailed', event)
}
