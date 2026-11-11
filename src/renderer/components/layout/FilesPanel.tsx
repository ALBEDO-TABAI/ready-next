import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconAdjustmentsHorizontal as SlidersHorizontal,
  IconFilePlus as FilePlus,
  IconFolderPlus as FolderPlus,
  IconLayoutGrid as LayoutGrid,
  IconLayoutList as LayoutList,
  IconSearch as Search,
} from '@tabler/icons-react'

import { useWorkspace } from '../../stores/useWorkspace'
import FileTree, { DEFAULT_FILE_FILTERS, type FileFilterMap, type FileViewMode } from './FileTree'
import { FloatPanel } from '../ui/float/FloatPanel'
import { computeNextGridHistory, type GridNavigationEntry } from './gridNavigation'
import { FILES_PANEL_DIMENSIONS, PANEL_TOKENS } from './panelTokens'
import { WORKBENCH_HEADER_EDGE_X } from '../../modules/workbench/chrome'
import {
  buildFloatingMenuCheckStyle,
  buildFloatingMenuItemStyle,
  buildFloatingMenuSurfaceStyle,
} from '../ui/floatingMenuStyles'
import { subscribeWorkbenchWindowResize } from '../../modules/workbench/windowResize'
import { subscribeDocumentDirectoryChanges } from '../../modules/document/directoryChangeBridge'
import './filesPanelFloatingMenu.css'

interface FilesPanelProps {
  isVisible: boolean
  children?: (slots: SidePanelSlots) => ReactNode
}

export interface SidePanelSlots {
  header: ReactNode
  body: ReactNode
}

interface FloatingMenuPosition {
  left: number
  top: number
}

const ICON_BTN =
  'flex items-center justify-center rounded transition-[background-color,box-shadow] duration-100 hover:bg-[var(--files-panel-state-hover-bg)] hover:shadow-[var(--files-panel-state-hover-shadow)]'

