import {
  MousePointer2,
  Square,
  Image,
  Type,
  Music2,
  Undo2,
  Redo2,
  Share2,
} from 'lucide-react'

interface EditorToolbarProps {
  title: string
  activeTool: string
  onToolChange: (tool: string) => void
  onImportMedia: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onExport: () => void
  exportState: 'idle' | 'exporting' | 'done' | 'error'
  exportMessage: string
}

export default function EditorToolbar({
  title,
  activeTool,
  onToolChange,
  onImportMedia,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onExport,
  exportState,
  exportMessage,
}: EditorToolbarProps) {
  const colors = {
    panelBg: 'var(--bg-primary)',
    panelBorder: 'var(--border-default)',
    activeBorder: 'var(--color-blue)',
    activeBg: 'var(--color-blue-light)',
    activeText: 'var(--color-blue)',
    icon: 'var(--text-muted)',
    divider: 'var(--border-default)',
    buttonBorder: 'var(--border-input)',
    buttonBg: 'var(--bg-primary)',
    buttonText: 'var(--text-body)',
    title: 'var(--text-title)',
    success: 'var(--color-green)',
    error: 'var(--color-red)',
  }

  const toolItems = [
    { id: 'select', label: 'Select', icon: MousePointer2 },
    { id: 'shape', label: 'Shape', icon: Square },
    { id: 'media', label: 'Media', icon: Image },
    { id: 'text', label: 'Text', icon: Type },
    { id: 'audio', label: 'Audio', icon: Music2 },
  ] as const

  return (
    <div
      className="flex items-center justify-between"
      style={{
        height: 46,
        flexShrink: 0,
        padding: '0 12px',
        background: colors.panelBg,
        borderBottom: `1px solid ${colors.panelBorder}`,
      }}
    >
      <div className="flex items-center gap-1">
        {toolItems.map((tool) => {
          const Icon = tool.icon
          const isActive = activeTool === tool.id
          return (
            <button
              key={tool.id}
              onClick={() => {
                onToolChange(tool.id)
                if (tool.id === 'media') onImportMedia()
              }}
              title={tool.label}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: `1px solid ${isActive ? colors.activeBorder : 'transparent'}`,
                background: isActive ? colors.activeBg : 'transparent',
                color: isActive ? colors.activeText : colors.icon,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 140ms ease',
              }}
            >
              <Icon size={16} />
            </button>
          )
        })}

        <div
          style={{
            width: 1,
            height: 20,
            background: colors.divider,
            margin: '0 8px',
          }}
        />

        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Cmd+Z)"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            border: '1px solid transparent',
            background: 'transparent',
            color: colors.icon,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: canUndo ? 1 : 0.35,
            cursor: canUndo ? 'pointer' : 'not-allowed',
          }}
        >
          <Undo2 size={16} />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Cmd+Shift+Z)"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            border: '1px solid transparent',
            background: 'transparent',
            color: colors.icon,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: canRedo ? 1 : 0.35,
            cursor: canRedo ? 'pointer' : 'not-allowed',
          }}
        >
          <Redo2 size={16} />
        </button>

        <button
          onClick={onExport}
          disabled={exportState === 'exporting'}
          title="Export"
          style={{
            height: 32,
            borderRadius: 8,
            border: `1px solid ${colors.buttonBorder}`,
            background: colors.buttonBg,
            color: colors.buttonText,
            padding: '0 10px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: exportState === 'exporting' ? 'not-allowed' : 'pointer',
            opacity: exportState === 'exporting' ? 0.6 : 1,
          }}
        >
          <Share2 size={14} />
          {exportState === 'exporting' ? 'Exporting' : 'Export'}
        </button>
      </div>

      <div className="flex items-center gap-3 min-w-0">
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: colors.title,
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={title}
        >
          {title}
        </div>
        {exportState !== 'idle' && exportState !== 'exporting' ? (
          <span
            style={{
              fontSize: 11,
              color: exportState === 'done' ? colors.success : colors.error,
              maxWidth: 240,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={exportMessage}
          >
            {exportMessage}
          </span>
        ) : null}
      </div>
    </div>
  )
}
