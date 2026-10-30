import { z } from 'zod'
import type { FastCardItem } from '../../../shared/fastcard'
import type { DatabaseConnection } from '../database/connection'

const optionalText = z.string().optional()
export const fastCardItemSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['text', 'image', 'video', 'translation', 'image-description', 'audio']),
  createdAt: z.number().finite(),
  title: optionalText, text: optionalText, imageUrl: optionalText, alt: optionalText,
  caption: optionalText, description: optionalText, originalText: optionalText,
  translatedText: optionalText, targetLanguage: optionalText,
  media: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('cached'), key: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp|webm|ogg|wav)$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.string(), bytes: z.number().int().positive() }),
    z.strictObject({ status: z.literal('missing'), error: z.string() }),
  ]).optional(),
  transcription: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('unavailable') }), z.strictObject({ status: z.literal('pending') }),
    z.strictObject({ status: z.literal('running'), attemptId: z.string() }),
    z.strictObject({ status: z.literal('ready'), text: z.string() }), z.strictObject({ status: z.literal('failed'), error: z.string() }),
  ]).optional(),
  tags: z.array(z.string()).optional(),
  source: z.strictObject({
    pageUrl: optionalText, pageTitle: optionalText, domain: optionalText,
    tabId: z.string().nullable().optional(), capturedAt: z.number().finite().optional(),
  }).optional(),
  video: z.strictObject({
    originalUrl: optionalText, pageUrl: optionalText, playableUrl: optionalText,
    downloadUrl: optionalText, posterUrl: optionalText, title: optionalText,
    author: optionalText, platform: optionalText, durationSeconds: z.number().finite().optional(),
    parseStatus: z.enum(['not_needed', 'resolved', 'failed']), error: optionalText,
  }).optional(),
}) satisfies z.ZodType<FastCardItem>

export class FastCardRepository {
  constructor(private readonly db: DatabaseConnection) {}

  list(): FastCardItem[] {
    return this.db.prepare('SELECT payload_json FROM fastcard_items ORDER BY position DESC')
      .all<{ payload_json: string }>().map(row => fastCardItemSchema.parse(JSON.parse(row.payload_json)))
  }

  add(input: unknown): FastCardItem {
    const item = fastCardItemSchema.parse(input)
    const payload = JSON.stringify(item)
    this.db.prepare(`
      INSERT INTO fastcard_items (id, payload_json, position)
      VALUES (?, ?, (SELECT position + 1 FROM fastcard_sequence WHERE singleton = 1))
      ON CONFLICT(id) DO NOTHING
    `).run(item.id, payload)
    const row = this.db.prepare('SELECT payload_json FROM fastcard_items WHERE id = ?')
      .get<{ payload_json: string }>(item.id)
    if (!row) throw new Error('FastCard write receipt missing')
    if (row.payload_json !== payload) throw new Error(`FastCard id already exists: ${item.id}`)
    return fastCardItemSchema.parse(JSON.parse(row.payload_json))
  }

  remove(input: unknown): void {
    const id = z.string().min(1).parse(input)
    this.assertUnlocked(id)
    this.db.prepare('DELETE FROM fastcard_items WHERE id = ?').run(id)
  }

  private assertUnlocked(id: string): void {
    if (this.db.prepare('SELECT item_id FROM fastcard_transfer_items WHERE item_id = ?').get(id)) throw new Error('暂存正在转存，请先完成或撤销')
  }

  update(item: FastCardItem): FastCardItem {
    this.assertUnlocked(item.id)
    const parsed = fastCardItemSchema.parse(item)
    if (!this.db.prepare('SELECT id FROM fastcard_items WHERE id = ?').get(item.id)) throw new Error('FastCard not found')
    this.db.prepare('UPDATE fastcard_items SET payload_json = ? WHERE id = ?').run(JSON.stringify(parsed), item.id)
    return parsed
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = action(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  loadTransfer(operationId: string): string | undefined {
    return this.db.prepare('SELECT payload_json FROM fastcard_transfers WHERE operation_id = ?')
      .get<{ payload_json: string }>(operationId)?.payload_json
  }

  pendingTransfers(): string[] {
    return this.db.prepare("SELECT payload_json FROM fastcard_transfers WHERE state NOT IN ('completed', 'undone') ORDER BY rowid")
      .all<{ payload_json: string }>().map(row => row.payload_json)
  }

  saveTransfer(operationId: string, libraryId: string, state: string, payload: string): void {
    this.db.prepare(`INSERT INTO fastcard_transfers(operation_id, library_id, state, payload_json) VALUES(?,?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json`).run(operationId, libraryId, state, payload)
  }

  reserve(operationId: string, items: FastCardItem[]): void {
    for (const item of items) {
      this.assertUnlocked(item.id)
      const current = this.list().find(value => value.id === item.id)
      if (JSON.stringify(current) !== JSON.stringify(item)) throw new Error('FastCard content version conflict')
      this.db.prepare('INSERT INTO fastcard_transfer_items(item_id,operation_id) VALUES(?,?)').run(item.id, operationId)
    }
  }

  positions(ids: string[]): Record<string, number> {
    return Object.fromEntries(ids.map(id => {
      const row = this.db.prepare('SELECT position FROM fastcard_items WHERE id = ?').get<{ position: number }>(id)
      if (!row) throw new Error('FastCard snapshot missing')
      return [id, row.position]
    }))
  }

  restoreItems(items: FastCardItem[], positions: Record<string, number>): void {
    for (const item of items) {
      const parsed = fastCardItemSchema.parse(item), payload = JSON.stringify(parsed)
      const existing = this.db.prepare('SELECT payload_json FROM fastcard_items WHERE id = ?').get<{ payload_json: string }>(item.id)
      if (existing && existing.payload_json !== payload) throw new Error('undo conflict: 暂存身份已被使用')
      if (!Number.isSafeInteger(positions[item.id])) throw new Error('FastCard snapshot position missing')
      this.db.prepare('INSERT INTO fastcard_items(id,payload_json,position) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(item.id, payload, positions[item.id])
    }
  }

  removeTransferred(operationId: string, items: FastCardItem[]): void {
    for (const item of items) {
      const lock = this.db.prepare('SELECT operation_id FROM fastcard_transfer_items WHERE item_id = ?').get<{ operation_id: string }>(item.id)
      if (lock?.operation_id !== operationId) throw new Error('FastCard transfer ownership conflict')
      const current = this.list().find(value => value.id === item.id)
      if (JSON.stringify(current) !== JSON.stringify(item)) throw new Error('FastCard content version conflict')
      this.db.prepare('DELETE FROM fastcard_items WHERE id = ?').run(item.id)
    }
    this.db.prepare('DELETE FROM fastcard_transfer_items WHERE operation_id = ?').run(operationId)
  }

  lastTarget(libraryId: string): string | undefined {
    return this.db.prepare('SELECT object_id FROM fastcard_targets WHERE library_id = ?').get<{ object_id: string }>(libraryId)?.object_id
  }

  rememberTarget(libraryId: string, objectId: string): void {
    this.db.prepare('INSERT INTO fastcard_targets(library_id,object_id) VALUES(?,?) ON CONFLICT(library_id) DO UPDATE SET object_id=excluded.object_id').run(libraryId, objectId)
  }

  clear(): void {
    for (const item of this.list()) this.assertUnlocked(item.id)
    this.db.prepare('DELETE FROM fastcard_items').run()
  }
}
