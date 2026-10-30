import { randomUUID } from 'node:crypto'
import type { AIModelConfig } from '../../../shared/ai-providers'
import { resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import type { FastCardItem } from '../../../shared/fastcard'
import type { FastCardRepository } from '../repositories/fastcard-repository'
import type { FastCardCollectionService } from './collection-service'
import type { FastCardMediaCache } from './media-cache'

export const QUICK_NOTE_SHORTCUT = 'Alt+Command+Space'
export type QuickNoteStatus = { registered: true } | { registered: false; error: string }
export interface QuickNoteHost {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  show(): Promise<void>
  hide(): void
  readClipboard(): { kind: 'text'; text: string } | { kind: 'image'; bytes: Buffer }
  notify(status: QuickNoteStatus): void
}
export interface AudioTranscriptionProvider {
  configuredModels(): AIModelConfig[]
  transcribe(config: AIModelConfig, bytes: Buffer, mime: string, attemptId: string): Promise<string>
}
/** No audio claim is inferred from OpenAI compatibility or a model name. The current shared
 * capability catalog has no audio declaration, so all current configurations remain unavailable. */
export function configuredAudioModel(configs: AIModelConfig[]): AIModelConfig | undefined {
  return configs.find(config => {
    const capabilities = resolveAIConfigCapabilities(config)
    return Boolean(config.apiKey && config.baseUrl && config.model && capabilities
      && 'supportsAudio' in capabilities && capabilities.supportsAudio === true)
  })
}
export class FastCardQuickNoteService {
  private ownsShortcut = false
  private status: QuickNoteStatus = { registered: false, error: '快记快捷键尚未注册' }
  constructor(private readonly host: QuickNoteHost, private readonly collection: FastCardCollectionService,
    private readonly repository: FastCardRepository, private readonly cache: FastCardMediaCache,
    private readonly transcription?: AudioTranscriptionProvider) {}
  start(): QuickNoteStatus {
    if (this.ownsShortcut) return this.status
    try {
      this.ownsShortcut = this.host.register(QUICK_NOTE_SHORTCUT, () => {
        this.host.show().catch(error => this.host.notify({ registered: false, error: `快记窗口打开失败：${String(error)}` }))
      })
      this.status = this.ownsShortcut ? { registered: true } : { registered: false, error: '⌥⌘Space 注册失败，请检查快捷键是否被占用' }
    } catch (error) { this.status = { registered: false, error: `快记快捷键注册失败：${String(error)}` } }
    this.host.notify(this.status)
    // Interrupted transcription is visible and is never automatically submitted again (may incur charges).
    for (const item of this.repository.list()) if (item.transcription?.status === 'running') {
      this.repository.update({ ...item, transcription: { status: 'failed', error: '转写被中断；音频已保留' } })
    }
    return this.status
  }
  close(): void { this.host.hide() }
  getStatus(): QuickNoteStatus { return this.status }
  stop(): void { if (this.ownsShortcut) { this.host.unregister(QUICK_NOTE_SHORTCUT); this.ownsShortcut = false } }
  text(text: string, itemId: string = randomUUID()): Promise<FastCardItem> {
    if (!text.trim()) throw new Error('快记内容为空')
    const existing = this.repository.list().find(item => item.id === itemId)
    if (existing) {
      if (existing.kind !== 'text' || existing.text !== text) throw new Error('Quick note id conflict')
      return Promise.resolve(existing)
    }
    return this.collection.add({ id: itemId, kind: 'text', text, createdAt: Date.now() })
  }
  clipboard(itemId: string = randomUUID()): Promise<FastCardItem> {
    const content = this.host.readClipboard()
    if (content.kind === 'text') return this.text(content.text, itemId)
    const media = this.cache.save(content.bytes, 'image/png')
    const existing = this.repository.list().find(item => item.id === itemId)
    if (existing) {
      if (existing.kind !== 'image' || existing.media?.status !== 'cached' || existing.media.sha256 !== media.sha256) throw new Error('Clipboard id conflict')
      return Promise.resolve(existing)
    }
    return Promise.resolve(this.repository.add({ id: itemId, kind: 'image', createdAt: Date.now(), title: '剪贴板图片', media }))
  }
  recording(bytes: Buffer, mime: string, itemId: string = randomUUID()): FastCardItem {
    if (!mime.startsWith('audio/')) throw new Error('Expected audio recording')
    const media = this.cache.save(bytes, mime)
    const existing = this.repository.list().find(item => item.id === itemId)
    if (existing) {
      if (existing.kind !== 'audio' || existing.media?.status !== 'cached' || existing.media.sha256 !== media.sha256) throw new Error('Recording id conflict')
      return existing
    }
    // The collection receipt must exist before consulting any transcription configuration.
    const item = this.repository.add({ id: itemId, kind: 'audio', createdAt: Date.now(), title: '录音', media, transcription: { status: 'pending' } })
    try {
      if (configuredAudioModel(this.transcription?.configuredModels() ?? [])) return item
      return this.repository.update({ ...item, transcription: { status: 'unavailable' } })
    } catch (error) { return this.repository.update({ ...item, transcription: { status: 'failed', error: String(error) } }) }
  }
  async transcribe(itemId: string): Promise<FastCardItem> {
    const item = this.repository.list().find(value => value.id === itemId)
    if (item?.kind !== 'audio' || item.media?.status !== 'cached') throw new Error('Recording not found')
    if (item.transcription?.status === 'ready') return item
    if (item.transcription?.status === 'running') throw new Error('转写正在进行，请勿重复提交')
    const provider = this.transcription, model = configuredAudioModel(provider?.configuredModels() ?? [])
    if (!provider || !model) return this.repository.update({ ...item, transcription: { status: 'unavailable' } })
    const attemptId = randomUUID()
    this.repository.update({ ...item, transcription: { status: 'running', attemptId } })
    let result: FastCardItem
    try { result = { ...item, transcription: { status: 'ready', text: await provider.transcribe(model, this.cache.read(item.media), item.media.mime, attemptId) } } }
    catch (error) { result = { ...item, transcription: { status: 'failed', error: String(error) } } }
    return this.repository.update(result)
  }
  playback(itemId: string): string {
    const item = this.repository.list().find(value => value.id === itemId)
    if (item?.kind !== 'audio' || item.media?.status !== 'cached') throw new Error('Recording not found')
    return `data:${item.media.mime};base64,${this.cache.read(item.media).toString('base64')}`
  }
}
