import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { ReadyRefSchema } from '../../../shared/ready-ref'
import { openIndexedSearchResult } from '../../modules/workbench/open-ready-ref'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText, Loader2, Database, RotateCw } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { formatIndexedAt, useLibraryIndex } from '../../modules/search/useLibraryIndex'
import type { WorkbenchMode } from '../../stores/useMode'
import { useDocTabs } from '../../stores/useDocTabs'
import { draftSearchResults, mergeDraftResults, queryObjectIndex, type SearchResultItem } from '../../modules/workbench/object-ui/query'
import { GLOBAL_SEARCH_DIMENSIONS, PANEL_TOKENS } from './panelTokens'
import Modal from '../ui/Modal'
import { isLocalHtmlFilePath, openLocalHtmlFileInBrowser } from '../../modules/browser/localHtmlFileOpen'
import { requestWorkbenchModeOpen } from '../../modules/workbench/mode-transition'

const SOURCE_BADGE_LABEL: Record<string, string> = {
  document: 'doc',
  bookmark: 'bookmark',
  rss: 'rss',
  calendar: 'calendar',
  agent: 'agent',
}

interface SearchStats {
  returned: number
  elapsedMs: number
}

interface GlobalSearchPanelProps {
  resetSignal?: number
  children?: (slots: SidePanelSlots) => ReactNode
}

export interface SidePanelSlots {
  header: ReactNode
  body: ReactNode
}

