import type { IpcMain } from 'electron'
import type { LibraryResult, LibraryState } from '../../../shared/library'
import type { LibraryEngine } from './library-engine'
import type { LibraryArchiveImporter } from './archive-import'

export function registerLibraryArchiveIPC(ipcMain: Pick<IpcMain, 'handle'>, dependencies: {
  engine: LibraryEngine; importer: LibraryArchiveImporter
  suggestion: string
  pickDirectory(): Promise<string | null>
  confirm(directory: string): Promise<boolean>
  changed(state: LibraryState): void
}): void {
  let busy = false
  const result = async <T>(work: () => Promise<T> | T): Promise<LibraryResult<T>> => {
    try { return { success: true, data: await work() } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle('library:archiveSuggestion', () => result(() => dependencies.suggestion))
  ipcMain.handle('library:pickAndImportArchive', event => result(async () => {
    if (busy) throw new Error('藏书阁导入正在进行，请等待完成')
    if (!dependencies.engine.vaultRoot()) throw new Error('请先配置可用的资料库')
    busy = true
    try {
      const root = dependencies.engine.vaultRoot()
      const directory = await dependencies.pickDirectory()
      if (!directory || !await dependencies.confirm(directory)) return null
      if (dependencies.engine.vaultRoot() !== root) throw new Error('资料库已切换，请重新选择')
      const report = await dependencies.importer.run(directory, progress => {
        if (!event.sender.isDestroyed()) event.sender.send('library:archiveProgress', progress)
      })
      dependencies.changed(await dependencies.engine.get())
      return report
    } finally { busy = false }
  }))
}
