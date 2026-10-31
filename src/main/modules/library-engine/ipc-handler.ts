import { registerLibraryAgentSelectionIPC } from './agent-selection-ipc'
import { LibraryHighlightService } from './highlight-service'
import type { IpcMain } from 'electron'
import type { LibraryResult, LibraryState } from '../../../shared/library'
import type { LibraryEngine } from './library-engine'
import type { LibraryReadingRepository } from './reading-repository'
import { bookmarkInputSchema, bookIdSchema, positionSchema } from './validation'

export function registerLibraryIPC(ipcMain: Pick<IpcMain, 'handle'>, dependencies: {
  engine: LibraryEngine
  highlights?: LibraryHighlightService
  reading: LibraryReadingRepository
  pickFiles(): Promise<string[]>
  changed(state: LibraryState): void
}): void {
  registerLibraryAgentSelectionIPC(ipcMain, async () => {
    const [{ getDatabase }, { productionLibraryReader }] = await Promise.all([import('../database'), import('../agent-control/codex-runtime/library-read-production')])
    return productionLibraryReader(getDatabase())
  })
  const { engine, reading } = dependencies
  const highlights = dependencies.highlights ?? new LibraryHighlightService(engine)
  const result = async <T>(work: () => Promise<T> | T): Promise<LibraryResult<T>> => {
    try { return { success: true, data: await work() } } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}) }
    }
  }
  const changed = async () => dependencies.changed(await engine.get())
  const importFiles = async (paths: unknown) => {
    const imported = await engine.importFiles(paths)
    await changed()
    return imported
  }
  ipcMain.handle('library:listHighlights', (_event, input: unknown) => result(() => highlights.list(input)))
  ipcMain.handle('library:createHighlight', (_event, input: unknown) => result(() => highlights.create(input)))
  ipcMain.handle('library:updateHighlight', (_event, input: unknown) => result(() => highlights.update(input)))
  ipcMain.handle('library:removeHighlight', (_event, input: unknown) => result(() => highlights.remove(input)))
  ipcMain.handle('library:get', () => result(() => engine.get()))
  ipcMain.handle('library:importFiles', (_event, paths: unknown) => result(() => importFiles(paths)))
  ipcMain.handle('library:pickAndImport', () => result(async () => {
    if (engine.vaultRoot() === null) throw Object.assign(new Error('请先配置可用的资料库'), { code: 'no_vault' })
    const paths = await dependencies.pickFiles()
    return paths.length ? importFiles(paths) : { imported: [], failed: [] }
  }))
  ipcMain.handle('library:updateBook', (_event, input: unknown) => result(async () => {
    const book = await engine.updateBook(input)
    await changed()
    return book
  }))
  ipcMain.handle('library:getPosition', (_event, input: unknown) => result(async () => {
    const book = await engine.findBook(bookIdSchema.parse(input))
    return reading.getPosition(book.id)
  }))
  ipcMain.handle('library:setPosition', (_event, input: unknown) => result(async () => {
    const position = positionSchema.parse(input)
    await engine.findBook(position.bookId)
    return reading.setPosition(position)
  }))
  ipcMain.handle('library:listBookmarks', (_event, input: unknown) => result(async () => {
    const book = await engine.findBook(bookIdSchema.parse(input))
    return reading.listBookmarks(book.id)
  }))
  ipcMain.handle('library:setBookmarks', (_event, input: unknown) => result(async () => {
    const { bookId, bookmarks } = bookmarkInputSchema.parse(input)
    await engine.findBook(bookId)
    return reading.setBookmarks(bookId, bookmarks)
  }))
}
