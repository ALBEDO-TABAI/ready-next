import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  FilePlus,
  FolderPlus,
  LayoutGrid,
  LayoutList,
  Search,
} from 'lucide-react'

import { useWorkspace } from '../../stores/useWorkspace'
import FileTree, { DEFAULT_FILE_FILTERS, type FileFilterMap, type FileViewMode } from './FileTree'
import { FloatPanel } from '../ui/float/FloatPanel'
import { IconButton, Input, MenuList, type MenuEntry } from '../ui'
import { computeNextGridHistory, type GridNavigationEntry } from './gridNavigation'
import { FILES_PANEL_DIMENSIONS, PANEL_TOKENS } from './panelTokens'
import { WORKBENCH_HEADER_EDGE_X } from '../../modules/workbench/chrome'
import { subscribeWorkbenchWindowResize } from '../../modules/workbench/windowResize'
import { subscribeDocumentDirectoryChanges } from '../../modules/document/directoryChangeBridge'
import { releaseDirectoryWatch, watchDirectoriesFor } from '../../modules/document/directoryWatchRegistry'

interface FilesPanelProps {
  isVisible: boolean
  children?: (slots: SidePanelSlots) => ReactNode
}

export interface SidePanelSlots {
  header: ReactNode
  body: ReactNode
}

/** The shared menu list's width (rn-menu's min-width), used to keep the filter menu inside the panel. */
const FILTER_MENU_WIDTH = 200

interface FloatingMenuPosition {
  left: number
  top: number
}

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

  // The shared menu list, kept open while filters are toggled (each row is a checkable item).
  const filterMenuItems: MenuEntry[] = filterLabels.map(({ key, label }) => ({
    id: key,
    label,
    checked: filters[key],
    onSelect: () => toggleFilter(key),
  }))
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
      setFilterMenuPosition(next ? computeMenuPosition(filterTriggerRef.current, FILTER_MENU_WIDTH) : null)
      return next
    })
  }, [computeMenuPosition])

  useEffect(() => {
    if (!showFilterMenu) return

    const syncMenuPositions = () => {
      if (showFilterMenu) {
        setFilterMenuPosition(computeMenuPosition(filterTriggerRef.current, FILTER_MENU_WIDTH))
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

  // The file view's share of the window's watched folders (other owners, e.g. an open database, keep theirs).
  const watchOwner = useRef(Symbol('files-panel'))
  useEffect(() => {
    const owner = watchOwner.current
    watchDirectoriesFor(owner, isVisible && isConnected ? watchedDirectories : [])
    return () => releaseDirectoryWatch(owner)
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
          <IconButton
            size="sm"
            title="列表视图"
            icon={<LayoutList />}
            active={viewMode === 'tree'}
            onClick={() => setViewMode('tree')}
          />
          <IconButton
            size="sm"
            title="缩略图视图"
            icon={<LayoutGrid />}
            active={viewMode === 'grid'}
            onClick={() => setViewMode('grid')}
          />

          <div className="relative">
            <IconButton
              ref={filterTriggerRef}
              size="sm"
              title="筛选"
              icon={<SlidersHorizontal />}
              active={showFilterMenu}
              aria-haspopup="menu"
              aria-expanded={showFilterMenu}
              onClick={toggleFilterMenu}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconButton size="sm" title="新建文档" icon={<FilePlus />} onClick={() => startCreating('file')} />
          <IconButton size="sm" title="新建文件夹" icon={<FolderPlus />} onClick={() => startCreating('folder')} />
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
              <IconButton size="sm" title="后退" icon={<ChevronLeft />} onClick={handleGridNavigateBack} disabled={!canGridNavigateBack} />
              <IconButton size="sm" title="前进" icon={<ChevronRight />} onClick={handleGridNavigateForward} disabled={!canGridNavigateForward} />
            </div>
          )}
          <div className="relative flex min-w-0 flex-1 items-center">
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件..."
              aria-label="搜索文件"
              style={{
                width: '100%',
                height: FILES_PANEL_DIMENSIONS.searchHeight,
                paddingLeft: 10,
                paddingRight: 28,
              }}
            />
            <Search className="h-[13px] w-[13px] pointer-events-none absolute" aria-hidden="true" style={{ right: 10, color: PANEL_TOKENS.sectionTitle }} />
          </div>
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
          className="rn-ui"
          style={{
            position: 'fixed',
            left: filterMenuPosition.left,
            top: filterMenuPosition.top,
            zIndex: 250,
            maxHeight: 360,
          }}
        >
          <MenuList items={filterMenuItems} label="筛选" onDone={() => {}} />
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
