import type { MigrationDatabase } from '../migrations'

export const RSS_CATALOG_MIGRATION = '130_rss_catalog_revision'
export function migrateRSSCatalog(db: MigrationDatabase): void {
  db.exec(`ALTER TABLE rss_workspace_state ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 1;
    CREATE TRIGGER rss_catalog_workspace_change AFTER UPDATE OF revision ON rss_workspace_state
      WHEN OLD.revision<>NEW.revision BEGIN
      UPDATE rss_workspace_state SET catalog_revision=catalog_revision+1 WHERE id=1; END;`)
  // Task progress must invalidate catalog pages without disrupting the ordinary article list.
  for (const table of ['rss_sources', 'rss_analysis_jobs', 'rss_classification_results']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER rss_catalog_${table}_${event.toLowerCase()}
      AFTER ${event} ON ${table} BEGIN UPDATE rss_workspace_state SET catalog_revision=catalog_revision+1 WHERE id=1; END;`)
  }
}
