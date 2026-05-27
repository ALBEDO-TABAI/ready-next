import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText, Loader2, Database, RotateCw } from 'lucide-react'
import { useWorkspace, computeDesiredRoots } from '../../stores/useWorkspace'
import { reduceReindexResponse } from './reindex-response-reducer'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import { parseDocumentGraph, normalizeSearchText } from '../../../shared/document-graph-parse'
import { readJsonStorage, writeJsonStorage, removeStorage } from '../../utils/storage'
import { GLOBAL_SEARCH_DIMENSIONS, PANEL_TOKENS } from './panelTokens'
import Modal from '../ui/Modal'
import { isLocalHtmlFilePath, openLocalHtmlFileInBrowser } from '../../modules/browser/localHtmlFileOpen'

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
  if (isLocalHtmlFilePath(path)) return 'browser'
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

// Persisted index status — lets us remember "the user already built an index for
// this workspace" across panel toggles and app restarts, so we know whether to
// show the "Build Index" empty state vs. the "Rebuild Index" affordance. Keyed
// by workspace root because different workspaces have separate FTS5 stores.
interface IndexStatus {
  docCount: number
  lastIndexedAt: string // ISO timestamp
  workspaceRoot: string
}

const INDEX_STATUS_KEY_PREFIX = 'ready-search-index-status:'

function indexStatusKey(workspaceRoot: string): string {
  return `${INDEX_STATUS_KEY_PREFIX}${workspaceRoot}`
}

function loadIndexStatus(workspaceRoot: string | null): IndexStatus | null {
  if (!workspaceRoot) return null
  const raw = readJsonStorage<IndexStatus | null>(indexStatusKey(workspaceRoot), null)
  if (!raw || typeof raw !== 'object') return null
  if (raw.workspaceRoot !== workspaceRoot) return null
  if (typeof raw.docCount !== 'number' || typeof raw.lastIndexedAt !== 'string') return null
  return raw
}

function persistIndexStatus(status: IndexStatus): void {
  writeJsonStorage(indexStatusKey(status.workspaceRoot), status)
}

function clearIndexStatus(workspaceRoot: string): void {
  removeStorage(indexStatusKey(workspaceRoot))
}

