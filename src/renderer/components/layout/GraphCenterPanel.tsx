import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs } from '../../stores/useDocTabs'
import GraphView from '../graph/GraphView'
import type { GraphWorkspaceRequest } from '../graph/GraphWorkspace'
import { PANEL_TOKENS, SKILLS_PANEL_DIMENSIONS } from './panelTokens'

export interface SidePanelSlots {
  header: ReactNode
  body: ReactNode
}

export interface GraphCenterPanelProps {
  children?: (slots: SidePanelSlots) => ReactNode
  onOpenGlobal?: (request: GraphWorkspaceRequest) => void
  globalBrowseOpen?: boolean
}

type FocusMode = 'workspace' | 'active'

export default function GraphCenterPanel({ children, onOpenGlobal, globalBrowseOpen = false }: GraphCenterPanelProps) {
  const workspaceRoot = useWorkspace((s) => s.workspaceRoot)
  const activeTabId = useDocTabs((s) => s.activeTabId)
  const tabs = useDocTabs((s) => s.tabs)
  const activePath = useMemo(() => {
    const active = tabs.find((t) => t.id === activeTabId)
    return active?.path ?? null
  }, [tabs, activeTabId])

  const [focus, setFocus] = useState<FocusMode>('workspace')
  useEffect(() => {
    if (!activePath && focus === 'active') setFocus('workspace')
  }, [activePath, focus])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 320, height: 360 })
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setSize({ width: Math.max(120, Math.floor(width)), height: Math.max(200, Math.floor(height)) })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const header = (
    <div
      className="shrink-0 border-b flex items-center justify-between"
      style={{
        borderColor: 'transparent',
        height: SKILLS_PANEL_DIMENSIONS.headerHeight,
        padding: '0 7px',
        boxSizing: 'border-box',
        background: 'transparent',
      }}
    >
      <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold" style={{ color: PANEL_TOKENS.title }}>
        关系图谱
      </span>
      <div className="flex shrink-0 items-center gap-px">
        <button
          type="button"
          onClick={() => setFocus('workspace')}
          className="shrink-0 whitespace-nowrap rounded-[6px] px-[4px] py-[2px] text-[9px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            color: focus === 'workspace' ? PANEL_TOKENS.text : PANEL_TOKENS.muted,
            background: focus === 'workspace' ? 'var(--bg-hover)' : 'transparent',
          }}
        >
          全景
        </button>
        <button
          type="button"
          onClick={() => activePath && setFocus('active')}
          disabled={!activePath}
          className="shrink-0 whitespace-nowrap rounded-[6px] px-[4px] py-[2px] text-[9px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            color: focus === 'active' ? PANEL_TOKENS.text : PANEL_TOKENS.muted,
            background: focus === 'active' ? 'var(--bg-hover)' : 'transparent',
          }}
          title={activePath ? '围绕当前文档展开' : '先在编辑器中打开一个文档'}
        >
          聚焦当前
        </button>
        <button
          type="button"
          onClick={() => onOpenGlobal?.({
            centerPath: focus === 'active' && activePath ? activePath : undefined,
            depth: focus === 'active' ? 2 : undefined,
          })}
          disabled={!workspaceRoot || !onOpenGlobal}
          className="shrink-0 whitespace-nowrap rounded-[6px] px-[4px] py-[2px] text-[9px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ color: PANEL_TOKENS.muted, background: 'transparent' }}
          title="在中央工作区打开大图谱"
        >
          全局浏览
        </button>
      </div>
    </div>
  )

  const body = (
    <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" style={{ position: 'relative' }}>
      {workspaceRoot && globalBrowseOpen ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-[11px]" style={{ color: PANEL_TOKENS.placeholder }}>
          已在中央工作区打开
        </div>
      ) : workspaceRoot ? (
        <GraphView
          workspaceRoot={workspaceRoot}
          centerPath={focus === 'active' && activePath ? activePath : undefined}
          depth={focus === 'active' ? 2 : undefined}
          width={size.width}
          height={size.height}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center text-[11px]" style={{ color: PANEL_TOKENS.placeholder }}>
          请先选择工作区根目录
        </div>
      )}
    </div>
  )

  if (children) return <>{children({ header, body })}</>
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {header}
      {body}
    </div>
  )
}
