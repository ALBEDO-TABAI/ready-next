import { dirname } from 'node:path'
import type { IpcChannelGroup } from './types'
import type { RSSContentStore } from '../../database/rss-content-store'
import { RSSWorkspaceFiles } from '../workspace-files'
import { RSSQuerySchema, RSSSaveNoteSchema } from '../../../../shared/rss-workspace'
import { broadcastDirectoryChanged } from '../../document-engine/ipc/directory-change-broadcast'

interface FileGroupDeps {
  getContent(): RSSContentStore
  chooseDirectory(sender: Electron.WebContents, title: string, defaultDirectory?: string): Promise<string | null>
}
const CHANNELS = ['rss:saveArticleNote', 'rss:exportQuery'] as const

export const workspaceFilesGroup: IpcChannelGroup<FileGroupDeps> = {
  namespace: 'rss:workspace-files',
  register(ipcMain, deps) {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    ipcMain.handle('rss:saveArticleNote', async (event, input: unknown) => {
      try {
        const params = RSSSaveNoteSchema.parse(input)
        const result = await new RSSWorkspaceFiles(deps.getContent()).saveNote(params, () => deps.chooseDirectory(event.sender, '选择笔记保存文件夹', params.defaultDirectory))
        if (!result.canceled) broadcastDirectoryChanged([dirname(result.path)])
        return { success: true, data: result }
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    })
    ipcMain.handle('rss:exportQuery', async (event, input: unknown) => {
      try {
        const params = RSSQuerySchema.parse(input)
        const result = await new RSSWorkspaceFiles(deps.getContent()).exportQuery(params, () => deps.chooseDirectory(event.sender, '选择当前结果导出文件夹'))
        if (!result.canceled) broadcastDirectoryChanged([dirname(result.path)])
        return { success: true, data: result }
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    })
    return { dispose: () => { for (const channel of CHANNELS) ipcMain.removeHandler(channel) } }
  },
}
