/**
 * browser-collector per-note action (plan §3.3/§3.4).
 *
 * The deterministic per-note sequence the sub-agent runs for ONE note, entirely
 * through the ScopedBrowserFacade (so every call is forced onto the agent tab,
 * under the agent-view lease + control gate + collection subset). The driver
 * decides WHICH note; this runs it: navigate → collect page details/images →
 * cookie-aware download into the note's own folder → write a note manifest.
 *
 * The facade is an interface (run(tool, args) => Promise<string>) so this is
 * unit-testable without Electron.
 */

import { isAgentBrowserError } from './agent-browser-errors'
import { sourceIdFromUrl } from './collection-targets'

export interface NoteCollectFacade {
  run(toolName: string, args?: Record<string, unknown>): Promise<string>
}

export interface CollectNoteInput {
  noteUrl: string
  canonicalUrl?: string
  openUrl?: string
  title?: string
  titleConfidence?: 'none' | 'low' | 'medium' | 'high'
  sourceId?: string
  order?: number
  folderName?: string
  duplicateTitle?: boolean
  skipNavigate?: boolean
  max_images?: number
  outputDir: string
}

export interface NoteCollectResult {
  success: boolean
  noteUrl: string
  canonicalUrl?: string
  openUrl?: string
  title?: string
  sourceId?: string
  order?: number
  imageCount: number
  videoCount?: number
  mediaKind?: 'image' | 'video'
  savedDir: string
  notePath?: string
  manifestPath?: string
  files?: string[]
  reason?: string
}

export interface NoteCollectFileOps {
  ensureDir(path: string): Promise<void>
  writeTextFile(path: string, content: string): Promise<void>
}

interface ImageCandidate {
  url: string
  alt?: string
  width?: number
  height?: number
}

interface VideoCandidate {
  url: string
  posterUrl?: string
  width?: number
  height?: number
}

interface MediaCollection {
  images: ImageCandidate[]
  videos: VideoCandidate[]
  videoCount: number
  scope?: string
  expectedImageCount?: number
  hasCarouselSignal?: boolean
}

const MAX_NOTE_IMAGE_CANDIDATES = 24

const CAROUSEL_ROOT_SELECTORS = [
  '[aria-roledescription="carousel"]',
  '[role="region"][aria-label*="carousel" i]',
  '.swiper',
  '.swiper-container',
  '.slick-slider',
  '.carousel',
  '[data-carousel]',
  '[data-ub-carousel]',
]

const CAROUSEL_DOT_SELECTORS = [
  '.swiper-pagination',
  '.swiper-pagination-bullet',
  '.slick-dots',
  '[aria-label*="Go to slide" i]',
  '[aria-label*="slide" i][role="button"]',
  '[aria-label*="第"][aria-label*="张"]',
]

const CAROUSEL_NEXT_BUTTON_SELECTORS = [
  '.swiper-button-next',
  '.slick-next',
  '.carousel-control-next',
  '[aria-label*="Next" i]',
  '[aria-label*="下一"]',
  'button[class*="next"]',
  '[role="button"][class*="next"]',
]

const CAROUSEL_DETECTION_SELECTOR = [
  ...CAROUSEL_ROOT_SELECTORS,
  ...CAROUSEL_DOT_SELECTORS,
  ...CAROUSEL_NEXT_BUTTON_SELECTORS,
].join(', ')

const CAROUSEL_NEXT_BUTTON_SELECTOR = CAROUSEL_NEXT_BUTTON_SELECTORS.join(', ')

