import type { DatabaseConnection } from '../../../database/connection'
import type { CodexBindingRepository } from '../codex-binding-repository'
import { CodexToolBindingRepository } from '../codex-tool-binding-repository'
import type { CodexBindingRepositoryContract } from './types'

/** What every binding-repository operation shares: one connection, the runtime contract and the repository. */
export type CodexBindingContext = {
  readonly db: DatabaseConnection
  readonly currentContract: CodexBindingRepositoryContract | undefined
  readonly toolBindings: CodexToolBindingRepository
  /** The repository itself: public operations are called through it, as `this.x(...)` was before the split. */
  readonly self: CodexBindingRepository
  immediate<T>(work: () => T): T
}

export function createCodexBindingContext(
  db: DatabaseConnection,
  currentContract: CodexBindingRepositoryContract | undefined,
  self: CodexBindingRepository,
): CodexBindingContext {
  return {
    db,
    currentContract,
    self,
    toolBindings: new CodexToolBindingRepository(db),
    immediate<T>(work: () => T): T {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = work()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}
