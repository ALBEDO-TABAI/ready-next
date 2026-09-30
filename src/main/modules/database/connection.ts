

export interface DatabaseStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}


export interface DatabaseConnection {
  exec(sql: string): void
  prepare(sql: string): DatabaseStatement
  close(): void
  // better-sqlite3 exposes pragma() at runtime; declared optional so mocks /
  // in-memory fallbacks that omit it stay structurally compatible.
  pragma?(source: string, options?: { simple?: boolean }): unknown
}


export class DatabaseUnavailableError extends Error {
  readonly code = 'database_unavailable'
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'DatabaseUnavailableError'
    this.cause = cause
  }
}


export function assertDatabaseConnectionReady(
  db: DatabaseConnection | null,
  label = 'database',
): asserts db is DatabaseConnection {
  if (!db) {
    throw new DatabaseUnavailableError(`${label} is not available`)
  }
}
