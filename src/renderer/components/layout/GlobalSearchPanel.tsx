import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import { parseDocumentGraph, normalizeSearchText } from '../../../shared/document-graph-parse'
import { GLOBAL_SEARCH_DIMENSIONS, PANEL_TOKENS } from './panelTokens'

interface SearchResultItem {
  path: string
  name: string
  nameMatch: boolean
  snippet: string
  tagsHit: string[]
  linksHit: string[]
  sourceType: string
  sourceMeta?: Record<string, unknown> | null
  draft?: { tabId: string }
}

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

interface ParsedLocalQuery {
  tags: string[]
  wikilinks: string[]
  terms: string[]
}

function parseLocalQuery(raw: string): ParsedLocalQuery {
  const tags: string[] = []
  const wikilinks: string[] = []
  const terms: string[] = []
  const trimmed = raw.trim()
  if (!trimmed) return { tags, wikilinks, terms }
  const pieces: string[] = []
  let buffer = ''
  let inQuote = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (ch === '"') {
      inQuote = !inQuote
      buffer += ch
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (buffer.length > 0) { pieces.push(buffer); buffer = '' }
      continue
    }
    buffer += ch
  }
  if (buffer.length > 0) pieces.push(buffer)

  for (const piece of pieces) {
    const normalized = normalizeSearchText(piece)
    if (!normalized) continue
    if (!/[\p{L}\p{N}]/u.test(normalized)) continue
    if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2) {
      const inner = normalized.slice(1, -1).trim()
      if (inner) terms.push(inner.toLowerCase())
      continue
    }
    if (normalized.startsWith('#') && normalized.length > 1) {
      tags.push(normalized.slice(1).toLowerCase())
      continue
    }
    if (normalized.startsWith('[[') && normalized.endsWith(']]') && normalized.length > 4) {
      wikilinks.push(normalized.slice(2, -2).trim().toLowerCase())
      continue
    }
    terms.push(normalized.toLowerCase())
  }
  return { tags, wikilinks, terms }
}

