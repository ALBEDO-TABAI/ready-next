/**
 * Reads what a platform page itself requested while it loaded. Nothing here makes a request: the inputs are
 * response bodies observed on the hidden page, and each parser recognises the data by its shape so that a renamed
 * endpoint does not break it.
 */

export interface ObservedResponse {
  url: string
  status: number
  body: string
}

export type SessionRiskKind = 'auth' | 'anti_bot' | 'waf'

export interface SessionRiskSignal {
  kind: SessionRiskKind
  detail: string
}

export interface BilibiliVideoRow {
  bvid: string
  title: string
  description: string
  cover: string
  author: string
  publishedAt: number | null
}

export interface BilibiliSpaceReading {
  rows: BilibiliVideoRow[]
  risk: SessionRiskSignal | null
  /** What the page's own account request said; null when the page did not ask. */
  loggedIn: boolean | null
}

export interface XiaohongshuNoteRow {
  noteId: string
  title: string
  cover: string
  author: string
  userId: string
  xsecToken: string
}

export interface XiaohongshuNotesReading {
  rows: XiaohongshuNoteRow[]
  risk: SessionRiskSignal | null
}

const MAX_WALK_NODES = 40_000
const MAX_WALK_DEPTH = 12

function parseJson(body: string): unknown {
  const text = body.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}

function absoluteImage(value: unknown): string {
  const url = text(value)
  if (!url) return ''
  return url.startsWith('//') ? `https:${url}` : url.replace(/^http:\/\//i, 'https://')
}

/** Visits every array in a JSON value, bounded so a huge payload cannot stall the main process. */
function forEachArray(root: unknown, visit: (rows: unknown[]) => void): void {
  let budget = MAX_WALK_NODES
  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') return
    budget -= 1
    if (Array.isArray(node)) {
      visit(node)
      for (const entry of node) walk(entry, depth + 1)
      return
    }
    for (const value of Object.values(node as Record<string, unknown>)) walk(value, depth + 1)
  }
  walk(root, 0)
}

function queryParam(url: string, name: string): string {
  try {
    return new URL(url).searchParams.get(name) || ''
  } catch {
    return ''
  }
}

const BILIBILI_BVID = /^BV[0-9A-Za-z]{8,12}$/
const BILIBILI_RISK_CODES = new Map<number, SessionRiskSignal>([
  [-352, { kind: 'waf', detail: 'bilibili_risk_control_-352' }],
  [-412, { kind: 'waf', detail: 'bilibili_request_blocked_-412' }],
  [-799, { kind: 'waf', detail: 'bilibili_too_frequent_-799' }],
  [-101, { kind: 'auth', detail: 'bilibili_not_logged_in_-101' }],
])

function readBilibiliVideoRow(entry: unknown): (BilibiliVideoRow & { ownerId: string }) | null {
  if (!isRecord(entry)) return null
  const bvid = text(entry.bvid)
  const title = text(entry.title)
  if (!BILIBILI_BVID.test(bvid) || !title) return null
  const owner = isRecord(entry.owner) ? entry.owner : isRecord(entry.upper) ? entry.upper : null
  const seconds = Number(entry.created ?? entry.pubdate ?? entry.ctime)
  return {
    bvid,
    title,
    description: text(entry.description ?? entry.desc),
    cover: absoluteImage(entry.pic ?? entry.cover),
    author: text(entry.author) || text(owner?.name),
    publishedAt: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    ownerId: text(entry.mid) || text(owner?.mid),
  }
}

function isBilibiliAccountResponse(url: string): boolean {
  return url.includes('/x/web-interface/nav')
}

/**
 * The uploads a space page requested for itself. A response that names the space in its address is trusted whole
 * (a co-authored video carries another uploader's id); otherwise a row must carry the space owner's id.
 */
