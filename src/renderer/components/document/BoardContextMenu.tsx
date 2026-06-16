import { ClipboardPaste, Copy, MessageSquareQuote } from 'lucide-react'
import ContextMenu, { type ContextMenuItem } from '../layout/ContextMenu'

interface BoardContextMenuProps {
  visible: boolean
  position: { x: number; y: number }
  canCopy: boolean
  canReference: boolean
  onCopy: () => void
  onPaste: () => void
  onReferenceToAgent: () => void
  onClose: () => void
}

export default function BoardContextMenu({
  visible,
  position,
  canCopy,
  canReference,
  onCopy,
  onPaste,
  onReferenceToAgent,
  onClose,
}: BoardContextMenuProps) {
  if (!visible) return null

  const items: ContextMenuItem[] = [
    {
      id: 'copy',
      label: '复制',
      shortcut: '⌘C',
      icon: <Copy style={{ width: 16, height: 16 }} />,
      disabled: !canCopy,
      onClick: onCopy,
    },
    {
      id: 'reference-to-agent',
      label: '引用到输入框',
      icon: <MessageSquareQuote style={{ width: 16, height: 16 }} />,
      disabled: !canReference,
      onClick: onReferenceToAgent,
    },
    { id: 'div1', label: '', separator: true },
    {
      id: 'paste',
      label: '粘贴',
      shortcut: '⌘V',
      icon: <ClipboardPaste style={{ width: 16, height: 16 }} />,
      onClick: onPaste,
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
