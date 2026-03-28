import type { Editor } from '@tiptap/react'
import {
  Scissors,
  Copy,
  ClipboardPaste,
  Trash2,
  MousePointer2,
  Undo2,
  Redo2,
  MessageSquareQuote,
} from 'lucide-react'
import ContextMenu, { type ContextMenuItem } from '../layout/ContextMenu'

interface EditorContextMenuProps {
  editor: Editor | null
  visible: boolean
  position: { x: number; y: number }
  onClose: () => void
  canQuote?: boolean
  onQuoteToAgent?: () => void
}

export default function EditorContextMenu({
  editor,
  visible,
  position,
  onClose,
  canQuote = false,
  onQuoteToAgent,
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
      id: 'quote-to-agent',
      label: '引用到输入框',
      icon: <MessageSquareQuote style={{ width: 16, height: 16 }} />,
      disabled: !canQuote,
      onClick: () => {
        onQuoteToAgent?.()
      },
    },
    {
      id: 'paste',
      label: '粘贴',
      shortcut: '⌘V',
      icon: <ClipboardPaste style={{ width: 16, height: 16 }} />,
      disabled: !editor,
      onClick: async () => {
        if (!editor) return
        try {
          const text = await navigator.clipboard.readText()
          editor.chain().focus().insertContent(text).run()
        } catch {
          // Clipboard access may be denied
        }
      },
    },
    { id: 'div1', label: '', separator: true },
    {
      id: 'delete',
      label: '删除',
      shortcut: '⌫',
      danger: true,
      icon: <Trash2 style={{ width: 16, height: 16 }} />,
      disabled: !editor,
      onClick: () => {
        editor?.chain().focus().deleteSelection().run()
      },
    },
    { id: 'div2', label: '', separator: true },
    {
      id: 'selectAll',
      label: '全选',
      shortcut: '⌘A',
      icon: <MousePointer2 style={{ width: 16, height: 16 }} />,
      disabled: !editor,
      onClick: () => {
        editor?.chain().focus().selectAll().run()
      },
    },
    {
      id: 'undo',
      label: '撤销',
      shortcut: '⌘Z',
      icon: <Undo2 style={{ width: 16, height: 16 }} />,
      disabled: !editor,
      onClick: () => {
        editor?.chain().focus().undo().run()
      },
    },
    {
      id: 'redo',
      label: '重做',
      shortcut: '⌘⇧Z',
      icon: <Redo2 style={{ width: 16, height: 16 }} />,
      disabled: !editor,
      onClick: () => {
        editor?.chain().focus().redo().run()
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
