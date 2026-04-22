import { useMemo, type ReactNode } from 'react'
import { useDocTabs } from '../../stores/useDocTabs'
import BacklinksPanel from '../document/BacklinksPanel'
import { PANEL_TOKENS, SKILLS_PANEL_DIMENSIONS } from './panelTokens'

export interface SidePanelSlots {
  header: ReactNode
  body: ReactNode
}

interface BacklinksCenterPanelProps {
  children?: (slots: SidePanelSlots) => ReactNode
}

export default function BacklinksCenterPanel({ children }: BacklinksCenterPanelProps) {
  const activeTabId = useDocTabs((s) => s.activeTabId)
  const tabs = useDocTabs((s) => s.tabs)
  const activePath = useMemo(() => {
    const active = tabs.find((t) => t.id === activeTabId)
    return active?.path ?? null
  }, [tabs, activeTabId])

  const header = (
    <div
      className="shrink-0 border-b flex items-center"
      style={{
        borderColor: 'transparent',
        height: SKILLS_PANEL_DIMENSIONS.headerHeight,
        padding: `0 ${SKILLS_PANEL_DIMENSIONS.sectionPaddingX}px`,
        boxSizing: 'border-box',
        background: 'transparent',
      }}
    >
      <span className="text-[13px] font-semibold" style={{ color: PANEL_TOKENS.title }}>
        反向链接
      </span>
    </div>
  )

  const body = (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="panel-hover-scrollbar h-full min-h-0 overflow-auto">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
          {!activePath ? (
            <p className="text-[11px] font-medium" style={{ color: PANEL_TOKENS.mutedStrong }}>
              先在编辑器中打开一个文档，这里会显示指向该文档的反向链接。
            </p>
          ) : (
            <>
              <p className="shrink-0 text-[12px] font-semibold" style={{ color: PANEL_TOKENS.sectionTitle }}>
                当前文档
              </p>
              <p className="truncate text-[11px]" style={{ color: PANEL_TOKENS.muted }} title={activePath}>
                {activePath.split(/[\\/]/).pop() ?? activePath}
              </p>
              <BacklinksPanel path={activePath} />
              <p className="text-[11px]" style={{ color: PANEL_TOKENS.placeholder }}>
                若没有结果出现，说明当前索引里没有 Markdown 文件通过 `[[wikilink]]` 指向此文档。
              </p>
            </>
          )}
        </div>
      </div>
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
