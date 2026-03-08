import type { ReactNode } from 'react'
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
import { WORKBENCH_ROW_PADDING_X, WORKBENCH_TOOLBAR_ROW_HEIGHT } from '../../modules/workbench/chrome'

interface DesignToolbarProps {
  chatPanelVisible: boolean
  uiHidden: boolean
  isDirty: boolean
  saveStatus: string
  onImportImages: () => void
  onToggleLayers: () => void
  onToggleVariables: () => void
  onOpenStyleGuides: () => void
  onOpenAgentPanel: () => void
  onToggleLeftPanel: () => void
  onToggleRightPanel: () => void
  onToggleUiClick: () => void
}

function toolbarIconButton(
  title: string,
  active: boolean,
  onClick: () => void,
  icon: ReactNode,
) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center transition-all duration-150 ease-out hover:bg-[var(--bg-hover)] active:scale-[0.95] rounded-md"
      style={{
        width: 32,
        height: 32,
        color: active ? 'var(--color-blue)' : 'var(--text-muted)',
        border: `1px solid ${active ? 'rgba(59,130,246,0.22)' : 'transparent'}`,
        background: active ? 'var(--color-blue-light)' : 'transparent',
      }}
      title={title}
    >
      {icon}
    </button>
  )
}

export default function DesignToolbar({
  chatPanelVisible,
  uiHidden,
  isDirty,
  saveStatus,
  onImportImages,
  onToggleLayers,
  onToggleVariables,
  onOpenStyleGuides,
  onOpenAgentPanel,
  onToggleLeftPanel,
  onToggleRightPanel,
  onToggleUiClick,
}: DesignToolbarProps) {
  const saveLabel = saveStatus === 'saving'
    ? '保存中...'
    : saveStatus === 'saved'
      ? '已保存'
      : saveStatus === 'error'
        ? '保存失败'
        : isDirty
          ? '未保存'
          : '空闲'

  return (
    <div
      className="flex items-center justify-between flex-shrink-0"
      style={{
        height: WORKBENCH_TOOLBAR_ROW_HEIGHT,
        padding: `0 ${WORKBENCH_ROW_PADDING_X}px`,
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border-default)',
      }}
    >
      <div className="flex items-center gap-1">
        {toolbarIconButton('导入图片', false, onImportImages, <ImagePlus style={{ width: 16, height: 16 }} strokeWidth={1.8} />)}
        {toolbarIconButton('图层', false, onToggleLayers, <Layers3 style={{ width: 16, height: 16 }} strokeWidth={1.8} />)}
        {toolbarIconButton('变量', false, onToggleVariables, <SlidersHorizontal style={{ width: 16, height: 16 }} strokeWidth={1.8} />)}
        {toolbarIconButton('设计套件', false, onOpenStyleGuides, <Palette style={{ width: 16, height: 16 }} strokeWidth={1.8} />)}
        <div
          style={{
            width: 1,
            height: 20,
            background: 'var(--border-default)',
            margin: '0 8px',
          }}
        />
        {toolbarIconButton(
          chatPanelVisible ? 'Agent 已开' : '连接 Agent',
          chatPanelVisible,
          onOpenAgentPanel,
          <Bot style={{ width: 16, height: 16 }} strokeWidth={1.8} />,
        )}
        {toolbarIconButton('切换左侧面板', false, onToggleLeftPanel, <PanelLeftClose style={{ width: 16, height: 16 }} strokeWidth={1.8} />)}
        {toolbarIconButton('切换右侧面板', false, onToggleRightPanel, <PanelRightClose style={{ width: 16, height: 16 }} strokeWidth={1.8} />)}
        {toolbarIconButton(
          uiHidden ? '显示 UI (Cmd+\\)' : '隐藏 UI (Cmd+\\)',
          uiHidden,
          onToggleUiClick,
          <EyeOff style={{ width: 16, height: 16 }} strokeWidth={1.8} />,
        )}
      </div>

      <div className="flex items-center gap-3 min-w-0">
        <div
          style={{
            fontSize: 11,
            color: saveStatus === 'error' ? 'var(--color-orange)' : 'var(--text-light)',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={saveLabel}
        >
          {saveLabel}
        </div>
      </div>
    </div>
  )
}
