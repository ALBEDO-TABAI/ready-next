export type BrowserTabResourceAction =
  | 'web_clip'
  | 'content_study'
  | 'copy_analysis'
  | 'visual_analysis'
  | 'browser_collection'

export type BrowserTabResourceKind =
  | 'direct_video'
  | 'video_page'
  | 'xiaohongshu_note'
  | 'xiaohongshu_account'
  | 'xiaohongshu_creator'
  | 'generic_page'
  | 'unknown'

export interface BrowserTabResourceInput {
  url?: string | null
  title?: string | null
}

export interface BrowserTabResourceClassification {
  kind: BrowserTabResourceKind
  url: string
  host: string
  stableId?: string
  hasLikelyVideo: boolean
  canAttemptVisualAnalysis: boolean
  supportedActions: BrowserTabResourceAction[]
}

const VIDEO_PAGE_HOST_HINTS = [
  'youtube.com',
  'youtu.be',
  'bilibili.com',
  'b23.tv',
  'bili2233.cn',
  'vimeo.com',
  'douyin.com',
  'tiktok.com',
]

export const BROWSER_VIDEO_FILE_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv'] as const

function normalizeUrlInput(input: string | BrowserTabResourceInput | null | undefined): string {
  if (typeof input === 'string') return input.trim()
  return String(input?.url || '').trim()
}

function sanitizeStableId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 80)
}

export function extractXiaohongshuNoteId(input: string | URL): string | null {
  let parsed: URL
  try {
    parsed = typeof input === 'string' ? new URL(input) : input
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (!host.endsWith('xiaohongshu.com')) return null
  const segments = parsed.pathname.split('/').map((part) => part.trim()).filter(Boolean)
  if (segments[0] === 'explore' && segments[1]) return sanitizeStableId(segments[1]) || null
  if (segments[0] === 'discovery' && segments[1] === 'item' && segments[2]) return sanitizeStableId(segments[2]) || null
  if (segments[0] === 'user' && segments[1] === 'profile' && segments[2] && segments[3]) return sanitizeStableId(segments[3]) || null
  return null
}

function isDirectVideoUrl(parsed: URL, rawLower: string): boolean {
  return BROWSER_VIDEO_FILE_EXTENSIONS.some((ext) => rawLower.endsWith(ext) || parsed.pathname.toLowerCase().endsWith(ext))
}

function actions(...items: BrowserTabResourceAction[]): BrowserTabResourceAction[] {
  return [...items]
}

export function classifyBrowserTabResource(input: string | BrowserTabResourceInput | null | undefined): BrowserTabResourceClassification {
  const raw = normalizeUrlInput(input)
  const rawLower = raw.toLowerCase()
  if (!rawLower) {
    return {
      kind: 'unknown',
      url: '',
      host: '',
      hasLikelyVideo: false,
      canAttemptVisualAnalysis: false,
      supportedActions: [],
    }
  }

  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    const noteId = extractXiaohongshuNoteId(parsed)
    if (noteId) {
      return {
        kind: 'xiaohongshu_note',
        url: parsed.toString(),
        host,
        stableId: noteId,
        hasLikelyVideo: false,
        canAttemptVisualAnalysis: true,
        supportedActions: actions('web_clip', 'content_study', 'copy_analysis', 'visual_analysis', 'browser_collection'),
      }
    }

    if (host.endsWith('xiaohongshu.com')) {
      const segments = parsed.pathname.split('/').map((part) => part.trim()).filter(Boolean)
      if (segments[0] === 'user' && segments[1] === 'profile' && segments[2]) {
        return {
          kind: 'xiaohongshu_account',
          url: parsed.toString(),
          host,
          stableId: sanitizeStableId(segments[2]) || undefined,
          hasLikelyVideo: false,
          canAttemptVisualAnalysis: false,
          supportedActions: actions('web_clip', 'content_study', 'copy_analysis', 'browser_collection'),
        }
      }
      if (host.startsWith('creator.') || segments[0] === 'publish') {
        return {
          kind: 'xiaohongshu_creator',
          url: parsed.toString(),
          host,
          hasLikelyVideo: false,
          canAttemptVisualAnalysis: false,
          supportedActions: actions('web_clip', 'content_study'),
        }
      }
    }

    const directVideo = isDirectVideoUrl(parsed, rawLower)
    const knownVideoPage = rawLower.includes('/video/') || VIDEO_PAGE_HOST_HINTS.some((hint) => host.includes(hint))
    if (directVideo || knownVideoPage) {
      return {
        kind: directVideo ? 'direct_video' : 'video_page',
        url: parsed.toString(),
        host,
        hasLikelyVideo: true,
        canAttemptVisualAnalysis: true,
        supportedActions: actions('web_clip', 'content_study', 'copy_analysis', 'visual_analysis'),
      }
    }

    return {
      kind: 'generic_page',
      url: parsed.toString(),
      host,
      hasLikelyVideo: false,
      canAttemptVisualAnalysis: false,
      supportedActions: actions('web_clip', 'content_study', 'copy_analysis'),
    }
  } catch {
    const directVideo = BROWSER_VIDEO_FILE_EXTENSIONS.some((ext) => rawLower.endsWith(ext))
    return {
      kind: directVideo ? 'direct_video' : 'unknown',
      url: raw,
      host: '',
      hasLikelyVideo: directVideo,
      canAttemptVisualAnalysis: directVideo,
      supportedActions: directVideo ? actions('copy_analysis', 'visual_analysis') : [],
    }
  }
}

export function canAttemptVisualAnalysis(input: string | BrowserTabResourceInput | null | undefined): boolean {
  return classifyBrowserTabResource(input).canAttemptVisualAnalysis
}

export function hasLikelyVideoResource(input: string | BrowserTabResourceInput | null | undefined): boolean {
  return classifyBrowserTabResource(input).hasLikelyVideo
}
