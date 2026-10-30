import type { IpcMain } from 'electron'
import { DatabaseRequestSchema, type DatabaseReply } from '../../../shared/document-database'
import type { DocumentDatabaseService } from './service'

/** Each request resolves the active vault's service after startup recovery; an unconfigured or switched vault is refused. */
export function registerDocumentDatabaseIPC(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Promise<DocumentDatabaseService>): void {
  ipcMain.handle('documentDatabase:request', async (_event, input: unknown): Promise<DatabaseReply> => {
    try {
      const service = await resolve()
      const request = DatabaseRequestSchema.parse(input)
      return { ok: true, value: await service.request(request) }
    } catch (error) {
      return { ok: false, code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'database_failed', message: String(error) }
    }
  })
}
