import type { DatabaseConnection } from '../../database/connection'

export function migrateDateMentions(db: Pick<DatabaseConnection, 'exec'>): void {
  db.exec(`
    CREATE TABLE calendar_date_mention_documents (
      object_id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL
    );
    CREATE TABLE calendar_date_mentions (
      id TEXT PRIMARY KEY NOT NULL, object_id TEXT NOT NULL,
      start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL, title TEXT NOT NULL,
      date TEXT NOT NULL, time_zone TEXT NOT NULL, start_time INTEGER NOT NULL,
      offset_minutes INTEGER, revision INTEGER NOT NULL CHECK(revision > 0),
      cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1))
    );
    CREATE INDEX calendar_date_mentions_document ON calendar_date_mentions(object_id);
  `)
}
