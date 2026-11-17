/**
 * Updates for subscriptions that need the person's own login (Bilibili, Xiaohongshu, Weibo, Douyin).
 *
 * One hidden page in the person's browser session opens the profile, and the update is read from what that page
 * loaded and shows. This module makes no request of its own: no signatures, no platform API calls, no short-link
 * resolution outside the page. Contract: docs/superpowers/plans/2026-11-17-ready-next-rss-session-acquisition-implementation.md
 */
import { createHash } from 'crypto'
import {
  withDeadline,
  type BackgroundPageHandle,
  type BackgroundPageObserveOptions,
} from '../browser-engine/background-capture-page'
import { platformLabel, type PlatformType } from './scrapers'
import type { ScrapeResult, ScrapedItem } from './scrapers/base'
import { isSessionPlatform } from './session-acquisition-pacer'
import {
  BILIBILI_VIDEO_OWNER_SCRIPT,
  PAGE_META_SCRIPT,
  buildSessionPageScript,
  type BrowserAcquisitionMode,
} from './session-page-scripts'
import {
  bilibiliUploadsUrl,
  extractBilibiliUserId,
  extractXiaohongshuUserId,
  normalizeBrowserAcquisitionUrl,
} from './session-profile-urls'
import {
  parseBilibiliSpaceResponses,
  parseXiaohongshuNoteResponses,
  type BilibiliVideoRow,
  type SessionRiskSignal,
  type XiaohongshuNoteRow,
} from './session-response-parsers'

export type { BrowserAcquisitionMode } from './session-page-scripts'
export { normalizeBrowserAcquisitionUrl } from './session-profile-urls'

interface BrowserFeedCandidate {
  title?: string
  link?: string
  description?: string
  author?: string
  pubDate?: string
  coverImage?: string
  fingerprint?: string
  noteId?: string
  xsecToken?: string
}

export type BrowserSessionState = 'ready' | 'auth' | 'anti_bot' | 'waf' | 'empty'

/** How the items were read: the page's own responses, its embedded state, or its rendered list. */
export type BrowserSessionReadPath = 'responses' | 'state' | 'dom'

interface BrowserFeedExtractionResult {
  title?: string
  finalUrl?: string
  items?: BrowserFeedCandidate[]
  state?: BrowserSessionState
  via?: BrowserSessionReadPath
  detail?: string
  textSnippet?: string
  __readyCaptureError?: string
}

export interface BrowserSessionScrapeResult extends ScrapeResult {
  /** `error` means the page could not be opened or read at all. */
  state: BrowserSessionState | 'error'
  via: BrowserSessionReadPath | null
}

/** The one thing this module needs from the browser: a hidden page in the person's session. */
export interface SessionPageOpener {
  openBackgroundPage(options?: { observe?: BackgroundPageObserveOptions }): Promise<BackgroundPageHandle>
}

