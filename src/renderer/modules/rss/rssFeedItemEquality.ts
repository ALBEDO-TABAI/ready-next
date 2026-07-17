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
}

export interface ComparableRSSFeedAnalysis {
  status: string
  progress: number
  message: string | null
  error: string | null
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
  const sameAnalysis = previousAnalysis === nextAnalysis || (
    previousAnalysis?.status === nextAnalysis?.status
    && previousAnalysis?.progress === nextAnalysis?.progress
    && previousAnalysis?.message === nextAnalysis?.message
    && previousAnalysis?.error === nextAnalysis?.error
  )
  return sameItem && sameAnalysis
}