export function parseBilibiliSpaceResponses(responses: ObservedResponse[], ownerId: string): BilibiliSpaceReading {
  const rows = new Map<string, BilibiliVideoRow>()
  let risk: SessionRiskSignal | null = null
  let loggedIn: boolean | null = null

  for (const response of responses) {
    const payload = parseJson(response.body)
    const code = isRecord(payload) ? Number(payload.code) : NaN

    if (isBilibiliAccountResponse(response.url)) {
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null
      if (typeof data?.isLogin === 'boolean') loggedIn = data.isLogin
      else if (code === -101) loggedIn = false
      continue
    }

    if (response.status === 412) {
      risk = risk ?? { kind: 'waf', detail: 'bilibili_http_412' }
      continue
    }
    if (!isRecord(payload)) continue
    if (Number.isFinite(code) && code !== 0) {
      risk = risk ?? BILIBILI_RISK_CODES.get(code) ?? null
      continue
    }

    const namesSpace = queryParam(response.url, 'mid') === ownerId || queryParam(response.url, 'host_mid') === ownerId
    forEachArray(payload.data, (entries) => {
      for (const entry of entries) {
        const row = readBilibiliVideoRow(entry)
        if (!row) continue
        if (!namesSpace && row.ownerId !== ownerId) continue
        if (rows.has(row.bvid)) continue
        const { ownerId: _owner, ...video } = row
        rows.set(row.bvid, video)
      }
    })
  }

  const ordered = [...rows.values()].sort((left, right) => (right.publishedAt ?? 0) - (left.publishedAt ?? 0))
  return { rows: ordered.slice(0, 30), risk, loggedIn }
}

const XIAOHONGSHU_NOTE_ID = /^[0-9a-f]{24}$/i
const XIAOHONGSHU_RISK_CODES = new Map<number, SessionRiskSignal>([
  [-100, { kind: 'auth', detail: 'xiaohongshu_login_expired_-100' }],
  [-101, { kind: 'auth', detail: 'xiaohongshu_not_logged_in_-101' }],
  [300011, { kind: 'waf', detail: 'xiaohongshu_account_abnormal_300011' }],
  [300012, { kind: 'waf', detail: 'xiaohongshu_network_risk_300012' }],
  [300013, { kind: 'waf', detail: 'xiaohongshu_too_frequent_300013' }],
  [300015, { kind: 'waf', detail: 'xiaohongshu_browser_abnormal_300015' }],
])

function readXiaohongshuNoteRow(entry: unknown): XiaohongshuNoteRow | null {
  if (!isRecord(entry)) return null
  const card = isRecord(entry.noteCard) ? entry.noteCard : isRecord(entry.note_card) ? entry.note_card : entry
  const noteId = text(card.note_id ?? card.noteId) || text(entry.note_id ?? entry.noteId ?? entry.id)
  const title = text(card.display_title ?? card.displayTitle ?? card.title)
  if (!XIAOHONGSHU_NOTE_ID.test(noteId)) return null
  const user = isRecord(card.user) ? card.user : null
  const cover = isRecord(card.cover) ? card.cover : null
  const firstInfo = Array.isArray(cover?.info_list) ? cover.info_list[0] : Array.isArray(cover?.infoList) ? cover.infoList[0] : null
  return {
    noteId: noteId.toLowerCase(),
    title: title || '小红书内容',
    cover: absoluteImage(cover?.url_default ?? cover?.urlDefault ?? cover?.url ?? (isRecord(firstInfo) ? firstInfo.url : '')),
    author: text(user?.nickname ?? user?.nick_name ?? user?.nickName),
    userId: text(user?.user_id ?? user?.userId),
    xsecToken: text(card.xsec_token ?? card.xsecToken ?? entry.xsec_token ?? entry.xsecToken),
  }
}

/** The notes a profile page requested for itself. A note is kept only when it belongs to that profile. */
export function parseXiaohongshuNoteResponses(responses: ObservedResponse[], profileUserId: string): XiaohongshuNotesReading {
  const rows = new Map<string, XiaohongshuNoteRow>()
  let risk: SessionRiskSignal | null = null

  for (const response of responses) {
    if (response.status === 461 || response.status === 471) {
      risk = risk ?? { kind: 'anti_bot', detail: `xiaohongshu_verification_http_${response.status}` }
      continue
    }
    const payload = parseJson(response.body)
    if (!isRecord(payload)) continue
    const code = Number(payload.code)
    if (Number.isFinite(code) && code !== 0) {
      risk = risk ?? XIAOHONGSHU_RISK_CODES.get(code) ?? null
      continue
    }
    const namesProfile = Boolean(profileUserId) && queryParam(response.url, 'user_id') === profileUserId
    forEachArray(payload.data, (entries) => {
      for (const entry of entries) {
        const row = readXiaohongshuNoteRow(entry)
        if (!row || rows.has(row.noteId)) continue
        if (profileUserId && row.userId ? row.userId !== profileUserId : !namesProfile) continue
        rows.set(row.noteId, row)
      }
    })
  }

  return { rows: [...rows.values()].slice(0, 30), risk }
}
