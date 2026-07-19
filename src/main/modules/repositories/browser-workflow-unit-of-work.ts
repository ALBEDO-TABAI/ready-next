export interface WorkflowStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

export interface WorkflowRawDatabase {
  prepare(sql: string): WorkflowStatement
  exec(sql: string): void
}

export interface WorkflowDatabaseAccessor {
  getRawDb(): WorkflowRawDatabase | null
}

export interface DurableWriteResult<T> {
  value: T
  /** Core truth is committed even if a derived FTS/recall repair fails. */
  derivedRepairError: Error | null
}

function isBusyOrLocked(error: unknown): boolean {
  const code = typeof error === 'object' && error
    ? String((error as { code?: unknown }).code || '')
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || /SQLITE_(?:BUSY|LOCKED)|database is (?:busy|locked)/i.test(message)
}

function waitOutsideTransaction(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/** One synchronous BEGIN IMMEDIATE boundary; retry waits only after rollback. */
export class BrowserWorkflowUnitOfWork {
  constructor(private readonly accessor: WorkflowDatabaseAccessor) {}

  runImmediate<T>(body: (db: WorkflowRawDatabase) => T): T {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = body(db)
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('browser_workflow_transaction_must_be_synchronous')
      }
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original SQLite error when BEGIN/COMMIT left no txn.
      }
      throw error
    }
  }

  async runImmediateWithRetry<T>(
    body: (db: WorkflowRawDatabase, attempt: number) => T,
    delaysMs: readonly number[] = [8, 24, 64],
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.runImmediate((db) => body(db, attempt))
      } catch (error) {
        const delay = delaysMs[attempt]
        if (!isBusyOrLocked(error) || delay === undefined) throw error
        await waitOutsideTransaction(delay)
      }
    }
  }

  async commitCoreCloseout<T>(input: {
    writeCore: (db: WorkflowRawDatabase, attempt: number) => T
    repairDerived?: (value: T) => Promise<void>
  }): Promise<DurableWriteResult<T>> {
    const value = await this.runImmediateWithRetry(input.writeCore)
    if (!input.repairDerived) return { value, derivedRepairError: null }
    try {
      await input.repairDerived(value)
      return { value, derivedRepairError: null }
    } catch (error) {
      return {
        value,
        derivedRepairError: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }
}
