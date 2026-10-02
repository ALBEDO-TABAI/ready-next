import { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react'
import {
  SETTINGS_ROW_CONTROL_MIN_WIDTH,
  SettingsCard,
  SettingsNotice,
  settingsButtonClass,
} from './settings-shared'
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
    <div className="flex flex-col gap-5">
      {/* ===== 清除浏览数据 ===== */}
      <SettingsCard
        title="清除浏览数据"
        description="清除浏览历史、下载记录、Cookie 和缓存"
        actions={(
          <select
            value={timeRange}
            aria-label="时间范围"
            onChange={(e) => setTimeRange(e.target.value as TimeRangeValue)}
            className="sx-select"
            style={{ minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH }}
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}
      >
        {summaryError && (
          <div className="sx-text-danger text-[12px]" style={{ padding: '0 20px 12px' }}>
            {summaryError}
          </div>
        )}

        <div>
          {CLEAR_ITEMS.map((item) => (
            <label
              key={item.id}
              className="sx-row cursor-pointer select-none transition-colors hover:bg-[var(--sx-hover)]"
              style={{ justifyContent: 'flex-start', gap: 14, minHeight: 58 }}
            >
              <input
                type="checkbox"
                checked={checkedItems[item.id]}
                onChange={(e) =>
                  setCheckedItems((prev) => ({ ...prev, [item.id]: e.target.checked }))
                }
                className="sx-check"
              />
              <span className="sx-row__text">
                <span className="sx-row__label block">
                  {item.label}
                </span>
                <span className="sx-row__desc block">
                  {summaryLoading ? '…' : itemDescriptions[item.id]}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="sx-card__footer">
          {showFullClearNote && (
            <div className="sx-meta mr-auto">
              Cookie、站点数据与缓存不支持按时间范围清除，勾选后将全部清除。
            </div>
          )}
          <button
            type="button"
            onClick={requestClear}
            disabled={clearing || selectedItems.length === 0}
            aria-busy={clearing || undefined}
            className={settingsButtonClass('danger')}
            style={{ minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH }}
          >
            {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {clearing ? '清除中…' : '清除所选数据'}
          </button>
        </div>
      </SettingsCard>

      {clearResult && (
        <SettingsNotice
          tone={clearResult.errors.length === 0 ? 'plain' : 'danger'}
          icon={clearResult.errors.length === 0 ? Check : undefined}
          title={clearResult.errors.length === 0
            ? `已清除：${clearResult.clearedLabels.join('、')}`
            : clearResult.clearedLabels.length > 0
              ? `部分完成：已清除 ${clearResult.clearedLabels.join('、')}，${clearResult.errors.length} 项失败`
              : '清除失败'}
        >
          {clearResult.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-[11.5px]">
              {clearResult.errors.slice(0, 5).map((err, idx) => (
                <li key={idx}>{err}</li>
              ))}
            </ul>
          )}
        </SettingsNotice>
      )}

      {/* ===== Cookie 管理 ===== */}
      <SettingsCard
        title="Cookie 管理"
        description={summary
          ? `${summary.cookieDomainCount} 个站点 · ${summary.cookieCount} 个 Cookie`
          : '查看并删除各站点存储在本地的 Cookie'}
        actions={(
          <>
            <button
              type="button"
              onClick={() => { void refreshCookies(); void refreshSummary() }}
              disabled={cookiesLoading}
              className={settingsButtonClass('secondary')}
            >
              <RefreshCw className={cookiesLoading ? 'animate-spin' : ''} />
              刷新
            </button>
            <button
              type="button"
              onClick={() =>
                setConfirm({
                  title: '确认清除全部 Cookie',
                  message: `将删除全部 ${summary?.cookieDomainCount ?? ''} 个站点的 ${totalCookies} 个 Cookie，多数网站需要重新登录。是否继续？`,
                  confirmLabel: '全部删除',
                  action: clearAllCookies,
                })
              }
              disabled={clearingAllCookies || totalCookies === 0}
              aria-busy={clearingAllCookies || undefined}
              className={settingsButtonClass('danger')}
            >
              {clearingAllCookies ? <Loader2 className="animate-spin" /> : <Trash2 />}
              全部删除
            </button>
          </>
        )}
      >
        <div style={{ padding: '0 20px 14px' }}>
          <div className="relative" style={{ maxWidth: 340 }}>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-[14px] w-[14px] -translate-y-1/2"
              strokeWidth={1.9}
              style={{ color: 'var(--sx-subtle)' }}
            />
            <input
              value={cookieSearch}
              onChange={(e) => setCookieSearch(e.target.value)}
              placeholder="按域名搜索"
              aria-label="按域名搜索"
              className="sx-input"
              style={{ paddingLeft: 32 }}
            />
          </div>
          {cookieError && (
            <div className="sx-text-danger mt-2 text-[12px]">
              {cookieError}
            </div>
          )}
        </div>

        <div className="max-h-[440px] overflow-y-auto rounded-b-[15px]">
          {cookiesLoading && (
            <div
              className="flex items-center justify-center gap-2 text-[12px]"
              style={{ padding: '28px 16px', color: 'var(--sx-muted)' }}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在读取 Cookie…
            </div>
          )}
          {!cookiesLoading && filteredGroups.length === 0 && (
            <div
              className="text-center text-[12px]"
              style={{ padding: '28px 16px', color: 'var(--sx-muted)' }}
            >
              {cookieSearch.trim() ? '没有匹配的站点' : '暂无 Cookie'}
            </div>
          )}
          {!cookiesLoading && filteredGroups.map((group) => {
            const expanded = expandedDomain === group.domain
            return (
              <div key={group.domain}>
                <div
                  className="sx-table__row group"
                  style={{
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    minHeight: 46,
                    borderRadius: 0,
                    paddingRight: 12,
                    ...(expanded ? { background: 'var(--sx-hover)' } : null),
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedDomain(expanded ? null : group.domain)}
                    aria-expanded={expanded}
                    className="flex min-w-0 cursor-pointer items-center gap-2.5 self-stretch text-left"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                      strokeWidth={2}
                      style={{ color: 'var(--sx-subtle)' }}
                    />
                    <span
                      className={`sx-mono truncate text-[12.5px] ${expanded ? 'font-medium' : ''}`}
                      style={{ color: expanded ? 'var(--sx-title)' : 'var(--sx-body)' }}
                    >
                      {group.domain}
                    </span>
                    <span
                      className="flex-shrink-0 text-[11.5px] tabular-nums"
                      style={{ marginLeft: 'auto', paddingLeft: 16, color: 'var(--sx-subtle)' }}
                    >
                      {group.cookies.length} 个
                    </span>
                  </button>
                  <button
                    type="button"
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
                    aria-label={`删除 ${group.domain} 的全部 Cookie`}
                    className={`${settingsButtonClass('danger-quiet', { size: 'sm', icon: true })} ml-1 transition-opacity ${
                      expanded || busyDomain === group.domain ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                    }`}
                  >
                    {busyDomain === group.domain
                      ? <Loader2 className="animate-spin" />
                      : <Trash2 />}
                  </button>
                </div>
                {expanded && (
                  // 左缘 44px = 行内衬 20 + chevron 14 + 间距 10，与域名文字起点严格对齐。
                  <div className="sx-inset" style={{ margin: '4px 20px 14px 44px' }}>
                    {group.cookies.map((cookie, cookieIndex) => {
                      const key = `${group.domain}|${cookie.name}|${cookie.path}`
                      return (
                        <div
                          key={key}
                          className="group/cookie"
                          style={{
                            padding: '10px 10px 10px 14px',
                            borderTop: cookieIndex === 0 ? undefined : '1px solid var(--sx-divider)',
                          }}
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="sx-mono min-w-0 truncate text-[12px] font-medium" style={{ color: 'var(--sx-body)' }}>
                              {cookie.name}
                            </span>
                            <span
                              className="sx-meta flex-shrink-0"
                              style={{ marginLeft: 'auto' }}
                            >
                              {cookieMetaLine(cookie)}
                            </span>
                            <button
                              type="button"
                              onClick={() => { void removeSingleCookie(cookie, key) }}
                              disabled={busyCookieKey === key}
                              title="删除此 Cookie"
                              aria-label={`删除 Cookie ${cookie.name}`}
                              className={`${settingsButtonClass('danger-quiet', { size: 'sm', icon: true })} transition-opacity ${
                                busyCookieKey === key ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover/cookie:opacity-100'
                              }`}
                              style={{ width: 24, height: 24 }}
                            >
                              {busyCookieKey === key
                                ? <Loader2 className="animate-spin" />
                                : <Trash2 />}
                            </button>
                          </div>
                          <div
                            className="sx-mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px] leading-4"
                            style={{ marginTop: 4, paddingRight: 34, color: 'var(--sx-muted)' }}
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
      </SettingsCard>

      {/* Confirmation modal — same pattern as StorageSettingsPanel */}
      {confirm && createPortal(
        <div
          data-ready-native-overlay=""
          className="sx-scrim"
          onClick={() => setConfirm(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-privacy-confirm-title"
            className="sx-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div id="browser-privacy-confirm-title" className="sx-card-title">
              {confirm.title}
            </div>
            <div className="mt-2 text-[12.5px] leading-[1.65]" style={{ color: 'var(--sx-muted)' }}>
              {confirm.message}
            </div>
            <div className="sx-dialog__actions">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className={settingsButtonClass('secondary')}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const action = confirm.action
                  setConfirm(null)
                  void action()
                }}
                className={settingsButtonClass('danger')}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
