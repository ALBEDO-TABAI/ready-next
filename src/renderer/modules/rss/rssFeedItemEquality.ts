export interface ComparableRSSFeedItem {
  id: string
  title: string
  source: string
  author: string
  sourceId: string
  summary: string
  publishedAt: string
  inboxVisible?: boolean
  read: boolean
  starred: boolean
  coverImage?: string
  link: string
  publishedAtMs?: number | null
  collectedAt?: number
  revision?: string
  classifications?: unknown
  eventGroup?: unknown
}

export interface ComparableRSSFeedAnalysis {
  status: string
  progress: number
  message: string | null
  error: string | null
  sourceWarning?: string | null
}

// Classification and event-group summaries are small value objects rebuilt on every query snapshot.
function sameValue(previous: unknown, next: unknown): boolean {
  return previous === next || JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)
}

export function isRSSFeedItemContentEqual(
  previous: ComparableRSSFeedItem,
  next: ComparableRSSFeedItem,
  previousAnalysis?: ComparableRSSFeedAnalysis,
  nextAnalysis?: ComparableRSSFeedAnalysis,
): boolean {
  const sameItem = previous.id === next.id
    && previous.title === next.title
    && previous.source === next.source
    && previous.author === next.author
    && previous.sourceId === next.sourceId
    && previous.summary === next.summary
    && previous.publishedAt === next.publishedAt
    && previous.inboxVisible === next.inboxVisible
    && previous.read === next.read
    && previous.starred === next.starred
    && previous.coverImage === next.coverImage
    && previous.link === next.link
    && previous.publishedAtMs === next.publishedAtMs
    && previous.collectedAt === next.collectedAt
    && previous.revision === next.revision
    && sameValue(previous.classifications, next.classifications)
    && sameValue(previous.eventGroup, next.eventGroup)
  const sameAnalysis = previousAnalysis === nextAnalysis || (
    previousAnalysis?.status === nextAnalysis?.status
    && previousAnalysis?.progress === nextAnalysis?.progress
    && previousAnalysis?.message === nextAnalysis?.message
    && previousAnalysis?.error === nextAnalysis?.error
    && previousAnalysis?.sourceWarning === nextAnalysis?.sourceWarning
  )
  return sameItem && sameAnalysis
}
