import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssetRecordType, Tldraw, createShapeId, type Editor, type TLComponents } from 'tldraw'
import type { TLEditorSnapshot } from '@tldraw/editor'
import 'tldraw/tldraw.css'
import { Bot, EyeOff, ImagePlus, Layers3, PanelLeftClose, PanelRightClose, Palette, Plus, SlidersHorizontal, X } from 'lucide-react'
import { useTheme } from '../../stores/useTheme'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDesignSession } from '../../stores/useDesignSession'
import ComponentPanel from '../../components/design/ComponentPanel'
import { allShapeUtils, allTools } from '../../components/design/shapes'
import { MorphTabButton, MorphTabStrip } from '../../components/motion/MorphTabStrip'
import {
  getDroppedFileKind,
  getDroppedFilesFromDataTransfer,
  toFileUrl,
} from '../../utils/dragDrop'

// Keep canvas state when users switch between workbench modes.
const fileSnapshotCache = new Map<string, TLEditorSnapshot>()
let transientSnapshot: TLEditorSnapshot | null = null
let baseSnapshot: TLEditorSnapshot | null = null
let openedDesignTabs: string[] = []

const designComponents: TLComponents = {
  InFrontOfTheCanvas: ComponentPanel,
}

function getPathBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function getImageMimeType(ext: string): string {
  const normalized = ext.toLowerCase().replace(/^\./, '')
  if (normalized === 'png') return 'image/png'
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg'
  if (normalized === 'webp') return 'image/webp'
  if (normalized === 'gif') return 'image/gif'
  if (normalized === 'bmp') return 'image/bmp'
  if (normalized === 'svg') return 'image/svg+xml'
  if (normalized === 'ico') return 'image/x-icon'
  if (normalized === 'tiff' || normalized === 'tif') return 'image/tiff'
  return 'image/png'
}

function isAnimatedImageExt(ext: string): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, '')
  return normalized === 'gif'
}

function emitDesignUIEvent(eventName: string) {
  window.dispatchEvent(new CustomEvent(eventName))
}

