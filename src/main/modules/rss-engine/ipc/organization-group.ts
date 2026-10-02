import type { IpcChannelGroup } from './types'
import type { RSSOrganizationStore } from '../../database/rss-organization-store'
import { RSSDefinitionWriteSchema, RSSDefinitionDeleteSchema, RSSMembershipWriteSchema } from '../../../../shared/rss-organization'

const CHANNELS = ['rss:getDefinitions', 'rss:saveDefinition', 'rss:removeDefinition', 'rss:setMembership'] as const
export const organizationGroup: IpcChannelGroup<{ getStore(): RSSOrganizationStore; notify(): void }> = {
  namespace: 'rss:organization',
  register(ipcMain, deps) {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    const respond = (action: () => unknown, mutation = false) => {
      try { const data = action(); if (mutation) deps.notify(); return { success: true, data } }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    }
    ipcMain.handle('rss:getDefinitions', () => respond(() => deps.getStore().list()))
    ipcMain.handle('rss:saveDefinition', (_event, input: unknown) => respond(() => deps.getStore().save(RSSDefinitionWriteSchema.parse(input)), true))
    ipcMain.handle('rss:removeDefinition', (_event, input: unknown) => respond(() => deps.getStore().remove(RSSDefinitionDeleteSchema.parse(input)), true))
    ipcMain.handle('rss:setMembership', (_event, input: unknown) => respond(() => deps.getStore().setManual(RSSMembershipWriteSchema.parse(input)), true))
    return { dispose: () => { for (const channel of CHANNELS) ipcMain.removeHandler(channel) } }
  },
}
