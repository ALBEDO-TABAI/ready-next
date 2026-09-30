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
      fetchHtml: async (url, signal) => {
        const { session } = await import('electron')
        const browserSession = session.fromPartition('persist:browser')
        return fetchClipHtml(url, AbortSignal.any([signal, AbortSignal.timeout(45_000)]), (input, init) => {
          const headers = new Headers(init.headers)
          headers.set('user-agent', browserSession.getUserAgent())
          return browserSession.fetch(input, { ...init, headers, credentials: 'include' })
        })
      },
      extractor: new ReadabilityJsdomAdapter(),
    })
  }
  return service
}

export async function stopRSSContentService(): Promise<void> {
  await service?.stop()
}
