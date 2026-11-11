import { getDatabase } from '../database'
import { fetchClipHtml } from '../clipping/clip-fetch'
import { ReadabilityJsdomAdapter } from '../clipping/readability-jsdom-adapter'
import { RSSContentService } from './content-service'
import { RSSTranslationService } from './translation-service'
import { completeRSSModel } from './model-completion'
import { hasRSSProcessingModel, rssModelConfig } from './model-readiness'

let service: RSSContentService | null = null
let translations: RSSTranslationService | null = null

export function getRSSContentService(): RSSContentService {
  if (!service) {
    const content = getDatabase().rss.content
    content.recoverInterruptedLoads()
    service = new RSSContentService({
      content,
      fetchHtml: async (url, signal, credentials) => {
        const { session } = await import('electron')
        const browserSession = session.fromPartition('persist:browser')
        return fetchClipHtml(url, AbortSignal.any([signal, AbortSignal.timeout(45_000)]), (input, init) => {
          const headers = new Headers(init.headers)
          headers.set('user-agent', browserSession.getUserAgent())
          return browserSession.fetch(input, { ...init, headers, credentials })
        })
      },
      // The reader never renders page HTML, so tables must arrive as Markdown grids or text.
      extractor: new ReadabilityJsdomAdapter({ tables: 'markdown' }),
    })
  }
  return service
}

/** Article translations derive from saved bodies and use the same model, readiness and limits as RSS judgments. */
export function getRSSTranslationService(): RSSTranslationService {
  if (!translations) {
    const rss = getDatabase().rss
    translations = new RSSTranslationService({
      store: rss.translations,
      getArticle: (id) => rss.content.getArticle(id),
      assertModelReady: () => {
        if (!hasRSSProcessingModel()) throw new Error('请先在 Ready 中配置可用的模型，再翻译文章。')
      },
      complete: (request) => completeRSSModel(rssModelConfig(), request),
      notify: (itemId, targetLang) => {
        void import('electron').then(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('rss:translationChanged', { itemId, targetLang })
          }
        })
      },
    })
  }
  return translations
}

export async function stopRSSContentService(): Promise<void> {
  await Promise.all([service?.stop(), translations?.stop()])
}