const BILIBILI_OBSERVE: BackgroundPageObserveOptions = {
  urlIncludes: [
    'api.bilibili.com/x/space/',
    'api.bilibili.com/x/polymer/web-space/',
    'api.bilibili.com/x/web-interface/nav',
  ],
  // A space page asks for a few dozen things about its owner; the uploads must not be crowded out.
  maxResponses: 48,
}
const XIAOHONGSHU_OBSERVE: BackgroundPageObserveOptions = {
  urlIncludes: ['/api/sns/web/v1/user_posted'],
}
const XIAOHONGSHU_NOTE_LINK = /xiaohongshu\.com\/(?:explore|discovery\/item)\/([0-9a-f]{24})(?:[/?#]|$)/i

/** Short links and video links resolve to the same uploader for as long as the app runs. */
const resolvedBilibiliOwners = new Map<string, string>()

/** The space a Bilibili subscription points at, once known: a short or video link is known after its first read. */
export function knownBilibiliSpaceUrl(url: string): string | null {
  const ownerId = extractBilibiliUserId(url) ?? resolvedBilibiliOwners.get(url) ?? null
  return ownerId ? `https://space.bilibili.com/${ownerId}` : null
}

function generateItemId(platform: PlatformType, key: string): string {
  const hash = createHash('md5').update(key).digest('hex').slice(0, 12)
  return `${platform}_${hash}`
}

function clipText(input: string | undefined, maxChars: number): string {
  const text = String(input || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

function isValidBrowserCandidateLink(platform: PlatformType, link: string): boolean {
  if (!link) return false

  if (platform === 'bilibili') {
    return /bilibili\.com\/video\/(?:BV[0-9A-Za-z]+|av\d+)/i.test(link)
  }

  if (platform === 'xiaohongshu') {
    return (
      /xiaohongshu\.com\/(explore|discovery\/item)\/[a-zA-Z0-9]+/i.test(link) ||
      /xiaohongshu\.com\/user\/profile\/[a-zA-Z0-9_-]+(?:[/?#].*)?$/i.test(link)
    )
  }

  return true
}

function isXiaohongshuProfileFallbackLink(link: string): boolean {
  return /xiaohongshu\.com\/user\/profile\/[a-zA-Z0-9_-]+#note-/i.test(link)
}

function buildBrowserCandidateKey(
  platform: PlatformType,
  row: BrowserFeedCandidate,
  link: string,
  title: string,
  description: string,
  coverImage: string,
): string {
  const fingerprint = clipText(row.fingerprint, 500)
  if (fingerprint) return `${link}|${fingerprint}`

  if (platform === 'xiaohongshu' && isXiaohongshuProfileFallbackLink(link)) {
    return [link, title, description, coverImage].filter(Boolean).join('|')
  }

  return [link, title].filter(Boolean).join('|')
}

/** A rendered Bilibili card mixes the title with play counts and dates; only a real sentence is kept. */
function sanitizeBilibiliBrowserDescription(value: string): string {
  const text = clipText(value, 500)
  if (!text) return ''

  const cleaned = text
    .replace(/(?:播放量?|播放|观看)\s*[\d.]+[万亿wW]?/gi, ' ')
    .replace(/(?:点赞|赞|弹幕|评论|收藏|投币|分享|转发)\s*[\d.]+[万亿wW]?/gi, ' ')
    .replace(/\b\d{1,2}[-/月]\d{1,2}(?:\s+\d{1,2}:\d{2})?\b/g, ' ')
    .replace(/\b(?:今天|昨天|前天|\d+\s*(?:分钟前|小时前|天前))\b/g, ' ')
    .replace(/[\d.]+(?:万|亿|w|W)?/g, ' ')
    .replace(/\b(?:万|亿|w|W)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return ''
  // A lone short token is usually the uploader name carried over from the card footer, not a useful summary.
  if (cleaned.length <= 16 && !cleaned.includes(' ') && !/[，。！？,.!?:：]/.test(cleaned)) return ''
  return cleaned
}

/**
 * A note is the same item however it was read: its identity is the note id, never the title, the cover or the
 * access token the page attached to its link.
 */
function xiaohongshuNoteItem(row: {
  noteId: string
  xsecToken?: string
  title?: string
  description?: string
  author?: string
  coverImage?: string
}): ScrapedItem {
  const canonical = `https://www.xiaohongshu.com/explore/${row.noteId.toLowerCase()}`
  const token = clipText(row.xsecToken, 300)
  return {
    itemId: generateItemId('xiaohongshu', canonical),
    title: clipText(row.title, 160) || '小红书内容',
    description: clipText(row.description, 500),
    link: token ? `${canonical}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user` : canonical,
    pubDate: '',
    author: clipText(row.author, 80),
    coverImage: clipText(row.coverImage, 500) || null,
    metadata: { rssGuid: canonical },
  }
}

function normalizeItems(platform: PlatformType, payload: BrowserFeedExtractionResult): ScrapedItem[] {
  const seen = new Set<string>()
  const rows = Array.isArray(payload.items) ? payload.items : []
  const mapped: ScrapedItem[] = []

  for (const row of rows) {
    const link = clipText(row.link, 500)
    if (!isValidBrowserCandidateLink(platform, link)) continue

    const noteId = platform === 'xiaohongshu'
      ? (/^[0-9a-f]{24}$/i.test(String(row.noteId || '')) ? String(row.noteId) : link.match(XIAOHONGSHU_NOTE_LINK)?.[1] || '')
      : ''
    if (noteId) {
      const item = xiaohongshuNoteItem({ ...row, noteId })
      if (seen.has(item.itemId)) continue
      seen.add(item.itemId)
      mapped.push(item)
    } else {
      if (seen.has(link)) continue
      seen.add(link)
      const title = clipText(row.title, 160) || '(Untitled)'
      const description = platform === 'bilibili'
        ? sanitizeBilibiliBrowserDescription(row.description || '')
        : clipText(row.description, 500)
      const coverImage = clipText(row.coverImage, 500)
      const itemKey = buildBrowserCandidateKey(platform, row, link, title, description, coverImage)
      mapped.push({
        itemId: generateItemId(platform, itemKey),
        title,
        description,
        link,
        pubDate: clipText(row.pubDate, 80),
        author: clipText(row.author, 80),
        coverImage: coverImage || null,
        metadata: clipText(row.fingerprint, 500)
          ? { fingerprint: clipText(row.fingerprint, 500) }
          : {},
      })
    }
    if (mapped.length >= 20) break
  }

  return mapped
}

function bilibiliVideoItem(row: BilibiliVideoRow): ScrapedItem {
  const link = `https://www.bilibili.com/video/${row.bvid}`
  return {
    itemId: generateItemId('bilibili', link),
    title: clipText(row.title, 160),
    description: clipText(row.description, 500),
    link,
    pubDate: row.publishedAt ? new Date(row.publishedAt * 1000).toISOString() : '',
    author: clipText(row.author, 80),
    coverImage: clipText(row.cover, 500) || null,
    metadata: {},
  }
}

function xiaohongshuObservedItem(row: XiaohongshuNoteRow): ScrapedItem {
  return xiaohongshuNoteItem({
    noteId: row.noteId,
    xsecToken: row.xsecToken,
    title: row.title,
    author: row.author,
    coverImage: row.cover,
  })
}

export function buildExtractionScriptForTest(
  platform: PlatformType,
  targetUrl: string,
  mode: BrowserAcquisitionMode = 'full',
): string {
  return buildSessionPageScript(platform, targetUrl, mode)
}

function describeBrowserFailure(platform: PlatformType, payload: BrowserFeedExtractionResult): string {
  const label = platformLabel(platform)
  const finalUrl = clipText(payload.finalUrl, 240)
  const suffix = finalUrl ? ` (${finalUrl})` : ''

  if (payload.state === 'auth') {
    return `${label} 应用内浏览器会话当前未登录，或已被重定向到登录页${suffix}。请先在 Ready 浏览器中登录该站点后再刷新。`
  }

  if (payload.state === 'anti_bot') {
    return `${label} 应用内浏览器当前遇到验证码/风控校验${suffix}${payload.textSnippet ? `：${clipText(payload.textSnippet, 180)}` : ''}`
  }

  if (payload.state === 'waf') {
    return `${label} 应用内浏览器当前被平台风控/WAF 拦截${suffix}${payload.textSnippet ? `：${clipText(payload.textSnippet, 180)}` : ''}`
  }

  return `${label} 应用内浏览器已加载页面，但未提取到可用条目${suffix}${payload.textSnippet ? `：${clipText(payload.textSnippet, 180)}` : ''}`
}

export function supportsBrowserSessionAcquisition(platform: PlatformType): boolean {
  return isSessionPlatform(platform)
}

interface SessionReading {
  snapshot: BrowserFeedExtractionResult
  items: ScrapedItem[]
  via: BrowserSessionReadPath | null
  /** What the page's own responses said when nothing could be read. */
  risk?: SessionRiskSignal | null
  signedOut?: boolean
}

/** A page script polls for at most this long; the page gets a little more before it is given up on. */
const PAGE_SCRIPT_TIMEOUT_MS: Readonly<Record<string, number>> = {
  bilibili: 20_000,
  xiaohongshu: 20_000,
  weibo: 32_000,
  douyin: 32_000,
}

/** One profile, start to finish. A page that never settles is closed rather than waited for. */
const SESSION_READ_DEADLINE_MS = 150_000

async function readSnapshot(
  page: BackgroundPageHandle,
  script: string,
  timeoutMs: number,
): Promise<BrowserFeedExtractionResult> {
  const value = await page.evaluate(script, { timeoutMs })
  return value && typeof value === 'object' ? (value as BrowserFeedExtractionResult) : {}
}

/**
 * Where the page ended up, when that address alone says the profile was not shown. Checked before a page is
 * read and again when reading failed, because a platform may send the page away while it is being read.
 */
export function classifySessionLanding(platform: PlatformType, url: string): BrowserSessionState | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  if (platform === 'xiaohongshu') {
    if (path.startsWith('/website-login/captcha')) return 'anti_bot'
    if (path.startsWith('/website-login/error')) return 'waf'
    if (path === '/login' || path.startsWith('/login/')) return 'auth'
    return null
  }
  if (platform === 'bilibili') return host === 'passport.bilibili.com' ? 'auth' : null
  if (platform === 'weibo') {
    return host === 'passport.weibo.com' || host === 'login.sina.com.cn' || path.startsWith('/login') ? 'auth' : null
  }
  if (platform === 'douyin') return path.startsWith('/passport') || path.startsWith('/login') ? 'auth' : null
  return null
}

function landedElsewhere(page: BackgroundPageHandle, platform: PlatformType): SessionReading | null {
  const finalUrl = page.currentUrl()
  const state = classifySessionLanding(platform, finalUrl)
  return state ? { snapshot: { finalUrl, state }, items: [], via: null } : null
}

async function readBilibili(
  page: BackgroundPageHandle,
  url: string,
): Promise<SessionReading> {
  let ownerId = extractBilibiliUserId(url) ?? resolvedBilibiliOwners.get(url) ?? null
  if (!ownerId) {
    // A short link or a video link: open it, then go on to the uploader's space the way a person would.
    await page.navigate(url, { timeoutMs: 30_000 })
    ownerId = extractBilibiliUserId(page.currentUrl())
    if (!ownerId) {
      const owner = await page.evaluate(BILIBILI_VIDEO_OWNER_SCRIPT, { timeoutMs: 10_000 }) as { ownerId?: string } | null
      ownerId = /^\d+$/.test(String(owner?.ownerId || '')) ? String(owner?.ownerId) : null
    }
    if (!ownerId) {
      return {
        snapshot: {
          finalUrl: page.currentUrl(),
          state: 'empty',
          textSnippet: '这个链接没有指向 UP 主，请改用 UP 主空间页的链接订阅',
        },
        items: [],
        via: null,
      }
    }
    resolvedBilibiliOwners.set(url, ownerId)
  }

  const owner = ownerId
  await page.navigate(bilibiliUploadsUrl(owner), { timeoutMs: 45_000 })
  const elsewhere = landedElsewhere(page, 'bilibili')
  if (elsewhere) return elsewhere

  // Wait for the uploads the page asks for. A risk answer on some other request of the page does not end the
  // wait: the list may still arrive. Only a refusal of the uploads request itself does.
  await page.waitForResponses((responses) => {
    const reading = parseBilibiliSpaceResponses(responses, owner)
    return reading.rows.length > 0 || reading.uploadsRefused
  }, 10_000)
  const fromResponses = (): SessionReading | null => {
    const observed = parseBilibiliSpaceResponses(page.responses(), owner)
    return observed.rows.length > 0
      ? { snapshot: { state: 'ready' }, items: observed.rows.map(bilibiliVideoItem), via: 'responses' }
      : null
  }
  const early = fromResponses()
  if (early) return { ...early, snapshot: { ...(await readSnapshot(page, PAGE_META_SCRIPT, 10_000)), state: 'ready' } }

  const snapshot = await readSnapshot(page, buildSessionPageScript('bilibili', page.currentUrl(), 'full'), PAGE_SCRIPT_TIMEOUT_MS.bilibili)
  // The list may have arrived while the rendered page was being read; it is the better reading.
  const late = fromResponses()
  if (late) return { ...late, snapshot: { ...snapshot, state: 'ready' } }
  const items = normalizeItems('bilibili', snapshot)
  const observed = parseBilibiliSpaceResponses(page.responses(), owner)
  return {
    snapshot,
    items,
    via: items.length > 0 ? 'dom' : null,
    risk: observed.risk,
    signedOut: observed.loggedIn === false,
  }
}

async function readXiaohongshu(
  page: BackgroundPageHandle,
  url: string,
  mode: BrowserAcquisitionMode,
  settle: () => Promise<void>,
): Promise<SessionReading> {
  const entry = normalizeBrowserAcquisitionUrl('xiaohongshu', url)
  await page.navigate(entry, { timeoutMs: 45_000 })
  await settle()
  const elsewhere = landedElsewhere(page, 'xiaohongshu')
  if (elsewhere) return elsewhere

  // Only a profile is read, and only its owner's notes: a page that is not a profile (a note, the feed the visit
  // was sent to) holds other people's notes as well.
  const landedUrl = page.currentUrl() || entry
  const profileId = extractXiaohongshuUserId(landedUrl)
  if (!profileId) {
    return {
      snapshot: {
        finalUrl: landedUrl,
        state: 'empty',
        textSnippet: '小红书订阅需要作者主页的链接（/user/profile/…），这个链接没有打开某位作者的主页',
      },
      items: [],
      via: null,
    }
  }

  const profileUrl = `https://www.xiaohongshu.com/user/profile/${profileId}`
  const snapshot = await readSnapshot(page, buildSessionPageScript('xiaohongshu', profileUrl, mode), PAGE_SCRIPT_TIMEOUT_MS.xiaohongshu)
  const fromPage = normalizeItems('xiaohongshu', snapshot)
  if (fromPage.length > 0 && snapshot.via === 'state') {
    return { snapshot, items: fromPage, via: 'state' }
  }

  const observed = parseXiaohongshuNoteResponses(page.responses(), profileId)
  if (observed.rows.length > 0) {
    return { snapshot: { ...snapshot, state: 'ready' }, items: observed.rows.slice(0, 20).map(xiaohongshuObservedItem), via: 'responses' }
  }
  return { snapshot, items: fromPage, via: fromPage.length > 0 ? 'dom' : null, risk: observed.risk }
}

async function readProfilePage(
  page: BackgroundPageHandle,
  platform: PlatformType,
  url: string,
  mode: BrowserAcquisitionMode,
  settle: () => Promise<void>,
): Promise<SessionReading> {
  const entry = normalizeBrowserAcquisitionUrl(platform, url)
  await page.navigate(entry, { timeoutMs: 45_000 })
  await settle()
  const elsewhere = landedElsewhere(page, platform)
  if (elsewhere) return elsewhere
  const snapshot = await readSnapshot(
    page,
    buildSessionPageScript(platform, page.currentUrl() || entry, mode),
    PAGE_SCRIPT_TIMEOUT_MS[platform] ?? 32_000,
  )
  const items = normalizeItems(platform, snapshot)
  return { snapshot, items, via: items.length > 0 ? 'dom' : null }
}

function failureState(reading: SessionReading): BrowserSessionState {
  const pageState = reading.snapshot.state
  if (pageState === 'auth' || reading.signedOut || reading.risk?.kind === 'auth') return 'auth'
  if (pageState === 'anti_bot' || pageState === 'waf') return pageState
  if (reading.risk) return reading.risk.kind
  return 'empty'
}

export async function fetchFeedViaBrowserSession(
  controller: SessionPageOpener,
  platform: PlatformType,
  url: string,
  options?: {
    mode?: BrowserAcquisitionMode
    /** The pause after a page stops loading, before it is read. Injected so tests do not wait. */
    settle?: () => Promise<void>
    /**
     * How long a page that was read stays open before it is closed, so that it finishes what it would load
     * for a person (covers, its own follow-up requests) instead of being cut off the moment the list arrived.
     */
    dwell?: () => Promise<void>
  },
): Promise<BrowserSessionScrapeResult> {
  const mode = options?.mode ?? 'full'
  const settle = options?.settle ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)))
  const dwell = options?.dwell
    ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 2_000 + Math.random() * 2_000)))
  const label = platformLabel(platform)
  let page: BackgroundPageHandle | null = null

  try {
    page = await controller.openBackgroundPage({
      observe: platform === 'bilibili' ? BILIBILI_OBSERVE : platform === 'xiaohongshu' ? XIAOHONGSHU_OBSERVE : undefined,
    })
    const opened = page
    const reading = await withDeadline(
      platform === 'bilibili'
        ? readBilibili(opened, url)
        : platform === 'xiaohongshu'
          ? readXiaohongshu(opened, url, mode, settle)
          : readProfilePage(opened, platform, url, mode, settle),
      SESSION_READ_DEADLINE_MS,
      `${label} page`,
    )
    const feedTitle = clipText(reading.snapshot.title, 160)

    if (reading.items.length > 0) {
      await dwell()
      return { items: reading.items, feedTitle, platform, state: 'ready', via: reading.via }
    }
    if (reading.snapshot.__readyCaptureError) {
      return {
        items: [],
        feedTitle: '',
        platform,
        state: 'error',
        via: null,
        error: `${label} 应用内浏览器提取脚本执行失败：${clipText(reading.snapshot.__readyCaptureError, 280)}`,
      }
    }
    const state = failureState(reading)
    return {
      items: [],
      feedTitle,
      platform,
      state,
      via: null,
      error: describeBrowserFailure(platform, { ...reading.snapshot, state }),
    }
  } catch (error) {
    // The platform may have sent the page to a sign-in or verification address while it was being read; that
    // is what happened, not a reading error.
    const landed = page ? classifySessionLanding(platform, page.currentUrl()) : null
    if (landed && landed !== 'ready' && landed !== 'empty') {
      return {
        items: [],
        feedTitle: '',
        platform,
        state: landed,
        via: null,
        error: describeBrowserFailure(platform, { finalUrl: page?.currentUrl(), state: landed }),
      }
    }
    return {
      items: [],
      feedTitle: '',
      platform,
      state: 'error',
      via: null,
      error: `${label} 应用内浏览器抓取异常：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    if (page) {
      await page.close().catch((error: unknown) => {
        console.warn('[rss-session] hidden page did not close cleanly:', error instanceof Error ? error.message : String(error))
      })
    }
  }
}
