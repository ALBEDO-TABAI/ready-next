import type { FastCardItem } from '../../../shared/fastcard'
import { fastCardItemSchema, type FastCardRepository } from '../repositories/fastcard-repository'
import type { FastCardMediaCache } from './media-cache'

export class FastCardCollectionService {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly repository: FastCardRepository, private readonly cache: FastCardMediaCache) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result
  }
  add(input: unknown): Promise<FastCardItem> {
    return this.serial(async () => {
      const parsed = fastCardItemSchema.parse(input)
      // Renderer cannot mint local-file receipts or transcription state.
      if (parsed.media || parsed.transcription || parsed.kind === 'audio') throw new Error('Media receipts are Main-owned')
      const existing = this.repository.list().find(item => item.id === parsed.id)
      if (existing) {
        const { media: _media, ...original } = existing
        if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new Error('FastCard id already exists')
        if ((existing.kind === 'image' || existing.kind === 'image-description') && !existing.media) {
          return this.repository.update({ ...existing, media: existing.imageUrl ? await this.cache.download(existing.imageUrl) : { status: 'missing', error: '图片网址缺失' } })
        }
        return existing
      }
      const item = this.repository.add(parsed)
      if (item.kind === 'image' || item.kind === 'image-description') {
        return this.repository.update({ ...item, media: item.imageUrl ? await this.cache.download(item.imageUrl) : { status: 'missing', error: '图片网址缺失' } })
      }
      return item
    })
  }
  list(): Promise<FastCardItem[]> {
    return this.serial(async () => {
      // Absence of media is the durable one-time backfill marker, including interrupted old collections.
      for (const item of this.repository.list()) {
        if ((item.kind === 'image' || item.kind === 'image-description') && !item.media) {
          this.repository.update({ ...item, media: item.imageUrl ? await this.cache.download(item.imageUrl) : { status: 'missing', error: '图片网址缺失' } })
        }
      }
      return this.repository.list()
    })
  }
}
