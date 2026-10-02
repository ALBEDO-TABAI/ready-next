// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
import type {
  BrowserCookieDomainGroup,
  BrowserCookieRecord,
  BrowserPrivacySummary,
  ClearBrowsingDataRequest,
  RemoveBrowserCookiePayload,
} from '../../../shared/browser-privacy'

const inThirtyDays = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
const inOneYear = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365

function cookie(hostDomain: string, name: string, value: string, extra: Partial<BrowserCookieRecord> = {}): BrowserCookieRecord {
  return {
    domain: `.${hostDomain}`,
    hostDomain,
    name,
    value,
    path: '/',
    secure: true,
    httpOnly: false,
    session: false,
    expirationDate: inThirtyDays,
    sameSite: 'lax',
    ...extra,
  }
}

let cookieGroups: BrowserCookieDomainGroup[] = [
  {
    domain: 'github.com',
    cookies: [
      cookie('github.com', '_gh_sess', 'a4f9c1e0b7d24e8f9a6c3b1d0e2f4a5b', { httpOnly: true, session: true, expirationDate: undefined, sameSite: 'lax' }),
      cookie('github.com', 'logged_in', 'yes', { httpOnly: true, expirationDate: inOneYear }),
      cookie('github.com', 'color_mode', '%7B%22color_mode%22%3A%22auto%22%7D', { secure: true }),
      cookie('github.com', 'tz', 'Asia%2FShanghai', { session: true, expirationDate: undefined }),
    ],
  },
  {
    domain: 'bilibili.com',
    cookies: [
      cookie('bilibili.com', 'SESSDATA', '6c1e2b%2C1767226000%2Cf0a1b*c2', { httpOnly: true, expirationDate: inOneYear }),
      cookie('bilibili.com', 'bili_jct', '9f2e6d4c0b1a3e5d7c9b8a6f4e2d0c1b'),
      cookie('bilibili.com', 'buvid3', '3B5C7D9E-1F2A-4B6C-8D0E-2F4A6B8C0D1E', { expirationDate: inOneYear, sameSite: 'no_restriction' }),
    ],
  },
  {
    domain: 'xiaohongshu.com',
    cookies: [
      cookie('xiaohongshu.com', 'web_session', '040069b4c1d2e3f40a5b6c7d8e9f0a1b2c3d', { httpOnly: true }),
      cookie('xiaohongshu.com', 'a1', '18c2f0e9d8b-0a1b2c3d4e5f6a-26031e51-1fa400-18c2f0e9d8c'),
    ],
  },
  {
    domain: 'news.ycombinator.com',
    cookies: [
      cookie('news.ycombinator.com', 'user', 'ready&3a9f1c7e2b4d6f8a0c', { httpOnly: true, expirationDate: inOneYear }),
    ],
  },
  {
    domain: 'docs.google.com',
    cookies: [
      cookie('docs.google.com', 'COMPASS', 'docs=CgAQ9_vwqAYa', { path: '/document', httpOnly: true }),
      cookie('docs.google.com', 'S', 'documents=hz3rVx8kY1pQ', { session: true, expirationDate: undefined, httpOnly: true }),
    ],
  },
]

function buildSummary(): BrowserPrivacySummary {
  return {
    cacheBytes: 186 * 1024 * 1024 + 420 * 1024,
    cookieCount: cookieGroups.reduce((sum, group) => sum + group.cookies.length, 0),
    cookieDomainCount: cookieGroups.length,
    historyCount: 1284,
    downloadCount: 37,
  }
}

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  browser: {
    getPrivacySummary: async () => ({ success: true, data: buildSummary() }),
    listCookies: async () => ({ success: true, data: cookieGroups }),
    clearBrowsingData: async (request: ClearBrowsingDataRequest) => {
      if (request.dataTypes.includes('cookies')) cookieGroups = []
      return { success: true, data: { cleared: request.dataTypes, errors: [] } }
    },
    removeCookie: async (payload: RemoveBrowserCookiePayload) => {
      cookieGroups = cookieGroups
        .map((group) => ({
          ...group,
          cookies: group.cookies.filter((item) => !(item.hostDomain === payload.domain && item.name === payload.name && item.path === payload.path)),
        }))
        .filter((group) => group.cookies.length > 0)
      return { success: true }
    },
    removeCookiesForDomain: async ({ domain }: { domain: string }) => {
      cookieGroups = cookieGroups.filter((group) => group.domain !== domain)
      return { success: true }
    },
  },
}
