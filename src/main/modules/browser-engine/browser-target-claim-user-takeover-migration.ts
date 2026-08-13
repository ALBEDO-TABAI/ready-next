interface BrowserTargetClaimMigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    get<T = unknown>(...params: unknown[]): T | undefined
    all<T = unknown>(...params: unknown[]): T[]
  }
}

const OLD_USER_OWNED_CHECK = /\(\s*state\s+IN\s*\(\s*'user_owned'\s*,\s*'suspended'\s*\)\s*AND\s+suspension_checkpoint_id\s+IS\s+NOT\s+NULL\s+AND\s+suspension_reason\s+IS\s+NOT\s+NULL\s*\)/i

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Public continuation is retired, so a physical user takeover must not require
 * a resumable checkpoint. Rebuild from the installed table SQL instead of a
 * frozen column list: deployed databases can contain later Browser claim
 * columns and objects that this migration must preserve byte-for-byte.
 */
export function applyBrowserTargetClaimUserTakeoverMigration(
  db: BrowserTargetClaimMigrationDatabase,
): void {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_target_claims'",
  ).get<{ sql: string | null }>()
  if (!table?.sql) return
  if (table.sql.includes("state = 'user_owned' AND suspension_reason IS NOT NULL")) return
  if (!OLD_USER_OWNED_CHECK.test(table.sql)) {
    throw new Error('browser_target_claim_user_takeover_schema_unrecognized')
  }

  const columns = db.prepare('PRAGMA table_info(browser_target_claims)')
    .all<{ name: string }>()
    .map((column) => quoteIdentifier(column.name))
  if (columns.length === 0) return
  const objects = db.prepare(`
    SELECT sql
      FROM sqlite_master
     WHERE tbl_name = 'browser_target_claims'
       AND type IN ('index', 'trigger')
       AND sql IS NOT NULL
     ORDER BY type, name
  `).all<{ sql: string }>()

  const nextTableSql = table.sql.replace(
    OLD_USER_OWNED_CHECK,
    "((state = 'suspended' AND suspension_checkpoint_id IS NOT NULL AND suspension_reason IS NOT NULL) OR (state = 'user_owned' AND suspension_reason IS NOT NULL))",
  )
  const columnList = columns.join(', ')
  const legacyAlter = Number(db.prepare('PRAGMA legacy_alter_table').get<{ legacy_alter_table: number }>()?.legacy_alter_table || 0)
  db.exec('PRAGMA legacy_alter_table = ON')
  try {
    db.exec('ALTER TABLE browser_target_claims RENAME TO browser_target_claims_before_user_takeover_109')
    db.exec(nextTableSql)
    db.exec(`
      INSERT INTO browser_target_claims (${columnList})
      SELECT ${columnList} FROM browser_target_claims_before_user_takeover_109;
      DROP TABLE browser_target_claims_before_user_takeover_109;
    `)
    for (const object of objects) db.exec(object.sql)
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacyAlter ? 'ON' : 'OFF'}`)
  }
}
