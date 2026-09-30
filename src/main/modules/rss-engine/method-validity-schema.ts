import type { MigrationDatabase } from '../migrations'

export const RSS_METHOD_VALIDITY_MIGRATION = '086_rss_effective_method_versions'
export function migrateRSSMethodValidity(db: MigrationDatabase): void {
  // Effective query membership now excludes superseded model methods. Old query references cannot retain their old membership promise.
  db.exec('UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1')
}
