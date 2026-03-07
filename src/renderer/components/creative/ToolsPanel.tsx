import {
  MousePointer, Type, Square, Image, Music, Subtitles, Mic, Sparkles
} from 'lucide-react'

interface ToolsPanelProps {
  activeTool: string
  onToolChange: (tool: string) => void
}

const tools = [
  { id: 'select', icon: MousePointer, label: 'Select' },
  { id: 'text', icon: Type, label: 'Text' },
  { id: 'shape', icon: Square, label: 'Shape' },
  { id: 'image', icon: Image, label: 'Image' },
  { id: 'audio', icon: Music, label: 'Audio' },
  { id: 'subtitle', icon: Subtitles, label: 'Subtitle' },
  { id: 'voiceover', icon: Mic, label: 'Voiceover' },
]

export default function ToolsPanel({ activeTool, onToolChange }: ToolsPanelProps) {
  return (
    <div
      className="flex flex-col items-center gap-1"
      style={{
        width: 48,
        flexShrink: 0,
        padding: '12px 0',
        background: '#FAFAF9',
        borderRight: '1px solid #E8E8E8'
      }}
    >
      {tools.map((tool) => (
        <button
          key={tool.id}
          onClick={() => onToolChange(tool.id)}
          title={tool.label}
          className={`
            w-9 h-9 rounded-lg flex items-center justify-center
            transition-all duration-200
            ${activeTool === tool.id
              ? 'bg-[#EBE8E1] text-[#333333]'
              : 'text-[#888888] hover:bg-black/5'
            }
          `}
        >
          <tool.icon className="w-4 h-4" strokeWidth={2} />
        </button>
      ))}

      <div className="w-6 h-px bg-[var(--border-default)] my-1" />

      <button className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--color-blue)] hover:bg-[var(--color-blue-light)] transition-all">
        <Sparkles className="w-4 h-4" strokeWidth={2} />
      </button>
    </div>
  )
}
