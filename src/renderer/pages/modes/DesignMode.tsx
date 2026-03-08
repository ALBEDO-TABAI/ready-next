import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssetRecordType, Tldraw, createShapeId, type Editor, type TLComponents } from 'tldraw'
import type { TLEditorSnapshot } from '@tldraw/editor'
import 'tldraw/tldraw.css'
import { useTheme } from '../../stores/useTheme'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDesignSession } from '../../stores/useDesignSession'
import { useDesignAgentAdapter } from '../../modules/design/useDesignAgentAdapter'
import ComponentPanel from '../../components/design/ComponentPanel'
import DesignDiagnosticsPanel from '../../components/design/DesignDiagnosticsPanel'
import DesignProjectTabsBar from '../../components/design/DesignProjectTabsBar'
import DesignToolbar from '../../components/design/DesignToolbar'
import { allShapeUtils, allTools } from '../../components/design/shapes'
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

function hashDesignSnapshot(snapshot: TLEditorSnapshot | null): string | null {
  if (!snapshot) return null
  const raw = JSON.stringify(snapshot)
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i)
    hash |= 0
  }
  return `tldr-${Math.abs(hash).toString(36)}`
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
  const setSnapshotMeta = useDesignSession((state) => state.setSnapshotMeta)
  const setLastExportArtifactPath = useDesignSession((state) => state.setLastExportArtifactPath)
  const isDirty = useDesignSession((state) => state.isDirty)
  const saveStatus = useDesignSession((state) => state.saveStatus)
  const lastSavedAt = useDesignSession((state) => state.lastSavedAt)
  const lastError = useDesignSession((state) => state.lastError)
  const snapshotHash = useDesignSession((state) => state.snapshotHash)
  const selectionSummary = useDesignSession((state) => state.selectionSummary)
  const currentToolContext = useDesignSession((state) => state.currentToolContext)
  const lastExportArtifactPath = useDesignSession((state) => state.lastExportArtifactPath)
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

  const loadDesignFileIntoEditor = useCallback(async (path: string) => {
    const editor = editorRef.current
    if (!editor || !isDesignFile(path)) return false

    activeFileRef.current = path
    setActiveFile(path)
    selectWorkspaceFile(path)

    const cached = fileSnapshotCache.get(path)
    if (cached) {
      applySnapshot(editor, cached)
      return true
    }

    if (typeof window === 'undefined' || !window.electronAPI?.design) {
      applySnapshot(editor, baseSnapshot)
      return true
    }

    const readResult = await window.electronAPI.design.read(path)
    if (readResult.success && readResult.data) {
      const snapshot = readResult.data as TLEditorSnapshot
      fileSnapshotCache.set(path, snapshot)
      applySnapshot(editor, snapshot)
      return true
    }

    applySnapshot(editor, baseSnapshot)
    return false
  }, [applySnapshot, isDesignFile, selectWorkspaceFile, setActiveFile])

  const exportCurrentDesign = useCallback(async (payload: {
    format: 'png' | 'svg'
    path?: string
    defaultName?: string
  }) => {
    const editor = editorRef.current
    if (!editor) {
      throw new Error('Design editor is not ready')
    }
    const selected = editor.getSelectedShapeIds() as never[]
    const all = Array.from(editor.getCurrentPageShapeIds()) as never[]
    const targetIds = selected.length > 0 ? selected : all
    if (targetIds.length === 0) {
      throw new Error('当前画布没有可导出的元素')
    }

    const fallbackName = payload.defaultName || `${getPathBasename(activeFileRef.current || 'design')}.${payload.format}`
    const exportResult = payload.format === 'svg'
      ? await (async () => {
        const svgResult = await editor.getSvgString(targetIds, { background: false })
        if (!svgResult) throw new Error('无法生成 SVG 导出结果')
        return window.electronAPI?.design?.export({
          format: 'svg',
          data: svgResult.svg,
          path: payload.path,
          defaultName: fallbackName,
        })
      })()
      : await (async () => {
        const imageResult = await editor.toImageDataUrl(targetIds, {
          format: 'png',
          background: true,
          scale: 1,
        })
        return window.electronAPI?.design?.export({
          format: 'png',
          data: imageResult.url,
          path: payload.path,
          defaultName: fallbackName,
        })
      })()

    if (!exportResult?.success || !exportResult.path) {
      throw new Error(exportResult?.error || '导出失败')
    }
    setLastExportArtifactPath(exportResult.path)
    return exportResult.path
  }, [setLastExportArtifactPath])

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

  useDesignAgentAdapter({
    editorRef,
    activeFileRef,
    isDirty,
    saveStatus,
    loadDesignFileIntoEditor,
    flushSave,
    exportCurrentDesign,
    markDirty,
    markSaved,
    selectWorkspaceFile,
    setActiveFile,
  })

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
      const snapshot = editor.getSnapshot()
      const selectedCount = editor.getSelectedShapeIds().length
      setSnapshotMeta({
        snapshotHash: hashDesignSnapshot(snapshot),
        selectionSummary: selectedCount > 0 ? `已选中 ${selectedCount} 个元素` : '未选中元素',
        currentToolContext: String((editor as Editor & { getCurrentToolId?: () => string }).getCurrentToolId?.() || 'select'),
      })
      if (restoringRef.current) return
      const activeFile = activeFileRef.current
      if (!activeFile || !isDesignFile(activeFile)) {
        transientSnapshot = snapshot
        return
      }
      markDirty()
      schedulePersist()
    }, { source: 'user', scope: 'document' })
  }, [resolvedTheme, applySnapshot, isDesignFile, markDirty, schedulePersist, setActiveFile, setSnapshotMeta])

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
      <DesignProjectTabsBar
        projectTabs={projectTabs}
        activeDesignPath={activeDesignPath}
        isDirty={isDirty}
        getPathBasename={getPathBasename}
        onSelectProjectTab={handleSelectProjectTab}
        onCloseProjectTab={handleCloseProjectTab}
        onProjectTabDragStart={handleProjectTabDragStart}
        onCreateNewDraft={handleCreateNewDraft}
      />

      <DesignToolbar
        chatPanelVisible={chatPanelVisible}
        uiHidden={uiHidden}
        isDirty={isDirty}
        saveStatus={saveStatus}
        onImportImages={() => emitDesignUIEvent('ready-design-import-images')}
        onToggleLayers={() => emitDesignUIEvent('ready-design-toggle-layers')}
        onToggleVariables={() => emitDesignUIEvent('ready-design-toggle-variables')}
        onOpenStyleGuides={() => emitDesignUIEvent('ready-design-open-style-guides')}
        onOpenAgentPanel={handleOpenAgentPanel}
        onToggleLeftPanel={() => emitDesignUIEvent('ready-design-toggle-left-panel')}
        onToggleRightPanel={() => emitDesignUIEvent('ready-design-toggle-right-panel')}
        onToggleUiClick={handleToggleUiClick}
      />

      <DesignDiagnosticsPanel
        activeFile={activeDesignPath}
        isDirty={isDirty}
        saveStatus={saveStatus}
        lastSavedAt={lastSavedAt}
        lastError={lastError}
        snapshotHash={snapshotHash}
        selectionSummary={selectionSummary}
        currentToolContext={currentToolContext}
        lastExportArtifactPath={lastExportArtifactPath}
      />

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
