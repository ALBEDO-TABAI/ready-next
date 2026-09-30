import { RSSReadExcerptSchema } from '../../../../shared/rss-excerpt'
import type { IpcChannelGroup } from './types'
import type { RSSContentStore } from '../../database/rss-content-store'
import type { RSSContentService } from '../content-service'
import { RSSLoadArticleSchema, RSSQuerySchema, RSSReadArticleSchema } from '../../../../shared/rss-workspace'

interface ContentGroupDeps {
  useMock: boolean
  getContent(): RSSContentStore
  getLoader(): RSSContentService
}

const CHANNELS = ['rss:readExcerpt', 'rss:queryItems', 'rss:queryCards', 'rss:readArticle', 'rss:loadArticle', 'rss:dismissQuery'] as const

export const contentGroup: IpcChannelGroup<ContentGroupDeps> = {
  namespace: 'rss:content',
  register(ipcMain, deps) {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    const respond = async (action: () => unknown | Promise<unknown>) => {
      if (deps.useMock) return { success: false, mock: true, error: 'RSS content requires real storage' }
      try { return { success: true, mock: false, data: await action() } }
      catch (error) { return { success: false, mock: false, error: error instanceof Error ? error.message : String(error) } }
    }
    ipcMain.handle('rss:readExcerpt', (_event, input: unknown) => respond(() => deps.getContent().readExcerpt(RSSReadExcerptSchema.parse(input))))
    ipcMain.handle('rss:queryItems', (_event, input: unknown) => respond(() => deps.getContent().query(RSSQuerySchema.parse(input ?? {}))))
    ipcMain.handle('rss:queryCards', (_event, input: unknown) => respond(() => deps.getContent().cards(RSSQuerySchema.parse(input ?? {}))))
    ipcMain.handle('rss:dismissQuery', (_event, input: unknown) => respond(() => deps.getContent().dismissQuery(RSSQuerySchema.parse(input))))
    ipcMain.handle('rss:readArticle', (_event, input: unknown) => respond(() => deps.getContent().readArticle(RSSReadArticleSchema.parse(input))))
    ipcMain.handle('rss:loadArticle', (_event, input: unknown) => respond(async () => {
      const { itemId, force } = RSSLoadArticleSchema.parse(input)
      const article = await deps.getLoader().load(itemId, force)
      if (article.body.error || article.body.status !== 'ready' && article.body.status !== 'partial') throw new Error(article.body.error || article.body.status)
      const { body: { markdown: _markdown, ...body }, ...metadata } = article
      return { ...metadata, body }
    }))
    return { dispose: () => { for (const channel of CHANNELS) ipcMain.removeHandler(channel) } }
  },
}
