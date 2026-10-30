import { ReadingBeginSchema, ReadingEndSchema, type ReadingBegin, type ReadingEnd } from '../../../shared/calendar-layers'
import { ObjectRegistry, isInside } from '../object-service/registry'
import { checkedPath } from '../document-drafts/files'

export class LibrarySessions {
  constructor(private root: string, private registry: ObjectRegistry) {}
  begin(input: ReadingBegin): void {
    const value = ReadingBeginSchema.parse(input), object = this.registry.get(value.objectId)
    if (!object?.current_path || object.status !== 'present' || object.identity_state === 'conflict' || !isInside(this.root, object.current_path)) throw new Error('Reading object unavailable')
    checkedPath(this.root, object.current_path)
    const prior = this.registry.db.prepare('SELECT * FROM library_reading_sessions WHERE id=?').get<{ object_id: string; book_id: string; loc: string; started_at: number }>(value.id)
    if (prior) {
      if (prior.object_id !== value.objectId || prior.book_id !== value.bookId || prior.loc !== value.loc || prior.started_at !== value.startedAt) throw new Error('session_conflict')
      return
    }
    this.registry.db.prepare('INSERT INTO library_reading_sessions (id,object_id,book_id,loc,workspace_root,started_at) VALUES (?,?,?,?,?,?)').run(value.id, value.objectId, value.bookId, value.loc, this.root, value.startedAt)
  }
  end(input: ReadingEnd): void {
    const value = ReadingEndSchema.parse(input)
    const prior = this.registry.db.prepare('SELECT started_at,ended_at FROM library_reading_sessions WHERE id=? AND workspace_root=?').get<{ started_at: number; ended_at: number | null }>(value.id, this.root)
    if (!prior || value.endedAt < prior.started_at) throw new Error('Invalid reading session')
    if (prior.ended_at !== null && prior.ended_at !== value.endedAt) throw new Error('session_conflict')
    this.registry.db.prepare('UPDATE library_reading_sessions SET ended_at=? WHERE id=? AND workspace_root=? AND ended_at IS NULL').run(value.endedAt, value.id, this.root)
  }
}
