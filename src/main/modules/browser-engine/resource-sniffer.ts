import type { BrowserNetworkObserverHandle, BrowserNetworkEventRecord } from './network-observer-service'

export type BrowserResourceKind = 'video' | 'audio' | 'image' | 'document' | 'json' | 'stream' | 'unknown'
export type BrowserResourceSource = 'dom' | 'performance' | 'network' | 'response_body'

export interface BrowserResourceCandidate {
  id: string
  kind: BrowserResourceKind
  url: string
  sourcePageUrl: string
  sourceTabId: string
  source: BrowserResourceSource
  mimeType?: string
  status?: number
  score: number
  evidence: string[]
  suggestedName?: string
  referer?: string
  downloadHeaders?: Record<string, string>
}

export interface BrowserResourceInspectOptions {
  tabId?: string | null
  url?: string | null
  kinds?: BrowserResourceKind[]
  waitMs?: number
  maxCandidates?: number
  signal?: AbortSignal
}

export interface BrowserResourceInspectResult {
  ok: boolean
  sourcePageUrl: string
  sourceTabId: string | null
  candidateCount: number
  candidates: BrowserResourceCandidate[]
  evidence: string[]
  nextActions?: string[]
  errorCode?: string
  message?: string
}

interface BrowserResourceSnifferController {
  getActiveTab?: () => { id: string; url: string; title?: string; active?: boolean } | undefined
  getTabList?: () => Array<{ id: string; url: string; title?: string; active?: boolean }>
  navigate?: (tabId: string | null, url: string) => Promise<{ success: boolean; error?: string }>
  executeJS: (tabId: string | null, code: string) => Promise<unknown>
  startNetworkObserver?: (tabId: string, options?: { maxEvents?: number }) => Promise<BrowserNetworkObserverHandle>
}

