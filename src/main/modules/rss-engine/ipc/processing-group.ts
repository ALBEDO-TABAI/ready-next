import { z } from 'zod'
import type { IpcChannelGroup } from './types'
import type { RSSProcessingStore } from '../../database/rss-processing-store'
import type { RSSProcessingService } from '../processing-service'
import { RSSProcessingSettingsSchema, RSSProcessingListSchema, RSSReprocessSchema } from '../../../../shared/rss-processing'

const CHANNELS = ['rss:processingStatus', 'rss:processingJobs', 'rss:configureProcessing', 'rss:reprocessArticle', 'rss:cancelProcessing', 'rss:resumeProcessing'] as const
export const processingGroup: IpcChannelGroup<{ store(): RSSProcessingStore; service(): RSSProcessingService; hasModel(): boolean; notify(): void }> = {
  namespace: 'rss:processing',
  register(ipcMain, deps) {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    const respond = (action: () => unknown) => {
      try { return { success: true, data: action() } }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    }
    ipcMain.handle('rss:processingStatus', () => respond(() => deps.store().status(Date.now(), deps.hasModel())))
    ipcMain.handle('rss:processingJobs', (_event, input: unknown) => respond(() => deps.store().list(RSSProcessingListSchema.parse(input || {}))))
    ipcMain.handle('rss:configureProcessing', (_event, input: unknown) => respond(() => { const saved = deps.store().configure(RSSProcessingSettingsSchema.parse(input)); deps.notify(); return saved }))
    ipcMain.handle('rss:reprocessArticle', (_event, input: unknown) => respond(() => {
      const params = RSSReprocessSchema.parse(input)
      const jobIds = deps.store().enqueue(params.itemId, 'manual', params.expectedArticleRevision)
      void deps.service().wake(); deps.notify(); return { jobIds }
    }))
    ipcMain.handle('rss:cancelProcessing', (_event, input: unknown) => respond(() => { const id = z.string().min(1).parse(input); deps.service().cancel(id); return { id } }))
    ipcMain.handle('rss:resumeProcessing', () => respond(() => { void deps.service().wake(); return { requested: true } }))
    return { dispose: () => { for (const channel of CHANNELS) ipcMain.removeHandler(channel) } }
  },
}
