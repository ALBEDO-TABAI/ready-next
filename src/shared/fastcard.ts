export type FastCardItemKind = 'text' | 'image' | 'video' | 'translation' | 'image-description' | 'audio'

export interface FastCardSource {
  pageUrl?: string
  pageTitle?: string
  domain?: string
  tabId?: string | null
  capturedAt?: number
}

export interface FastCardVideoMeta {
  originalUrl?: string
  pageUrl?: string
  playableUrl?: string
  downloadUrl?: string
  posterUrl?: string
  title?: string
  author?: string
  platform?: string
  durationSeconds?: number
  parseStatus: 'not_needed' | 'resolved' | 'failed'
  error?: string
}

export interface FastCardItem {
  id: string
  kind: FastCardItemKind
  createdAt: number
  title?: string
  text?: string
  imageUrl?: string
  alt?: string
  caption?: string
  description?: string
  originalText?: string
  translatedText?: string
  targetLanguage?: string
  source?: FastCardSource
  video?: FastCardVideoMeta
  tags?: string[]
  media?: FastCardMedia
  transcription?: FastCardTranscription
}

export interface BrowserFastCardBaseTarget extends FastCardSource {
  kind: 'text' | 'image' | 'video'
}

export interface BrowserFastCardTextTarget extends BrowserFastCardBaseTarget {
  kind: 'text'
  text: string
}

export interface BrowserFastCardImageTarget extends BrowserFastCardBaseTarget {
  kind: 'image'
  imageUrl: string
  alt?: string
  caption?: string
}

export interface BrowserFastCardVideoTarget extends BrowserFastCardBaseTarget {
  kind: 'video'
  videoUrl?: string
  posterUrl?: string
  title?: string
  sources?: string[]
}

export type BrowserFastCardTarget =
  | BrowserFastCardTextTarget
  | BrowserFastCardImageTarget
  | BrowserFastCardVideoTarget

export type BrowserFastCardContextAction =
  | 'save-to-canvas'
  | 'add-to-fastcard'
  | 'describe-image'
  | 'translate-selection'

export interface BrowserFastCardContextActionEvent {
  action: BrowserFastCardContextAction
  target: BrowserFastCardTarget
}

export interface FastCardTranslateRequest {
  text: string
  targetLanguage: string
  source?: FastCardSource
}

export interface FastCardTranslateResult {
  originalText: string
  translatedText: string
  targetLanguage: string
}

export interface FastCardDescribeImageRequest {
  imageUrl: string
  source?: FastCardSource
}

export interface FastCardDescribeImageResult {
  imageUrl: string
  description: string
}

export interface FastCardResolveVideoRequest {
  target: BrowserFastCardVideoTarget
}

export interface FastCardResolveVideoResult {
  video: FastCardVideoMeta
}

export interface FastCardOverlayBounds {
  left: number
  top: number
  width: number
  height: number
}

export type FastCardResultPanelData =
  | {
    kind: 'translation'
    status: 'loading' | 'ready' | 'error'
    originalText: string
    translatedText?: string
    targetLanguage: string
    error?: string
  }
  | {
    kind: 'image-description'
    status: 'loading' | 'ready' | 'error'
    imageUrl: string
    description?: string
    error?: string
  }

export type FastCardSyncState =
  | { kind: 'idle' | 'loading' | 'saving' | 'ready' }
  | { kind: 'error'; message: string }

export interface FastCardStorageAPI {
  listFastCardItems: () => Promise<FastCardIPCResult<FastCardItem[]>>
  addFastCardItem: (item: FastCardItem) => Promise<FastCardIPCResult<FastCardItem>>
  removeFastCardItem: (id: string) => Promise<FastCardIPCResult<void>>
  clearFastCardItems: () => Promise<FastCardIPCResult<void>>
}

export interface FastCardOverlaySnapshot {
  mode: 'fastcard' | 'result'
  syncState?: FastCardSyncState
  items: FastCardItem[]
  resultPanel?: FastCardResultPanelData | null
  bounds: FastCardOverlayBounds
}

