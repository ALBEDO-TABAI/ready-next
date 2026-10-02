import { createHash } from 'node:crypto'
import type { MigrationDatabase } from '../migrations'
import { RSS_DEFAULT_DEFINITIONS, rssArticleRevision } from '../../../shared/rss-organization'

export const RSS_ORGANIZATION_MIGRATION = '125_rss_organization'

export function migrateRSSOrganization(db: MigrationDatabase): void {
  db.exec(`
    CREATE TABLE rss_definitions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('all','unread','starred','history','curated','topic')),
      name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL, position INTEGER NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 1, rule_revision INTEGER NOT NULL DEFAULT 1,
      CHECK(kind<>'all' OR visible=1)
    );
    CREATE TABLE rss_definition_filters (
      collection_id TEXT NOT NULL REFERENCES rss_definitions(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES rss_definitions(id) ON DELETE CASCADE,
      PRIMARY KEY(collection_id,topic_id)
    );
    CREATE TABLE rss_memberships (
      item_id TEXT NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
      definition_id TEXT NOT NULL REFERENCES rss_definitions(id) ON DELETE CASCADE,
      manual_decision INTEGER CHECK(manual_decision IN (0,1)),
      derived_decision INTEGER CHECK(derived_decision IN (0,1,2)),
      derived_origin TEXT CHECK(derived_origin IN ('legacy','model')),
      reason TEXT, evidence TEXT, content_revision TEXT, rule_revision INTEGER,
      PRIMARY KEY(item_id,definition_id)
    );
    CREATE INDEX idx_rss_memberships_definition ON rss_memberships(definition_id,item_id);
  `)
  const insert = db.prepare('INSERT INTO rss_definitions(id,kind,name,description,icon,position) VALUES (?,?,?,?,?,?)')
  for (const definition of RSS_DEFAULT_DEFINITIONS) insert.run(definition.id, definition.kind, definition.name, definition.description, definition.icon, definition.position)
  const rows = db.prepare(`SELECT i.id,i.ai_tags,i.content_revision,c.item_revision,c.body_revision
    FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id WHERE i.ai_tags IS NOT NULL AND trim(i.ai_tags)<>''`)
    .all<{ id: string; ai_tags: string; content_revision: string; item_revision: string | null; body_revision: string | null }>()
  const definitions = new Map<string, string>()
  for (const row of rows) {
    let id = definitions.get(row.ai_tags)
    if (!id) {
      id = `topic-${createHash('sha256').update(row.ai_tags).digest('hex').slice(0, 24)}`
      insert.run(id, 'topic', row.ai_tags, `历史分类“${row.ai_tags}”，可修改描述以定义新的归类标准。`, 'tag', 100 + definitions.size)
      definitions.set(row.ai_tags, id)
      db.prepare('INSERT INTO rss_definition_filters(collection_id,topic_id) VALUES (?,?)').run('all', id)
    }
    db.prepare(`INSERT INTO rss_memberships(item_id,definition_id,derived_decision,derived_origin,reason,content_revision,rule_revision)
      VALUES (?,?,1,'legacy',?,?,1)`).run(row.id, id, `从旧分类“${row.ai_tags}”迁移，尚未按新标准整理。`, rssArticleRevision(row.content_revision, row.item_revision, row.body_revision))
  }
  // Old migrations still describe the historical column; no live reader or writer uses it after this migration.
  db.exec('ALTER TABLE rss_items DROP COLUMN ai_tags')
  for (const table of ['rss_definitions', 'rss_definition_filters', 'rss_memberships']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER ${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
      BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;`)
  }
  db.exec('UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1')
}