const CAROUSEL_TEXT_MARKER_PATTERNS = [
  /aria-roledescription=["']?carousel/i,
  /\bswiper\b/i,
  /\bcarousel\b/i,
  /轮播/u,
]

const FOLDER_UNSAFE_PATTERN = new RegExp(
  '[\\\\/:*?"<>|' + String.fromCharCode(0x00) + '-' + String.fromCharCode(0x1f) + ']',
  'g',
)

function sanitizeFolderName(name: string, fallback: string): string {
  const cleaned = String(name || '')
    .replace(FOLDER_UNSAFE_PATTERN, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
  return cleaned || fallback
}

function sanitizeId(id: string): string {
  return String(id || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function shortId(id: string): string {
  const cleaned = sanitizeId(id)
  return cleaned.slice(0, 10)
}

function parseFacadeError(out: string): string | null {
  try {
    const o = JSON.parse(out)
    return isAgentBrowserError(o) ? o.errorCode : null
  } catch {
    return null
  }
}

function extractMediaCollection(collectOutput: string): MediaCollection {
  try {
    const parsed = JSON.parse(collectOutput)
    const images = Array.isArray(parsed?.images) ? parsed.images : []
    const rawVideos = Array.isArray(parsed?.videos) ? parsed.videos : []
    const videos = rawVideos
      .map((item: unknown) => {
        const obj = item && typeof item === 'object'
          ? item as { url?: unknown; posterUrl?: unknown; width?: unknown; height?: unknown }
          : null
        return {
          url: String(obj?.url || ''),
          posterUrl: String(obj?.posterUrl || ''),
          width: Number(obj?.width || 0),
          height: Number(obj?.height || 0),
        }
      })
    const videoCount = rawVideos.length > 0
      ? videos.length
      : Math.max(0, Number(parsed?.videoCount || 0))
      return {
        videoCount,
        scope: typeof parsed?.scope === 'string' ? parsed.scope : undefined,
        expectedImageCount: Number.isFinite(Number(parsed?.expectedImageCount)) && Number(parsed?.expectedImageCount) > 0
          ? Number(parsed.expectedImageCount)
          : undefined,
        hasCarouselSignal: parsed?.hasCarouselSignal === true,
        videos,
        images: images
      .map((img: unknown) => {
        const obj = img && typeof img === 'object' ? img as { url?: unknown; alt?: unknown; width?: unknown; height?: unknown } : null
        const url = String(obj?.url || '')
        return {
          url,
          alt: String(obj?.alt || ''),
          width: Number(obj?.width || 0),
          height: Number(obj?.height || 0),
        }
      })
        .filter((img: ImageCandidate) => /^https?:\/\//i.test(img.url)),
    }
  } catch {
    return { images: [], videos: [], videoCount: 0 }
  }
}

function extractImages(collectOutput: string): ImageCandidate[] {
  return extractMediaCollection(collectOutput).images
}

function extractDetail(collectOutput: string): { title?: string; summary?: string } {
  try {
    const parsed = JSON.parse(collectOutput)
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    const first = items.find((item: unknown) => item && typeof item === 'object') as Record<string, unknown> | undefined
    if (!first) return {}
    const title = String(first.title || '').replace(/\s+/g, ' ').trim()
    const summary = String(first.summary || '').replace(/\s+/g, ' ').trim()
    return {
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
    }
  } catch {
    return {}
  }
}

function successfulDownloadFiles(downloadOutput: string): string[] {
  try {
    const parsed = JSON.parse(downloadOutput)
    const results = Array.isArray(parsed?.results) ? parsed.results : []
    return results
      .filter((item: unknown) => item && typeof item === 'object' && (item as { success?: unknown }).success === true)
      .map((item: unknown) => {
        const obj = item as { path?: unknown; filename?: unknown }
        return String(obj.path || obj.filename || '').trim()
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function titleCanBeReplaced(confidence: CollectNoteInput['titleConfidence']): boolean {
  return confidence === 'none' || confidence === 'low'
}

function formatOrder(order: number | undefined): string {
  const value = Number.isFinite(order) && Number(order) > 0 ? Math.trunc(Number(order)) : 1
  return String(value).padStart(2, '0')
}

function relativeToNoteDir(noteDir: string, file: string): string {
  const normalizedDir = noteDir.replace(/\/+$/g, '')
  const normalizedFile = String(file || '').replace(/\\/g, '/')
  const marker = `${normalizedDir}/`
  if (normalizedFile.startsWith(marker)) return normalizedFile.slice(marker.length)
  const assetIndex = normalizedFile.lastIndexOf('/assets/')
  if (assetIndex >= 0) return normalizedFile.slice(assetIndex + 1)
  return normalizedFile
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = String(value || '').trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function isLikelyDirectVideoUrl(url: string): boolean {
  const value = String(url || '').trim()
  if (!/^https?:\/\//i.test(value)) return false
  const lower = value.toLowerCase()
  if (/\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(lower)) return false
  return (
    /(?:^|[.-])sns-video[.-]/i.test(lower)
    || /\.(?:mp4|m4v|mov|webm|m3u8)(?:[?#]|$)/i.test(lower)
  )
}

function activeUrlFromTabsOutput(tabsOutput: string): string | null {
  const lines = String(tabsOutput || '').split(/\r?\n/)
  const activeIndex = lines.findIndex((line) => line.trimStart().startsWith('▶'))
  const candidates = activeIndex >= 0 ? [lines[activeIndex + 1] || ''] : lines
  for (const candidate of candidates) {
    const match = candidate.match(/https?:\/\/\S+/i)
    if (match) return match[0]
  }
  return null
}

function xiaohongshuExploreUrlFromSourceId(sourceId: string | undefined): string | null {
  const id = String(sourceId || '').trim()
  if (!/^[a-f0-9]{8,}$/i.test(id)) return null
  return `https://www.xiaohongshu.com/explore/${id}`
}

function videoPageUrlCandidates(input: CollectNoteInput, tabsOutput: string): string[] {
  return uniqueStrings([
    activeUrlFromTabsOutput(tabsOutput),
    input.openUrl,
    input.canonicalUrl,
    input.noteUrl,
    isXiaohongshuTarget(input) ? xiaohongshuExploreUrlFromSourceId(input.sourceId) : null,
  ]).filter((value) => /^https?:\/\//i.test(value))
}

function buildFolderName(input: CollectNoteInput, title: string, sourceId: string): string {
  if (input.folderName && input.folderName.trim()) {
    return sanitizeFolderName(input.folderName, `note-${sourceId}`)
  }
  const baseTitle = sanitizeFolderName(title, `note-${sourceId}`)
  const duplicateSuffix = input.duplicateTitle ? ` - ${shortId(sourceId) || 'source'}` : ''
  return sanitizeFolderName(`${formatOrder(input.order)} - ${baseTitle}${duplicateSuffix}`, `note-${sourceId}`)
}

const ACCESS_BLOCK_TEXT_PATTERNS = [
  /扫码/u,
  /二维码/u,
  /登录/u,
  /登陆/u,
  /安全验证/u,
  /身份验证/u,
  /验证码/u,
  /验证身份/u,
  /滑块验证/u,
  /请完成验证/u,
  /captcha/i,
  /sign in/i,
  /log in/i,
  /login/i,
  /qr code/i,
  /scan (the )?(code|qr)/i,
  /verify (that )?(you|your)/i,
]

const ACCESS_BLOCK_TITLES = new Set(['消息', '登录', '登陆', 'login', 'log in', 'sign in', 'messages', 'notifications'])

const UNAVAILABLE_TEXT_PATTERNS = [
  /当前笔记暂时无法浏览/u,
  /你访问的页面不见了/u,
  /页面不见了/u,
  /内容不存在/u,
  /笔记不存在/u,
  /error_code=300031/i,
]

const UNAVAILABLE_TITLES = new Set(['小红书 - 你访问的页面不见了'])

function normalizeText(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function containsAccessBlockText(value: string | undefined): boolean {
  const text = normalizeText(value)
  return text.length > 0 && ACCESS_BLOCK_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

function containsUnavailableText(value: string | undefined): boolean {
  const text = normalizeText(value)
  return text.length > 0 && UNAVAILABLE_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

function isLikelyPlatformAssetUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const haystack = `${url.hostname} ${url.pathname}`.toLowerCase()
    return /\b(platform|captcha|login|signin|auth|verify|qrcode|qr-code)\b/.test(haystack)
      || /(^|[.-])fe-platform[.-]/.test(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function isLikelyAvatarAssetUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const haystack = `${url.hostname} ${url.pathname}`.toLowerCase()
    return /(^|[.-])sns-avatar[.-]/.test(url.hostname.toLowerCase())
      || /\b(avatar|profile|default-avatar|defaultavatar|user-icon)\b/.test(haystack)
  } catch {
    return false
  }
}

function isLikelyCommentAssetUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return /(^|\/)(comment)(\/|$)/i.test(url.pathname)
  } catch {
    return false
  }
}

function imageDedupeKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    // Pinterest serves the same pin at multiple resolutions via a leading PATH
    // segment (/236x/, /474x/, /originals/, ...). Collapse those variants so a
    // thumbnail and its original are not treated as two distinct images.
    if (/(^|\.)pinimg\.com$/i.test(url.hostname)) {
      const segments = url.pathname.split('/').filter(Boolean)
      if (segments.length >= 2 && /^(originals|\d+x(\d+)?)$/i.test(segments[0])) {
        return `${url.hostname}/${segments.slice(1).join('/')}`.toLowerCase()
      }
    }
    const path = url.pathname.replace(/!.+$/u, '')
    return `${url.hostname}${path}`.toLowerCase()
  } catch {
    return rawUrl.toLowerCase()
  }
}

function hasTinyKnownDimensions(image: ImageCandidate): boolean {
  const width = Number(image.width || 0)
  const height = Number(image.height || 0)
  return width > 0 && height > 0 && (width < 96 || height < 96)
}

function isLikelyNoteContentImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const haystack = `${url.hostname} ${url.pathname}`.toLowerCase()
    return /(^|[.-])(sns-webpic|sns-img|ci)[.-]/.test(url.hostname.toLowerCase())
      || /\b(notes_pre_post|spectrum|note_image|note-img|imagevault)\b/.test(haystack)
  } catch {
    return false
  }
}

function filterNoteImageCandidates(images: ImageCandidate[], maxItems = MAX_NOTE_IMAGE_CANDIDATES): ImageCandidate[] {
  const seen = new Set<string>()
  const usable: ImageCandidate[] = []
  for (const image of images) {
    if (!/^https?:\/\//i.test(image.url)) continue
    if (isLikelyPlatformAssetUrl(image.url) || isLikelyAvatarAssetUrl(image.url)) continue
    if (isLikelyCommentAssetUrl(image.url)) continue
    if (hasTinyKnownDimensions(image)) continue
    const key = imageDedupeKey(image.url)
    if (seen.has(key)) continue
    seen.add(key)
    usable.push(image)
  }
  const preferred = usable.filter((image) => isLikelyNoteContentImageUrl(image.url))
  return (preferred.length > 0 ? preferred : usable).slice(0, maxItems)
}

function mergeImageCandidates(...sets: ImageCandidate[][]): ImageCandidate[] {
  const seen = new Set<string>()
  const out: ImageCandidate[] = []
  for (const images of sets) {
    for (const image of images) {
      if (!/^https?:\/\//i.test(image.url)) continue
      const key = imageDedupeKey(image.url)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(image)
    }
  }
  return out
}

function mergeVideoCandidates(...sets: VideoCandidate[][]): VideoCandidate[] {
  const seen = new Set<string>()
  const out: VideoCandidate[] = []
  for (const videos of sets) {
    for (const video of videos) {
      if (!/^https?:\/\//i.test(video.url)) continue
      const key = video.url.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(video)
    }
  }
  return out
}

function extractImagesFromStructuredGallery(output: string): ImageCandidate[] {
  try {
    const parsed = JSON.parse(output)
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    const images: ImageCandidate[] = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const media = Array.isArray(record.media) ? record.media : []
      const urls = [
        ...media,
        record.link,
        record.image,
        (record.rawFields && typeof record.rawFields === 'object' ? (record.rawFields as Record<string, unknown>).link : undefined),
      ]
      for (const value of urls) {
        const url = String(value || '').trim()
        if (/^https?:\/\//i.test(url)) images.push({ url })
      }
    }
    return images
  } catch {
    return []
  }
}

async function collectXiaohongshuGalleryFallback(facade: NoteCollectFacade): Promise<ImageCandidate[]> {
  const out = await facade.run('browser_collect', {
    mode: 'structured',
    template: 'image_gallery',
    limit: 60,
    min_width: 120,
  }).catch(() => '')
  if (parseFacadeError(out)) return []
  return extractImagesFromStructuredGallery(out)
}

function isPartialImagesReason(reason: string | undefined): boolean {
  return String(reason || '').startsWith('partial_images')
}

function hasOnlyPlaceholderImages(images: ImageCandidate[] | undefined): boolean {
  if (!images || images.length === 0 || images.length > 3) return false
  return images.every((img) => isLikelyPlatformAssetUrl(img.url))
}

function isGenericAccessTitle(title: string | undefined): boolean {
  const normalized = normalizeText(title).toLowerCase()
  return normalized.length > 0 && ACCESS_BLOCK_TITLES.has(normalized)
}

function detectAccessBlock(input: {
  pageText?: string
  title?: string
  summary?: string
  images?: ImageCandidate[]
}): string | null {
  if (containsAccessBlockText(input.pageText) || containsAccessBlockText(input.title) || containsAccessBlockText(input.summary)) {
    return 'needs_verification'
  }
  if (hasOnlyPlaceholderImages(input.images) && isGenericAccessTitle(input.title)) {
    return 'needs_verification'
  }
  return null
}

function detectTerminalPageBlock(input: {
  pageText?: string
  title?: string
  summary?: string
  images?: ImageCandidate[]
}): string | null {
  const title = normalizeText(input.title)
  if (
    containsUnavailableText(input.pageText)
    || containsUnavailableText(input.title)
    || containsUnavailableText(input.summary)
    || UNAVAILABLE_TITLES.has(title)
  ) {
    return 'unavailable'
  }
  return detectAccessBlock(input)
}

function isXiaohongshuTarget(input: { canonicalUrl?: string; noteUrl?: string; openUrl?: string }): boolean {
  return [input.canonicalUrl, input.noteUrl, input.openUrl]
    .some((value) => /xiaohongshu\.com/i.test(String(value || '')))
}

function isLikelyXiaohongshuProfileListPage(pageText: string, input: { canonicalUrl?: string; noteUrl?: string; openUrl?: string }): boolean {
  if (!isXiaohongshuTarget(input)) return false
  const text = normalizeText(pageText)
  if (!text) return false
  const profileMarkers = ['小红书号', '粉丝', '获赞与收藏', '笔记 收藏']
  return profileMarkers.every((marker) => text.includes(marker))
}

function isLikelyListSurfacePage(pageText: string, input: { canonicalUrl?: string; noteUrl?: string; openUrl?: string }): boolean {
  if (isLikelyXiaohongshuProfileListPage(pageText, input)) return true
  const text = normalizeText(pageText)
  return /(?:主页列表|用户主页|profile list|feed list)/i.test(text)
}

function detailMatchesTarget(pageText: string, input: { title?: string; sourceId?: string; canonicalUrl?: string; noteUrl?: string }): boolean {
  const haystack = normalizeText(pageText).toLowerCase()
  const markers = [
    input.sourceId,
    input.title,
    input.canonicalUrl,
    input.noteUrl,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter((value) => value.length >= 3)
  if (markers.length === 0) return true
  return markers.some((marker) => haystack.includes(marker))
}

function tabsOutputContainsTargetUrl(tabsOutput: string, input: { sourceId?: string; canonicalUrl?: string; noteUrl?: string }): boolean {
  const haystack = normalizeText(tabsOutput).toLowerCase()
  const markers = [
    input.sourceId,
    input.canonicalUrl,
    input.noteUrl,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter((value) => value.length >= 6)
  if (markers.length === 0) return true
  return markers.some((marker) => haystack.includes(marker))
}

function activeTabOutputContainsTargetUrl(tabsOutput: string, input: { sourceId?: string; canonicalUrl?: string; noteUrl?: string }): boolean {
  const lines = String(tabsOutput || '').split(/\r?\n/)
  const activeIndex = lines.findIndex((line) => line.trimStart().startsWith('▶'))
  if (activeIndex < 0) return tabsOutputContainsTargetUrl(tabsOutput, input)
  const activeBlock = [lines[activeIndex] || '', lines[activeIndex + 1] || ''].join('\n')
  return tabsOutputContainsTargetUrl(activeBlock, input)
}

const CARD_DETAIL_OPEN_TIMEOUT_MS = 8000
const CARD_DETAIL_OPEN_POLL_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForTargetDetailTab(
  facade: NoteCollectFacade,
  input: { title?: string; sourceId?: string; canonicalUrl?: string; noteUrl?: string; openUrl?: string },
): Promise<{ opened: boolean; tabsOut: string }> {
  const deadline = Date.now() + CARD_DETAIL_OPEN_TIMEOUT_MS
  let lastTabsOut = ''
  while (Date.now() <= deadline) {
    lastTabsOut = await facade.run('browser_tabs').catch(() => '')
    if (activeTabOutputContainsTargetUrl(lastTabsOut, input)) return { opened: true, tabsOut: lastTabsOut }
    const pageOut = await facade.run('browser_read').catch(() => '')
    if (
      pageOut
      && !parseFacadeError(pageOut)
      && !isLikelyListSurfacePage(pageOut, input)
      && detailMatchesTarget(pageOut, input)
    ) {
      return { opened: true, tabsOut: lastTabsOut }
    }
    await sleep(CARD_DETAIL_OPEN_POLL_MS)
  }
  return { opened: false, tabsOut: lastTabsOut }
}

function waitConditionMatched(output: string): boolean {
  if (parseFacadeError(output)) return false
  try {
    const parsed = JSON.parse(output)
    return parsed?.matched === true || (parsed?.ready === true && parsed?.selectorMatched === true)
  } catch {
    return false
  }
}

function shouldProbeCarousel(input: CollectNoteInput, detailText: string): boolean {
  return isXiaohongshuTarget(input) || CAROUSEL_TEXT_MARKER_PATTERNS.some((pattern) => pattern.test(detailText))
}

async function pageHasCarouselStructure(
  facade: NoteCollectFacade,
  input: CollectNoteInput,
  detailText: string,
): Promise<boolean> {
  if (!shouldProbeCarousel(input, detailText)) return false
  const out = await facade.run('browser_wait', {
    condition: 'selector',
    selector: CAROUSEL_DETECTION_SELECTOR,
    timeout_ms: CARD_DETAIL_OPEN_POLL_MS,
    check_interval_ms: CARD_DETAIL_OPEN_POLL_MS,
  }).catch(() => '')
  return waitConditionMatched(out)
}

function carouselClickSucceeded(output: string): boolean {
  if (parseFacadeError(output)) return false
  const text = String(output || '').trim()
  if (!text) return false
  if (/^(?:error|element not found)\b/i.test(text)) return false
  try {
    const parsed = JSON.parse(text)
    return parsed?.ok !== false
  } catch {
    return true
  }
}

function carouselMaxImages(input: CollectNoteInput): number {
  const value = Number(input.max_images || 0)
  if (Number.isFinite(value) && value > 0) return Math.min(MAX_NOTE_IMAGE_CANDIDATES, Math.trunc(value))
  return MAX_NOTE_IMAGE_CANDIDATES
}

async function collectVisibleCarouselFrame(facade: NoteCollectFacade, maxImages: number): Promise<MediaCollection> {
  const out = await facade.run('browser_collect', { mode: 'images', include_hidden: false, limit: Math.max(36, maxImages) }).catch(() => '')
  if (!out || parseFacadeError(out)) return { images: [], videos: [], videoCount: 0 }
  return extractMediaCollection(out)
}

async function collectCarouselMedia(
  facade: NoteCollectFacade,
  input: CollectNoteInput,
  detailText: string,
): Promise<MediaCollection | null> {
  const hasCarousel = await pageHasCarouselStructure(facade, input, detailText)
  if (!hasCarousel) return null

  const maxImages = carouselMaxImages(input)
  let rawImages: ImageCandidate[] = []
  let rawVideos: VideoCandidate[] = []
  let scope: string | undefined

  for (let frameIndex = 0; frameIndex < maxImages; frameIndex += 1) {
    const beforeCount = filterNoteImageCandidates(rawImages, maxImages).length
    const frame = await collectVisibleCarouselFrame(facade, maxImages)
    rawImages = mergeImageCandidates(rawImages, frame.images)
    rawVideos = mergeVideoCandidates(rawVideos, frame.videos)
    scope = frame.scope || scope

    const images = filterNoteImageCandidates(rawImages, maxImages)
    if (images.length >= maxImages) {
      rawImages = images
      break
    }
    if (frameIndex > 0 && images.length <= beforeCount) break
    if (frameIndex + 1 >= maxImages) break

    const clickOut = await facade.run('browser_click', { selector: CAROUSEL_NEXT_BUTTON_SELECTOR }).catch(() => '')
    if (!carouselClickSucceeded(clickOut)) break
    await facade.run('browser_wait', { duration_ms: CARD_DETAIL_OPEN_POLL_MS }).catch(() => '')
  }

  const images = filterNoteImageCandidates(rawImages, maxImages)
  if (images.length === 0 && rawVideos.length === 0) return null
  return {
    images,
    videos: rawVideos,
    videoCount: rawVideos.length,
    scope: scope || 'carousel',
    hasCarouselSignal: true,
  }
}

function facadeWithCarouselMedia(facade: NoteCollectFacade, media: MediaCollection): NoteCollectFacade {
  let consumed = false
  return {
    run: async (toolName, args = {}) => {
      if (toolName === 'browser_collect' && args.mode === 'images' && !consumed && args.include_hidden !== true) {
        consumed = true
        return JSON.stringify({
          count: media.images.length,
          images: media.images,
          videos: media.videos,
          videoCount: media.videoCount,
          expectedImageCount: media.expectedImageCount,
          hasCarouselSignal: media.hasCarouselSignal,
          scope: media.scope,
        })
      }
      return facade.run(toolName, args)
    },
  }
}

function noteMarkdown(input: {
  title: string
  url: string
  canonicalUrl?: string
  summary?: string
  imageCount: number
  videoCount?: number
  mediaKind?: 'image' | 'video'
  success: boolean
  reason?: string
  files: string[]
}): string {
  const fileLines = input.files.map((file) => input.mediaKind === 'video'
    ? `[视频文件](${file})`
    : `![图片](${file})`)
  return [
    `# ${input.title}`,
    '',
    `来源链接：${input.canonicalUrl || input.url}`,
    `打开链接：${input.url}`,
    `状态：${input.success ? '成功' : '失败'}`,
    `图片数量：${input.imageCount}`,
    ...(input.videoCount ? [`视频数量：${input.videoCount}`] : []),
    ...(input.reason ? [`失败原因：${input.reason}`] : []),
    '',
    ...(input.summary ? [input.summary, ''] : []),
    ...fileLines,
    '',
  ].join('\n')
}

function failureFilename(result: NoteCollectResult): string {
  const order = formatOrder(result.order)
  const id = shortId(result.sourceId || result.canonicalUrl || result.noteUrl) || 'unknown'
  return `${order}-${id}.json`
}

async function writeArtifacts(
  fileOps: NoteCollectFileOps | undefined,
  pathJoin: (...parts: string[]) => string,
  result: NoteCollectResult,
  extra: { summary?: string; imageUrls?: string[]; videoUrls?: string[] },
): Promise<NoteCollectResult> {
  if (!fileOps) return result
  if (!result.success && (result.imageCount <= 0 || isPartialImagesReason(result.reason))) {
    const failedDir = pathJoin(result.savedDir, '_failed')
    await fileOps.ensureDir(failedDir)
    const failurePath = pathJoin(failedDir, failureFilename(result))
    await fileOps.writeTextFile(failurePath, JSON.stringify({
      url: result.canonicalUrl || result.noteUrl,
      openUrl: result.openUrl || result.noteUrl,
      title: result.title || result.noteUrl,
      sourceId: result.sourceId,
      order: result.order,
      success: false,
      imageCount: result.imageCount,
      videoCount: result.videoCount || 0,
      mediaKind: result.mediaKind,
      reason: result.reason,
      imageUrls: extra.imageUrls || [],
      videoUrls: extra.videoUrls || [],
      savedAt: new Date().toISOString(),
    }, null, 2))
    return { ...result, savedDir: failedDir, manifestPath: failurePath }
  }
  await fileOps.ensureDir(result.savedDir)
  const assetsDir = pathJoin(result.savedDir, 'assets')
  await fileOps.ensureDir(assetsDir)
  const notePath = pathJoin(result.savedDir, 'note.md')
  const manifestPath = pathJoin(result.savedDir, 'manifest.json')
  const title = result.title || result.noteUrl
  await fileOps.writeTextFile(notePath, noteMarkdown({
    title,
    url: result.openUrl || result.noteUrl,
    canonicalUrl: result.canonicalUrl,
    summary: extra.summary,
    imageCount: result.imageCount,
    videoCount: result.videoCount,
    mediaKind: result.mediaKind,
    success: result.success,
    reason: result.reason,
    files: result.files || [],
  }))
  await fileOps.writeTextFile(manifestPath, JSON.stringify({
    url: result.canonicalUrl || result.noteUrl,
    openUrl: result.openUrl || result.noteUrl,
    title,
    sourceId: result.sourceId,
    order: result.order,
    success: result.success,
    savedDir: result.savedDir,
    imageCount: result.imageCount,
    videoCount: result.videoCount || 0,
    mediaKind: result.mediaKind || 'image',
    files: result.files || [],
    imageUrls: extra.imageUrls || [],
    videoUrls: extra.videoUrls || [],
    reason: result.reason,
    savedAt: new Date().toISOString(),
  }, null, 2))
  return { ...result, notePath, manifestPath }
}

function parseVideoResolveOutput(out: string): { downloadUrl?: string; videoUrl?: string; posterUrl?: string; error?: string } {
  const err = parseFacadeError(out)
  if (err) return { error: err }
  try {
    const parsed = JSON.parse(out)
    const video = parsed?.video && typeof parsed.video === 'object' ? parsed.video as Record<string, unknown> : null
    const downloadUrl = String(video?.downloadUrl || video?.playableUrl || '').trim()
    if (isLikelyDirectVideoUrl(downloadUrl)) {
      return {
        downloadUrl,
        videoUrl: String(video?.pageUrl || video?.originalUrl || '').trim(),
        posterUrl: String(video?.posterUrl || '').trim(),
      }
    }
    return {
      error: String(video?.error || parsed?.error || 'video_resolve_failed'),
      posterUrl: String(video?.posterUrl || '').trim(),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function resolveNoteVideo(
  facade: NoteCollectFacade,
  input: CollectNoteInput,
  title: string,
  media: MediaCollection,
): Promise<{ downloadUrl?: string; videoUrl?: string; posterUrl?: string; error?: string }> {
  const directVideoUrl = media.videos.map((video) => video.url).find(isLikelyDirectVideoUrl)
  const posterUrl = media.videos.map((video) => video.posterUrl || video.url).find((url) => /^https?:\/\//i.test(String(url || '')))
  const tabsOut = await facade.run('browser_tabs').catch(() => '')
  const pageUrls = videoPageUrlCandidates(input, tabsOut)
  const sources = media.videos.map((video) => video.url).filter(isLikelyDirectVideoUrl)
  const attempts = directVideoUrl && pageUrls.length === 0 ? [''] : pageUrls
  let lastError = ''

  for (const pageUrl of attempts) {
    const out = await facade.run('browser_download', {
      mode: 'resolve',
      ...(pageUrl ? { page_url: pageUrl } : {}),
      ...(directVideoUrl ? { video_url: directVideoUrl } : {}),
      ...(posterUrl ? { poster_url: posterUrl } : {}),
      ...(title ? { title } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    })
    const resolved = parseVideoResolveOutput(out)
    if (resolved.downloadUrl) return resolved
    lastError = resolved.error || lastError
    if (directVideoUrl) break
  }

  return { error: lastError || 'video_resolve_failed' }
}

async function downloadVideoNote(
  facade: NoteCollectFacade,
  input: CollectNoteInput,
  pathJoin: (...parts: string[]) => string,
  fileOps: NoteCollectFileOps | undefined,
  args: {
    title: string
    sourceId: string
    noteDir: string
    openUrl: string
    canonicalUrl: string
    summary?: string
    media: MediaCollection
  },
): Promise<NoteCollectResult> {
  const resolved = await resolveNoteVideo(facade, input, args.title, args.media)
  if (!resolved.downloadUrl) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: args.canonicalUrl,
      openUrl: args.openUrl,
      title: args.title,
      sourceId: args.sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: `video_resolve:${resolved.error || 'failed'}`,
    }, { summary: args.summary, videoUrls: resolved.videoUrl ? [resolved.videoUrl] : [] })
  }

  const assetsDir = pathJoin(args.noteDir, 'assets')
  const dlOut = await facade.run('browser_download', { mode: 'urls', urls: [resolved.downloadUrl], directory: assetsDir, filename_prefix: 'video' })
  const dlErr = parseFacadeError(dlOut)
  if (dlErr) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: args.canonicalUrl,
      openUrl: args.openUrl,
      title: args.title,
      sourceId: args.sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: `video_download:${dlErr}`,
    }, { summary: args.summary, videoUrls: [resolved.downloadUrl] })
  }

  let savedCount = 1
  let files = successfulDownloadFiles(dlOut).map((file) => relativeToNoteDir(args.noteDir, file))
  try {
    const parsed = JSON.parse(dlOut)
    if (typeof parsed?.success === 'number') savedCount = parsed.success
  } catch {
    // keep optimistic count
  }
  if (savedCount <= 0) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: args.canonicalUrl,
      openUrl: args.openUrl,
      title: args.title,
      sourceId: args.sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: 'video_download_failed',
    }, { summary: args.summary, videoUrls: [resolved.downloadUrl] })
  }
  if (files.length === 0) files = [resolved.downloadUrl]
  return writeArtifacts(fileOps, pathJoin, {
    success: true,
    noteUrl: input.noteUrl,
    canonicalUrl: args.canonicalUrl,
    openUrl: args.openUrl,
    title: args.title,
    sourceId: args.sourceId,
    order: input.order,
    imageCount: 0,
    videoCount: savedCount,
    mediaKind: 'video',
    savedDir: args.noteDir,
    files,
  }, { summary: args.summary, videoUrls: [resolved.downloadUrl] })
}

/**
 * Collect one note. Resolves to a structured result; never throws (a tool error
 * becomes a failed result so the driver can count it and move on).
 */
export async function collectNote(
  facade: NoteCollectFacade,
  input: CollectNoteInput,
  pathJoin: (...parts: string[]) => string,
  fileOps?: NoteCollectFileOps,
): Promise<NoteCollectResult> {
  const canonicalUrl = input.canonicalUrl || input.noteUrl
  const openUrl = input.openUrl || input.noteUrl
  const sourceId = sanitizeId(input.sourceId || sourceIdFromUrl(canonicalUrl))
  const requestedTitle = String(input.title || '').replace(/\s+/g, ' ').trim()
  const initialTitle = requestedTitle || `note-${sourceId}`
  const folderForTitle = (title: string) => pathJoin(input.outputDir, buildFolderName(input, title, sourceId))
  const initialNoteDir = input.outputDir

  // 1. Navigate the agent tab to the note (facade forces agentTabId). card_loop
  // callers set skipNavigate after opening the card from the list naturally.
  if (!input.skipNavigate) {
    const navOut = await facade.run('browser_navigate', { url: openUrl })
    const navErr = parseFacadeError(navOut)
    if (navErr) {
      return writeArtifacts(fileOps, pathJoin, {
        success: false,
        noteUrl: input.noteUrl,
        canonicalUrl,
        openUrl,
        title: initialTitle,
        sourceId,
        order: input.order,
        imageCount: 0,
        savedDir: initialNoteDir,
        reason: `navigate:${navErr}`,
      }, {})
    }
  }
  const pageOut = await facade.run('browser_read')
  const pageErr = parseFacadeError(pageOut)
  let pageText = pageErr ? '' : pageOut
  if (!input.skipNavigate && isLikelyXiaohongshuProfileListPage(pageText, input)) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title: requestedTitle || initialTitle,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: initialNoteDir,
      reason: 'detail_not_opened',
    }, {})
  }
  const pageAccessBlock = detectTerminalPageBlock({ pageText, title: requestedTitle || initialTitle })
  if (pageAccessBlock) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title: requestedTitle || initialTitle,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: initialNoteDir,
      reason: pageAccessBlock,
    }, {})
  }

  // 2. Read the detail page title/body when the generic structured extractor
  // can see them. Failure here is non-fatal; image capture still proceeds.
  let detail: { title?: string; summary?: string } = {}
  const detailOut = await facade.run('browser_collect', { mode: 'structured', template: 'article_list', limit: 1 })
  const detailErr = parseFacadeError(detailOut)
  if (!detailErr) detail = extractDetail(detailOut)
  const title = requestedTitle && !titleCanBeReplaced(input.titleConfidence)
    ? requestedTitle
    : detail.title || requestedTitle || initialTitle
  const noteDir = folderForTitle(title)
  const detailAccessBlock = detectTerminalPageBlock({ pageText, title: detail.title || title, summary: detail.summary })
  if (detailAccessBlock) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: detailAccessBlock,
    }, { summary: detail.summary })
  }

  // 3. Collect image candidates on the note page. Prefer visible images so a
  // modal detail page does not download the profile grid behind it.
  let imagesOut = await facade.run('browser_collect', { mode: 'images', include_hidden: false, limit: 36 })
  const collectErr = parseFacadeError(imagesOut)
  if (collectErr) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: `collect:${collectErr}`,
    }, { summary: detail.summary })
  }
  let media = extractMediaCollection(imagesOut)
  let rawImages = media.images
  let videoCount = media.videoCount
  let expectedImageCount = media.expectedImageCount || 0
  let hasCarouselSignal = media.hasCarouselSignal === true || expectedImageCount > 1
  let images = filterNoteImageCandidates(rawImages)
  let rawImagesForAccessBlock = rawImages
  if (
    input.skipNavigate
    && isLikelyXiaohongshuProfileListPage(pageText, input)
    && media.scope !== 'xiaohongshu-detail'
  ) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: 'detail_not_opened',
    }, { summary: detail.summary, imageUrls: rawImages.map((img) => img.url) })
  }
  if (images.length === 0) {
    const visibleAccessBlock = detectTerminalPageBlock({ pageText, title: detail.title || title, summary: detail.summary, images: rawImages })
    if (visibleAccessBlock) {
      return writeArtifacts(fileOps, pathJoin, {
        success: false,
        noteUrl: input.noteUrl,
        canonicalUrl,
        openUrl,
        title,
        sourceId,
        order: input.order,
        imageCount: 0,
        savedDir: input.outputDir,
        reason: visibleAccessBlock,
      }, { summary: detail.summary, imageUrls: rawImages.map((img) => img.url) })
    }
    imagesOut = await facade.run('browser_collect', { mode: 'images', include_hidden: true, limit: 36 })
    const hiddenCollectErr = parseFacadeError(imagesOut)
    if (hiddenCollectErr) {
      return writeArtifacts(fileOps, pathJoin, {
        success: false,
        noteUrl: input.noteUrl,
        canonicalUrl,
        openUrl,
        title,
        sourceId,
        order: input.order,
        imageCount: 0,
        savedDir: input.outputDir,
        reason: `collect:${hiddenCollectErr}`,
      }, { summary: detail.summary })
    }
    media = extractMediaCollection(imagesOut)
    rawImages = media.images
    videoCount = Math.max(videoCount, media.videoCount)
    expectedImageCount = Math.max(expectedImageCount, media.expectedImageCount || 0)
    hasCarouselSignal = hasCarouselSignal || media.hasCarouselSignal === true || expectedImageCount > 1
    rawImagesForAccessBlock = rawImages
    if (
      input.skipNavigate
      && isLikelyXiaohongshuProfileListPage(pageText, input)
      && media.scope !== 'xiaohongshu-detail'
    ) {
      return writeArtifacts(fileOps, pathJoin, {
        success: false,
        noteUrl: input.noteUrl,
        canonicalUrl,
        openUrl,
        title,
        sourceId,
        order: input.order,
        imageCount: 0,
        savedDir: input.outputDir,
        reason: 'detail_not_opened',
      }, { summary: detail.summary, imageUrls: rawImages.map((img) => img.url) })
    }
    images = filterNoteImageCandidates(rawImages)
  }
  if (isXiaohongshuTarget(input) && (media.scope === 'xiaohongshu-detail' || input.skipNavigate) && images.length <= 1) {
    const galleryImages = await collectXiaohongshuGalleryFallback(facade)
    if (galleryImages.length > 0) {
      rawImages = mergeImageCandidates(rawImages, galleryImages)
      rawImagesForAccessBlock = rawImages
      images = filterNoteImageCandidates(rawImages)
    }
  }
  if (images.length === 0 && videoCount === 0 && input.skipNavigate && isXiaohongshuTarget(input)) {
    for (const waitMs of [1000, 1500, 2500]) {
      await facade.run('browser_wait', { duration_ms: waitMs }).catch(() => '')
      const retryPageOut = await facade.run('browser_read').catch(() => '')
      if (retryPageOut && !parseFacadeError(retryPageOut)) {
        pageText = retryPageOut
        const retryPageBlock = detectTerminalPageBlock({ pageText, title: detail.title || title, summary: detail.summary, images: rawImagesForAccessBlock })
        if (retryPageBlock) {
          return writeArtifacts(fileOps, pathJoin, {
            success: false,
            noteUrl: input.noteUrl,
            canonicalUrl,
            openUrl,
            title,
            sourceId,
            order: input.order,
            imageCount: 0,
            savedDir: input.outputDir,
            reason: retryPageBlock,
          }, { summary: detail.summary, imageUrls: rawImagesForAccessBlock.map((img) => img.url) })
        }
      }
      const retryVisibleOut = await facade.run('browser_collect', { mode: 'images', include_hidden: false, limit: 36 })
      if (parseFacadeError(retryVisibleOut)) break
      let retryMedia = extractMediaCollection(retryVisibleOut)
      rawImages = retryMedia.images
      videoCount = Math.max(videoCount, retryMedia.videoCount)
      expectedImageCount = Math.max(expectedImageCount, retryMedia.expectedImageCount || 0)
      hasCarouselSignal = hasCarouselSignal || retryMedia.hasCarouselSignal === true || expectedImageCount > 1
      rawImagesForAccessBlock = rawImages
      images = filterNoteImageCandidates(rawImages)
      if (images.length > 0 || videoCount > 0) break
      const retryHiddenOut = await facade.run('browser_collect', { mode: 'images', include_hidden: true, limit: 36 })
      if (parseFacadeError(retryHiddenOut)) break
      retryMedia = extractMediaCollection(retryHiddenOut)
      rawImages = retryMedia.images
      videoCount = Math.max(videoCount, retryMedia.videoCount)
      expectedImageCount = Math.max(expectedImageCount, retryMedia.expectedImageCount || 0)
      hasCarouselSignal = hasCarouselSignal || retryMedia.hasCarouselSignal === true || expectedImageCount > 1
      rawImagesForAccessBlock = rawImages
      images = filterNoteImageCandidates(rawImages)
      if (images.length > 0 || videoCount > 0) break
    }
  }
  if (
    expectedImageCount > images.length
    && images.length > 0
    && isXiaohongshuTarget(input)
    && (media.scope === 'xiaohongshu-detail' || input.skipNavigate)
  ) {
    await facade.run('browser_wait', { duration_ms: 1200 }).catch(() => '')
    const retryHiddenOut = await facade.run('browser_collect', { mode: 'images', include_hidden: true, limit: 60 }).catch(() => '')
    if (retryHiddenOut && !parseFacadeError(retryHiddenOut)) {
      const retryMedia = extractMediaCollection(retryHiddenOut)
      expectedImageCount = Math.max(expectedImageCount, retryMedia.expectedImageCount || 0)
      hasCarouselSignal = hasCarouselSignal || retryMedia.hasCarouselSignal === true || expectedImageCount > 1
      rawImages = mergeImageCandidates(rawImages, retryMedia.images)
      rawImagesForAccessBlock = rawImages
      images = filterNoteImageCandidates(rawImages)
    }
    const retryGalleryImages = await collectXiaohongshuGalleryFallback(facade)
    if (retryGalleryImages.length > 0) {
      rawImages = mergeImageCandidates(rawImages, retryGalleryImages)
      rawImagesForAccessBlock = rawImages
      images = filterNoteImageCandidates(rawImages)
    }
  }
  const imageUrls = images.map((img) => img.url)
  if (imageUrls.length === 0) {
    if (videoCount > 0) {
      return downloadVideoNote(facade, input, pathJoin, fileOps, {
        title,
        sourceId,
        noteDir,
        openUrl,
        canonicalUrl,
        summary: detail.summary,
        media,
      })
    }
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: videoCount > 0 ? 'skipped_video' : 'no_images',
    }, { summary: detail.summary })
  }
  if (expectedImageCount > imageUrls.length) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: imageUrls.length,
      savedDir: input.outputDir,
      reason: `partial_images:${imageUrls.length}/${expectedImageCount}`,
    }, { summary: detail.summary, imageUrls })
  }
  if (
    hasCarouselSignal
    && imageUrls.length <= 1
    && isXiaohongshuTarget(input)
    && (media.scope === 'xiaohongshu-detail' || input.skipNavigate)
  ) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: imageUrls.length,
      savedDir: input.outputDir,
      reason: `partial_images:${imageUrls.length}/unknown`,
    }, { summary: detail.summary, imageUrls })
  }
  const imageAccessBlock = detectTerminalPageBlock({ pageText, title: detail.title || title, summary: detail.summary, images: images.length > 0 ? images : rawImagesForAccessBlock })
  if (imageAccessBlock) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: imageAccessBlock,
    }, { summary: detail.summary, imageUrls })
  }

  // 4. Cookie-aware download into the note's own folder.
  const assetsDir = pathJoin(noteDir, 'assets')
  const dlOut = await facade.run('browser_download', { mode: 'urls', urls: imageUrls, directory: assetsDir, filename_prefix: 'image' })
  const dlErr = parseFacadeError(dlOut)
  if (dlErr) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: `download:${dlErr}`,
    }, { summary: detail.summary, imageUrls })
  }
  let savedCount = imageUrls.length
  let files = successfulDownloadFiles(dlOut).map((file) => relativeToNoteDir(noteDir, file))
  try {
    const parsed = JSON.parse(dlOut)
    if (typeof parsed?.success === 'number') savedCount = parsed.success
  } catch {
    // keep the optimistic count
  }
  if (savedCount <= 0) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl,
      openUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      files,
      reason: 'download_failed',
    }, { summary: detail.summary, imageUrls })
  }
  if (files.length === 0) files = imageUrls.slice(0, savedCount)
  return writeArtifacts(fileOps, pathJoin, {
    success: true,
    noteUrl: input.noteUrl,
    canonicalUrl,
    openUrl,
    title,
    sourceId,
    order: input.order,
    imageCount: savedCount,
    savedDir: noteDir,
    files,
  }, { summary: detail.summary, imageUrls })
}

