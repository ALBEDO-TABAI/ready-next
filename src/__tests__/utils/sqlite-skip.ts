/**
 * Stage 5 — canonical sqlite-skip helper.
 *
 * Usage contract (enforced by scripts/check-sqlite-test-skip-pattern.cjs):
 *   - Tests that DIRECTLY load better-sqlite3 (require / await import /
 *     side-effect import / value `from 'better-sqlite3'`): must call this
 *     helper at the top of EVERY outer `test(...)` / `it(...)` block. Even
 *     fake-only blocks must guard, because the file as a whole loads sqlite
 *     and a future edit could turn any block into a sqlite-using one.
 *   - Tests that only transitively reach a nativeBackedModule via a value
 *     import (BFS depth ≤ 4): must import this helper and call it at least
 *     once in the file. Per-block enforcement is intentionally NOT applied to
 *     transitive files because most of their blocks use fake injection and
 *     don't actually trigger native load — forcing a guard would lose
 *     host-Node coverage. Files that don't actually trigger native load can
 *     register in scripts/test-coverage-exemptions.json under c4Exempt[].
 *
 * The skip message is structured so the static gate can prove intent. On host
 * Node where better-sqlite3 fails to bind, the test is skipped with a
 * `[ABI-SKIP][<reason>]` token. SQLite-backed acceptance is provided by
 * `npm run verify:native` under Electron runtime — see CLAUDE.md §6.13.
 */

import type { TestContext } from 'node:test'
import { createRequire } from 'node:module'

export type SqliteSkipReason =
  | 'native_abi_host_mismatch'
  | 'binding_missing'
  | 'sqlite_runtime_error'

const requireFromHere = createRequire(import.meta.url)

export interface SqliteSkipOptions {
  /**
   * Optional probe — defaults to constructing an in-memory better-sqlite3 DB.
   * Override only when you need to probe a different require path (e.g. tests
   * that use their own createRequire).
   */
  probe?: () => void
}

export interface SqliteTestDatabaseConstructor {
  new (
    filename: string,
    options?: import('better-sqlite3').Options,
  ): import('better-sqlite3').Database
}

/** Load the constructor only after the outer test has passed the ABI guard. */
export function loadSqliteAfterGuardForTest(): SqliteTestDatabaseConstructor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = requireFromHere('better-sqlite3') as any
  return (mod.default ?? mod) as SqliteTestDatabaseConstructor
}

export function skipIfSqliteUnavailable(
  t: Pick<TestContext, 'skip'>,
  label: string,
  options: SqliteSkipOptions = {},
): boolean {
  const probe = options.probe ?? defaultProbe
  try {
    probe()
    return false
  } catch (error) {
    const reason = classifySkipReason(error)
    const message = (error as Error)?.message ?? String(error)
    t.skip(`[ABI-SKIP][${reason}] ${label}: ${message}; covered by npm run verify:native`)
    return true
  }
}

function defaultProbe(): void {
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  db.close()
}

function classifySkipReason(error: unknown): SqliteSkipReason {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ERR_DLOPEN_FAILED') return 'native_abi_host_mismatch'
  if (code === 'MODULE_NOT_FOUND') return 'binding_missing'
  return 'sqlite_runtime_error'
}
