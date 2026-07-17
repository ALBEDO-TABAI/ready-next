import { useState, useEffect, useCallback, useMemo } from 'react'
import { CheckCircle2, ChevronRight, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../components/settings/settings-theme'
import { SETTINGS_ROW_CONTROL_MIN_WIDTH } from './settings-shared'
import type {
  BrowserCookieDomainGroup,
  BrowserCookieRecord,
  BrowserPrivacySummary,
  BrowsingDataType,
} from '../../../shared/browser-privacy'

// Browser privacy panel — wired to browser:getPrivacySummary /
// browser:clearBrowsingData / browser:listCookies / browser:removeCookie /
// browser:removeCookiesForDomain. All operations target the persist:browser
// partition (the real browsing session), not the default session.

type TimeRangeValue = 'hour' | 'day' | 'week' | 'month' | 'all'

const TIME_RANGE_OPTIONS: { value: TimeRangeValue; label: string; seconds: number | null }[] = [
  { value: 'hour', label: '过去 1 小时', seconds: 3600 },
  { value: 'day', label: '过去 24 小时', seconds: 86400 },
  { value: 'week', label: '过去 7 天', seconds: 604800 },
  { value: 'month', label: '过去 4 周', seconds: 2419200 },
  { value: 'all', label: '全部时间', seconds: null },
]

type ClearItemId = 'history' | 'downloads' | 'cookiesAndSiteData' | 'cache'

// Edge-style checklist: “Cookie 及其他站点数据” 一项覆盖 cookies + siteStorage 两个 wire 类型。
const CLEAR_ITEMS: { id: ClearItemId; label: string; dataTypes: BrowsingDataType[]; timeRanged: boolean }[] = [
  { id: 'history', label: '浏览历史', dataTypes: ['history'], timeRanged: true },
  { id: 'downloads', label: '下载记录', dataTypes: ['downloads'], timeRanged: true },
  { id: 'cookiesAndSiteData', label: 'Cookie 及其他站点数据', dataTypes: ['cookies', 'siteStorage'], timeRanged: false },
  { id: 'cache', label: '缓存的图片和文件', dataTypes: ['cache'], timeRanged: false },
]

const DATA_TYPE_LABELS: Record<BrowsingDataType, string> = {
  history: '浏览历史',
  downloads: '下载记录',
  cookies: 'Cookie',
  siteStorage: '站点存储',
  cache: '缓存',
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

// 次级元数据合成一行：省略无信息量的默认值（路径 /、SameSite unspecified）。
function cookieMetaLine(cookie: BrowserCookieRecord): string {
  const parts: string[] = []
  if (cookie.session || typeof cookie.expirationDate !== 'number') {
    parts.push('会话')
  } else {
    try {
      parts.push(`到期 ${new Date(cookie.expirationDate * 1000).toLocaleDateString('zh-CN')}`)
    } catch {
      parts.push('到期未知')
    }
  }
  if (cookie.secure) parts.push('Secure')
  if (cookie.httpOnly) parts.push('HttpOnly')
  if (cookie.sameSite && cookie.sameSite !== 'unspecified') parts.push(`SameSite ${cookie.sameSite}`)
  if (cookie.path !== '/') parts.push(`路径 ${cookie.path}`)
  return parts.join(' · ')
}

interface ConfirmState {
  title: string
  message: string
  confirmLabel: string
  action: () => Promise<void>
}

export function BrowserPrivacySettingsPanel() {
  const [summary, setSummary] = useState<BrowserPrivacySummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [timeRange, setTimeRange] = useState<TimeRangeValue>('hour')
  const [checkedItems, setCheckedItems] = useState<Record<ClearItemId, boolean>>({
    history: true,
    downloads: true,
    cookiesAndSiteData: false,
    cache: true,
  })
  const [clearing, setClearing] = useState(false)
  const [clearResult, setClearResult] = useState<{ clearedLabels: string[]; errors: string[] } | null>(null)

  const [cookieGroups, setCookieGroups] = useState<BrowserCookieDomainGroup[] | null>(null)
  const [cookiesLoading, setCookiesLoading] = useState(true)
  const [cookieError, setCookieError] = useState<string | null>(null)
  const [cookieSearch, setCookieSearch] = useState('')
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null)
  const [busyDomain, setBusyDomain] = useState<string | null>(null)
  const [busyCookieKey, setBusyCookieKey] = useState<string | null>(null)
  const [clearingAllCookies, setClearingAllCookies] = useState(false)

  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const refreshSummary = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.browser?.getPrivacySummary) {
      setSummaryLoading(false)
      setSummaryError('浏览器 IPC 不可用')
      return
    }
    setSummaryLoading(true)
    try {
      const result = await window.electronAPI.browser.getPrivacySummary()
      if (result.success && result.data) {
        setSummary(result.data)
        setSummaryError(null)
      } else {
        setSummaryError(result.error || '读取浏览数据概况失败')
      }
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err))
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const refreshCookies = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.browser?.listCookies) {
      setCookiesLoading(false)
      setCookieError('浏览器 IPC 不可用')
      return
    }
    setCookiesLoading(true)
    try {
      const result = await window.electronAPI.browser.listCookies()
      if (result.success && result.data) {
        setCookieGroups(result.data)
        setCookieError(null)
      } else {
        setCookieError(result.error || '读取 Cookie 失败')
      }
    } catch (err) {
      setCookieError(err instanceof Error ? err.message : String(err))
    } finally {
      setCookiesLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshSummary()
    void refreshCookies()
  }, [refreshSummary, refreshCookies])

  const itemDescriptions: Record<ClearItemId, string> = {
    history: summary ? `${summary.historyCount} 条记录` : '…',
    downloads: summary
      ? `${summary.downloadCount} 条记录（仅清除记录，不删除已下载的文件）`
      : '…',
    cookiesAndSiteData: summary
      ? `${summary.cookieDomainCount} 个站点，${summary.cookieCount} 个 Cookie；清除后多数网站需要重新登录`
      : '…',
    cache: summary ? `${formatBytes(summary.cacheBytes)}；下次访问网站时会重新下载` : '…',
  }

  const selectedItems = CLEAR_ITEMS.filter((item) => checkedItems[item.id])
  const rangeSeconds = TIME_RANGE_OPTIONS.find((opt) => opt.value === timeRange)?.seconds ?? null
  const showFullClearNote =
    rangeSeconds !== null && selectedItems.some((item) => !item.timeRanged)

  const performClear = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.browser?.clearBrowsingData) return
    const dataTypes = selectedItems.flatMap((item) => item.dataTypes)
    if (dataTypes.length === 0) return
    setClearing(true)
    setClearResult(null)
    try {
      const sinceEpochSeconds =
        rangeSeconds !== null ? Math.floor(Date.now() / 1000) - rangeSeconds : undefined
      const result = await window.electronAPI.browser.clearBrowsingData({ dataTypes, sinceEpochSeconds })
      if (result.success && result.data) {
        const clearedLabels = CLEAR_ITEMS
          .filter((item) => item.dataTypes.some((t) => result.data!.cleared.includes(t)))
          .map((item) => item.label)
        setClearResult({
          clearedLabels,
          errors: result.data.errors.map((e) => `${DATA_TYPE_LABELS[e.type as BrowsingDataType] || e.type}：${e.message}`),
        })
      } else {
        setClearResult({ clearedLabels: [], errors: [result.error || '清除失败'] })
      }
    } catch (err) {
      setClearResult({ clearedLabels: [], errors: [err instanceof Error ? err.message : String(err)] })
    } finally {
      setClearing(false)
      void refreshSummary()
      void refreshCookies()
    }
  }, [selectedItems, rangeSeconds, refreshSummary, refreshCookies])

  const requestClear = useCallback(() => {
    const rangeLabel = TIME_RANGE_OPTIONS.find((opt) => opt.value === timeRange)?.label || ''
    const scopeParts = rangeSeconds === null
      ? [`全部时间的${selectedItems.map((item) => item.label).join('、')}`]
      : [
          selectedItems.some((item) => item.timeRanged)
            ? `${rangeLabel}的${selectedItems.filter((item) => item.timeRanged).map((item) => item.label).join('、')}`
            : null,
          selectedItems.some((item) => !item.timeRanged)
            ? `全部时间的${selectedItems.filter((item) => !item.timeRanged).map((item) => item.label).join('、')}`
            : null,
        ].filter((part): part is string => Boolean(part))
    setConfirm({
      title: '确认清除浏览数据',
      message: `将清除${scopeParts.join('，并清除')}。此操作不可撤销，是否继续？`,
      confirmLabel: '确认清除',
      action: performClear,
    })
  }, [selectedItems, timeRange, rangeSeconds, performClear])

  const removeDomainCookies = useCallback(async (domain: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.browser?.removeCookiesForDomain) return
    setBusyDomain(domain)
    try {
      const result = await window.electronAPI.browser.removeCookiesForDomain({ domain })
      if (!result.success) {
        setCookieError(result.error || `删除 ${domain} 的 Cookie 失败`)
      }
    } catch (err) {
      setCookieError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyDomain(null)
      void refreshCookies()
      void refreshSummary()
    }
  }, [refreshCookies, refreshSummary])

  const removeSingleCookie = useCallback(
    async (cookie: { hostDomain: string; path: string; name: string; secure: boolean }, key: string) => {
      if (typeof window === 'undefined' || !window.electronAPI?.browser?.removeCookie) return
      setBusyCookieKey(key)
      try {
        const result = await window.electronAPI.browser.removeCookie({
          domain: cookie.hostDomain,
          path: cookie.path,
          name: cookie.name,
          secure: cookie.secure,
        })
        if (!result.success) {
          setCookieError(result.error || `删除 Cookie ${cookie.name} 失败`)
        }
      } catch (err) {
        setCookieError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyCookieKey(null)
        void refreshCookies()
        void refreshSummary()
      }
    },
    [refreshCookies, refreshSummary],
  )

  const clearAllCookies = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.browser?.clearBrowsingData) return
    setClearingAllCookies(true)
    try {
      const result = await window.electronAPI.browser.clearBrowsingData({ dataTypes: ['cookies'] })
      if (!result.success) {
        setCookieError(result.error || '清除全部 Cookie 失败')
      } else if (result.data && result.data.errors.length > 0) {
        setCookieError(result.data.errors.map((e) => e.message).join('；'))
      }
    } catch (err) {
      setCookieError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearingAllCookies(false)
      void refreshCookies()
      void refreshSummary()
    }
  }, [refreshCookies, refreshSummary])

  const filteredGroups = useMemo(() => {
    if (!cookieGroups) return []
    const query = cookieSearch.trim().toLowerCase()
    if (!query) return cookieGroups
    return cookieGroups.filter((group) => group.domain.includes(query))
  }, [cookieGroups, cookieSearch])

  const totalCookies = summary?.cookieCount ?? 0

  return (
    <div className="flex flex-col gap-7">
      {/* ===== 清除浏览数据 ===== */}
      <div
        className="glass-surface-card rounded-2xl border"
        style={{ ...SETTINGS_CARD_STYLE, padding: '22px 24px' }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
              清除浏览数据
            </div>
            <div className="text-[11px]" style={{ marginTop: 4, color: 'var(--text-light)' }}>
              清除浏览历史、下载记录、Cookie 和缓存
            </div>
          </div>
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRangeValue)}
            className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
            style={{
              ...SETTINGS_INPUT_STYLE,
              padding: '8px 32px 8px 14px',
              width: 'auto',
              minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
            }}
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {summaryError && (
          <div className="text-[11px]" style={{ marginTop: 8, color: 'var(--color-red, #d44)' }}>
            {summaryError}
          </div>
        )}

        <div className="flex flex-col gap-4" style={{ marginTop: 20 }}>
          {CLEAR_ITEMS.map((item) => (
            <label key={item.id} className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={checkedItems[item.id]}
                onChange={(e) =>
                  setCheckedItems((prev) => ({ ...prev, [item.id]: e.target.checked }))
                }
                className="h-4 w-4 cursor-pointer accent-[var(--color-blue)]"
                style={{ marginTop: 2 }}
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium" style={{ color: 'var(--text-body)' }}>
                  {item.label}
                </span>
                <span className="block text-[11px]" style={{ marginTop: 2, color: 'var(--text-light)' }}>
                  {summaryLoading ? '…' : itemDescriptions[item.id]}
                </span>
              </span>
            </label>
          ))}
        </div>

        {showFullClearNote && (
          <div className="text-[11px]" style={{ marginTop: 12, color: 'var(--text-muted)' }}>
            Cookie、站点数据与缓存不支持按时间范围清除，勾选后将全部清除。
          </div>
        )}

        <div className="flex justify-end" style={{ marginTop: 20 }}>
          <button
            onClick={requestClear}
            disabled={clearing || selectedItems.length === 0}
            className="flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
            style={{
              ...SETTINGS_DANGER_BUTTON_STYLE,
              minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
              justifyContent: 'center',
              opacity: clearing || selectedItems.length === 0 ? 0.6 : 1,
              cursor: clearing || selectedItems.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {clearing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {clearing ? '清除中…' : '清除所选数据'}
          </button>
        </div>

        {clearResult && (
          <div
            className="rounded-xl"
            style={{ ...SETTINGS_SUBTLE_CARD_STYLE, marginTop: 16, padding: '12px 14px' }}
          >
            <div className="flex items-center gap-2">
              {clearResult.errors.length === 0
                ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--color-green)' }} />
                : <XCircle className="w-3.5 h-3.5" style={{ color: 'var(--color-red, #d44)' }} />}
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-body)' }}>
                {clearResult.errors.length === 0
                  ? `已清除：${clearResult.clearedLabels.join('、')}`
                  : clearResult.clearedLabels.length > 0
                    ? `部分完成：已清除 ${clearResult.clearedLabels.join('、')}，${clearResult.errors.length} 项失败`
                    : '清除失败'}
              </span>
            </div>
            {clearResult.errors.length > 0 && (
              <ul className="list-disc text-[11px]" style={{ marginTop: 8, paddingLeft: 20, color: 'var(--text-light)' }}>
                {clearResult.errors.slice(0, 5).map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ===== Cookie 管理 ===== */}
      <div
        className="glass-surface-card rounded-2xl border"
        style={{ ...SETTINGS_CARD_STYLE, padding: '22px 24px' }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
              Cookie 管理
            </div>
            <div className="text-[11px]" style={{ marginTop: 4, color: 'var(--text-light)' }}>
              {summary
                ? `${summary.cookieDomainCount} 个站点 · ${summary.cookieCount} 个 Cookie`
                : '查看并删除各站点存储在本地的 Cookie'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void refreshCookies(); void refreshSummary() }}
              disabled={cookiesLoading}
              className="flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
              style={{
                ...SETTINGS_SECONDARY_BUTTON_STYLE,
                opacity: cookiesLoading ? 0.6 : 1,
                cursor: cookiesLoading ? 'not-allowed' : 'pointer',
              }}
            >
              <RefreshCw className={`w-3 h-3 ${cookiesLoading ? 'animate-spin' : ''}`} />
              刷新
            </button>
            <button
              onClick={() =>
                setConfirm({
                  title: '确认清除全部 Cookie',
                  message: `将删除全部 ${summary?.cookieDomainCount ?? ''} 个站点的 ${totalCookies} 个 Cookie，多数网站需要重新登录。是否继续？`,
                  confirmLabel: '全部删除',
                  action: clearAllCookies,
                })
              }
              disabled={clearingAllCookies || totalCookies === 0}
              className="flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
              style={{
                ...SETTINGS_DANGER_BUTTON_STYLE,
                opacity: clearingAllCookies || totalCookies === 0 ? 0.6 : 1,
                cursor: clearingAllCookies || totalCookies === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              {clearingAllCookies ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              全部删除
            </button>
          </div>
        </div>

        <input
          value={cookieSearch}
          onChange={(e) => setCookieSearch(e.target.value)}
          placeholder="按域名搜索"
          className="block text-[12px]"
          style={{ ...SETTINGS_INPUT_STYLE, marginTop: 20, padding: '9px 14px', maxWidth: 340 }}
        />

        {cookieError && (
          <div className="text-[11px]" style={{ marginTop: 8, color: 'var(--color-red, #d44)' }}>
            {cookieError}
          </div>
        )}

        <div
          className="max-h-[440px] overflow-y-auto"
          style={{ ...SETTINGS_SUBTLE_CARD_STYLE, marginTop: 16, padding: 10 }}
        >
          {cookiesLoading && (
            <div className="flex items-center gap-2 text-[12px]" style={{ padding: '32px 16px', color: 'var(--text-light)' }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              正在读取 Cookie…
            </div>
          )}
          {!cookiesLoading && filteredGroups.length === 0 && (
            <div className="text-[12px]" style={{ padding: '32px 16px', color: 'var(--text-light)' }}>
              {cookieSearch.trim() ? '没有匹配的站点' : '暂无 Cookie'}
            </div>
          )}
          {!cookiesLoading && filteredGroups.map((group) => {
            const expanded = expandedDomain === group.domain
            return (
              <div key={group.domain}>
                <div
                  className="group flex items-center rounded-[10px] transition-colors duration-150 hover:bg-[var(--bg-hover)]"
                  style={expanded ? { background: 'var(--bg-hover)' } : undefined}
                >
                  <button
                    onClick={() => setExpandedDomain(expanded ? null : group.domain)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                    style={{ padding: '10px 14px' }}
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                      style={{ color: 'var(--text-light)' }}
                    />
                    <span
                      className={`truncate font-mono text-[12px] ${expanded ? 'font-medium' : ''}`}
                      style={{ color: expanded ? 'var(--text-title)' : 'var(--text-body)' }}
                    >
                      {group.domain}
                    </span>
                    <span
                      className="flex-shrink-0 text-[11px] tabular-nums"
                      style={{ marginLeft: 'auto', paddingLeft: 16, color: 'var(--text-light)' }}
                    >
                      {group.cookies.length} 个
                    </span>
                  </button>
                  <button
                    onClick={() =>
                      setConfirm({
                        title: '确认删除站点 Cookie',
                        message: `将删除 ${group.domain} 的 ${group.cookies.length} 个 Cookie，该站点可能需要重新登录。是否继续？`,
                        confirmLabel: '删除',
                        action: () => removeDomainCookies(group.domain),
                      })
                    }
                    disabled={busyDomain === group.domain}
                    title="删除该站点全部 Cookie"
                    className={`flex-shrink-0 cursor-pointer rounded-lg transition-[opacity,background-color] duration-150 hover:bg-[var(--bg-hover)] ${
                      expanded || busyDomain === group.domain ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    style={{ margin: '0 8px 0 4px', padding: 8, color: 'var(--color-red)' }}
                  >
                    {busyDomain === group.domain
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {expanded && (
                  // 左缘 38px = 行内衬 14 + chevron 14 + 间距 10，与域名文字起点严格对齐。
                  <div className="flex flex-col gap-2.5" style={{ margin: '10px 10px 14px 38px' }}>
                    {group.cookies.map((cookie) => {
                      const key = `${group.domain}|${cookie.name}|${cookie.path}`
                      return (
                        <div
                          key={key}
                          className="group/cookie rounded-[10px]"
                          style={{
                            padding: '12px 16px',
                            border: '1px solid color-mix(in srgb, var(--surface-border) 40%, transparent)',
                            background: 'color-mix(in srgb, var(--surface-floating-bg) 62%, transparent)',
                          }}
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="min-w-0 truncate font-mono text-[12px] font-medium" style={{ color: 'var(--text-body)' }}>
                              {cookie.name}
                            </span>
                            <span
                              className="flex-shrink-0 text-[11px]"
                              style={{ marginLeft: 'auto', color: 'var(--text-light)' }}
                            >
                              {cookieMetaLine(cookie)}
                            </span>
                            <button
                              onClick={() => { void removeSingleCookie(cookie, key) }}
                              disabled={busyCookieKey === key}
                              title="删除此 Cookie"
                              className={`flex-shrink-0 cursor-pointer rounded-md transition-[opacity,background-color] duration-150 hover:bg-[var(--bg-hover)] ${
                                busyCookieKey === key ? 'opacity-100' : 'opacity-0 group-hover/cookie:opacity-100'
                              }`}
                              style={{ padding: 6, color: 'var(--color-red)' }}
                            >
                              {busyCookieKey === key
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <Trash2 className="h-3 w-3" />}
                            </button>
                          </div>
                          <div
                            className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] leading-4"
                            style={{ marginTop: 8, color: 'var(--text-muted)' }}
                          >
                            {cookie.value || '（空值）'}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Confirmation modal — same pattern as StorageSettingsPanel */}
      {confirm && (
        <div
          data-ready-native-overlay=""
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.32)' }}
          onClick={() => setConfirm(null)}
        >
          <div
            className="glass-surface-card rounded-2xl border"
            style={{
              ...SETTINGS_CARD_STYLE,
              padding: '20px 22px',
              width: 360,
              maxWidth: 'calc(100vw - 48px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
              {confirm.title}
            </div>
            <div className="text-[12px] leading-5" style={{ marginTop: 8, color: 'var(--text-light)' }}>
              {confirm.message}
            </div>
            <div className="flex justify-end gap-2" style={{ marginTop: 16 }}>
              <button
                onClick={() => setConfirm(null)}
                className="rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '8px 14px' }}
              >
                取消
              </button>
              <button
                onClick={() => {
                  const action = confirm.action
                  setConfirm(null)
                  void action()
                }}
                className="rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                style={{ ...SETTINGS_DANGER_BUTTON_STYLE, padding: '8px 14px' }}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
