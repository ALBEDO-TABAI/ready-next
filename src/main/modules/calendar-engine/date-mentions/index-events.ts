import type { DocumentIndexChangedEvent } from '../../../../shared/document-index-events'

export type MentionIndexEvent = Omit<DocumentIndexChangedEvent, 'completedAt'>
let synchronize: ((event: MentionIndexEvent) => void) | null = null
export function configureDateMentionIndex(listener: typeof synchronize): void { synchronize = listener }
export function syncDateMentionIndex(event: MentionIndexEvent): void { synchronize?.(event) }
