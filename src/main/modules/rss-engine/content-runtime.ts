import { getDatabase } from '../database'
import { fetchClipHtml } from '../clipping/clip-fetch'
import { ReadabilityJsdomAdapter } from '../clipping/readability-jsdom-adapter'
import { RSSContentService } from './content-service'

let service: RSSContentService | null = null

export function getRSSContentService(): RSSContentService {
  if (!service) {
    const content = getDatabase().rss.content
    content.recoverInterruptedLoads()
    service = new RSSContentService({
      content,
      fetchHtml: (url, signal) => fetchClipHtml(url, AbortSignal.any([signal, AbortSignal.timeout(45_000)])),
      extractor: new ReadabilityJsdomAdapter(),
    })
  }
  return service
}

export async function stopRSSContentService(): Promise<void> {
  await service?.stop()
}
