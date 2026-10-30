import { z } from 'zod'
import type { FastCardItem } from '../../../shared/fastcard'
import type { DatabaseConnection } from '../database/connection'

const optionalText = z.string().optional()
const itemSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['text', 'image', 'video', 'translation', 'image-description']),
  createdAt: z.number().finite(),
  title: optionalText, text: optionalText, imageUrl: optionalText, alt: optionalText,
  caption: optionalText, description: optionalText, originalText: optionalText,
  translatedText: optionalText, targetLanguage: optionalText,
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
      .all<{ payload_json: string }>().map(row => itemSchema.parse(JSON.parse(row.payload_json)))
  }

  add(input: unknown): FastCardItem {
    const item = itemSchema.parse(input)
    const payload = JSON.stringify(item)
    this.db.prepare(`
      INSERT INTO fastcard_items (id, payload_json, position)
      VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM fastcard_items))
      ON CONFLICT(id) DO NOTHING
    `).run(item.id, payload)
    const row = this.db.prepare('SELECT payload_json FROM fastcard_items WHERE id = ?')
      .get<{ payload_json: string }>(item.id)
    if (!row) throw new Error('FastCard write receipt missing')
    if (row.payload_json !== payload) throw new Error(`FastCard id already exists: ${item.id}`)
    return itemSchema.parse(JSON.parse(row.payload_json))
  }

  remove(input: unknown): void {
    const id = z.string().min(1).parse(input)
    this.db.prepare('DELETE FROM fastcard_items WHERE id = ?').run(id)
  }

  clear(): void {
    this.db.prepare('DELETE FROM fastcard_items').run()
  }
}
