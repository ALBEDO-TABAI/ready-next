import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, FilePlus, FolderPlus, MoreVertical,
  LayoutList, LayoutGrid, SlidersHorizontal, RefreshCw,
  Folder, FolderOpen,
} from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import FileTree, { DEFAULT_FILE_FILTERS, type FileFilterMap, type FileViewMode } from './FileTree'
import GlobalSearchPanel from './GlobalSearchPanel'
import SkillsCenterPanel from './SkillsCenterPanel'
import { FILES_PANEL_DIMENSIONS, PANEL_TOKENS } from './panelTokens'
import { WORKBENCH_HEADER_EDGE_X } from '../../modules/workbench/chrome'

export type SidePanelVariant = 'files' | 'search' | 'skills' | 'calendar' | 'hidden'

interface SidePanelProps {
  variant?: SidePanelVariant
}

const ICON_BTN =
  'flex items-center justify-center rounded transition-colors duration-100 hover:bg-[var(--bg-hover)]'

export default function SidePanel({ variant = 'files' }: SidePanelProps) {
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<FileViewMode>('tree')
  const [filters, setFilters] = useState<FileFilterMap>({ ...DEFAULT_FILE_FILTERS })
  const [showFilterMenu, setShowFilterMenu] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [thumbnailSize, setThumbnailSize] = useState(132)
  const filterMenuRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  const {
    sidebarVisible,
    sidePanelWidths,
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

  const isVisible = variant !== 'hidden' && sidebarVisible
  const panelWidth = variant === 'skills'
    ? sidePanelWidths.skills
    : variant === 'search'
      ? sidePanelWidths.search
      : sidePanelWidths.files

  const isConnected = useMemo(() => {
    if (workspaceRoot) return true
    if (typeof window === 'undefined') return false
    return !!window.electronAPI
  }, [workspaceRoot])

  // Close menus on outside click
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
    if (!isConnected || isRefreshing) return
    setIsRefreshing(true)
    try {
      await refreshFiles()
      const dirs = new Set<string>(Array.from(expandedDirs))
      if (currentPath && currentPath !== '/') {
        dirs.add(currentPath)
      }
      await Promise.all(Array.from(dirs).map((dir) => loadDirChildren(dir)))
    } finally {
      setIsRefreshing(false)
    }
  }, [currentPath, expandedDirs, isConnected, isRefreshing, loadDirChildren, refreshFiles])

  return (
    <div
      className="content-surface-panel flex-shrink-0 border-r flex flex-col select-none overflow-hidden"
      style={{
        width: isVisible ? panelWidth : 0,
        minWidth: isVisible ? panelWidth : 0,
        background: PANEL_TOKENS.panelBg,
        fontFamily: 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        transition: 'width 300ms ease-in-out, min-width 300ms ease-in-out',
        borderColor: PANEL_TOKENS.border,
        borderRightWidth: isVisible ? 1 : 0,
      }}
    >
      {variant === 'calendar' ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-[13px]" style={{ color: PANEL_TOKENS.mutedStrong }}>日历侧边栏</span>
        </div>
      ) : variant === 'search' ? (
        <GlobalSearchPanel key="global-search-panel" />
      ) : variant === 'skills' ? (
        <SkillsCenterPanel key="skills-center-panel" />
      ) : (
        <>
          {/* Header row */}
          <div
            className="shrink-0 border-b flex items-center justify-between"
            style={{
              height: FILES_PANEL_DIMENSIONS.headerHeight,
              borderColor: PANEL_TOKENS.border,
              padding: `0 ${FILES_PANEL_DIMENSIONS.headerPaddingX}px`,
              boxSizing: 'border-box',
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

          {/* Toolbar row */}
          <div
            className="shrink-0 border-b flex items-center justify-between"
            style={{
              height: FILES_PANEL_DIMENSIONS.toolbarHeight,
              borderColor: PANEL_TOKENS.border,
              padding: `0 ${WORKBENCH_HEADER_EDGE_X}px`,
              boxSizing: 'border-box',
            }}
          >
            {/* Left: view mode + filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                className={ICON_BTN}
                style={{
                  width: 24, height: 24,
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
                  width: 24, height: 24,
                  color: viewMode === 'grid' ? PANEL_TOKENS.title : PANEL_TOKENS.mutedStrong,
                  background: viewMode === 'grid' ? 'var(--bg-hover)' : 'transparent',
                }}
                onClick={() => setViewMode('grid')}
                title="缩略图视图"
              >
                <LayoutGrid style={{ width: 14, height: 14 }} />
              </button>

              {/* Filter */}
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
                            width: 14, height: 14, borderRadius: 3,
                            border: `1px solid ${filters[key] ? PANEL_TOKENS.blue : PANEL_TOKENS.border}`,
                            background: filters[key] ? PANEL_TOKENS.blue : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: '#fff', fontSize: 10, lineHeight: 1,
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

            {/* Right: new file, new folder, more */}
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

              {/* More menu */}
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

          {/* Search */}
          <div
            className="shrink-0"
            style={{
              padding: `${FILES_PANEL_DIMENSIONS.searchPaddingY}px ${FILES_PANEL_DIMENSIONS.searchPaddingX}px`,
            }}
          >
            <label
              className="flex items-center gap-[6px] border"
              style={{
                height: FILES_PANEL_DIMENSIONS.searchHeight,
                borderRadius: FILES_PANEL_DIMENSIONS.searchRadius,
                borderColor: PANEL_TOKENS.inputBorder,
                padding: '6px 10px',
                background: PANEL_TOKENS.cardBg,
              }}
            >
              <Search className="h-[13px] w-[13px]" style={{ color: PANEL_TOKENS.sectionTitle }} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索文件..."
                className="h-full w-full bg-transparent border-none outline-none text-[13px] font-medium placeholder:text-[var(--text-placeholder)]"
                style={{ color: PANEL_TOKENS.text }}
              />
            </label>
          </div>

          {/* File tree / grid */}
          <FileTree
            query={query}
            filters={filters}
            viewMode={viewMode}
            thumbnailSize={thumbnailSize}
            onThumbnailSizeChange={setThumbnailSize}
          />
        </>
      )}
    </div>
  )
}