export default function FilesPanel({ isVisible, children }: FilesPanelProps) {
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<FileViewMode>('tree')
  const [filters, setFilters] = useState<FileFilterMap>({ ...DEFAULT_FILE_FILTERS })
  const [showFilterMenu, setShowFilterMenu] = useState(false)
  const [filterMenuPosition, setFilterMenuPosition] = useState<FloatingMenuPosition | null>(null)
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
  const toolbarRef = useRef<HTMLDivElement>(null)
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const filterMenuRef = useRef<HTMLDivElement>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshRunStateRef = useRef({ running: false, pending: false })
  const wasAutoRefreshActiveRef = useRef(false)

  const {
    workspaceRoot,
    pinnedFolders,
    startCreating,
    refreshFiles,
    loadDirChildren,
    expandedDirs,
    currentPath,
  } = useWorkspace()

  const isConnected = useMemo(() => {
    if (workspaceRoot) return true
    if (typeof window === 'undefined') return false
    return !!window.electronAPI
  }, [workspaceRoot])

  useEffect(() => {
    if (!showFilterMenu) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const clickedFilterMenu = !!(
        filterMenuRef.current?.contains(target) ||
        filterTriggerRef.current?.contains(target)
      )

      if (showFilterMenu && !clickedFilterMenu) setShowFilterMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showFilterMenu])

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

  const filterMenuStyle = buildFloatingMenuSurfaceStyle(168, {
    maxHeight: 360,
    padding: 6,
    zIndex: 250,
  })
  const portalRoot = typeof document !== 'undefined' ? document.body : null

  const computeMenuPosition = useCallback((trigger: HTMLButtonElement | null, menuWidth: number): FloatingMenuPosition | null => {
    if (!trigger || !toolbarRef.current) return null

    const triggerRect = trigger.getBoundingClientRect()
    const panelRect = toolbarRef.current.getBoundingClientRect()
    const padding = 8
    const left = Math.max(
      panelRect.left + padding,
      Math.min(triggerRect.right - menuWidth, panelRect.right - menuWidth - padding),
    )

    return {
      left: Math.round(left),
      top: Math.round(triggerRect.bottom + 6),
    }
  }, [])

  const toggleFilterMenu = useCallback(() => {
    setShowFilterMenu((prev) => {
      const next = !prev
      setFilterMenuPosition(next ? computeMenuPosition(filterTriggerRef.current, 168) : null)
      return next
    })
  }, [computeMenuPosition])

  useEffect(() => {
    if (!showFilterMenu) return

    const syncMenuPositions = () => {
      if (showFilterMenu) {
        setFilterMenuPosition(computeMenuPosition(filterTriggerRef.current, 168))
      }
    }

    const unsubscribeWindowResize = subscribeWorkbenchWindowResize(syncMenuPositions)
    window.addEventListener('scroll', syncMenuPositions, true)
    return () => {
      unsubscribeWindowResize()
      window.removeEventListener('scroll', syncMenuPositions, true)
    }
  }, [computeMenuPosition, showFilterMenu])

  const handleConnectedRefresh = useCallback(async () => {
    if (!isConnected) return
    if (refreshRunStateRef.current.running) {
      refreshRunStateRef.current.pending = true
      return
    }
    refreshRunStateRef.current.running = true
    try {
      await refreshFiles()
      const dirs = new Set<string>(Array.from(expandedDirs))
      if (currentPath && currentPath !== '/') {
        dirs.add(currentPath)
      }
      await Promise.all(Array.from(dirs).map((dir) => loadDirChildren(dir)))
    } finally {
      refreshRunStateRef.current.running = false
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
    // fire-and-forget: visibility/connection edge → reset watched-directories on the main process; if the IPC drops, the worst case is a stale watcher that gets corrected on the next visibility transition.
    if (!isVisible || !isConnected) {
      void window.electronAPI.document.watchDirectories([]).catch(() => undefined)
      return
    }
    // fire-and-forget: same rationale — apply the desired watch set; main side reconciles on next call.
    void window.electronAPI.document.watchDirectories(watchedDirectories).catch(() => undefined)
    return () => {
      // fire-and-forget: cleanup on unmount; idempotent at the main-process boundary.
      void window.electronAPI.document.watchDirectories([]).catch(() => undefined)
    }
  }, [isConnected, isVisible, watchedDirectories])

  useEffect(() => {
    if (!isVisible || !isConnected) return

    const unsubscribe = subscribeDocumentDirectoryChanges(() => {
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
      <span aria-hidden="true" />
    </div>
  )

  const body = (
    <>
      <div
        ref={toolbarRef}
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
              background: viewMode === 'tree' ? 'var(--files-panel-state-active-bg)' : 'transparent',
              boxShadow: viewMode === 'tree' ? 'var(--files-panel-state-active-shadow)' : 'none',
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
              background: viewMode === 'grid' ? 'var(--files-panel-state-active-bg)' : 'transparent',
              boxShadow: viewMode === 'grid' ? 'var(--files-panel-state-active-shadow)' : 'none',
            }}
            onClick={() => setViewMode('grid')}
            title="缩略图视图"
          >
            <LayoutGrid style={{ width: 14, height: 14 }} />
          </button>

          <div className="relative">
            <button
              ref={filterTriggerRef}
              className={ICON_BTN}
              style={{
                width: 24,
                height: 24,
                color: PANEL_TOKENS.mutedStrong,
                background: showFilterMenu ? 'var(--files-panel-state-active-bg)' : 'transparent',
                boxShadow: showFilterMenu ? 'var(--files-panel-state-active-shadow)' : 'none',
              }}
              onClick={toggleFilterMenu}
              title="筛选"
            >
              <SlidersHorizontal style={{ width: 14, height: 14 }} />
            </button>
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
                  background: canGridNavigateBack ? 'var(--input-slot-bg)' : 'var(--files-panel-state-hover-bg)',
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
                  background: canGridNavigateForward ? 'var(--input-slot-bg)' : 'var(--files-panel-state-hover-bg)',
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
      {portalRoot && showFilterMenu && filterMenuPosition && createPortal(
        <FloatPanel
          ref={filterMenuRef}
          style={{
            ...filterMenuStyle,
            position: 'fixed',
            left: filterMenuPosition.left,
            top: filterMenuPosition.top,
            minWidth: 168,
          }}
        >
          {filterLabels.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
              className="ready-floating-menu-item w-full text-left flex items-center gap-2"
              style={{
                ...buildFloatingMenuItemStyle({ compact: true }),
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 12,
                color: PANEL_TOKENS.text,
              }}
            >
              <span style={buildFloatingMenuCheckStyle(filters[key])}>
                {filters[key] ? '✓' : ''}
              </span>
              {label}
            </button>
          ))}
        </FloatPanel>,
        document.body,
      )}
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
