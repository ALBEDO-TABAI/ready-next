import { readFileSync } from 'node:fs'
import { ObjectRegistry, canonicalObjectPath } from '../../object-service/registry'
import type { DateMentionService } from './service'
import { systemTimeZone } from '../../../../shared/calendar/tz'
import type { ReminderFirePayload } from '../../../../shared/calendar-types'

/** Receives confirmed index batches. Identity reconciliation must have finished before calling this owner. */
export class DateMentionDocuments {
  constructor(private registry: ObjectRegistry, private reminders: DateMentionService, private timeZone = systemTimeZone) {}

  sync(objectId: string): void {
    const object = this.registry.get(objectId)
    if (!object || object.status !== 'present' || object.kind !== 'markdown' || !object.current_path) {
      this.reminders.remove(objectId)
      return
    }
    try { this.reminders.sync(objectId, readFileSync(object.current_path, 'utf8'), this.timeZone()) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') this.reminders.remove(objectId)
      else throw error
    }
  }

  /** Rebuild uses the same durable object IDs; missing/deleted objects revoke their reminders. */
  rebuild(): void {
    for (const object of this.registry.list()) if (object.kind === 'markdown') this.sync(object.id)
  }

  changed(paths: readonly string[]): void {
    const changed = new Set(paths.map(canonicalObjectPath))
    for (const object of this.registry.list()) {
      if (object.kind === 'markdown' && (changed.has(object.last_known_path) || (object.current_path && changed.has(object.current_path)))) this.sync(object.id)
    }
  }

  claim(payload: ReminderFirePayload): boolean {
    if (!payload.mention) return false
    // A filesystem change may be waiting in the index batch when an old timer fires.
    this.sync(payload.mention.objectId)
    return this.reminders.claim(payload)
  }
}