function formatLastIndexedAt(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      return `今天 ${hh}:${mm}`
    }
    const yyyy = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${yyyy}-${mo}-${dd} ${hh}:${mi}`
  } catch {
    return iso
  }
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
  const pinnedFolders = useWorkspace((state) => state.pinnedFolders)
  const selectFile = useWorkspace((state) => state.selectFile)
  const setWorkbenchMode = useMode((state) => state.setWorkbenchMode)
  const tabs = useDocTabs((state) => state.tabs)
  const setActiveTab = useDocTabs((state) => state.setActiveTab)
  const openTab = useDocTabs((state) => state.openTab)

  // Multi-root scope: every safe pinned folder (∪ workspaceRoot) is searched
  // and indexed in one batch. `computeDesiredRoots` is the single rule
  // source — outside this file we never re-derive the union or its safety
  // filter. Memoized so downstream useCallback deps stay stable.
  const roots = useMemo(
    () => computeDesiredRoots({ workspaceRoot, pinnedFolders }),
    [workspaceRoot, pinnedFolders],
  )
  const indexStatusKey = roots[0] ?? null

  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const [stats, setStats] = useState<SearchStats>({ returned: 0, elapsedMs: 0 })
  const [message, setMessage] = useState('')
  const [degraded, setDegraded] = useState(false)
  const searchVersionRef = useRef(0)

  // Explicit index lifecycle. The previous behaviour auto-triggered
  // reindexAllSources whenever the workspace root changed, which on a Home
  // directory could scan 600K+ files and balloon FTS5 storage past 80GB.
  // Building the index is now an opt-in user action gated by a confirmation
  // modal, and we remember the success so the panel can show "Rebuild" instead
  // of "Build" on subsequent visits.
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(() => loadIndexStatus(indexStatusKey))
  const [isIndexing, setIsIndexing] = useState(false)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const indexingRef = useRef(false)

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

  // Reload persisted index status whenever the active root set's primary
  // root changes (the first element of `roots` — workspaceRoot when set, else
  // the first safe pinned folder). The status itself is an aggregate across
  // all roots; we just use the primary as a stable storage key. We
  // intentionally do NOT trigger reindexAllSources here.
  useEffect(() => {
    setIndexStatus(loadIndexStatus(indexStatusKey))
    setIndexError(null)
  }, [indexStatusKey])

  const runReindex = useCallback(async () => {
    if (roots.length === 0 || typeof window === 'undefined') return
    const doc = window.electronAPI?.document
    if (!doc?.reindexAllSources && !doc?.reindexWorkspace) {
      setIndexError('当前环境不支持索引')
      return
    }
    if (indexingRef.current) return
    indexingRef.current = true
    setIsIndexing(true)
    setIndexError(null)
    try {
      // Multi-root reindex contract:
      //   - First root → `reindexAllSources` (rebuilds the FS index for the
      //     root PLUS the shared sources bucket — bookmarks / RSS / calendar
      //     / agent messages — which lives in a single SHARED workspace_id).
      //   - Subsequent roots → `reindexWorkspace` (FS only). The shared
      //     sources have already been refreshed by the first call; running
      //     `reindexAllSources` again would duplicate that work N times.
      let docCount = 0
      let rootsSucceeded = 0
      const errors: string[] = []
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i]
        if (i === 0 && doc.reindexAllSources) {
          const response = await doc.reindexAllSources(root)
          const outcome = reduceReindexResponse(root, response, 'all-sources')
          docCount += outcome.docCount
          if (outcome.error) errors.push(outcome.error)
          // `rootIndexed` distinguishes "root failed" (FS pass blew up) from
          // "partial source failure" (FS ok, but RSS / bookmark / calendar
          // adapter erred). The latter keeps the FS index valid for this
          // root, so it still counts as a success — the error becomes a
          // non-blocking warning. Treating any error as failure would discard
          // a successful file-tree index just because one shared adapter
          // timed out.
          if (outcome.rootIndexed) rootsSucceeded += 1
        } else if (doc.reindexWorkspace) {
          const response = await doc.reindexWorkspace(root)
          const outcome = reduceReindexResponse(root, response, 'fs-only')
          docCount += outcome.docCount
          if (outcome.error) errors.push(outcome.error)
          if (outcome.rootIndexed) rootsSucceeded += 1
        }
      }
      // Throw only when EVERY root failed at the root level. Partial-source
      // failures (rootIndexed=true with a warning error) still persist a
      // success status — the warning is surfaced via setIndexError below.
      if (rootsSucceeded === 0 && errors.length > 0) {
        throw new Error(errors.join('; '))
      }
      const next: IndexStatus = {
        docCount,
        lastIndexedAt: new Date().toISOString(),
        workspaceRoot: indexStatusKey ?? '',
      }
      persistIndexStatus(next)
      setIndexStatus(next)
      if (errors.length > 0) {
        // Partial success: surface a non-blocking note so the user knows at
        // least one root failed (e.g. ENOSPC, validation reject) while others
        // succeeded.
        setIndexError(`搜索结果可能不完整：${errors.join('; ')}`)
      }
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : String(error))
    } finally {
      indexingRef.current = false
      setIsIndexing(false)
    }
  }, [roots, indexStatusKey])

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

  // If the active root set was emptied while a stale status was cached for a
  // different root, drop it so the empty state renders correctly.
  useEffect(() => {
    if (roots.length === 0 && indexStatus) {
      const stale = indexStatus.workspaceRoot
      if (stale) {
        clearIndexStatus(stale)
      }
      setIndexStatus(null)
    }
  }, [roots, indexStatus])

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
      // Multi-root payload: a single SQL pass on the main side ranks across
      // all roots fairly. Falling back to the legacy `workspaceRoot` field
      // would re-introduce the bug where pinned folders couldn't be searched.
      const response = await window.electronAPI.document.searchIndex({
        query: trimmed,
        workspaceRoots: roots as string[],
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
  }, [roots])

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
        if (isLocalHtmlFilePath(item.path)) {
          selectFile(item.path)
          void openLocalHtmlFileInBrowser(item.path, item.name).then((opened) => {
            if (opened) setWorkbenchMode('browser')
          })
          return
        }
        openTab(item.path)
        selectFile(item.path)
        setWorkbenchMode(modeForPath(item.path))
    }
  }, [openTab, selectFile, setActiveTab, setWorkbenchMode])

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
        className="border px-[14px] flex items-center gap-[6px] text-[12px] font-semibold transition-colors"
        style={{
          height: 32,
          borderRadius: 10,
          borderColor: 'transparent',
          background: PANEL_COLORS.blue,
          color: '#FFFFFF',
        }}
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

      {indexStatus && (
        <div className="flex items-center justify-between gap-[8px] pt-[2px]">
          <p className="text-[10px] font-medium leading-[1.4]" style={{ color: PANEL_COLORS.mutedStrong }}>
            已索引 {indexStatus.docCount} 项 · {formatLastIndexedAt(indexStatus.lastIndexedAt)}
          </p>
          <button
            type="button"
            onClick={handleBuildIndexClick}
            disabled={isIndexing}
            title="重新扫描当前工作区"
            className="border px-[8px] flex items-center gap-[4px] text-[10px] font-medium transition-colors disabled:opacity-45"
            style={{
              height: 22,
              borderRadius: 8,
              borderColor: PANEL_COLORS.inputBorder,
              color: PANEL_COLORS.muted,
              background: 'transparent',
            }}
          >
            <RotateCw className="h-3 w-3" />
            重建索引
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
