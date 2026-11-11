import { readStoredObjectPreview } from './preview'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { ObjectLocation, ObjectStateMigrationReport } from '../../../shared/object-identity'
import { ObjectRegistry } from './registry'

const pathSchema = z.string().min(1).refine(isAbsolute, 'Object path must be absolute')
const migrationSchema = z.object({ migrationId: z.string().min(1).max(160), paths: z.array(pathSchema).max(10000) }).strict()

/** Read-only file access. Receipts live in the existing primary settings table. */
export class ObjectPresentationService {
  constructor(readonly registry: ObjectRegistry) {}
  resolve(path: unknown): ObjectLocation {
    const row = this.registry.register(pathSchema.parse(path))
    return { objectId: row.id, path: row.current_path!, revision: row.revision }
  }
  locate(objectId: unknown): ObjectLocation | null {
    const row = this.registry.get(z.string().min(1).parse(objectId))
    return row?.status === 'present' && row.current_path
      ? { objectId: row.id, path: row.current_path, revision: row.revision } : null
  }
  private key(id: string): string { return `object-presentation-migration:${id}` }
  private read(id: string): { paths: string[]; report: ObjectStateMigrationReport } | null {
    const row = this.registry.db.prepare('SELECT value FROM settings WHERE key=?').get<{ value: string }>(this.key(id))
    return row ? JSON.parse(row.value) : null
  }
  private write(id: string, receipt: { paths: string[]; report: ObjectStateMigrationReport }): void {
    this.registry.db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(this.key(id), JSON.stringify(receipt), new Date().toISOString())
  }
  prepareMigration(value: unknown): ObjectStateMigrationReport {
    const { migrationId, paths } = migrationSchema.parse(value)
    const previous = this.read(migrationId)
    if (previous) {
      if (JSON.stringify(previous.paths) !== JSON.stringify(paths)) throw new Error('Object migration input changed')
      return previous.report
    }
    const report: ObjectStateMigrationReport = { migrationId, state: 'prepared', resolved: [], unresolved: [] }
    for (const path of paths) {
      try { report.resolved.push({ ...this.resolve(path), sourcePath: path }) }
      catch (error) { report.unresolved.push({ path, reason: error instanceof Error ? error.message : String(error) }) }
    }
    this.write(migrationId, { paths, report })
    return report
  }
  completeMigration(value: unknown): ObjectStateMigrationReport {
    const id = z.string().min(1).parse(value)
    const receipt = this.read(id)
    if (!receipt) throw new Error('Object migration was not prepared')
    receipt.report.state = 'completed'
    this.write(id, receipt)
    return receipt.report
  }
}

export function registerObjectIPC(ipcMain: {
  removeHandler(channel: string): void
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void
}, service: () => ObjectPresentationService): void {
  ipcMain.removeHandler('object:preview')
  ipcMain.handle('object:preview', (_event, ref) => readStoredObjectPreview(service().registry, ref))
  ipcMain.removeHandler('object:resolve-path')
  ipcMain.handle('object:resolve-path', (_event, path) => service().resolve(path))
  ipcMain.removeHandler('object:locate')
  ipcMain.handle('object:locate', (_event, id) => service().locate(id))
  ipcMain.removeHandler('object:migration-prepare')
  ipcMain.handle('object:migration-prepare', (_event, request) => service().prepareMigration(request))
  ipcMain.removeHandler('object:migration-complete')
  ipcMain.handle('object:migration-complete', (_event, id) => service().completeMigration(id))
}
