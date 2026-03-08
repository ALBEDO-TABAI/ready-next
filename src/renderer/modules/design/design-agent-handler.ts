import { createShapeId, type Editor } from 'tldraw'
import type { TLEditorSnapshot } from '@tldraw/editor'
import type { MutableRefObject } from 'react'
import type { ModuleAgentActionHandler } from '../../utils/moduleAgentBridge'

function getPathBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
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

export interface DesignAgentHandlerDeps {
  editorRef: MutableRefObject<Editor | null>
  activeFileRef: MutableRefObject<string | null>
  isDirty: boolean
  saveStatus: string
  loadDesignFileIntoEditor: (path: string) => Promise<boolean>
  flushSave: (path?: string) => Promise<boolean>
  exportCurrentDesign: (payload: { format: 'png' | 'svg'; path?: string; defaultName?: string }) => Promise<string>
  markDirty: () => void
  markSaved: () => void
  selectWorkspaceFile: (path: string | null) => void
  setActiveFile: (file: string | null) => void
}

export function createDesignAgentHandler(deps: DesignAgentHandlerDeps): ModuleAgentActionHandler {
  return async ({ action, args }) => {
    if (action === 'design.captureSession') {
      const editor = deps.editorRef.current
      const snapshot = editor ? editor.getSnapshot() : null
      const selectedCount = editor?.getSelectedShapeIds().length || 0
      const activeFile = deps.activeFileRef.current
      return {
        intent: 'capture_design_session',
        ownerResourceId: activeFile,
        summary: activeFile
          ? `设计会话已捕获：${getPathBasename(activeFile)}，${selectedCount > 0 ? `已选中 ${selectedCount} 个元素` : '当前没有选中元素'}。`
          : '设计会话已捕获：当前为未保存画布。',
        snapshotHash: hashDesignSnapshot(snapshot),
        selectedCount,
        saveStatus: deps.saveStatus,
        isDirty: deps.isDirty,
      }
    }

    if (action === 'design.openFile') {
      const path = String(args.path || '').trim()
      if (!path) throw new Error('design.openFile 缺少 path')
      await deps.loadDesignFileIntoEditor(path)
      return {
        intent: 'open_design_file',
        ownerResourceId: path,
        summary: `已打开设计文件：${getPathBasename(path)}。`,
      }
    }

    if (action === 'design.createText') {
      const editor = deps.editorRef.current
      if (!editor) throw new Error('Design editor is not ready')
      const text = String(args.text || '').trim()
      if (!text) throw new Error('design.createText 缺少 text')
      const viewport = editor.getViewportPageBounds()
      const x = Number.isFinite(Number(args.x)) ? Number(args.x) : viewport.x + viewport.w / 2 - 120
      const y = Number.isFinite(Number(args.y)) ? Number(args.y) : viewport.y + viewport.h / 2 - 24
      const id = createShapeId()
      editor.createShape({
        id,
        type: 'text',
        x,
        y,
        props: {
          richText: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          },
        },
      } as never)
      editor.setSelectedShapes([id])
      deps.markDirty()
      return {
        intent: 'create_design_element',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已在画布上插入文本元素：“${text.slice(0, 40)}”。`,
      }
    }

    if (action === 'design.saveProject') {
      const requestedPath = String(args.path || '').trim()
      const editor = deps.editorRef.current
      if (!editor) throw new Error('Design editor is not ready')
      const snapshot = editor.getSnapshot()

      let savedPath = deps.activeFileRef.current
      if (requestedPath) {
        const result = await window.electronAPI?.design?.write(requestedPath, snapshot)
        if (!result?.success) {
          throw new Error(result?.error || '保存设计文件失败')
        }
        savedPath = requestedPath
        deps.selectWorkspaceFile(requestedPath)
        deps.setActiveFile(requestedPath)
        deps.activeFileRef.current = requestedPath
        deps.markSaved()
      } else if (savedPath) {
        const ok = await deps.flushSave(savedPath)
        if (!ok) throw new Error('保存设计文件失败')
      } else {
        const result = await window.electronAPI?.design?.saveAs({ data: snapshot })
        if (!result?.success || !result.path) {
          throw new Error(result?.error || '另存设计文件失败')
        }
        savedPath = result.path
        deps.selectWorkspaceFile(savedPath)
        deps.setActiveFile(savedPath)
        deps.activeFileRef.current = savedPath
        deps.markSaved()
      }

      return {
        intent: 'save_design_project',
        ownerResourceId: savedPath,
        summary: `设计项目已保存到 ${savedPath}.`,
        artifactRefs: savedPath ? [{
          kind: 'design-project',
          label: getPathBasename(savedPath),
          path: savedPath,
          mimeType: 'application/json',
        }] : [],
      }
    }

    if (action === 'design.exportArtifact') {
      const format = String(args.format || 'png').trim().toLowerCase() === 'svg' ? 'svg' : 'png'
      const outputPath = await deps.exportCurrentDesign({
        format,
        path: typeof args.path === 'string' ? args.path : undefined,
        defaultName: typeof args.defaultName === 'string' ? args.defaultName : undefined,
      })
      return {
        intent: 'export_design_artifact',
        ownerResourceId: deps.activeFileRef.current,
        summary: `设计已导出为 ${format.toUpperCase()}：${outputPath}`,
        artifactRefs: [{
          kind: 'design-export',
          label: getPathBasename(outputPath),
          path: outputPath,
          mimeType: format === 'svg' ? 'image/svg+xml' : 'image/png',
        }],
      }
    }

    throw new Error(`Unsupported design agent action: ${action}`)
  }
}