export async function collectCardNote(
  facade: NoteCollectFacade,
  input: CollectNoteInput,
  pathJoin: (...parts: string[]) => string,
  fileOps?: NoteCollectFileOps,
): Promise<NoteCollectResult> {
  const title = String(input.title || '').replace(/\s+/g, ' ').trim()
  const sourceId = sanitizeId(input.sourceId || sourceIdFromUrl(input.canonicalUrl || input.noteUrl))
  if (!title) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: input.canonicalUrl || input.noteUrl,
      openUrl: input.openUrl || input.noteUrl,
      title: `note-${sourceId}`,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: 'card_not_found',
    }, {})
  }

  const clickOut = await facade.run('browser_click', { text: title, exact: false, ...(sourceId ? { href_contains: sourceId } : {}) })
  const clickErr = parseFacadeError(clickOut)
  if (clickErr) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: input.canonicalUrl || input.noteUrl,
      openUrl: input.openUrl || input.noteUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: `open_card:${clickErr}`,
    }, {})
  }
  const detailTarget = {
    title,
    sourceId,
    canonicalUrl: input.canonicalUrl || input.noteUrl,
    noteUrl: input.noteUrl,
    openUrl: input.openUrl || input.noteUrl,
  }
  const detailTab = await waitForTargetDetailTab(facade, detailTarget)
  const activeTargetConfirmed = activeTabOutputContainsTargetUrl(detailTab.tabsOut, detailTarget)
  if (!detailTab.opened) {
    await facade.run('browser_navigate', { action: 'back' }).catch(() => '')
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: input.canonicalUrl || input.noteUrl,
      openUrl: input.openUrl || input.noteUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: 'detail_not_opened',
    }, {})
  }
  let detailOut = await facade.run('browser_read')
  const detailErr = parseFacadeError(detailOut)
  if (detailErr) {
    await facade.run('browser_navigate', { action: 'back' }).catch(() => '')
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: input.canonicalUrl || input.noteUrl,
      openUrl: input.openUrl || input.noteUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: `verify_detail:${detailErr}`,
    }, {})
  }
  if (isLikelyXiaohongshuProfileListPage(detailOut, input) && !activeTargetConfirmed) {
    await facade.run('browser_navigate', { action: 'back' }).catch(() => '')
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: input.canonicalUrl || input.noteUrl,
      openUrl: input.openUrl || input.noteUrl,
      title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: 'detail_not_opened',
    }, {})
  }
  if (!detailMatchesTarget(detailOut, {
    title,
    sourceId,
    canonicalUrl: input.canonicalUrl || input.noteUrl,
    noteUrl: input.noteUrl,
  })) {
    const confirmedTabsOut = await facade.run('browser_tabs').catch(() => detailTab.tabsOut)
    if (!activeTabOutputContainsTargetUrl(confirmedTabsOut, detailTarget)) {
      await facade.run('browser_navigate', { action: 'back' }).catch(() => '')
      return writeArtifacts(fileOps, pathJoin, {
        success: false,
        noteUrl: input.noteUrl,
        canonicalUrl: input.canonicalUrl || input.noteUrl,
        openUrl: input.openUrl || input.noteUrl,
        title,
        sourceId,
        order: input.order,
        imageCount: 0,
        savedDir: input.outputDir,
        reason: 'detail_mismatch',
      }, {})
    }
  }
  const carouselMedia = await collectCarouselMedia(facade, input, detailOut)
  const collectFacade = carouselMedia ? facadeWithCarouselMedia(facade, carouselMedia) : facade
  const result = await collectNote(collectFacade, { ...input, skipNavigate: true }, pathJoin, fileOps)
  const returnOut = await facade.run('browser_navigate', { action: 'back' }).catch((error) => JSON.stringify({
    ok: false,
    errorCode: 'return_failed',
    message: error instanceof Error ? error.message : String(error),
  }))
  const returnErr = parseFacadeError(returnOut)
  if (returnErr) {
    return writeArtifacts(fileOps, pathJoin, {
      success: false,
      noteUrl: input.noteUrl,
      canonicalUrl: input.canonicalUrl || input.noteUrl,
      openUrl: input.openUrl || input.noteUrl,
      title: result.title || title,
      sourceId,
      order: input.order,
      imageCount: 0,
      savedDir: input.outputDir,
      reason: `return_list:${returnErr}`,
    }, {})
  }
  await facade.run('browser_wait', { duration_ms: 500 }).catch(() => '')
  return result
}
