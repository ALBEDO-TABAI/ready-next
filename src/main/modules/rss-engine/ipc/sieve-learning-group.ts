import { z } from 'zod'
import type { IpcChannelGroup } from './types'
import type { RSSStore } from '../../database/rss-store'
import { RSSCalibrationDecisionSchema, RSSNotificationSettingsSchema, RSSSieveSettingsSchema, RSSTopicNotificationSchema } from '../../../../shared/rss-sieve'

const CHANNELS = [
  'rss:sievePendingOpen', 'rss:sieveAckOpen', 'rss:sieveCalibration', 'rss:sieveAcceptCalibration',
  'rss:sieveDismissCalibration', 'rss:sieveMetrics', 'rss:sieveSettings', 'rss:sieveSaveSettings',
  'rss:sieveNotificationSettings', 'rss:sieveSaveNotificationSettings', 'rss:sieveTopicNotifications',
  'rss:sieveSaveTopicNotification', 'rss:importOpml',
] as const

export const sieveLearningGroup: IpcChannelGroup<{ store(): RSSStore; notify(): void }> = {
  namespace: 'rss:sieveLearning',
  register(ipcMain, deps) {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    const respond = (action: () => unknown, changed = false) => {
      try {
        const data = action()
        if (changed) deps.notify()
        return { success: true, data }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    ipcMain.handle('rss:sievePendingOpen', () => respond(() => deps.store().learning.pendingOpen()))
    ipcMain.handle('rss:sieveAckOpen', (_event, input: unknown) => respond(() => deps.store().learning.ackOpen(z.string().min(1).parse(input))))
    ipcMain.handle('rss:sieveCalibration', () => respond(() => deps.store().learning.calibration()))
    ipcMain.handle('rss:sieveAcceptCalibration', (_event, input: unknown) => respond(() => deps.store().learning.accept(RSSCalibrationDecisionSchema.parse(input)), true))
    ipcMain.handle('rss:sieveDismissCalibration', (_event, input: unknown) => respond(() => deps.store().learning.dismiss(z.object({ week: z.string() }).strict().parse(input)), true))
    ipcMain.handle('rss:sieveMetrics', () => respond(() => deps.store().learning.metrics()))
    ipcMain.handle('rss:sieveSettings', () => respond(() => deps.store().sieve.settings()))
    ipcMain.handle('rss:sieveSaveSettings', (_event, input: unknown) => respond(() => deps.store().sieve.saveSettings(RSSSieveSettingsSchema.parse(input)), true))
    ipcMain.handle('rss:sieveNotificationSettings', () => respond(() => deps.store().learning.notificationSettings()))
    ipcMain.handle('rss:sieveSaveNotificationSettings', (_event, input: unknown) => respond(() => deps.store().learning.saveNotificationSettings(RSSNotificationSettingsSchema.parse(input)), true))
    ipcMain.handle('rss:sieveTopicNotifications', () => respond(() => deps.store().learning.topicNotifications()))
    ipcMain.handle('rss:sieveSaveTopicNotification', (_event, input: unknown) => respond(() => deps.store().learning.saveTopicNotification(RSSTopicNotificationSchema.parse(input)), true))
    ipcMain.handle('rss:importOpml', (_event, input: unknown) => respond(() => deps.store().importOpml(z.object({ xml: z.string().max(10_000_000) }).strict().parse(input).xml), true))
    return {
      dispose: () => {
        for (const channel of CHANNELS) ipcMain.removeHandler(channel)
      },
    }
  },
}
