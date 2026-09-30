import type { MigrationDatabase } from '../migrations'

export const RSS_CONTENT_MIGRATION = '079_rss_workspace_content'

export function migrateRSSContent(db: MigrationDatabase): void {
  db.exec(`
    ALTER TABLE rss_items ADD COLUMN content_revision TEXT NOT NULL DEFAULT '';
    ALTER TABLE rss_items ADD COLUMN first_seen_at INTEGER;
    UPDATE rss_items SET content_revision=lower(hex(randomblob(16))), first_seen_at=fetched_at;
    CREATE INDEX idx_rss_workspace_order ON rss_items(COALESCE(published_at,first_seen_at),id);
    CREATE TABLE rss_workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT INTO rss_workspace_state VALUES (1, 1);
    CREATE TABLE rss_article_content (
      item_id TEXT PRIMARY KEY REFERENCES rss_items(id) ON DELETE CASCADE,
      item_revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('loading','ready','partial','stale','login_required','failed')),
      request_id TEXT,
      body_revision TEXT,
      markdown TEXT,
      source_url TEXT NOT NULL,
      fetched_at INTEGER,
      error TEXT
    );
    CREATE TRIGGER rss_item_content_insert AFTER INSERT ON rss_items BEGIN
      UPDATE rss_items SET content_revision=lower(hex(randomblob(16))),
        first_seen_at=COALESCE(NEW.first_seen_at,NEW.fetched_at,unixepoch()) WHERE id=NEW.id;
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_item_content_change
    AFTER UPDATE OF title,summary,link,source_id,author,published_at,cover_image ON rss_items
    WHEN OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.link IS NOT NEW.link
      OR OLD.source_id IS NOT NEW.source_id OR OLD.author IS NOT NEW.author
      OR OLD.published_at IS NOT NEW.published_at OR OLD.cover_image IS NOT NEW.cover_image
    BEGIN
      UPDATE rss_items SET content_revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
      UPDATE rss_article_content SET status='stale',request_id=NULL,markdown=NULL,
        body_revision=NULL,source_url=NEW.link,error=NULL WHERE item_id=NEW.id;
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_item_read_state_change AFTER UPDATE OF read,starred,inbox_visible ON rss_items
    WHEN OLD.read IS NOT NEW.read OR OLD.starred IS NOT NEW.starred OR OLD.inbox_visible IS NOT NEW.inbox_visible
    BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER rss_item_content_delete AFTER DELETE ON rss_items
    BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER rss_source_metadata_change AFTER UPDATE OF name,url,group_name,enabled ON rss_sources
    WHEN OLD.name IS NOT NEW.name OR OLD.url IS NOT NEW.url OR OLD.group_name IS NOT NEW.group_name OR OLD.enabled IS NOT NEW.enabled
    BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER rss_body_insert AFTER INSERT ON rss_article_content
    BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER rss_body_update AFTER UPDATE ON rss_article_content
    BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER rss_body_delete AFTER DELETE ON rss_article_content
    BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;
  `)
}