// FTS5 snippet() wraps matches with char(1) / char(2); keep in sync with query.ts.
const MARK_START = ''
const MARK_END = ''
const PREFIX_TOKEN_REGEX = /(^|\s)([#[])/

const PANEL_COLORS = {
  panelBg: PANEL_TOKENS.panelBg,
  title: PANEL_TOKENS.title,
  mutedStrong: PANEL_TOKENS.mutedStrong,
  muted: PANEL_TOKENS.muted,
  text: PANEL_TOKENS.text,
  inputBorder: PANEL_TOKENS.inputBorder,
  cardBorder: PANEL_TOKENS.border,
  cardBg: PANEL_TOKENS.cardBg,
  replaceInputBg: 'var(--bg-toolbar)',
  replaceButtonBg: 'var(--bg-editor)',
  blue: PANEL_TOKENS.blue,
  blueLight: PANEL_TOKENS.blueLight,
}

function readTextPayload(result: unknown): string | null {
  const payload = result as {
    success?: boolean
    content?: unknown
    data?: { type?: unknown; content?: unknown }
  } | null
  if (!payload || !payload.success) return null
  if (typeof payload.content === 'string') return payload.content
  if (payload.data?.type === 'text' && typeof payload.data.content === 'string') {
    return payload.data.content
  }
  return null
}

function countOccurrences(text: string, keyword: string): number {
  if (!keyword) return 0
  let count = 0
  let from = 0
  while (from < text.length) {
    const idx = text.indexOf(keyword, from)
    if (idx < 0) break
    count += 1
    from = idx + keyword.length
  }
  return count
}

function modeForPath(path: string): WorkbenchMode {
  if (isLocalHtmlFilePath(path)) return 'browser'
  return 'document'
}

function revealWorkbenchModeForSearchOpen(mode: WorkbenchMode): void {
  requestWorkbenchModeOpen(mode)
}

function renderSnippet(snippet: string): ReactNode {
  if (!snippet) return null
  const parts: ReactNode[] = []
  let cursor = 0
  let key = 0
  let inMark = false
  const flushPlain = (end: number): void => {
    if (end <= cursor) return
    parts.push(snippet.slice(cursor, end))
  }
  const flushMarked = (end: number): void => {
    if (end <= cursor) return
    parts.push(
      <mark
        key={`snip-${key++}`}
        className="px-0.5 rounded-[4px]"
        style={{ background: PANEL_TOKENS.blueLight, color: PANEL_TOKENS.title }}
      >
        {snippet.slice(cursor, end)}
      </mark>,
    )
  }
  for (let i = 0; i < snippet.length; i += 1) {
    const ch = snippet[i]
    if (ch === MARK_START) {
      flushPlain(i)
      cursor = i + 1
      inMark = true
    } else if (ch === MARK_END) {
      flushMarked(i)
      cursor = i + 1
      inMark = false
    }
  }
  if (inMark) flushMarked(snippet.length)
  else flushPlain(snippet.length)
  return <>{parts}</>
}

// Persisted index status — lets us remember "the user already built an index for
// this workspace" across panel toggles and app restarts, so we know whether to
// show the "Build Index" empty state vs. the "Rebuild Index" affordance. Keyed
// by workspace root because different workspaces have separate FTS5 stores.
function highlightText(source: string, query: string): ReactNode {
  const keyword = query.trim()
  if (!keyword) return source
  const lowerSource = source.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  if (!lowerSource.includes(lowerKeyword)) return source

  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0

  while (cursor < source.length) {
    const idx = lowerSource.indexOf(lowerKeyword, cursor)
    if (idx < 0) {
      nodes.push(source.slice(cursor))
      break
    }
    if (idx > cursor) nodes.push(source.slice(cursor, idx))
    nodes.push(
      <mark
        key={`hl-${key++}`}
        className="px-0.5 rounded-[4px]"
        style={{ background: PANEL_COLORS.blueLight, color: PANEL_COLORS.title }}
      >
        {source.slice(idx, idx + keyword.length)}
      </mark>,
    )
    cursor = idx + keyword.length
  }

  return nodes
}

export default function GlobalSearchPanel({ resetSignal = 0, children }: GlobalSearchPanelProps) {
  const selectFile = useWorkspace((state) => state.selectFile)
  const tabs = useDocTabs((state) => state.tabs)
  const setActiveTab = useDocTabs((state) => state.setActiveTab)
  const openTab = useDocTabs((state) => state.openTab)

  // The library index (one build path, shared with 设置 › 资料库): the roots, the last success, and the
  // build itself. Rebuilding lives in settings; a library without an index can still be built from here.
  const { roots, status: indexStatus, indexing: isIndexing, error: indexError, rebuild: runReindex } = useLibraryIndex()

  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const [stats, setStats] = useState<SearchStats>({ returned: 0, elapsedMs: 0 })
  const [message, setMessage] = useState('')
  const [degraded, setDegraded] = useState(false)
  const searchVersionRef = useRef(0)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const clearAll = useCallback(() => {
    searchVersionRef.current += 1
    setQuery('')
    setReplaceText('')
    setResults([])
    setStats({ returned: 0, elapsedMs: 0 })
    setMessage('')
    setIsSearching(false)
    setIsReplacing(false)
  }, [])

  useEffect(() => {
    clearAll()
  }, [resetSignal, clearAll])

  const handleBuildIndexClick = useCallback(() => {
    if (roots.length === 0) return
    setConfirmOpen(true)
  }, [roots])

  const handleConfirmBuildIndex = useCallback(() => {
    setConfirmOpen(false)
    void runReindex()
  }, [runReindex])

  const handleCancelBuildIndex = useCallback(() => {
    setConfirmOpen(false)
  }, [])

  const runSearch = useCallback(async (keyword: string) => {
    if (roots.length === 0 || typeof window === 'undefined' || !window.electronAPI?.document?.searchIndex) {
      setResults([])
      setStats({ returned: 0, elapsedMs: 0 })
      return
    }

    const trimmed = keyword.trim()
    if (!trimmed) {
      setResults([])
      setStats({ returned: 0, elapsedMs: 0 })
      setIsSearching(false)
      return
    }

    const currentVersion = ++searchVersionRef.current
    setIsSearching(true)
    setMessage('')

    try {
      const response = await queryObjectIndex(trimmed, roots)
      if (searchVersionRef.current !== currentVersion) return
      const { items, stats: nextStats, degraded: nextDegraded } = response
      setResults(items)
      setStats(nextStats)
      setDegraded(nextDegraded)
      setMessage(nextDegraded ? 'FTS5 不可用，结果可能不完整' : '')
    } catch (error) {
      if (searchVersionRef.current !== currentVersion) return
      setResults([])
      setStats({ returned: 0, elapsedMs: 0 })
      setMessage(`搜索失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (searchVersionRef.current === currentVersion) setIsSearching(false)
    }
  }, [roots])

  useEffect(() => {
    searchVersionRef.current += 1
    const timer = setTimeout(() => {
      void runSearch(query)
    }, 280)
    return () => clearTimeout(timer)
  }, [query, runSearch])

  // Replace-all only runs on literal (non-prefix) queries; `#tag` / `[[link]]`
  // matches are semantic filters, not substrings to rewrite.
  const canReplaceAll = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return false
    return !PREFIX_TOKEN_REGEX.test(` ${trimmed}`)
  }, [query])

  const replaceAll = useCallback(async () => {
    if (!canReplaceAll || typeof window === 'undefined' || !window.electronAPI) return
    setIsReplacing(true)
    setMessage('')
    try {
      const keyword = query.trim()
      const targetFiles = Array.from(new Set(results.map((r) => r.path)))

      let changedFiles = 0
      let replacedCount = 0

      for (const path of targetFiles) {
        const readResult = await window.electronAPI.document.readFile(path)
        const content = readTextPayload(readResult)
        if (typeof content !== 'string') continue

        const occurrences = countOccurrences(content, keyword)
        if (occurrences <= 0) continue

        const next = content.split(keyword).join(replaceText)
        const writeResult = await window.electronAPI.document.writeFile(path, next)
        if (writeResult?.success) {
          changedFiles += 1
          replacedCount += occurrences
        }
      }

      setMessage(`替换完成：${changedFiles} 个文件，${replacedCount} 处匹配`)
      // `document:write` already invokes the index hook on the main side, so
      // the new content is searchable immediately after the await completes.
      await runSearch(query)
    } catch (error) {
      setMessage(`替换失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsReplacing(false)
    }
  }, [canReplaceAll, query, replaceText, results, runSearch])

  const openResult = useCallback((item: SearchResultItem) => {
    if (item.draft) {
      setActiveTab(item.draft.tabId)
      revealWorkbenchModeForSearchOpen('document')
      return
    }
    if (item.sourceType !== 'document' || item.path.startsWith('ready://')) {
      void openIndexedSearchResult(item).catch(error => setMessage(error instanceof Error ? error.message : String(error)))
      return
    }
    if (isLocalHtmlFilePath(item.path)) {
      selectFile(item.path)
      void openLocalHtmlFileInBrowser(item.path, item.name).then((opened) => {
        if (opened) revealWorkbenchModeForSearchOpen('browser')
      })
      return
    }
    openTab(item.path)
    selectFile(item.path)
    revealWorkbenchModeForSearchOpen(modeForPath(item.path))
  }, [openTab, selectFile, setActiveTab])

  const draftResults = useMemo(() => draftSearchResults(query, tabs), [query, tabs])
  const mergedResults = useMemo(() => mergeDraftResults(results, draftResults, tabs), [results, draftResults, tabs])

  const showEmptyState = !isSearching && query.trim().length > 0 && mergedResults.length === 0
  const statsText = useMemo(
    () => `命中 ${stats.returned} 条${draftResults.length ? ` +${draftResults.length} 草稿` : ''} · ${stats.elapsedMs} ms${degraded ? ' · degraded' : ''}`,
    [stats, degraded, draftResults.length],
  )

  const header = (
    <div
      className="flex items-center justify-between border-b"
      style={{
        height: GLOBAL_SEARCH_DIMENSIONS.headerHeight,
        borderColor: 'transparent',
        background: 'transparent',
        padding: `0 ${GLOBAL_SEARCH_DIMENSIONS.bodyPaddingX}px`,
        boxSizing: 'border-box',
      }}
    >
      <div className="min-w-0 flex items-center gap-[6px]">
        <span className="text-[13px] font-semibold" style={{ color: PANEL_COLORS.title }}>
          全局搜索
        </span>
        {isSearching && <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: PANEL_COLORS.mutedStrong }} />}
      </div>
      <button
        type="button"
        onClick={clearAll}
        className="text-[11px] font-medium transition-opacity hover:opacity-70"
        style={{ color: PANEL_COLORS.muted }}
      >
        清空
      </button>
    </div>
  )

  // The panel cycles through four mutually exclusive states. We render each
  // explicitly rather than overlaying messages on a single layout so the empty
  // / build / ready transitions stay obvious to the user.
  const panelState: 'no-workspace' | 'no-index' | 'indexing' | 'ready' = roots.length === 0
    ? 'no-workspace'
    : isIndexing
      ? 'indexing'
      : indexStatus
        ? 'ready'
        : 'no-index'

  const renderEmptyShell = (children: ReactNode) => (
    <div className="flex flex-1 min-h-0 flex-col items-center justify-center text-center" style={{ gap: 12, padding: '24px 16px' }}>
      {children}
    </div>
  )

  const noWorkspaceBody = renderEmptyShell(
    <>
      <Database className="h-6 w-6" style={{ color: PANEL_COLORS.mutedStrong }} />
      <p className="text-[12px] font-medium" style={{ color: PANEL_COLORS.text }}>
        请先选择工作区以启用搜索
      </p>
      <p className="text-[10px] font-medium leading-[1.45]" style={{ color: PANEL_COLORS.mutedStrong, maxWidth: 240 }}>
        在文件管理中打开一个工作区后，可在此手动构建索引并开始全局搜索。
      </p>
    </>,
  )

  const noIndexBody = renderEmptyShell(
    <>
      <Database className="h-6 w-6" style={{ color: PANEL_COLORS.mutedStrong }} />
      <p className="text-[12px] font-medium" style={{ color: PANEL_COLORS.text }}>
        尚未构建索引
      </p>
      <p className="text-[10px] font-medium leading-[1.45]" style={{ color: PANEL_COLORS.mutedStrong, maxWidth: 240 }}>
        点击下方按钮扫描当前工作区，仅扫描你选择的目录，不会触碰其它文件夹。
      </p>
      <p className="text-[10px] font-medium break-all whitespace-pre-line" style={{ color: PANEL_COLORS.muted, maxWidth: 280 }}>
        {roots.join('\n')}
      </p>
      <button
        type="button"
        onClick={handleBuildIndexClick}
        className="ready-glass-button text-[12px]"
      >
        <Database className="h-3.5 w-3.5" />
        构建索引
      </button>
      {indexError && (
        <p className="text-[10px] font-medium" style={{ color: 'var(--color-red, #c0392b)' }}>
          {indexError}
        </p>
      )}
    </>,
  )

  const indexingBody = renderEmptyShell(
    <>
      <Loader2 className="h-6 w-6 animate-spin" style={{ color: PANEL_COLORS.blue }} />
      <p className="text-[12px] font-medium" style={{ color: PANEL_COLORS.text }}>
        正在构建索引…
      </p>
      <p className="text-[10px] font-medium leading-[1.45]" style={{ color: PANEL_COLORS.mutedStrong, maxWidth: 240 }}>
        首次构建可能需要数分钟，请勿关闭工作区。
      </p>
      <p className="text-[10px] font-medium break-all whitespace-pre-line" style={{ color: PANEL_COLORS.muted, maxWidth: 280 }}>
        {roots.join('\n')}
      </p>
    </>,
  )

  const readyBody = (
    <div
      className="flex flex-1 min-h-0 flex-col"
      style={{
        gap: GLOBAL_SEARCH_DIMENSIONS.bodyGap,
        paddingLeft: GLOBAL_SEARCH_DIMENSIONS.bodyPaddingX,
        paddingRight: GLOBAL_SEARCH_DIMENSIONS.bodyPaddingX,
        paddingTop: GLOBAL_SEARCH_DIMENSIONS.bodyPaddingYTop,
        paddingBottom: GLOBAL_SEARCH_DIMENSIONS.bodyPaddingYBottom,
      }}
    >
      <p className="text-[10px] font-medium leading-4" style={{ color: PANEL_COLORS.mutedStrong }}>
        支持 #tag / [[wikilink]] 前缀语法 · 引号可做短语匹配
      </p>

      <label
        className="ready-input-shell w-full border px-[10px] flex items-center"
        style={{
          height: GLOBAL_SEARCH_DIMENSIONS.controlHeight,
          borderRadius: GLOBAL_SEARCH_DIMENSIONS.controlRadius,
          background: 'var(--input-slot-bg)',
          borderColor: 'var(--input-slot-border)',
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件名或内容..."
          className="ready-input-slot-inner h-full w-full bg-transparent border-none outline-none text-[13px] font-medium placeholder:text-[var(--text-placeholder)]"
          style={{ color: PANEL_COLORS.text }}
        />
      </label>

      <div className="flex items-center gap-[8px]">
        <label
          className="ready-input-shell flex-1 border px-[10px] flex items-center"
          style={{
            height: GLOBAL_SEARCH_DIMENSIONS.controlHeight,
            borderRadius: GLOBAL_SEARCH_DIMENSIONS.controlRadius,
            background: 'var(--input-slot-bg)',
            borderColor: 'var(--input-slot-border)',
          }}
        >
          <input
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder="替换为..."
            className="ready-input-slot-inner h-full w-full bg-transparent border-none outline-none text-[13px] font-medium placeholder:text-[var(--text-light)]"
            style={{ color: PANEL_COLORS.text }}
          />
        </label>
        <button
          type="button"
          onClick={() => void replaceAll()}
          disabled={isReplacing || !canReplaceAll}
          title={!canReplaceAll && query.trim() ? '前缀语法 (#tag / [[wikilink]]) 不支持替换' : undefined}
          className="content-surface-card border px-[10px] text-[10px] font-medium disabled:opacity-45"
          style={{
            borderColor: PANEL_COLORS.inputBorder,
            color: PANEL_COLORS.muted,
            background: 'color-mix(in srgb, var(--surface-card-bg) 22%, transparent)',
            height: GLOBAL_SEARCH_DIMENSIONS.controlHeight,
            borderRadius: GLOBAL_SEARCH_DIMENSIONS.controlRadius,
          }}
        >
          {isReplacing ? '替换中' : '全部替换'}
        </button>
      </div>

      {message && (
        <p className="text-[10px] font-medium" style={{ color: PANEL_COLORS.blue }}>
          {message}
        </p>
      )}

      <div className="panel-hover-scrollbar flex-1 min-h-0 overflow-auto">
        {query.trim().length > 0 && (
          <>
            {showEmptyState && (
              <p className="px-0.5 py-0.5 text-[11px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
                没有匹配结果
              </p>
            )}

            {mergedResults.length > 0 && (
              <div className="space-y-[6px] pb-[2px]">
                {mergedResults.map((item) => (
                  <div key={item.path}>
                  <button
                    onClick={() => openResult(item)}
                    className="w-full rounded-[8px] border px-[8px] py-[6px] text-left transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ borderColor: PANEL_COLORS.cardBorder, background: 'transparent' }}
                  >
                    <div className="flex items-center gap-[6px] min-w-0">
                      <FileText className="h-[13px] w-[13px] shrink-0" style={{ color: PANEL_COLORS.mutedStrong }} />
                      <span className="truncate text-[12px] font-medium leading-[1.25]" style={{ color: PANEL_COLORS.text }}>
                        {item.nameMatch ? highlightText(item.name, query) : item.name}
                      </span>
                      {item.draft && (
                        <span
                          className="rounded-[4px] border px-[4px] py-[0.5px] text-[9px] font-medium shrink-0"
                          style={{ borderColor: PANEL_COLORS.cardBorder, color: PANEL_COLORS.blue }}
                        >
                          draft
                        </span>
                      )}
                      {!item.draft && item.sourceType && item.sourceType !== 'document' && (
                        <span
                          className="rounded-[4px] border px-[4px] py-[0.5px] text-[9px] font-medium shrink-0"
                          style={{ borderColor: PANEL_COLORS.cardBorder, color: PANEL_COLORS.mutedStrong }}
                        >
                          {SOURCE_BADGE_LABEL[item.sourceType] ?? item.sourceType}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[10px] leading-[1.3]" style={{ color: PANEL_COLORS.mutedStrong }}>
                      {item.path}
                    </p>
                    {item.snippet && (
                      <p className="mt-0.5 text-[11px] leading-[1.35]" style={{ color: PANEL_COLORS.muted }}>
                        {renderSnippet(item.snippet)}
                      </p>
                    )}
                    {(item.tagsHit.length > 0 || item.linksHit.length > 0) && (
                      <div className="mt-0.5 flex flex-wrap gap-[4px]">
                        {item.tagsHit.map((tag) => (
                          <span
                            key={`t-${tag}`}
                            className="rounded-[4px] border px-[5px] py-[1px] text-[9px] font-medium"
                            style={{ borderColor: PANEL_COLORS.cardBorder, color: PANEL_COLORS.blue }}
                          >
                            #{tag}
                          </span>
                        ))}
                        {item.linksHit.map((link) => (
                          <span
                            key={`l-${link}`}
                            className="rounded-[4px] border px-[5px] py-[1px] text-[9px] font-medium"
                            style={{ borderColor: PANEL_COLORS.cardBorder, color: PANEL_COLORS.blue }}
                          >
                            [[{link}]]
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                  {item.sourceType === 'rss' && typeof item.sourceMeta?.link === 'string' && (
                    <button type="button" className="text-[10px] underline" onClick={() => {
                      const url = ReadyRefSchema.safeParse({ kind: 'web', url: item.sourceMeta?.link })
                      if (url.success && url.data.kind === 'web') void openWebpageInBrowser(url.data.url).then(opened => { if (!opened) setMessage('网页未能在 Ready 浏览器中打开') }).catch(error => setMessage(String(error)))
                    }}>打开原文</button>
                  )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {query.trim().length > 0 && !isSearching && (
        <p className="text-[10px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
          {statsText}
        </p>
      )}

      {indexStatus && (
        <div className="flex items-center justify-between gap-[8px] pt-[2px]">
          <p className="text-[10px] font-medium leading-[1.4]" style={{ color: PANEL_COLORS.mutedStrong }}>
            已索引 {indexStatus.docCount} 项 · {formatIndexedAt(indexStatus.lastIndexedAt)}
          </p>
          <button
            type="button"
            onClick={() => { window.location.hash = '#/settings?section=library' }}
            title="在 设置 › 资料库 里重建索引"
            className="border px-[8px] flex items-center gap-[4px] text-[10px] font-medium transition-colors"
            style={{
              height: 22,
              borderRadius: 8,
              borderColor: PANEL_COLORS.inputBorder,
              color: PANEL_COLORS.muted,
              background: 'transparent',
            }}
          >
            <RotateCw className="h-3 w-3" />
            管理索引
          </button>
        </div>
      )}

      {indexError && (
        <p className="text-[10px] font-medium" style={{ color: 'var(--color-red, #c0392b)' }}>
          {indexError}
        </p>
      )}
    </div>
  )

  const body = (
    <>
      {panelState === 'no-workspace' && noWorkspaceBody}
      {panelState === 'no-index' && noIndexBody}
      {panelState === 'indexing' && indexingBody}
      {panelState === 'ready' && readyBody}
      <Modal
        open={confirmOpen}
        mode="confirm"
        title="构建搜索索引"
        message={`此操作会扫描下列工作区中的所有文件以建立全文搜索索引：\n\n${roots.join('\n')}\n\n较大的目录可能需要数分钟，并占用磁盘空间。是否继续？`}
        confirmLabel="开始构建"
        cancelLabel="取消"
        onConfirm={handleConfirmBuildIndex}
        onCancel={handleCancelBuildIndex}
      />
    </>
  )

  if (children) {
    return <>{children({ header, body })}</>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {body}
    </div>
  )
}
