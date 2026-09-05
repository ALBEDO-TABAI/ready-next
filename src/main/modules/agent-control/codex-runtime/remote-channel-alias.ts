import { createHash } from 'node:crypto'
import type { DatabaseManager } from '../../database'
import type { CodexBindingRepository } from './codex-binding-repository'

export function ensureRemoteChannelAlias(input: {
  database: DatabaseManager
  repository: CodexBindingRepository
  scopeId: string
  runtimeManifestDigest: string
  protocolSchemaDigest: string
}): void {
  const scope = input.database.getConversationScope(input.scopeId)
  if (!scope || scope.source_kind !== 'channel') throw new Error('remote_scope_missing')
  if (input.repository.readLatestAliasGeneration(scope.id) !== null) return
  const db = input.database.getRawDb()
  if (!db) throw new Error('remote_database_unavailable')
  const ownsTransaction = !db.inTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    input.repository.createEmptyAliasGenerationInOpenTransaction({
      threadBindingId: `codex-thread-${createHash('sha256').update(`${scope.id}\u00001`).digest('hex').slice(0, 32)}`,
      aliasId: scope.id, aliasGeneration: 1, readyScopeId: scope.id,
      runtimeManifestDigest: input.runtimeManifestDigest,
      protocolSchemaDigest: input.protocolSchemaDigest,
      createdAt: new Date().toISOString(),
    })
    if (ownsTransaction) db.exec('COMMIT')
  } catch (error) {
    if (ownsTransaction && db.inTransaction) db.exec('ROLLBACK')
    throw error
  }
}