interface RawPageResource {
  url?: string
  kind?: BrowserResourceKind
  source?: 'dom' | 'performance'
  mimeType?: string
  evidence?: string[]
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

function normalizeUrl(raw: string, baseUrl: string): string {
  try {
    return new URL(raw, baseUrl || undefined).href
  } catch {
    return ''
  }
}

function urlSearchMime(raw: string): string {
  try {
    const parsed = new URL(raw)
    return String(parsed.searchParams.get('mime') || parsed.searchParams.get('mime_type') || '').toLowerCase()
  } catch {
    return ''
  }
}

function inferKind(url: string, mimeType?: string, resourceType?: string): BrowserResourceKind {
  const mime = String(mimeType || '').toLowerCase()
  const type = String(resourceType || '').toLowerCase()
  const lower = url.toLowerCase()
  const queryMime = urlSearchMime(url)
  if (mime.startsWith('video/') || type === 'media' || /\.(mp4|webm|mov|m4v|mkv|ogv)(?:[?#]|$)/.test(lower)) return 'video'
  if (mime.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav)(?:[?#]|$)/.test(lower)) return 'audio'
  if (queryMime.startsWith('video/') || queryMime.startsWith('video_')) return 'video'
  if (queryMime.startsWith('audio/') || queryMime.startsWith('audio_')) return 'audio'
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|avif|svg)(?:[?#]|$)/.test(lower)) return 'image'
  if (mime.includes('mpegurl') || /\.(m3u8|mpd)(?:[?#]|$)/.test(lower)) return 'stream'
  if (mime.includes('json') || /\.json(?:[?#]|$)/.test(lower)) return 'json'
  if (mime === 'application/pdf' || /\.(pdf|docx?|pptx?|xlsx?)(?:[?#]|$)/.test(lower)) return 'document'
  if (lower.includes('mime_type=video') || lower.includes('douyinvod.com')) return 'video'
  if (lower.includes('googlevideo.com/videoplayback') || /\/videoplayback(?:[?#]|$)/.test(lower)) {
    if (queryMime.includes('video')) return 'video'
    if (queryMime.includes('audio')) return 'audio'
  }
  return 'unknown'
}

function mediaAcceptHeader(kind: BrowserResourceKind): string | null {
  if (kind === 'video' || kind === 'stream') return 'video/webm,video/ogg,video/*;q=0.9,audio/*;q=0.8,*/*;q=0.8'
  if (kind === 'audio') return 'audio/*;q=0.9,*/*;q=0.8'
  if (kind === 'image') return 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  return null
}

function suggestedNameFor(url: string, kind: BrowserResourceKind): string | undefined {
  try {
    const parsed = new URL(url)
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last.slice(0, 160)
  } catch {
    // ignore
  }
  if (kind === 'video') return 'video'
  if (kind === 'audio') return 'audio'
  if (kind === 'image') return 'image'
  if (kind === 'stream') return 'stream'
  return undefined
}

function candidateScore(kind: BrowserResourceKind, source: BrowserResourceSource, status?: number): number {
  let score = 10
  if (kind === 'video') score += 80
  else if (kind === 'audio') score += 65
  else if (kind === 'stream') score += 60
  else if (kind === 'image') score += 45
  else if (kind === 'document') score += 35
  else if (kind === 'json') score += 20
  if (source === 'network') score += 15
  if (source === 'response_body') score += 25
  if (source === 'dom') score += 10
  if (status && status >= 200 && status < 300) score += 5
  return score
}

function makeCandidate(
  input: {
    url: string
    sourcePageUrl: string
    sourceTabId: string
    source: BrowserResourceSource
    kind?: BrowserResourceKind
    mimeType?: string
    status?: number
    resourceType?: string
    evidence: string[]
  },
): BrowserResourceCandidate | null {
  const url = normalizeUrl(input.url, input.sourcePageUrl)
  if (!url || !/^https?:\/\//i.test(url)) return null
  const kind = input.kind || inferKind(url, input.mimeType, input.resourceType)
  const accept = mediaAcceptHeader(kind)
  return {
    id: '',
    kind,
    url,
    sourcePageUrl: input.sourcePageUrl,
    sourceTabId: input.sourceTabId,
    source: input.source,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(typeof input.status === 'number' ? { status: input.status } : {}),
    score: candidateScore(kind, input.source, input.status),
    evidence: input.evidence,
    ...(suggestedNameFor(url, kind) ? { suggestedName: suggestedNameFor(url, kind) } : {}),
    referer: input.sourcePageUrl,
    ...(accept ? { downloadHeaders: { Accept: accept, Referer: input.sourcePageUrl } } : {}),
  }
}

function compactCandidates(candidates: BrowserResourceCandidate[], maxCandidates: number): BrowserResourceCandidate[] {
  const byUrl = new Map<string, BrowserResourceCandidate>()
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url)
    if (!existing || candidate.score > existing.score) {
      byUrl.set(candidate.url, candidate)
    }
  }
  return Array.from(byUrl.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates)
    .map((candidate, index) => ({ ...candidate, id: `resource-${index + 1}` }))
}

function resourceDiscoveryNextActions(): string[] {
  return [
    '先读取页面地图或正文，确认当前页确实是目标内容页，不要跳到第三方下载站。',
    '对页面里的视频/音频目标执行一次播放、展开、滚动或等待懒加载后，再重新观察资源。',
    '优先使用站内交互产生的完整 URL 和工具返回的 downloadHeaders；不要手写裁剪 query/token。',
    '若仍无候选，报告页面未加载目标媒体、需要登录/人工操作、或当前流格式暂不支持。',
  ]
}

function buildPageResourceProbe(): string {
  return `
    (() => {
      const out = []
      const push = (url, kind, source, mimeType, evidence) => {
        if (!url || typeof url !== 'string') return
        out.push({ url, kind, source, mimeType: mimeType || '', evidence: Array.isArray(evidence) ? evidence : [] })
      }
      for (const video of Array.from(document.querySelectorAll('video'))) {
        push(video.currentSrc || video.src || '', 'video', 'dom', '', ['video.currentSrc'])
        if (video.poster) push(video.poster, 'image', 'dom', '', ['video.poster'])
      }
      for (const audio of Array.from(document.querySelectorAll('audio'))) {
        push(audio.currentSrc || audio.src || '', 'audio', 'dom', '', ['audio.currentSrc'])
      }
      for (const source of Array.from(document.querySelectorAll('source'))) {
        const type = source.getAttribute('type') || ''
        const kind = type.startsWith('audio/') ? 'audio' : type.includes('mpegurl') ? 'stream' : 'video'
        push(source.src || source.getAttribute('src') || '', kind, 'dom', type, ['source.src'])
      }
      for (const img of Array.from(document.querySelectorAll('img'))) {
        push(img.currentSrc || img.src || '', 'image', 'dom', '', ['img.currentSrc'])
      }
      for (const link of Array.from(document.querySelectorAll('a[href],link[href]'))) {
        const href = link.href || link.getAttribute('href') || ''
        if (/\\.(mp4|webm|mov|m4v|mkv|ogv|mp3|m4a|aac|ogg|wav|m3u8|mpd|pdf)(?:[?#]|$)/i.test(href)) {
          push(href, '', 'dom', link.getAttribute('type') || '', ['link.href'])
        }
      }
      try {
        for (const entry of performance.getEntriesByType('resource')) {
          if (entry && typeof entry.name === 'string') {
            push(entry.name, '', 'performance', '', ['performance.' + String(entry.initiatorType || 'resource')])
          }
        }
      } catch {}
      return { url: location.href, resources: out }
    })()
  `
}

function networkCandidates(
  events: BrowserNetworkEventRecord[],
  sourcePageUrl: string,
  sourceTabId: string,
): BrowserResourceCandidate[] {
  return events
    .map((event) => makeCandidate({
      url: event.url,
      sourcePageUrl,
      sourceTabId,
      source: 'network',
      mimeType: event.mimeType,
      status: event.status,
      resourceType: event.resourceType,
      evidence: [`network.${event.resourceType || 'request'}`, event.status ? `status:${event.status}` : 'status:unknown'],
    }))
    .filter((candidate): candidate is BrowserResourceCandidate => Boolean(candidate))
}

function extractDouyinAwemeId(input: string): string | null {
  try {
    const parsed = new URL(input)
    for (const key of ['aweme_id', 'modal_id', 'item_id']) {
      const value = parsed.searchParams.get(key)
      if (value && /^\d{16,24}$/.test(value)) return value
    }
    const match = parsed.pathname.match(/\/video\/(\d{16,24})/)
    if (match) return match[1]
  } catch {
    // fall through to raw text extraction
  }
  const match = input.match(/\b(\d{16,24})\b/)
  return match ? match[1] : null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return undefined
}

function addressCandidates(label: string, address: unknown, bitrate = 0): Array<{ label: string; url: string; bitrate: number }> {
  const record = objectValue(address)
  const urlList = Array.isArray(record?.url_list) ? record?.url_list : []
  return urlList
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((url) => ({ label, url, bitrate }))
}

function chooseDouyinVideoAddress(aweme: Record<string, unknown>): { label: string; url: string; bitrate: number } | null {
  const video = objectValue(aweme.video) || {}
  const candidates: Array<{ label: string; url: string; bitrate: number }> = []
  const bitRates = Array.isArray(video.bit_rate) ? video.bit_rate : []
  for (const item of [...bitRates].filter((entry) => objectValue(entry)?.is_h265 !== true)) {
    const record = objectValue(item) || {}
    const bitrate = Number(record.bit_rate || 0)
    candidates.push(...addressCandidates(String(record.gear_name || 'bit_rate'), record.play_addr, bitrate))
  }
  candidates.sort((a, b) => b.bitrate - a.bitrate)
  candidates.push(...addressCandidates('play_addr_h264', video.play_addr_h264))
  candidates.push(...addressCandidates('play_addr', video.play_addr))
  candidates.push(...addressCandidates('download_addr', video.download_addr))

  const seen = new Set<string>()
  const unique = candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false
    seen.add(candidate.url)
    return true
  })
  return unique.find((candidate) => candidate.url.includes('mime_type=video_mp4'))
    || unique.find((candidate) => candidate.url.includes('douyinvod.com'))
    || unique[0]
    || null
}

async function douyinCandidatesFromResponses(
  observer: BrowserNetworkObserverHandle,
  events: BrowserNetworkEventRecord[],
  sourcePageUrl: string,
  sourceTabId: string,
): Promise<BrowserResourceCandidate[]> {
  const awemeId = extractDouyinAwemeId(sourcePageUrl)
  const out: BrowserResourceCandidate[] = []
  for (const event of events) {
    if (!event.url.includes('/aweme/v1/web/aweme/detail')) continue
    if (awemeId && !event.url.includes(`aweme_id=${awemeId}`)) continue
    const body = await observer.getResponseBody(event.requestId).catch(() => null)
    if (!body?.body) continue
    const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const json = objectValue(parsed)
    const aweme = objectValue(json?.aweme_detail) || objectValue(json?.aweme)
    if (!aweme) continue
    if (awemeId && String(aweme.aweme_id || '') !== awemeId) continue
    const selected = chooseDouyinVideoAddress(aweme)
    if (!selected) continue
    const candidate = makeCandidate({
      url: selected.url,
      sourcePageUrl,
      sourceTabId,
      source: 'response_body',
      kind: 'video',
      mimeType: 'video/mp4',
      status: event.status,
      resourceType: event.resourceType,
      evidence: ['douyin.detail_api', `label:${selected.label}`, selected.bitrate ? `bitrate:${selected.bitrate}` : 'bitrate:unknown'],
    })
    if (candidate) out.push(candidate)
  }
  return out
}

function responseBodyText(body: { body: string; base64Encoded: boolean }): string {
  return body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
}

function extractBalancedJsonObject(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) return null
  const start = text.indexOf('{', markerIndex + marker.length)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function parseYouTubePlayerPayload(text: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(text))
  } catch {
    // fall through to ytInitialPlayerResponse embedded in HTML
  }
  const embedded = extractBalancedJsonObject(text, 'ytInitialPlayerResponse')
  if (!embedded) return null
  try {
    return objectValue(JSON.parse(embedded))
  } catch {
    return null
  }
}

function collectYouTubeStreamingData(
  value: unknown,
  out: Record<string, unknown>[] = [],
  seen = new Set<unknown>(),
  depth = 0,
): Record<string, unknown>[] {
  if (!value || depth > 6 || seen.has(value)) return out
  seen.add(value)
  const record = objectValue(value)
  if (record) {
    const streamingData = objectValue(record.streamingData)
    if (streamingData) out.push(streamingData)
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') collectYouTubeStreamingData(child, out, seen, depth + 1)
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      if (child && typeof child === 'object') collectYouTubeStreamingData(child, out, seen, depth + 1)
    }
  }
  return out
}

function youtubeFormatKind(format: Record<string, unknown>): BrowserResourceKind {
  const mime = String(format.mimeType || '').toLowerCase()
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  const directUrl = firstText(format.url)
  return directUrl ? inferKind(directUrl, mime) : 'unknown'
}

function youtubeFormatHasAudio(format: Record<string, unknown>): boolean {
  const mime = String(format.mimeType || '').toLowerCase()
  const codecs = mime.match(/codecs="([^"]+)"/)?.[1] || ''
  return mime.startsWith('audio/') || Boolean(format.audioQuality) || /(?:mp4a|opus|vorbis)/i.test(codecs)
}

function youtubeFormatHasVideo(format: Record<string, unknown>): boolean {
  const mime = String(format.mimeType || '').toLowerCase()
  const codecs = mime.match(/codecs="([^"]+)"/)?.[1] || ''
  return mime.startsWith('video/') || Boolean(format.qualityLabel) || Boolean(format.width) || Boolean(format.height) || /(?:avc1|vp9|av01|hev1|hvc1)/i.test(codecs)
}

function youtubeFormatRank(format: Record<string, unknown>): number {
  const hasVideo = youtubeFormatHasVideo(format)
  const hasAudio = youtubeFormatHasAudio(format)
  const height = Number(format.height || 0)
  const bitrate = Number(format.bitrate || format.averageBitrate || 0)
  if (hasVideo && hasAudio) return 300_000_000 + height * 1_000 + bitrate
  if (hasVideo) return 200_000_000 + height * 1_000 + bitrate
  if (hasAudio) return 100_000_000 + bitrate
  return bitrate
}

function youtubeCandidatesFromStreamingData(
  streamingData: Record<string, unknown>,
  event: BrowserNetworkEventRecord,
  sourcePageUrl: string,
  sourceTabId: string,
): BrowserResourceCandidate[] {
  const formats = [
    ...arrayValue(streamingData.formats),
    ...arrayValue(streamingData.adaptiveFormats),
  ]
    .map((format) => objectValue(format))
    .filter((format): format is Record<string, unknown> => Boolean(format))
    .filter((format) => firstText(format.url))
    .sort((a, b) => youtubeFormatRank(b) - youtubeFormatRank(a))

  const out: BrowserResourceCandidate[] = []
  for (const format of formats) {
    const directUrl = firstText(format.url)
    if (!directUrl) continue
    const kind = youtubeFormatKind(format)
    if (kind !== 'video' && kind !== 'audio') continue
    const mimeType = firstText(format.mimeType)?.split(';', 1)[0]
    const track = youtubeFormatHasVideo(format) && youtubeFormatHasAudio(format)
      ? 'track:progressive'
      : youtubeFormatHasVideo(format)
        ? 'track:video_only'
        : 'track:audio_only'
    const evidence = [
      'youtube.player_response',
      track,
      firstText(format.itag) ? `itag:${firstText(format.itag)}` : '',
      firstText(format.qualityLabel, format.audioQuality) ? `quality:${firstText(format.qualityLabel, format.audioQuality)}` : '',
      mimeType ? `mime:${mimeType}` : '',
    ].filter(Boolean)
    const candidate = makeCandidate({
      url: directUrl,
      sourcePageUrl,
      sourceTabId,
      source: 'response_body',
      kind,
      mimeType,
      status: event.status,
      resourceType: event.resourceType,
      evidence,
    })
    if (candidate) out.push(candidate)
  }
  return out
}

function isYouTubePlayerResponseEvent(event: BrowserNetworkEventRecord, sourcePageUrl: string): boolean {
  const url = event.url.toLowerCase()
  const page = sourcePageUrl.toLowerCase()
  if (url.includes('/youtubei/v1/player')) return true
  if (!page.includes('youtube.com') && !url.includes('youtube.com')) return false
  const mime = String(event.mimeType || '').toLowerCase()
  return (url.includes('/watch') || url.includes('/shorts/')) && (mime.includes('html') || mime.includes('text'))
}

async function youtubeCandidatesFromResponses(
  observer: BrowserNetworkObserverHandle,
  events: BrowserNetworkEventRecord[],
  sourcePageUrl: string,
  sourceTabId: string,
): Promise<BrowserResourceCandidate[]> {
  const out: BrowserResourceCandidate[] = []
  for (const event of events) {
    if (!isYouTubePlayerResponseEvent(event, sourcePageUrl)) continue
    const body = await observer.getResponseBody(event.requestId).catch(() => null)
    if (!body?.body) continue
    const parsed = parseYouTubePlayerPayload(responseBodyText(body))
    if (!parsed) continue
    for (const streamingData of collectYouTubeStreamingData(parsed)) {
      out.push(...youtubeCandidatesFromStreamingData(streamingData, event, sourcePageUrl, sourceTabId))
    }
  }
  return out
}

export async function inspectBrowserResources(
  controller: BrowserResourceSnifferController,
  options: BrowserResourceInspectOptions,
): Promise<BrowserResourceInspectResult> {
  const requestedUrl = String(options.url || '').trim()
  let tabId = String(options.tabId || '').trim() || controller.getActiveTab?.()?.id || null
  const evidence: string[] = []
  let observer: BrowserNetworkObserverHandle | null = null
  const waitMs = Math.max(0, Math.min(15_000, Math.floor(options.waitMs ?? 1_500)))
  const maxCandidates = Math.max(1, Math.min(80, Math.floor(options.maxCandidates ?? 24)))

  try {
    if (tabId && controller.startNetworkObserver) {
      observer = await controller.startNetworkObserver(tabId, { maxEvents: 200 })
      evidence.push('network_observer_started')
    }

    if (requestedUrl) {
      if (!controller.navigate) {
        return {
          ok: false,
          sourcePageUrl: requestedUrl,
          sourceTabId: tabId,
          candidateCount: 0,
          candidates: [],
          evidence,
          errorCode: 'navigation_unavailable',
          message: '浏览器控制器不支持导航',
        }
      }
      const nav = await controller.navigate(tabId, requestedUrl)
      if (!nav.success) {
        return {
          ok: false,
          sourcePageUrl: requestedUrl,
          sourceTabId: tabId,
          candidateCount: 0,
          candidates: [],
          evidence,
          errorCode: 'navigation_failed',
          message: nav.error || '导航失败',
        }
      }
      const active = controller.getActiveTab?.()
      tabId = tabId || active?.id || null
      evidence.push('navigated')
      if (!observer && tabId && controller.startNetworkObserver) {
        observer = await controller.startNetworkObserver(tabId, { maxEvents: 200 })
        evidence.push('network_observer_started_after_navigation')
      }
    }

    if (waitMs > 0) await sleep(waitMs, options.signal)

    const raw = await controller.executeJS(tabId, buildPageResourceProbe()) as {
      url?: string
      resources?: RawPageResource[]
    } | null
    const sourcePageUrl = String(raw?.url || requestedUrl || controller.getActiveTab?.()?.url || '')
    const sourceTabId = tabId || controller.getActiveTab?.()?.id || ''
    const candidates: BrowserResourceCandidate[] = []

    for (const item of Array.isArray(raw?.resources) ? raw.resources : []) {
      const candidate = makeCandidate({
        url: String(item.url || ''),
        sourcePageUrl,
        sourceTabId,
        source: item.source === 'performance' ? 'performance' : 'dom',
        kind: item.kind,
        mimeType: item.mimeType,
        evidence: Array.isArray(item.evidence) ? item.evidence.map((entry) => String(entry || '')).filter(Boolean) : [],
      })
      if (candidate) candidates.push(candidate)
    }
    if (raw?.resources) evidence.push(`page_probe:${raw.resources.length}`)

    if (observer) {
      const networkEvents = observer.events()
      const network = networkCandidates(networkEvents, sourcePageUrl, sourceTabId)
      candidates.push(...network)
      candidates.push(...await douyinCandidatesFromResponses(observer, networkEvents, sourcePageUrl, sourceTabId))
      candidates.push(...await youtubeCandidatesFromResponses(observer, networkEvents, sourcePageUrl, sourceTabId))
      evidence.push(`network_events:${networkEvents.length}`)
    }

    const kinds = new Set((options.kinds || []).filter(Boolean))
    const filtered = kinds.size > 0
      ? candidates.filter((candidate) => kinds.has(candidate.kind))
      : candidates
    const compacted = compactCandidates(filtered, maxCandidates)
    return {
      ok: compacted.length > 0,
      sourcePageUrl,
      sourceTabId: sourceTabId || null,
      candidateCount: compacted.length,
      candidates: compacted,
      evidence,
      ...(compacted.length === 0
        ? {
          errorCode: 'failed_no_candidate',
          message: '没有发现可下载资源候选；请先换观察面触发页面真实加载，不要直接改用外部下载站。',
          nextActions: resourceDiscoveryNextActions(),
        }
        : {}),
    }
  } finally {
    await observer?.stop()
  }
}
