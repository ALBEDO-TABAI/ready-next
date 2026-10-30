export type PortableIdentityResult =
  | { ok: true; objectId: string; portable: true }
  | { ok: false; objectId: string; portable: false; code: 'version_conflict' | 'dirty_conflict' | 'operation_failed' | 'write_failed' | 'readback_mismatch' | 'identity_conflict' | 'not_markdown' | 'not_present'; message: string }

export interface ObjectLocation { objectId: string; path: string; revision: number }
export interface ObjectMovedEvent { objectId: string; from: string; to: string; revision: number }
export interface ObjectStateMigrationRequest { migrationId: string; paths: string[] }
export interface ObjectStateMigrationReport {
  migrationId: string
  state: 'prepared' | 'completed'
  resolved: Array<ObjectLocation & { sourcePath: string }>
  unresolved: Array<{ path: string; reason: string }>
}
export interface ObjectPresentationAPI {
  resolvePath(path: string): Promise<ObjectLocation>
  locate(objectId: string): Promise<ObjectLocation | null>
  prepareMigration(request: ObjectStateMigrationRequest): Promise<ObjectStateMigrationReport>
  completeMigration(migrationId: string): Promise<ObjectStateMigrationReport>
  onMoved(listener: (event: ObjectMovedEvent) => void): () => void
}
