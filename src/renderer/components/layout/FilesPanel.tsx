import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Search,
  FilePlus,
  FolderPlus,
  MoreVertical,
  LayoutList,
  LayoutGrid,
  SlidersHorizontal,
  RefreshCw,
  Folder,
  FolderOpen,
} from 'lucide-react'

import { useWorkspace } from '../../stores/useWorkspace'
import FileTree, { DEFAULT_FILE_FILTERS, type FileFilterMap, type FileViewMode } from './FileTree'
import { computeNextGridHistory, type GridNavigationEntry } from './gridNavigation'
import { FILES_PANEL_DIMENSIONS, PANEL_TOKENS } from './panelTokens'
import { WORKBENCH_HEADER_EDGE_X } from '../../modules/workbench/chrome'

interface FilesPanelProps {
  isVisible: boolean
  children?: (slots: SidePanelSlots) => ReactNode
}

export interface SidePanelSlots {
  header: ReactNode
  body: ReactNode
}

const ICON_BTN =
  'flex items-center justify-center rounded transition-colors duration-100 hover:bg-[var(--bg-hover)]'

export default function FilesPanel({ isVisible, children }: FilesPanelProps) {
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<FileViewMode>('tree')
  const [filters, setFilters] = useState<FileFilterMap>({ ...DEFAULT_FILE_FILTERS })
  const [showFilterMenu, setShowFilterMenu] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [thumbnailSize, setThumbnailSize] = useState(132)
  const [gridNavigation, setGridNavigation] = useState<{
    path: GridNavigationEntry
    history: GridNavigationEntry[]
    index: number
  }>({
    path: null,
    history: [null],
    index: 0,
  })
  const filterMenuRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshRunStateRef = useRef({ running: false, pending: false })
  const wasAutoRefreshActiveRef = useRef(false)

  const {
    workspaceRoot,
    pinnedFolders,
    startCreating,
    clearWorkspace,
    saveWorkspace,
    getSavedWorkspaces,
    loadSavedWorkspace,
    refreshFiles,
    loadDirChildren,
    expandedDirs,
    currentPath,
  } = useWorkspace()
  const [isRefreshing, setIsRefreshing] = useState(false)

  const isConnected = useMemo(() => {
    if (workspaceRoot) return true
    if (typeof window === 'undefined') return false
    return !!window.electronAPI
  }, [workspaceRoot])

  useEffect(() => {
    if (!showFilterMenu && !showMoreMenu) return
    const handler = (e: MouseEvent) => {
      if (showFilterMenu && filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setShowFilterMenu(false)
      }
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showFilterMenu, showMoreMenu])

  const toggleFilter = useCallback((key: keyof FileFilterMap) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const filterLabels: { key: keyof FileFilterMap; label: string }[] = [
    { key: 'folder', label: '文件夹' },
    { key: 'document', label: '文档' },
    { key: 'code', label: '代码' },
    { key: 'image', label: '图片' },
    { key: 'video', label: '视频' },
    { key: 'audio', label: '音频' },
    { key: 'spreadsheet', label: '表格' },
    { key: 'design', label: '设计' },
    { key: 'other', label: '其他' },
  ]

  const savedWorkspaces = useMemo(() => getSavedWorkspaces(), [getSavedWorkspaces])

  const handleConnectedRefresh = useCallback(async () => {
    if (!isConnected) return
    if (refreshRunStateRef.current.running) {
      refreshRunStateRef.current.pending = true
      return
    }
    refreshRunStateRef.current.running = true
    setIsRefreshing(true)
    try {
      await refreshFiles()
      const dirs = new Set<string>(Array.from(expandedDirs))
      if (currentPath && currentPath !== '/') {
        dirs.add(currentPath)
      }
      await Promise.all(Array.from(dirs).map((dir) => loadDirChildren(dir)))
    } finally {
      refreshRunStateRef.current.running = false
      setIsRefreshing(false)
      if (refreshRunStateRef.current.pending) {
        refreshRunStateRef.current.pending = false
        void handleConnectedRefresh()
      }
    }
  }, [currentPath, expandedDirs, isConnected, loadDirChildren, refreshFiles])

  const watchedDirectories = useMemo(() => {
    if (!isVisible || !isConnected) return []
    const dirs = new Set<string>()
    pinnedFolders.forEach((dir) => {
      if (dir) dirs.add(dir)
    })
    expandedDirs.forEach((dir) => {
      if (dir) dirs.add(dir)
    })
    if (currentPath && currentPath !== '/') {
      dirs.add(currentPath)
    }
    return Array.from(dirs)
  }, [currentPath, expandedDirs, isConnected, isVisible, pinnedFolders])

  useEffect(() => {
    if (!window.electronAPI?.document?.watchDirectories) return
    if (!isVisible || !isConnected) {
      void window.electronAPI.document.watchDirectories([]).catch(() => undefined)
      return
    }
    void window.electronAPI.document.watchDirectories(watchedDirectories).catch(() => undefined)
    return () => {
      void window.electronAPI.document.watchDirectories([]).catch(() => undefined)
    }
  }, [isConnected, isVisible, watchedDirectories])

  useEffect(() => {
    if (!isVisible || !isConnected) return
    if (!window.electronAPI?.document?.onDirectoryChange) return

    const unsubscribe = window.electronAPI.document.onDirectoryChange(() => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null
        void handleConnectedRefresh()
      }, 180)
    })

    return () => {
      unsubscribe()
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [handleConnectedRefresh, isConnected, isVisible])

  useEffect(() => {
    const isAutoRefreshActive = isVisible && isConnected
    if (isAutoRefreshActive && !wasAutoRefreshActiveRef.current) {
      void handleConnectedRefresh()
    }
    wasAutoRefreshActiveRef.current = isAutoRefreshActive
  }, [handleConnectedRefresh, isConnected, isVisible])

  useEffect(() => {
    setGridNavigation({
      path: null,
      history: [null],
      index: 0,
    })
  }, [workspaceRoot])

  const handleGridPathChange = useCallback((nextPath: GridNavigationEntry) => {
    setGridNavigation((prev) => {
      const nextHistory = computeNextGridHistory(prev.history, prev.index, nextPath)
      return {
        path: nextHistory.entries[nextHistory.index] ?? null,
        history: nextHistory.entries,
        index: nextHistory.index,
      }
    })
  }, [])

  const handleGridNavigateBack = useCallback(() => {
    setGridNavigation((prev) => {
      if (prev.index <= 0) return prev
      const nextIndex = prev.index - 1
      return {
        ...prev,
        index: nextIndex,
        path: prev.history[nextIndex] ?? null,
      }
    })
  }, [])

  const handleGridNavigateForward = useCallback(() => {
    setGridNavigation((prev) => {
      if (prev.index >= prev.history.length - 1) return prev
      const nextIndex = prev.index + 1
      return {
        ...prev,
        index: nextIndex,
        path: prev.history[nextIndex] ?? null,
      }
    })
  }, [])

  const canGridNavigateBack = viewMode === 'grid' && gridNavigation.index > 0
  const canGridNavigateForward = viewMode === 'grid' && gridNavigation.index < gridNavigation.history.length - 1

  const header = (
    <div
      className="shrink-0 flex items-center justify-between"
      style={{
        height: FILES_PANEL_DIMENSIONS.headerHeight,
        borderColor: 'transparent',
        padding: `0 ${FILES_PANEL_DIMENSIONS.headerPaddingX}px`,
        boxSizing: 'border-box',
        background: 'transparent',
      }}
    >
      <span className="text-[13px] font-semibold" style={{ color: PANEL_TOKENS.title }}>
        文件管理
      </span>
      <button
        type="button"
        onClick={handleConnectedRefresh}
        className="group inline-flex items-center gap-1 rounded-[10px] text-[10px] font-medium transition-colors"
        style={{
          padding: '3px 8px',
          background: isConnected ? 'var(--color-green-subtle)' : 'var(--bg-hover)',
          color: isConnected ? 'var(--color-green)' : PANEL_TOKENS.mutedStrong,
        }}
        title={isConnected ? '点击刷新文件状态' : '当前离线'}
      >
        <span
          className="h-[6px] w-[6px] rounded-full"
          style={{ background: isConnected ? 'var(--color-green)' : PANEL_TOKENS.mutedStrong }}
        />
        {isConnected ? 'Connected' : 'Offline'}
        <RefreshCw
          className={`h-[10px] w-[10px] ${isRefreshing ? 'animate-spin' : 'opacity-0 group-hover:opacity-70'}`}
          style={{ color: isConnected ? 'var(--color-green)' : PANEL_TOKENS.mutedStrong }}
        />
      </button>
    </div>
  )

  const body = (
    <>
      <div
        className="shrink-0 flex items-center justify-between"
        style={{
          height: FILES_PANEL_DIMENSIONS.toolbarHeight,
          borderColor: 'transparent',
          padding: `0 ${WORKBENCH_HEADER_EDGE_X}px`,
          boxSizing: 'border-box',
          background: 'transparent',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            className={ICON_BTN}
            style={{
              width: 24,
              height: 24,
              color: viewMode === 'tree' ? PANEL_TOKENS.title : PANEL_TOKENS.mutedStrong,
              background: viewMode === 'tree' ? 'var(--bg-hover)' : 'transparent',
            }}
            onClick={() => setViewMode('tree')}
            title="列表视图"
          >
            <LayoutList style={{ width: 14, height: 14 }} />
          </button>
          <button
            className={ICON_BTN}
            style={{
              width: 24,
              height: 24,
              color: viewMode === 'grid' ? PANEL_TOKENS.title : PANEL_TOKENS.mutedStrong,
              background: viewMode === 'grid' ? 'var(--bg-hover)' : 'transparent',
            }}
            onClick={() => setViewMode('grid')}
            title="缩略图视图"
          >
            <LayoutGrid style={{ width: 14, height: 14 }} />
          </button>

          <div className="relative" ref={filterMenuRef}>
            <button
              className={ICON_BTN}
              style={{ width: 24, height: 24, color: PANEL_TOKENS.mutedStrong }}
              onClick={() => setShowFilterMenu((v) => !v)}
              title="筛选"
            >
              <SlidersHorizontal style={{ width: 14, height: 14 }} />
            </button>
            {showFilterMenu && (
              <div
                className="absolute left-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1"
                style={{
                  minWidth: 140,
                  background: PANEL_TOKENS.cardBg,
                  borderColor: PANEL_TOKENS.border,
                }}
              >
                {filterLabels.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => toggleFilter(key)}
                    className="w-full text-left flex items-center gap-2 hover:bg-[var(--bg-hover)]"
                    style={{ padding: '5px 12px', fontSize: 12, color: PANEL_TOKENS.text }}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        border: `1px solid ${filters[key] ? PANEL_TOKENS.blue : PANEL_TOKENS.border}`,
                        background: filters[key] ? PANEL_TOKENS.blue : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#fff',
                        fontSize: 10,
                        lineHeight: 1,
                      }}
                    >
                      {filters[key] ? '✓' : ''}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            className={ICON_BTN}
            style={{ width: 24, height: 24, color: PANEL_TOKENS.mutedStrong }}
            onClick={() => startCreating('file')}
            title="新建文档"
          >
            <FilePlus style={{ width: 14, height: 14 }} />
          </button>
          <button
            className={ICON_BTN}
            style={{ width: 24, height: 24, color: PANEL_TOKENS.mutedStrong }}
            onClick={() => startCreating('folder')}
            title="新建文件夹"
          >
            <FolderPlus style={{ width: 14, height: 14 }} />
          </button>

          <div className="relative" ref={moreMenuRef}>
            <button
              className={ICON_BTN}
              style={{ width: 24, height: 24, color: PANEL_TOKENS.mutedStrong }}
              onClick={() => setShowMoreMenu((v) => !v)}
              title="更多"
            >
              <MoreVertical style={{ width: 14, height: 14 }} />
            </button>
            {showMoreMenu && (
              <div
                className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1"
                style={{
                  minWidth: 180,
                  background: PANEL_TOKENS.cardBg,
                  borderColor: PANEL_TOKENS.border,
                }}
                onClick={() => setShowMoreMenu(false)}
              >
                <button
                  onClick={() => {
                    if (pinnedFolders.length === 0) return
                    const defaultName =
                      pinnedFolders.map((p) => p.split('/').pop()).join(' + ') || '我的工作区'
                    const name = prompt('工作区名称：', defaultName)
                    if (name) saveWorkspace(name)
                  }}
                  className="w-full text-left flex items-center gap-2 hover:bg-[var(--bg-hover)]"
                  style={{ padding: '6px 12px', fontSize: 12, color: PANEL_TOKENS.text }}
                >
                  <Folder style={{ width: 14, height: 14, color: PANEL_TOKENS.mutedStrong }} />
                  保存当前工作区
                </button>
                <button
                  onClick={() => {
                    if (!workspaceRoot || confirm('确定新建工作区？当前文件列表将被清空。')) {
                      clearWorkspace()
                    }
                  }}
                  className="w-full text-left flex items-center gap-2 hover:bg-[var(--bg-hover)]"
                  style={{ padding: '6px 12px', fontSize: 12, color: PANEL_TOKENS.text }}
                >
                  <FolderOpen style={{ width: 14, height: 14, color: PANEL_TOKENS.mutedStrong }} />
                  新建工作区
                </button>

                {savedWorkspaces.length > 0 && (
                  <>
                    <div style={{ borderTop: `1px solid ${PANEL_TOKENS.border}`, margin: '4px 0' }} />
                    <div style={{ padding: '4px 12px', fontSize: 10, color: PANEL_TOKENS.mutedStrong, fontWeight: 500 }}>
                      已保存的工作区
                    </div>
                    {savedWorkspaces.map((w) => (
                      <button
                        key={w.name}
                        onClick={() => loadSavedWorkspace(w.folders)}
                        className="w-full text-left flex items-center gap-2 hover:bg-[var(--bg-hover)]"
                        style={{ padding: '6px 12px', fontSize: 12, color: PANEL_TOKENS.text }}
                      >
                        <FolderOpen style={{ width: 14, height: 14, color: PANEL_TOKENS.blue }} />
                        <span className="truncate">{w.name}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className="shrink-0"
        style={{
          padding: `${FILES_PANEL_DIMENSIONS.searchPaddingY}px ${FILES_PANEL_DIMENSIONS.searchPaddingX}px`,
        }}
      >
        <div className="flex items-center gap-[6px]">
          {viewMode === 'grid' && (
            <div className="flex items-center gap-[4px] shrink-0">
              <button
                type="button"
                onClick={handleGridNavigateBack}
                disabled={!canGridNavigateBack}
                title="后退"
                aria-label="后退"
                className="flex items-center justify-center rounded-[8px] border text-[12px] font-semibold transition-colors duration-100"
                style={{
                  width: 24,
                  height: 24,
                  borderColor: 'var(--input-slot-border)',
                  background: canGridNavigateBack ? 'var(--input-slot-bg)' : 'var(--bg-hover)',
                  color: canGridNavigateBack ? PANEL_TOKENS.text : PANEL_TOKENS.mutedStrong,
                  opacity: canGridNavigateBack ? 1 : 0.45,
                  cursor: canGridNavigateBack ? 'pointer' : 'default',
                }}
              >
                {'<'}
              </button>
              <button
                type="button"
                onClick={handleGridNavigateForward}
                disabled={!canGridNavigateForward}
                title="前进"
                aria-label="前进"
                className="flex items-center justify-center rounded-[8px] border text-[12px] font-semibold transition-colors duration-100"
                style={{
                  width: 24,
                  height: 24,
                  borderColor: 'var(--input-slot-border)',
                  background: canGridNavigateForward ? 'var(--input-slot-bg)' : 'var(--bg-hover)',
                  color: canGridNavigateForward ? PANEL_TOKENS.text : PANEL_TOKENS.mutedStrong,
                  opacity: canGridNavigateForward ? 1 : 0.45,
                  cursor: canGridNavigateForward ? 'pointer' : 'default',
                }}
              >
                {'>'}
              </button>
            </div>
          )}
          <label
            className="ready-input-shell flex items-center gap-[6px] border min-w-0 flex-1"
            style={{
              height: FILES_PANEL_DIMENSIONS.searchHeight,
              borderRadius: FILES_PANEL_DIMENSIONS.searchRadius,
              padding: '6px 10px',
              background: 'var(--input-slot-bg)',
              borderColor: 'var(--input-slot-border)',
            }}
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件..."
              className="ready-input-slot-inner h-full w-full bg-transparent border-none outline-none text-[13px] font-medium placeholder:text-[var(--text-placeholder)]"
              style={{ color: PANEL_TOKENS.text }}
            />
            <Search className="h-[13px] w-[13px] shrink-0" style={{ color: PANEL_TOKENS.sectionTitle }} />
          </label>
        </div>
      </div>

      <FileTree
        query={query}
        filters={filters}
        viewMode={viewMode}
        thumbnailSize={thumbnailSize}
        gridPath={gridNavigation.path}
        onGridPathChange={handleGridPathChange}
        onThumbnailSizeChange={setThumbnailSize}
      />
    </>
  )

  if (children) {
    return <>{children({ header, body })}</>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    </div>
  )
}