function buildDraftSnippet(body: string, terms: string[]): string {
  if (!body) return ''
  if (terms.length === 0) return body.slice(0, 120).replace(/\s+/g, ' ')
  const normalizedBody = body.toLowerCase()
  const first = terms[0]
  const idx = normalizedBody.indexOf(first)
  if (idx < 0) return body.slice(0, 120).replace(/\s+/g, ' ')
  const start = Math.max(0, idx - 40)
  const end = Math.min(body.length, idx + first.length + 80)
  const prefix = body.slice(start, idx).replace(/\s+/g, ' ')
  const match = body.slice(idx, idx + first.length)
  const suffix = body.slice(idx + first.length, end).replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${prefix}${MARK_START}${match}${MARK_END}${suffix}${end < body.length ? '…' : ''}`
}

function matchDraftTab(tab: DocTab, parsed: ParsedLocalQuery): SearchResultItem | null {
  const content = tab.content ?? ''
  const graph = parseDocumentGraph(content)
  const normalizedBody = graph.body.toLowerCase()
  const normalizedName = normalizeSearchText(tab.title).toLowerCase()

  for (const tag of parsed.tags) {
    if (!graph.tags.some((t) => t.toLowerCase() === tag)) return null
  }
  for (const link of parsed.wikilinks) {
    if (!graph.wikilinks.some((w) => w.target.toLowerCase() === link)) return null
  }
  let nameHits = 0
  for (const term of parsed.terms) {
    if (normalizedBody.includes(term)) continue
    if (normalizedName.includes(term)) { nameHits += 1; continue }
    return null
  }
  if (parsed.tags.length === 0 && parsed.wikilinks.length === 0 && parsed.terms.length === 0) {
    return null
  }

  const nameMatch = parsed.terms.length > 0 && parsed.terms.every((t) => normalizedName.includes(t)) ? true : nameHits > 0
  const snippet = buildDraftSnippet(graph.body, parsed.terms)
  const tagsHit = parsed.tags.filter((tag) => graph.tags.some((t) => t.toLowerCase() === tag))
  const linksHit = parsed.wikilinks.filter((link) => graph.wikilinks.some((w) => w.target.toLowerCase() === link))

  return {
    path: tab.path ?? `draft://${tab.id}`,
    name: tab.title || '新文档',
    nameMatch,
    snippet,
    tagsHit,
    linksHit,
    sourceType: 'document',
    draft: { tabId: tab.id },
  }
}

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
  void path
  // All files open in document mode now
  return 'document'
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
  const workspaceRoot = useWorkspace((state) => state.workspaceRoot)
  const selectFile = useWorkspace((state) => state.selectFile)
  const setWorkbenchMode = useMode((state) => state.setWorkbenchMode)
  const tabs = useDocTabs((state) => state.tabs)
  const setActiveTab = useDocTabs((state) => state.setActiveTab)

  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const [stats, setStats] = useState<SearchStats>({ returned: 0, elapsedMs: 0 })
  const [message, setMessage] = useState('')
  const [degraded, setDegraded] = useState(false)
  const searchVersionRef = useRef(0)

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

  // When the workspace root changes, ask main to reindex filesystem + shared
  // sources (bookmarks / RSS / calendar / agent). Reindex is idempotent —
  // unchanged rows are skipped via content hash.
  useEffect(() => {
    if (!workspaceRoot || typeof window === 'undefined') return
    const doc = window.electronAPI?.document
    if (doc?.reindexAllSources) {
      void doc.reindexAllSources(workspaceRoot).catch(() => {
        /* best-effort; user can retry via search */
      })
    } else if (doc?.reindexWorkspace) {
      void doc.reindexWorkspace(workspaceRoot).catch(() => {
        /* fallback for older bundles */
      })
    }
  }, [workspaceRoot])

  const runSearch = useCallback(async (keyword: string) => {
    if (!workspaceRoot || typeof window === 'undefined' || !window.electronAPI?.document?.searchIndex) {
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
      const response = await window.electronAPI.document.searchIndex({
        query: trimmed,
        workspaceRoot,
      })
      if (searchVersionRef.current !== currentVersion) return
      if (!response?.success || !response.data) {
        setResults([])
        setStats({ returned: 0, elapsedMs: 0 })
        setMessage(response?.error ? `搜索失败：${response.error}` : '搜索失败')
        setDegraded(false)
        return
      }
      const { items, stats: nextStats, degraded: nextDegraded } = response.data
      setResults(items.map((hit) => ({
        path: hit.path,
        name: hit.name,
        nameMatch: hit.nameMatch,
        snippet: hit.snippet,
        tagsHit: hit.tagsHit,
        linksHit: hit.linksHit,
        sourceType: hit.sourceType,
        sourceMeta: hit.sourceMeta ?? null,
      })))
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
  }, [workspaceRoot])

  useEffect(() => {
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
      setWorkbenchMode('document')
      return
    }
    // Route by source_type. Filesystem documents flow through the normal
    // selectFile/workbench path. URL-backed sources (bookmark/rss) use
    // openExternal when available; calendar/agent keep the renderer in the
    // current mode and reveal the snippet — deep-linking comes in Step 6.
    switch (item.sourceType) {
      case 'bookmark':
      case 'rss': {
        const url = item.sourceType === 'bookmark'
          ? item.path
          : typeof item.sourceMeta?.link === 'string'
            ? (item.sourceMeta.link as string)
            : ''
        if (url) {
          // main/index.ts setWindowOpenHandler redirects window.open to
          // shell.openExternal, so this opens in the system browser.
          window.open(url, '_blank')
        }
        return
      }
      case 'calendar':
        setWorkbenchMode('calendar')
        return
      case 'agent':
        setWorkbenchMode('document')
        return
      case 'document':
      default:
        selectFile(item.path)
        setWorkbenchMode(modeForPath(item.path))
    }
  }, [selectFile, setActiveTab, setWorkbenchMode])

  // Overlay unsaved (path-less or dirty) drafts from useDocTabs. Indexed search
  // only sees persisted files; this keeps brand-new or in-flight edits visible.
  const draftResults = useMemo<SearchResultItem[]>(() => {
    const trimmed = query.trim()
    if (!trimmed) return []
    const parsed = parseLocalQuery(trimmed)
    const out: SearchResultItem[] = []
    for (const tab of tabs) {
      if (tab.path && !tab.isDirty) continue
      const hit = matchDraftTab(tab, parsed)
      if (hit) out.push(hit)
    }
    return out
  }, [query, tabs])

  const mergedResults = useMemo(() => {
    if (draftResults.length === 0) return results
    const draftPaths = new Set(draftResults.map((d) => d.path))
    const filteredIpc = results.filter((r) => !draftPaths.has(r.path))
    return [...draftResults, ...filteredIpc]
  }, [draftResults, results])

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

  const body = (
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
                  <button
                    key={`${item.path}`}
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

      {!workspaceRoot && query.trim().length > 0 && (
        <p className="text-[10px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
          请先在文件管理中打开工作区
        </p>
      )}
    </div>
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
