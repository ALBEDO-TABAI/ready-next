import type { IpcMain } from 'electron'
import { DatabaseRequestSchema, type DatabaseReply } from '../../../shared/document-database'
import type { DocumentDatabaseService } from './service'

/** The integration owner supplies the active-vault authorization and startup recovery barrier. */
export function registerDocumentDatabaseIPC(ipcMain: Pick<IpcMain, 'handle'>, service: DocumentDatabaseService, ready: Promise<void>, authorize: (path: string) => void): void {
  ipcMain.handle('documentDatabase:request', async (_event, input: unknown): Promise<DatabaseReply> => {
    try {
      authorize(service.root)
      const request = DatabaseRequestSchema.parse(input)
      await ready
      return { ok: true, value: await service.request(request) }
    } catch (error) {
      return { ok: false, code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'database_failed', message: String(error) }
    }
  })
}
