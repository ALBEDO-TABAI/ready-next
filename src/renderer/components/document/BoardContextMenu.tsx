import { BringToFront, ClipboardPaste, Copy, SendToBack } from 'lucide-react'
import ContextMenu, { type ContextMenuItem } from '../layout/ContextMenu'

interface BoardContextMenuProps {
  visible: boolean
  position: { x: number; y: number }
  canCopy: boolean
  canReference: boolean
  canArrange: boolean
  onCopy: () => void
  onPaste: () => void
  onReferenceToAgent: () => void
  onBringToFront: () => void
  onSendToBack: () => void
  onClose: () => void
}

export default function BoardContextMenu({
  visible,
  position,
  canCopy,
  canArrange,
  onCopy,
  onPaste,
  onBringToFront,
  onSendToBack,
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
    { id: 'div1', label: '', separator: true },
    {
      id: 'bring-to-front',
      label: '置于最上方',
      icon: <BringToFront style={{ width: 16, height: 16 }} />,
      disabled: !canArrange,
      onClick: onBringToFront,
    },
    {
      id: 'send-to-back',
      label: '置于最下方',
      icon: <SendToBack style={{ width: 16, height: 16 }} />,
      disabled: !canArrange,
      onClick: onSendToBack,
    },
    { id: 'div2', label: '', separator: true },
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
