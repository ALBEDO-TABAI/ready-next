import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { GLOBAL_SEARCH_DIMENSIONS, PANEL_TOKENS } from './panelTokens'

interface SearchResultItem {
  path: string
  name: string
  nameMatch: boolean
  contentMatch: boolean
  snippet?: string
}

interface SearchStats {
  scannedFiles: number
  matchedFiles: number
}

interface GlobalSearchPanelProps {
  resetSignal?: number
}

const SEARCHABLE_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'less',
  'csv', 'tsv', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sql', 'log',
])

const MAX_SCAN_FILES = 1500
const MAX_MATCHES = 200

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

function getExt(path: string): string {
  const name = path.split('/').pop() || path
  const idx = name.lastIndexOf('.')
  if (idx < 0) return ''
  return name.slice(idx + 1).toLowerCase()
}

function isTextFile(path: string): boolean {
  const ext = getExt(path)
  return ext.length > 0 && SEARCHABLE_EXTENSIONS.has(ext)
}

function readTextPayload(result: any): string | null {
  if (!result || !result.success) return null
  if (typeof result.content === 'string') return result.content
  if (result.data?.type === 'text' && typeof result.data.content === 'string') {
    return result.data.content
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

function snippetFrom(content: string, query: string): string | undefined {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return undefined
  const start = Math.max(0, idx - 40)
  const end = Math.min(content.length, idx + query.length + 80)
  return content.slice(start, end).replace(/\s+/g, ' ')
}

function modeForPath(path: string): WorkbenchMode {
  const ext = getExt(path)
  if (ext === 'tldr') return 'document'
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg'].includes(ext)) return 'video'
  return 'document'
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

export default function GlobalSearchPanel({ resetSignal = 0 }: GlobalSearchPanelProps) {
  const workspaceRoot = useWorkspace((state) => state.workspaceRoot)
  const selectFile = useWorkspace((state) => state.selectFile)
  const setWorkbenchMode = useMode((state) => state.setWorkbenchMode)

  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const [stats, setStats] = useState<SearchStats>({ scannedFiles: 0, matchedFiles: 0 })
  const [message, setMessage] = useState('')
  const searchVersionRef = useRef(0)

  const clearAll = useCallback(() => {
    searchVersionRef.current += 1
    setQuery('')
    setReplaceText('')
    setResults([])
    setStats({ scannedFiles: 0, matchedFiles: 0 })
    setMessage('')
    setIsSearching(false)
    setIsReplacing(false)
  }, [])

  useEffect(() => {
    clearAll()
  }, [resetSignal, clearAll])

  const runSearch = useCallback(async (keyword: string) => {
    if (!workspaceRoot || typeof window === 'undefined' || !window.electronAPI) {
      setResults([])
      setStats({ scannedFiles: 0, matchedFiles: 0 })
      return
    }

    const normalized = keyword.trim().toLowerCase()
    if (!normalized) {
      setResults([])
      setStats({ scannedFiles: 0, matchedFiles: 0 })
      setIsSearching(false)
      return
    }

    const currentVersion = ++searchVersionRef.current
    setIsSearching(true)
    setMessage('')

    let scannedFiles = 0
    const found: SearchResultItem[] = []
    const stack = [workspaceRoot]

    while (stack.length > 0 && scannedFiles < MAX_SCAN_FILES && found.length < MAX_MATCHES) {
      if (searchVersionRef.current !== currentVersion) return

      const dir = stack.pop()!
      try {
        const listResult = await window.electronAPI.document.listFiles(dir)
        if (!listResult.success || !listResult.items) continue

        for (const item of listResult.items) {
          if (item.name.startsWith('.')) continue

          if (item.isDirectory) {
            stack.push(item.path)
            continue
          }

          scannedFiles += 1
          if (scannedFiles > MAX_SCAN_FILES) break

          const nameMatch = item.name.toLowerCase().includes(normalized)
          let contentMatch = false
          let snippet: string | undefined

          if (isTextFile(item.path)) {
            const readResult = await window.electronAPI.document.readFile(item.path)
            const content = readTextPayload(readResult)
            if (content) {
              const lower = content.toLowerCase()
              contentMatch = lower.includes(normalized)
              if (contentMatch) snippet = snippetFrom(content, normalized)
            }
          }

          if (nameMatch || contentMatch) {
            found.push({
              path: item.path,
              name: item.name,
              nameMatch,
              contentMatch,
              snippet,
            })
            if (found.length >= MAX_MATCHES) break
          }
        }
      } catch {
        // Continue scanning other directories even if one directory fails.
      }
    }

    if (searchVersionRef.current !== currentVersion) return
    setResults(found)
    setStats({ scannedFiles, matchedFiles: found.length })
    setIsSearching(false)
  }, [workspaceRoot])

  useEffect(() => {
    const timer = setTimeout(() => {
      void runSearch(query)
    }, 280)
    return () => clearTimeout(timer)
  }, [query, runSearch])

  const replaceAll = useCallback(async () => {
    if (!query.trim() || typeof window === 'undefined' || !window.electronAPI) return
    setIsReplacing(true)
    setMessage('')
    try {
      const keyword = query.trim()
      const targetFiles = Array.from(new Set(results.filter((r) => r.contentMatch).map((r) => r.path)))

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
      await runSearch(query)
    } catch (error) {
      setMessage(`替换失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsReplacing(false)
    }
  }, [query, replaceText, results, runSearch])

  const openResult = useCallback((item: SearchResultItem) => {
    selectFile(item.path)
    setWorkbenchMode(modeForPath(item.path))
  }, [selectFile, setWorkbenchMode])

  const showEmptyState = !isSearching && query.trim().length > 0 && results.length === 0
  const statsText = useMemo(
    () => `已扫描 ${stats.scannedFiles} 个文件，命中 ${stats.matchedFiles} 条`,
    [stats],
  )

  return (
    <div className="content-surface-panel flex h-full min-h-0 flex-col" style={{ background: 'var(--surface-panel-bg)' }}>
      <div
        className="glass-surface-panel flex items-center justify-between border-b"
        style={{
          height: GLOBAL_SEARCH_DIMENSIONS.headerHeight,
          borderColor: PANEL_COLORS.cardBorder,
          background: 'var(--surface-toolbar-bg)',
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
          支持工作区全量检索与尺寸替换
        </p>

        <label
          className="content-surface-card w-full border px-[10px] flex items-center"
          style={{
            borderColor: PANEL_COLORS.inputBorder,
            background: 'var(--surface-card-bg)',
            height: GLOBAL_SEARCH_DIMENSIONS.controlHeight,
            borderRadius: GLOBAL_SEARCH_DIMENSIONS.controlRadius,
          }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件名或内容..."
            className="h-full w-full bg-transparent border-none outline-none text-[13px] font-medium placeholder:text-[var(--text-placeholder)]"
            style={{ color: PANEL_COLORS.text }}
          />
        </label>

        <div className="flex items-center gap-[8px]">
          <label
            className="content-surface-card flex-1 border px-[10px] flex items-center"
            style={{
              borderColor: PANEL_COLORS.inputBorder,
              background: 'var(--surface-card-bg)',
              height: GLOBAL_SEARCH_DIMENSIONS.controlHeight,
              borderRadius: GLOBAL_SEARCH_DIMENSIONS.controlRadius,
            }}
          >
            <input
              type="text"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              placeholder="替换为..."
              className="h-full w-full bg-transparent border-none outline-none text-[13px] font-medium placeholder:text-[var(--text-light)]"
              style={{ color: PANEL_COLORS.text }}
            />
          </label>
          <button
            type="button"
            onClick={() => void replaceAll()}
            disabled={isReplacing || !query.trim()}
            className="content-surface-card border px-[10px] text-[10px] font-medium disabled:opacity-45"
            style={{
              borderColor: PANEL_COLORS.inputBorder,
              color: PANEL_COLORS.muted,
              background: 'var(--surface-card-bg)',
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

        <div className="flex-1 min-h-0 overflow-auto">
          {query.trim().length > 0 && (
            <>
              {showEmptyState && (
                <p className="px-0.5 py-0.5 text-[11px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
                  没有匹配结果
                </p>
              )}

              {results.length > 0 && (
                <div className="space-y-[6px] pb-[2px]">
                  {results.map((item) => (
                    <button
                      key={`${item.path}-${item.snippet || ''}`}
                      onClick={() => openResult(item)}
                      className="content-surface-card w-full rounded-[8px] border px-[8px] py-[6px] text-left transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ borderColor: PANEL_COLORS.cardBorder, background: 'var(--surface-card-bg)' }}
                    >
                      <div className="flex items-center gap-[6px] min-w-0">
                        <FileText className="h-[13px] w-[13px] shrink-0" style={{ color: PANEL_COLORS.mutedStrong }} />
                        <span className="truncate text-[12px] font-medium leading-[1.25]" style={{ color: PANEL_COLORS.text }}>
                          {highlightText(item.name, query)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[10px] leading-[1.3]" style={{ color: PANEL_COLORS.mutedStrong }}>
                        {item.path}
                      </p>
                      {item.snippet && (
                        <p className="mt-0.5 text-[11px] leading-[1.35]" style={{ color: PANEL_COLORS.muted }}>
                          {highlightText(item.snippet, query)}
                        </p>
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
    </div>
  )
}
