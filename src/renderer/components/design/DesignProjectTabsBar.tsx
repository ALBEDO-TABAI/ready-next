import type { DragEvent } from 'react'
import {
  Bot,
  EyeOff,
  ImagePlus,
  Layers3,
  Palette,
  PanelLeftClose,
  PanelRightClose,
  SlidersHorizontal,
} from 'lucide-react'
import WorkbenchProjectTabs from '../workbench/WorkbenchProjectTabs'

interface DesignProjectTabsBarProps {
  projectTabs: string[]
  activeDesignPath: string | null
  isDirty: boolean
  saveStatus: string
  chatPanelVisible: boolean
  uiHidden: boolean
  getPathBasename: (path: string) => string
  onSelectProjectTab: (path: string) => void
  onCloseProjectTab: (path: string) => void
  onProjectTabDragStart: (e: DragEvent, path: string) => void
  onCreateNewDraft: () => void | Promise<void>
  onOpenAgentPanel: () => void
  onToggleUiClick: () => void
  emitDesignUIEvent: (eventName: string) => void
}

export default function DesignProjectTabsBar({
  projectTabs,
  activeDesignPath,
  isDirty,
  saveStatus,
  chatPanelVisible,
  uiHidden,
  getPathBasename,
  onSelectProjectTab,
  onCloseProjectTab,
  onProjectTabDragStart,
  onCreateNewDraft,
  onOpenAgentPanel,
  onToggleUiClick,
  emitDesignUIEvent,
}: DesignProjectTabsBarProps) {
  const tabs = projectTabs.length > 0
    ? projectTabs.map((path) => ({
        id: path,
        label: getPathBasename(path),
        title: path,
        dotColor: 'var(--color-purple)',
        active: activeDesignPath === path,
        dirty: activeDesignPath === path && isDirty,
      }))
    : [{
        id: '__design-draft__',
        label: '设计草稿',
        title: '设计草稿',
        dotColor: 'var(--color-purple)',
        active: true,
        dirty: isDirty,
      }]

  return (
    <WorkbenchProjectTabs
      layoutId="design-tabs"
      tabs={tabs}
      onTabClick={(id) => {
        if (id === '__design-draft__') return
        onSelectProjectTab(id)
      }}
      onTabClose={projectTabs.length > 0 ? (id) => onCloseProjectTab(id) : undefined}
      onNewTab={onCreateNewDraft}
      onTabDragStart={(event, id) => {
        if (id === '__design-draft__') {
          const payload = JSON.stringify({
            type: 'design-project' as const,
            name: '设计草稿',
            dirty: isDirty,
            saveStatus,
            draggedAt: Date.now(),
          })
          event.dataTransfer.setData('application/x-ready-drag', payload)
          event.dataTransfer.effectAllowed = 'copy'
          return
        }
        onProjectTabDragStart(event as DragEvent, id)
      }}
      rightActions={<div className="flex items-center gap-1 flex-shrink-0" style={{ paddingRight: 4 }}>
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
          onClick={onOpenAgentPanel}
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
          onClick={onToggleUiClick}
          className="flex items-center justify-center hover:bg-[var(--bg-hover)] active:scale-[0.95] transition-all duration-150 ease-out rounded-md"
          style={{ width: 28, height: 28, color: 'var(--text-muted)' }}
          title={uiHidden ? '显示 UI (Cmd+\\)' : '隐藏 UI (Cmd+\\)'}
        >
          <EyeOff style={{ width: 15, height: 15 }} strokeWidth={1.8} />
        </button>
        {saveStatus !== 'idle' ? (
          <span className="text-[10px] pl-1" style={{ color: 'var(--text-light)' }}>
            {saveStatus === 'saving' ? '保存中...' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '保存失败' : isDirty ? '未保存' : ''}
          </span>
        ) : null}
      </div>}
    />
  )
}
