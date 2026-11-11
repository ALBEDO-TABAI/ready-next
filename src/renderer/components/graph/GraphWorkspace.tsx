import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { beginPersistentBrowserMask, endPersistentBrowserMask } from '../../modules/overlay/browserViewMask'
import GraphView from './GraphView'
import { Segmented } from '../ui'
import { useDocTabs } from '../../stores/useDocTabs'

export interface GraphWorkspaceRequest {
  centerPath?: string
  depth?: number
}

interface GraphWorkspaceProps {
  request: GraphWorkspaceRequest
  workspaceRoot: string | null
  onClose: () => void
}

// The one place the relationship graph opens (W2-T6): from the document navigator and ⌘K. It switches
// between the whole library and the document in front, which the old sidebar graph panel offered.
export default function GraphWorkspace({ request, workspaceRoot, onClose }: GraphWorkspaceProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const activePath = useDocTabs(state => state.tabs.find(tab => tab.id === state.activeTabId)?.path ?? null)
  const [focus, setFocus] = useState<'workspace' | 'active'>(request.centerPath ? 'active' : 'workspace')
  const centerPath = focus === 'active' ? (request.centerPath ?? activePath ?? undefined) : undefined
  const depth = focus === 'active' ? (request.depth ?? 2) : undefined
  const focusOptions = useMemo(() => [
    { value: 'workspace' as const, label: '全工作区' },
    ...(request.centerPath || activePath ? [{ value: 'active' as const, label: '当前文档' }] : []),
  ], [activePath, request.centerPath])

  useEffect(() => {
    beginPersistentBrowserMask()
    return () => { void endPersistentBrowserMask() }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const element = canvasRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          width: Math.max(320, Math.floor(entry.contentRect.width)),
          height: Math.max(260, Math.floor(entry.contentRect.height)),
        })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="knowledge-graph-workspace" data-knowledge-graph-workspace="true">
      <section
        className="knowledge-graph-workspace__panel ready-app-liquid-panel"
        role="dialog"
        aria-modal="true"
        aria-label="全局浏览关系图谱"
      >
        <header className="knowledge-graph-workspace__header">
          <div>
            <span>全局浏览</span>
            <h2>关系图谱</h2>
          </div>
          <div className="knowledge-graph-workspace__header-actions">
            <Segmented label="图谱范围" value={focus} onChange={setFocus} options={focusOptions} />
            <button type="button" onClick={onClose} aria-label="关闭全局浏览">
              <X size={18} />
            </button>
          </div>
        </header>

        <div ref={canvasRef} className="knowledge-graph-workspace__canvas">
          {workspaceRoot ? (
            <GraphView
              workspaceRoot={workspaceRoot}
              centerPath={centerPath}
              depth={depth}
              width={size.width}
              height={size.height}
              viewId="workspace"
              onDocumentOpen={onClose}
            />
          ) : (
            <div className="knowledge-graph-workspace__empty">请先选择工作区根目录</div>
          )}
        </div>

        <footer className="knowledge-graph-workspace__footer">
          <span>双指移动</span>
          <span>捏合缩放</span>
          <span>悬浮预览</span>
          <span>点击打开文档</span>
        </footer>
      </section>
    </div>
  )
}