export default function DesignMode() {
  const editorRef = useRef<Editor | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoringRef = useRef(false)
  const activeFileRef = useRef<string | null>(null)
  const resolvedTheme = useTheme((state) => state.resolvedTheme)
  const selectedFile = useWorkspace((state) => state.selectedFile)
  const selectWorkspaceFile = useWorkspace((state) => state.selectFile)
  const chatPanelVisible = useWorkspace((state) => state.chatPanelVisible)
  const setActiveFile = useDesignSession((state) => state.setActiveFile)
  const markDirty = useDesignSession((state) => state.markDirty)
  const markSaving = useDesignSession((state) => state.markSaving)
  const markSaved = useDesignSession((state) => state.markSaved)
  const markError = useDesignSession((state) => state.markError)
  const isDirty = useDesignSession((state) => state.isDirty)
  const saveStatus = useDesignSession((state) => state.saveStatus)
  const resetSession = useDesignSession((state) => state.reset)
  const [projectTabs, setProjectTabs] = useState<string[]>(() => [...openedDesignTabs])
  const [uiHidden, setUiHidden] = useState<boolean>(() => localStorage.getItem('ready-design-ui-hidden') === 'true')

  const isDesignFile = useCallback((path: string | null) => {
    return Boolean(path && path.toLowerCase().endsWith('.tldr'))
  }, [])

  const applySnapshot = useCallback((editor: Editor, snapshot: TLEditorSnapshot | null) => {
    if (!snapshot) return
    try {
      restoringRef.current = true
      editor.loadSnapshot(snapshot)
    } catch (error) {
      console.warn('Failed to load design snapshot:', error)
    } finally {
      restoringRef.current = false
    }
  }, [])

  const saveSnapshot = useCallback(async (path: string, snapshot: TLEditorSnapshot) => {
    fileSnapshotCache.set(path, snapshot)

    if (typeof window === 'undefined' || !window.electronAPI?.design) {
      markSaved()
      return true
    }

    try {
      markSaving()
      const result = await window.electronAPI.design.write(path, snapshot)
      if (!result.success) {
        throw new Error(result.error || 'Unknown write error')
      }
      markSaved()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      markError(message)
      console.warn('Design autosave failed:', message)
      return false
    }
  }, [markError, markSaved, markSaving])

  const flushSave = useCallback(async (fileOverride?: string) => {
    const file = fileOverride ?? activeFileRef.current
    const editor = editorRef.current
    if (!editor || !file || !isDesignFile(file) || restoringRef.current) return false

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    const snapshot = editor.getSnapshot()
    return saveSnapshot(file, snapshot)
  }, [isDesignFile, saveSnapshot])

  const schedulePersist = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    saveTimerRef.current = setTimeout(() => {
      const editor = editorRef.current
      const path = activeFileRef.current
      if (!editor || !path || !isDesignFile(path) || restoringRef.current) return
      const snapshot = editor.getSnapshot()
      void saveSnapshot(path, snapshot)
    }, 1500)
  }, [isDesignFile, saveSnapshot])

  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const editor = editorRef.current
      if (editor) {
        try {
          const snapshot = editor.getSnapshot()
          const activeFile = activeFileRef.current
          if (activeFile && isDesignFile(activeFile)) {
            fileSnapshotCache.set(activeFile, snapshot)
            void saveSnapshot(activeFile, snapshot)
          } else {
            transientSnapshot = snapshot
          }
        } catch {
          // Editor may already be disposed during unmount.
        }
      }
      resetSession()
    }
  }, [isDesignFile, resetSession, saveSnapshot])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.user.updateUserPreferences({
      colorScheme: resolvedTheme,
      isSnapMode: true,
    })
  }, [resolvedTheme])

  useEffect(() => {
    let cancelled = false
    const nextDesignFile = isDesignFile(selectedFile) ? selectedFile : null

    ;(async () => {
      const previousFile = activeFileRef.current
      if (previousFile && previousFile !== nextDesignFile) {
        await flushSave(previousFile)
      }

      activeFileRef.current = nextDesignFile
      setActiveFile(nextDesignFile)

      const editor = editorRef.current
      if (!editor) return

      if (!nextDesignFile) {
        const fallback = transientSnapshot ?? baseSnapshot
        applySnapshot(editor, fallback)
        return
      }

      const cached = fileSnapshotCache.get(nextDesignFile)
      if (typeof window === 'undefined' || !window.electronAPI?.design) {
        applySnapshot(editor, cached ?? baseSnapshot)
        return
      }

      const readResult = await window.electronAPI.design.read(nextDesignFile)
      if (cancelled || activeFileRef.current !== nextDesignFile) return

      if (readResult.success && readResult.data) {
        const snapshot = readResult.data as TLEditorSnapshot
        fileSnapshotCache.set(nextDesignFile, snapshot)
        applySnapshot(editor, snapshot)
        return
      }

      if (cached) {
        applySnapshot(editor, cached)
        return
      }

      applySnapshot(editor, baseSnapshot)
    })()

    return () => { cancelled = true }
  }, [selectedFile, applySnapshot, flushSave, isDesignFile, setActiveFile])

  useEffect(() => {
    if (!selectedFile || !isDesignFile(selectedFile)) return
    if (openedDesignTabs.includes(selectedFile)) return
    openedDesignTabs = [...openedDesignTabs, selectedFile]
    setProjectTabs([...openedDesignTabs])
  }, [isDesignFile, selectedFile])

  useEffect(() => {
    const handleManualSave = () => {
      const editor = editorRef.current
      if (!editor) return

      const activeFile = activeFileRef.current
      if (activeFile && isDesignFile(activeFile)) {
        void flushSave(activeFile)
        return
      }

      if (typeof window === 'undefined' || !window.electronAPI?.design) return
      void (async () => {
        const result = await window.electronAPI.design.saveAs({
          defaultPath: selectedFile || undefined,
          data: editor.getSnapshot(),
        })
        if (result.success && result.path) {
          selectWorkspaceFile(result.path)
        }
      })()
    }

    window.addEventListener('ready-design-save', handleManualSave as EventListener)
    return () => window.removeEventListener('ready-design-save', handleManualSave as EventListener)
  }, [flushSave, isDesignFile, selectWorkspaceFile, selectedFile])

  useEffect(() => {
    const onToggleUI = () => {
      setUiHidden((prev) => {
        const next = !prev
        localStorage.setItem('ready-design-ui-hidden', String(next))
        return next
      })
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        emitDesignUIEvent('ready-design-toggle-ui')
      }
    }
    window.addEventListener('ready-design-toggle-ui', onToggleUI as EventListener)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('ready-design-toggle-ui', onToggleUI as EventListener)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const activeDesignPath = useMemo(
    () => (selectedFile && isDesignFile(selectedFile) ? selectedFile : null),
    [isDesignFile, selectedFile],
  )

  const handleSelectProjectTab = useCallback((path: string) => {
    selectWorkspaceFile(path)
  }, [selectWorkspaceFile])

  const handleCloseProjectTab = useCallback((path: string) => {
    openedDesignTabs = openedDesignTabs.filter((item) => item !== path)
    setProjectTabs([...openedDesignTabs])
    if (activeDesignPath === path) {
      const fallback = openedDesignTabs[openedDesignTabs.length - 1] || null
      selectWorkspaceFile(fallback)
    }
  }, [activeDesignPath, selectWorkspaceFile])

  const handleProjectTabDragStart = useCallback((e: React.DragEvent, path: string) => {
    const isActive = activeDesignPath === path
    const payload = JSON.stringify({
      type: 'design-project' as const,
      name: getPathBasename(path),
      path,
      dirty: isActive ? isDirty : false,
      saveStatus: isActive ? saveStatus : 'idle',
      draggedAt: Date.now(),
    })
    e.dataTransfer.setData('application/x-ready-drag', payload)
    e.dataTransfer.setData('text/plain', path)
    e.dataTransfer.effectAllowed = 'copy'
  }, [activeDesignPath, isDirty, saveStatus])

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    if (!baseSnapshot) {
      baseSnapshot = editor.getSnapshot()
    }

    editor.user.updateUserPreferences({
      colorScheme: resolvedTheme,
      isSnapMode: true,
    })

    const currentSelectedFile = useWorkspace.getState().selectedFile
    const currentDesignFile = isDesignFile(currentSelectedFile) ? currentSelectedFile : null
    activeFileRef.current = currentDesignFile
    setActiveFile(currentDesignFile)

    if (currentDesignFile) {
      const cached = fileSnapshotCache.get(currentDesignFile)
      if (cached) {
        applySnapshot(editor, cached)
      } else if (typeof window !== 'undefined' && window.electronAPI?.design) {
        void (async () => {
          const readResult = await window.electronAPI.design.read(currentDesignFile)
          if (activeFileRef.current !== currentDesignFile) return
          if (readResult.success && readResult.data) {
            const snapshot = readResult.data as TLEditorSnapshot
            fileSnapshotCache.set(currentDesignFile, snapshot)
            applySnapshot(editor, snapshot)
            return
          }
          applySnapshot(editor, baseSnapshot)
        })()
      } else {
        applySnapshot(editor, baseSnapshot)
      }
    } else {
      applySnapshot(editor, transientSnapshot ?? baseSnapshot)
    }

    if (unsubscribeRef.current) {
      unsubscribeRef.current()
    }
    unsubscribeRef.current = editor.store.listen(() => {
      if (restoringRef.current) return
      const activeFile = activeFileRef.current
      if (!activeFile || !isDesignFile(activeFile)) {
        transientSnapshot = editor.getSnapshot()
        return
      }
      markDirty()
      schedulePersist()
    }, { source: 'user', scope: 'document' })
  }, [resolvedTheme, applySnapshot, isDesignFile, markDirty, schedulePersist, setActiveFile])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const types = new Set(Array.from(e.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    if (!editor) return

    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    const imageFiles = droppedFiles.filter((file) => getDroppedFileKind(file) === 'image')
    if (imageFiles.length === 0) return

    e.preventDefault()

    const pagePoint = editor.screenToPage({ x: e.clientX, y: e.clientY })
    const createdShapeIds: ReturnType<typeof createShapeId>[] = []

    imageFiles.forEach((file, index) => {
      const imageWidth = 320
      const imageHeight = 200
      const shapeId = createShapeId()
      const assetId = AssetRecordType.createId(`asset-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`)
      const src = toFileUrl(file.path)

      editor.createAssets([
        {
          id: assetId,
          typeName: 'asset',
          type: 'image',
          props: {
            name: file.name,
            src,
            w: imageWidth,
            h: imageHeight,
            mimeType: getImageMimeType(file.ext),
            isAnimated: isAnimatedImageExt(file.ext),
            ...(file.size > 0 ? { fileSize: file.size } : {}),
          },
          meta: {},
        } as never,
      ])

      editor.createShape({
        id: shapeId,
        type: 'image',
        x: pagePoint.x - imageWidth / 2 + index * 24,
        y: pagePoint.y - imageHeight / 2 + index * 24,
        props: {
          w: imageWidth,
          h: imageHeight,
          playing: true,
          url: '',
          assetId,
          crop: null,
          flipX: false,
          flipY: false,
          altText: file.name,
        },
      })
      createdShapeIds.push(shapeId)
    })

    if (createdShapeIds.length > 0) {
      editor.setSelectedShapes(createdShapeIds)
    }
  }, [])

  const handleToggleUiClick = useCallback(() => {
    emitDesignUIEvent('ready-design-toggle-ui')
  }, [])

  const handleCreateNewDraft = useCallback(async () => {
    await flushSave(activeFileRef.current || undefined)
    activeFileRef.current = null
    setActiveFile(null)
    selectWorkspaceFile(null)
    const editor = editorRef.current
    if (editor && baseSnapshot) {
      applySnapshot(editor, baseSnapshot)
      transientSnapshot = editor.getSnapshot()
    }
  }, [applySnapshot, flushSave, selectWorkspaceFile, setActiveFile])

  const handleOpenAgentPanel = useCallback(() => {
    useWorkspace.setState({ chatPanelVisible: true })
  }, [])

  return (
    <div
      className="workbench-mode-root"
      style={{ position: 'relative' }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div
        className="glass-surface-panel flex items-center justify-between flex-shrink-0"
        style={{
          height: 42,
          padding: '0 8px',
          borderBottom: '1px solid var(--border-default)',
          background: 'var(--surface-toolbar-bg)',
        }}
      >
        <div className="flex items-end h-full min-w-0 flex-1 overflow-hidden" style={{ paddingLeft: 0 }}>
          <MorphTabStrip
            layoutId="design-tabs"
            className="flex items-end h-full min-w-0 flex-1 overflow-hidden gap-[1px]"
          >
            {projectTabs.map((path) => {
              const isActive = activeDesignPath === path
              return (
                <div key={path} className="relative flex items-end min-w-0 flex-1 max-w-[220px]">
                  <MorphTabButton
                    layoutId="design-tabs"
                    active={isActive}
                    draggable
                    onDragStart={(e) => handleProjectTabDragStart(e, path)}
                    onClick={() => handleSelectProjectTab(path)}
                    className="group flex w-full min-w-0 items-center rounded-t-[8px] text-[12px] transition-all duration-150 ease-out"
                    style={{
                      gap: 6,
                      padding: '6px 12px',
                      cursor: 'grab',
                      marginBottom: -1,
                      background: isActive ? 'var(--surface-card-bg)' : 'transparent',
                      color: isActive ? 'var(--text-body)' : 'var(--text-muted)',
                      border: '1px solid var(--border-default)',
                      borderBottom: isActive ? '1px solid var(--surface-card-bg)' : '1px solid var(--border-default)',
                    }}
                    contentClassName="relative z-[1] flex min-w-0 flex-1 items-center gap-[6px]"
                    title={path}
                  >
                    <span
                      className="flex-shrink-0 rounded-full"
                      style={{ width: 8, height: 8, background: 'var(--color-purple)' }}
                    />
                    <span className="truncate flex-1 min-w-0">
                      {getPathBasename(path)}
                      {isActive && isDirty && <span className="ml-0.5" style={{ color: 'var(--text-light)' }}>●</span>}
                    </span>
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); handleCloseProjectTab(path) }}
                      className="rounded transition-all duration-150 ease-out cursor-pointer opacity-0 group-hover:opacity-100 flex-shrink-0 active:scale-[0.95]"
                      style={{ padding: 2, color: 'var(--text-light)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-body)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-light)')}
                    >
                      <X style={{ width: 11, height: 11 }} strokeWidth={2} />
                    </span>
                  </MorphTabButton>
                </div>
              )
            })}
          </MorphTabStrip>
          {projectTabs.length === 0 && (
            <div
              draggable
              onDragStart={(e) => {
                const payload = JSON.stringify({
                  type: 'design-project' as const,
                  name: '设计草稿',
                  dirty: isDirty,
                  saveStatus,
                  draggedAt: Date.now(),
                })
                e.dataTransfer.setData('application/x-ready-drag', payload)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className="flex items-center transition-all duration-150 ease-out"
              style={{
                gap: 6,
                padding: '6px 12px',
                fontSize: 12,
                marginBottom: -1,
                background: 'var(--bg-primary)',
                color: 'var(--text-muted)',
                borderRadius: '8px 8px 0 0',
                border: '1px solid var(--border-default)',
                borderBottom: '1px solid var(--bg-primary)',
              }}
            >
              <span
                className="flex-shrink-0 rounded-full"
                style={{ width: 8, height: 8, background: 'var(--color-purple)' }}
              />
              设计草稿
            </div>
          )}

          {/* New draft button */}
          <button
            onClick={() => void handleCreateNewDraft()}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, marginLeft: 2, marginBottom: 3 }}
            title="新建"
          >
            <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={1.8} />
          </button>
        </div>

        {/* Right: icon-only toolbar buttons */}
        <div className="flex items-center gap-1 flex-shrink-0" style={{ paddingRight: 4 }}>
          <button
            onClick={() => emitDesignUIEvent('ready-design-import-images')}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
            title="导入图片"
          >
            <ImagePlus style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          <button
            onClick={() => emitDesignUIEvent('ready-design-toggle-layers')}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
            title="图层"
          >
            <Layers3 style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          <button
            onClick={() => emitDesignUIEvent('ready-design-toggle-variables')}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
            title="变量"
          >
            <SlidersHorizontal style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          <button
            onClick={() => emitDesignUIEvent('ready-design-open-style-guides')}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
            title="设计套件"
          >
            <Palette style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          <button
            onClick={handleOpenAgentPanel}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: chatPanelVisible ? 'var(--color-blue)' : 'var(--text-muted)' }}
            title={chatPanelVisible ? 'Agent 已开' : '连接 Agent'}
          >
            <Bot style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          <button
            onClick={() => emitDesignUIEvent('ready-design-toggle-left-panel')}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
            title="切换左侧面板"
          >
            <PanelLeftClose style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          <button
            onClick={() => emitDesignUIEvent('ready-design-toggle-right-panel')}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
            title="切换右侧面板"
          >
            <PanelRightClose style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          <button
            onClick={handleToggleUiClick}
            className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
            style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
            title={uiHidden ? '显示 UI (Cmd+\\)' : '隐藏 UI (Cmd+\\)'}
          >
            <EyeOff style={{ width: 15, height: 15 }} strokeWidth={1.8} />
          </button>
          {saveStatus !== 'idle' && (
            <span className="text-[10px] pl-1" style={{ color: 'var(--text-light)' }}>
              {saveStatus === 'saving' ? '保存中...' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '保存失败' : isDirty ? '未保存' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Tldraw
          onMount={handleMount}
          autoFocus
          shapeUtils={allShapeUtils}
          tools={allTools}
          components={designComponents}
          hideUi
        />
      </div>
    </div>
  )
}
