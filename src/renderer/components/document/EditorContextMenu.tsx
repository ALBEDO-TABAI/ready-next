import {
  Scissors,
  Copy,
  StickyNote,
} from 'lucide-react'
import ContextMenu, { type ContextMenuItem } from '../layout/ContextMenu'

interface EditorContextMenuProps {
  visible: boolean
  position: { x: number; y: number }
  onClose: () => void
  canQuote?: boolean
  onQuoteToAgent?: () => void
  onPasteToStickyNote?: () => void
}

export default function EditorContextMenu({
  visible,
  position,
  onClose,
  canQuote = false,
  onPasteToStickyNote,
}: EditorContextMenuProps) {
  if (!visible) return null

  const items: ContextMenuItem[] = [
    {
      id: 'cut',
      label: '剪切',
      shortcut: '⌘X',
      icon: <Scissors style={{ width: 16, height: 16 }} />,
      onClick: () => {
        document.execCommand('cut')
      },
    },
    {
      id: 'copy',
      label: '复制',
      shortcut: '⌘C',
      icon: <Copy style={{ width: 16, height: 16 }} />,
      onClick: () => {
        document.execCommand('copy')
      },
    },
    {
      id: 'paste-to-sticky-note',
      label: '贴到便利贴',
      icon: <StickyNote style={{ width: 16, height: 16 }} />,
      disabled: !canQuote,
      onClick: () => {
        void onPasteToStickyNote?.()
      },
    },

  ]

  return (
    <ContextMenu
      items={items}
      x={position.x}
      y={position.y}
      onClose={onClose}
    />
  )
}