export type FastCardOverlayCommand =
  | { type: 'collapse' }
  | { type: 'close-result' }
  | { type: 'add-result' }
  | { type: 'clear' }
  | { type: 'save-canvas'; itemIds: string[] }
  | { type: 'insert-chat'; itemIds?: string[] }
  | { type: 'remove-item'; id: string }
  | { type: 'target-language-change'; targetLanguage: string }

export interface FastCardIPCResult<T> {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
}

export function createFastCardId(prefix = 'fastcard'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function extractFastCardDomain(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function detectFastCardTargetLanguage(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return 'zh-CN'
  const cjk = trimmed.match(/[\u3400-\u9fff]/g)?.length || 0
  const visible = trimmed.replace(/\s/g, '').length || 1
  return cjk / visible >= 0.25 ? 'en' : 'zh-CN'
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function buildFastCardItemTags(item: Pick<FastCardItem, 'kind' | 'source' | 'video'>): string[] {
  const tags = new Set<string>(['fastcard', item.kind])
  const domain = item.source?.domain || extractFastCardDomain(item.source?.pageUrl)
  if (domain) tags.add(`source-${normalizeTag(domain)}`)
  if (item.kind === 'translation') tags.add('translation')
  if (item.kind === 'image-description') tags.add('image-description')
  if (item.kind === 'video') tags.add('video-reference')
  const platform = item.video?.platform
  if (platform) tags.add(`platform-${normalizeTag(platform)}`)
  return Array.from(tags).filter(Boolean)
}

export function buildFastCardTags(items: FastCardItem[]): string[] {
  const tags = new Set<string>(['fastcard'])
  for (const item of items) {
    for (const tag of buildFastCardItemTags(item)) tags.add(tag)
  }
  return Array.from(tags).filter(Boolean).sort()
}

function mdEscape(value: string | undefined): string {
  return String(value || '').replace(/\r\n/g, '\n').trim()
}

function sourceLine(source: FastCardSource | undefined): string {
  const label = source?.pageTitle || source?.domain || source?.pageUrl || ''
  if (!source?.pageUrl) return label ? `来源：${label}` : ''
  return `来源：[${label || source.pageUrl}](${source.pageUrl})`
}

function renderItem(item: FastCardItem, index: number): string {
  const title = item.title || ({
    audio: '录音',
    text: '文字',
    image: '图片',
    video: '视频',
    translation: '翻译',
    'image-description': '图片反推描述',
  } satisfies Record<FastCardItemKind, string>)[item.kind]
  const lines = [`## ${index + 1}. ${title}`]
  const source = sourceLine(item.source)
  if (source) lines.push('', source)
  const tags = item.tags?.length ? item.tags : buildFastCardItemTags(item)
  if (tags.length) lines.push(`标签：${tags.map((tag) => `#${tag}`).join(' ')}`)

  if (item.kind === 'text' && item.text) {
    lines.push('', mdEscape(item.text))
  }
  if (item.kind === 'image') {
    if (item.imageUrl) lines.push('', `![${item.alt || item.caption || 'image'}](${item.imageUrl})`)
    if (item.caption) lines.push('', mdEscape(item.caption))
  }
  if (item.kind === 'translation') {
    lines.push('', '原文：', mdEscape(item.originalText || item.text || ''))
    lines.push('', `译文（${item.targetLanguage || ''}）：`, mdEscape(item.translatedText || ''))
  }
  if (item.kind === 'image-description') {
    if (item.imageUrl) lines.push('', `图片：${item.imageUrl}`)
    lines.push('', mdEscape(item.description || ''))
  }
  if (item.kind === 'video') {
    const video = item.video
    if (video?.title) lines.push('', `标题：${video.title}`)
    if (video?.author) lines.push(`作者：${video.author}`)
    if (video?.platform) lines.push(`平台：${video.platform}`)
    if (video?.originalUrl) lines.push(`原始链接：${video.originalUrl}`)
    if (video?.playableUrl) lines.push(`播放链接：${video.playableUrl}`)
    if (video?.downloadUrl && video.downloadUrl !== video.playableUrl) lines.push(`下载链接：${video.downloadUrl}`)
    if (video?.posterUrl) lines.push(`封面：${video.posterUrl}`)
    if (video?.parseStatus === 'failed' && video.error) lines.push(`解析状态：失败 - ${video.error}`)
  }

  return lines.filter((line, idx, list) => line || list[idx - 1] !== '').join('\n')
}

export function renderFastCardMarkdown(items: FastCardItem[], now = new Date()): string {
  const created = now.toISOString()
  const tags = buildFastCardTags(items)
  const frontmatter = [
    '---',
    `created: "${created}"`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    '---',
  ].join('\n')
  const body = items.length
    ? items.map((item, index) => renderItem(item, index)).join('\n\n')
    : '_FastCard is empty._'
  return `${frontmatter}\n\n# FastCard\n\n${body}\n`
}

export function createFastCardMarkdownFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `FastCard-${stamp}.md`
}

// C7: only Main can issue a cached receipt; a remote URL never proves offline availability.
export type FastCardMedia =
  | { status: 'cached'; key: string; sha256: string; mime: string; bytes: number }
  | { status: 'missing'; error: string }
export type FastCardTranscription =
  | { status: 'unavailable' | 'pending' }
  | { status: 'running'; attemptId: string }
  | { status: 'ready'; text: string }
  | { status: 'failed'; error: string }
export type FastCardCanvasTarget =
  | { kind: 'existing'; objectId: string }
  | { kind: 'new'; title: string; parentObjectId?: string; parentPath?: string }
export interface FastCardTransferRequest {
  operationId: string
  itemIds: string[]
  target?: FastCardCanvasTarget
  position?: { x: number; y: number }
}
export interface FastCardTransferReceipt {
  state: 'completed'; operationId: string; objectId: string; title: string; nodeIds: string[]
}
export interface FastCardTransferAPI {
  transfer(input: FastCardTransferRequest): Promise<FastCardIPCResult<FastCardTransferReceipt>>
  undo(operationId: string): Promise<FastCardIPCResult<{ state: 'undone' }>>
  targets(): Promise<FastCardIPCResult<Array<{ objectId: string; title: string }>>>
  pending(): Promise<FastCardIPCResult<FastCardTransferRequest[]>>
}
export function isFastCardTransferAPI(value: unknown): value is FastCardTransferAPI {
  return typeof value === 'object' && value !== null
    && 'transfer' in value && typeof value.transfer === 'function'
    && 'undo' in value && typeof value.undo === 'function'
    && 'targets' in value && typeof value.targets === 'function'
    && 'pending' in value && typeof value.pending === 'function'
}
export interface FastCardQuickNoteAPI {
  quickClose(): Promise<FastCardIPCResult<void>>
  quickStatus(): Promise<FastCardIPCResult<{ registered: boolean; error?: string }>>
  quickText(input: { text: string; itemId: string }): Promise<FastCardIPCResult<FastCardItem>>
  quickClipboard(itemId: string): Promise<FastCardIPCResult<FastCardItem>>
  quickRecording(input: { bytes: Uint8Array; mime: string; itemId: string }): Promise<FastCardIPCResult<FastCardItem>>
  transcribe(itemId: string): Promise<FastCardIPCResult<FastCardItem>>
  playback(itemId: string): Promise<FastCardIPCResult<string>>
}
export function isFastCardQuickNoteAPI(value: unknown): value is FastCardQuickNoteAPI {
  return typeof value === 'object' && value !== null
    && 'quickClose' in value && typeof value.quickClose === 'function'
    && 'quickStatus' in value && typeof value.quickStatus === 'function'
    && 'quickText' in value && typeof value.quickText === 'function'
    && 'quickClipboard' in value && typeof value.quickClipboard === 'function'
    && 'quickRecording' in value && typeof value.quickRecording === 'function'
    && 'transcribe' in value && typeof value.transcribe === 'function'
    && 'playback' in value && typeof value.playback === 'function'
}
