import type { IpcChannelGroup } from './types'
import type { RSSSieveStore } from '../../database/rss-sieve-store'
import type { RSSPictureStore } from '../../database/rss-picture-store'
import { RSSBehaviorSchema, RSSWorkPrivacyPatchSchema, RSSSieveQuerySchema, type RSSWorkContextSnapshot } from '../../../../shared/rss-sieve'
import { z } from 'zod'
const CHANNELS = ['rss:sieveRelevance','rss:sieveQuery','rss:sieveToday','rss:sieveRecordBehavior','rss:sievePrivacy','rss:sieveConfigurePrivacy',
  'rss:sieveWorkContext','rss:sieveExcludedPages','rss:sieveExcludePage','rss:sieveFocus','rss:sieveSaveFocus'] as const
export const sieveGroup: IpcChannelGroup<{ store(): RSSSieveStore; pictures(): RSSPictureStore; workContext(): RSSWorkContextSnapshot; notify(): void }> = {
  namespace:'rss:sieve',
  register(ipcMain,deps) {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    const respond = (action: () => unknown, changed = false) => {
      try { const data = action(); if (changed) deps.notify(); return {success:true,data} }
      catch (error) { return {success:false,error:error instanceof Error ? error.message : String(error)} }
    }
    ipcMain.handle('rss:sieveRelevance',(_event,input:unknown) => respond(() => deps.store().relevance(z.string().min(1).parse(input))))
    // 为你筛过的 shows pictures: an item without a feed cover carries the one kept for its page (资讯配图 P5).
    ipcMain.handle('rss:sieveQuery',(_event,input:unknown) => respond(() => {
      const result = deps.store().query(RSSSieveQuerySchema.parse(input ?? {}))
      return { ...result, items: deps.pictures().fill(result.items) }
    }))
    ipcMain.handle('rss:sieveToday',() => respond(() => deps.store().today()))
    ipcMain.handle('rss:sieveRecordBehavior',(_event,input:unknown) => respond(() => deps.store().recordBehavior(RSSBehaviorSchema.parse(input)),true))
    ipcMain.handle('rss:sievePrivacy',() => respond(() => deps.store().privacy()))
    ipcMain.handle('rss:sieveConfigurePrivacy',(_event,input:unknown) => respond(() => deps.store().configurePrivacy(RSSWorkPrivacyPatchSchema.parse(input)),true))
    ipcMain.handle('rss:sieveWorkContext',() => respond(() => deps.workContext()))
    ipcMain.handle('rss:sieveExcludedPages',() => respond(() => deps.store().excludedPages()))
    ipcMain.handle('rss:sieveExcludePage',(_event,input:unknown) => respond(() => deps.store().excludePage(z.object({objectId:z.string().min(1),excluded:z.boolean()}).strict().parse(input)),true))
    ipcMain.handle('rss:sieveFocus',() => respond(() => deps.store().focus()))
    ipcMain.handle('rss:sieveSaveFocus',(_event,input:unknown) => respond(() => deps.store().saveFocus(z.object({text:z.string(),expectedVersion:z.number().int().nonnegative()}).strict().parse(input)),true))
    return { dispose:() => { for (const channel of CHANNELS) ipcMain.removeHandler(channel) } }
  },
}
