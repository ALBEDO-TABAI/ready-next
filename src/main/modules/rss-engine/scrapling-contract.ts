export interface ScraplingFetchProfileFeedLikeItemsRequest {
  url: string
  platform: 'weibo' | 'douyin' | 'xiaohongshu'
  timeoutMs?: number
  sessionProfile?: string
}

export interface ScraplingFeedLikeItem {
  title: string
  link: string
  summary?: string | null
  author?: string | null
  publishedAt?: string | null
  coverImage?: string | null
  raw?: Record<string, unknown>
}

export interface ScraplingFetchProfileFeedLikeItemsResponse {
  success: boolean
  items: ScraplingFeedLikeItem[]
  error?: string
  durationMs: number
}

export interface ScraplingExtractPageStructuredContentRequest {
  url: string
  timeoutMs?: number
  sessionProfile?: string
}

export interface ScraplingExtractPageStructuredContentResponse {
  success: boolean
  title?: string
  summary?: string
  markdown?: string
  structured?: Record<string, unknown>
  error?: string
  durationMs: number
}

export interface ScraplingSidecarContract {
  fetchProfileFeedLikeItems(
    request: ScraplingFetchProfileFeedLikeItemsRequest,
  ): Promise<ScraplingFetchProfileFeedLikeItemsResponse>
  extractPageStructuredContent(
    request: ScraplingExtractPageStructuredContentRequest,
  ): Promise<ScraplingExtractPageStructuredContentResponse>
}
