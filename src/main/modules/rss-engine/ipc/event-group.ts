import type { IpcChannelGroup } from './types'
import type { RSSEventStore } from '../../database/rss-event-store'
import { RSSReadEventsSchema, RSSEventMoveSchema, RSSEventMergeSchema, RSSSeenFactsSchema } from '../../../../shared/rss-events'

const CHANNELS = ['rss:readEvents', 'rss:moveEventMember', 'rss:mergeEvents', 'rss:markEventFactsSeen'] as const
export const eventGroup: IpcChannelGroup<{ store(): RSSEventStore; notify(): void; notifySeen(): void }> = {
  namespace: 'rss:events',
  register(ipcMain, deps) {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    const respond = (action: () => unknown, mutation = false) => {
      try { const data = action(); if (mutation) deps.notify(); return { success: true, data } }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    }
    ipcMain.handle('rss:readEvents', (_event, input: unknown) => respond(() => deps.store().browse(RSSReadEventsSchema.parse(input || {}))))
    ipcMain.handle('rss:moveEventMember', (_event, input: unknown) => respond(() => deps.store().move(RSSEventMoveSchema.parse(input)), true))
    ipcMain.handle('rss:mergeEvents', (_event, input: unknown) => respond(() => deps.store().merge(RSSEventMergeSchema.parse(input)), true))
    ipcMain.handle('rss:markEventFactsSeen', (_event, input: unknown) => respond(() => { const result = deps.store().markSeen(RSSSeenFactsSchema.parse(input)); if (result.changed) deps.notifySeen(); return result }))
    return { dispose: () => { for (const channel of CHANNELS) ipcMain.removeHandler(channel) } }
  },
}
