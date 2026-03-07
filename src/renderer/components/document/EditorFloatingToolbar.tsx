import { useState, useRef, useEffect, useCallback, type CSSProperties, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  IndentIncrease,
  IndentDecrease,
  Link as LinkIcon,
  Grid2x2,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Check,
  ListOrdered,
  List,
  CheckSquare,
  Copy
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EditorFloatingToolbarProps {
  editor: Editor | null
  visible: boolean
  position: { x: number; y: number }
}

type DropdownKind = 'textType' | 'align' | 'color' | 'link' | null

// ---------------------------------------------------------------------------
// Shared constants & tiny helpers
// ---------------------------------------------------------------------------

const DROPDOWN_GAP = 4 // px between toolbar bottom and dropdown top

const dropdownContainerStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  background: 'var(--surface-floating-bg)',
  border: '1px solid var(--surface-border)',
  borderRadius: 10,
  boxShadow: 'var(--surface-shadow)',
  padding: '6px 0',
  zIndex: 1000
}

const menuItemBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 36,
  padding: '8px 14px',
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'Inter, system-ui, sans-serif',
  color: 'var(--text-body)',
  border: 'none',
  background: 'transparent',
  width: '100%',
  textAlign: 'left',
  boxSizing: 'border-box'
}

const dividerStyle: CSSProperties = {
  height: 1,
  background: 'var(--border-default)',
  margin: '4px 0'
}

function ToolbarSeparator(): ReactNode {
  return (
    <div
      style={{
        width: 1,
        height: 18,
        background: 'var(--border-default)',
        flexShrink: 0
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// MenuItem – reusable dropdown row
// ---------------------------------------------------------------------------

interface MenuItemProps {
  icon?: ReactNode
  label: string
  active?: boolean
  hasSubmenu?: boolean
  onClick?: () => void
}

function MenuItem({ icon, label, active, hasSubmenu, onClick }: MenuItemProps): ReactNode {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      style={{
        ...menuItemBase,
        background: hovered ? 'var(--bg-hover)' : 'transparent',
        color: active ? 'var(--color-blue)' : 'var(--text-body)'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <span style={{ width: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {active && <Check size={14} color="var(--color-blue)" />}
      {hasSubmenu && <ChevronRight size={14} color="var(--text-light)" />}
    </button>
  )
}

// ---------------------------------------------------------------------------
// TextTypeDropdown
// ---------------------------------------------------------------------------

interface TextTypeDropdownProps {
  editor: Editor
  onClose: () => void
}

function TextTypeDropdown({ editor, onClose }: TextTypeDropdownProps): ReactNode {
  const isParagraph = editor.isActive('paragraph')
  const isH1 = editor.isActive('heading', { level: 1 })
  const isH2 = editor.isActive('heading', { level: 2 })
  const isH3 = editor.isActive('heading', { level: 3 })
  const isOrderedList = editor.isActive('orderedList')
  const isBulletList = editor.isActive('bulletList')
  const isTaskList = editor.isActive('taskList')
  const isCodeBlock = editor.isActive('codeBlock')
  const isBlockquote = editor.isActive('blockquote')

  const run = (fn: () => void) => {
    fn()
    onClose()
  }

  return (
    <div style={{ ...dropdownContainerStyle, width: 200 }}>
      <MenuItem
        icon={<span style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 14 }}>T</span>}
        label="正文"
        active={isParagraph}
        onClick={() => run(() => editor.chain().focus().setParagraph().run())}
      />
      <MenuItem
        icon={<span style={{ fontFamily: 'Inter', fontWeight: 700, fontSize: 14 }}>H1</span>}
        label="一级标题"
        active={isH1}
        onClick={() => run(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}
      />
      <MenuItem
        icon={<span style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 14 }}>H2</span>}
        label="二级标题"
        active={isH2}
        onClick={() => run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
      />
      <MenuItem
        icon={<span style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 13 }}>H3</span>}
        label="三级标题"
        active={isH3}
        onClick={() => run(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
      />
      <MenuItem
        icon={<span style={{ fontFamily: 'Inter', fontWeight: 500, fontSize: 13 }}>Hn</span>}
        label="其他标题"
        hasSubmenu
        onClick={() => {
          /* submenu placeholder */
        }}
      />

      <div style={dividerStyle} />

      <MenuItem
        icon={<ListOrdered size={16} />}
        label="有序列表"
        active={isOrderedList}
        onClick={() => run(() => editor.chain().focus().toggleOrderedList().run())}
      />
      <MenuItem
        icon={<List size={16} />}
        label="无序列表"
        active={isBulletList}
        onClick={() => run(() => editor.chain().focus().toggleBulletList().run())}
      />
      <MenuItem
        icon={<CheckSquare size={16} />}
        label="任务"
        active={isTaskList}
        onClick={() => run(() => editor.chain().focus().toggleTaskList().run())}
      />
      <MenuItem
        icon={<span style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 13 }}>{'{ }'}</span>}
        label="代码块"
        active={isCodeBlock}
        onClick={() => run(() => editor.chain().focus().toggleCodeBlock().run())}
      />

      <div style={dividerStyle} />

      <MenuItem
        icon={<span style={{ fontSize: 16 }}>{'\u275D'}</span>}
        label="引用"
        active={isBlockquote}
        onClick={() => run(() => editor.chain().focus().toggleBlockquote().run())}
      />
      <MenuItem
        icon={<MessageSquare size={16} />}
        label="高亮块"
        onClick={() => run(() => editor.chain().focus().toggleHighlight().run())}
      />
      <MenuItem
        icon={<Copy size={16} />}
        label="同步块"
        onClick={() => {
          alert('同步块功能即将上线')
          onClose()
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// AlignDropdown
// ---------------------------------------------------------------------------

interface AlignDropdownProps {
  editor: Editor
  onClose: () => void
}

function AlignDropdown({ editor, onClose }: AlignDropdownProps): ReactNode {
  const isLeft = editor.isActive({ textAlign: 'left' })
  const isCenter = editor.isActive({ textAlign: 'center' })
  const isRight = editor.isActive({ textAlign: 'right' })

  const run = (fn: () => void) => {
    fn()
    onClose()
  }

  return (
    <div style={{ ...dropdownContainerStyle, width: 180 }}>
      <MenuItem
        icon={<AlignLeft size={16} />}
        label="左对齐"
        active={isLeft}
        onClick={() => run(() => editor.chain().focus().setTextAlign('left').run())}
      />
      <MenuItem
        icon={<AlignCenter size={16} />}
        label="居中对齐"
        active={isCenter}
        onClick={() => run(() => editor.chain().focus().setTextAlign('center').run())}
      />
      <MenuItem
        icon={<AlignRight size={16} />}
        label="右对齐"
        active={isRight}
        onClick={() => run(() => editor.chain().focus().setTextAlign('right').run())}
      />

      <div style={dividerStyle} />

      <MenuItem
        icon={<IndentIncrease size={16} />}
        label="增加缩进"
        onClick={() => run(() => editor.chain().focus().sinkListItem('listItem').run())}
      />
      <MenuItem
        icon={<IndentDecrease size={16} />}
        label="减少缩进"
        onClick={() => run(() => editor.chain().focus().liftListItem('listItem').run())}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// ColorPicker
// ---------------------------------------------------------------------------

const TEXT_COLORS = ['#FF4D4F', '#333333', '#999999', '#FF4D4F', '#FF9900', '#F5C542', '#52C41A']
const BG_COLORS_ROW1 = ['#FFFFFF', '#D9D9D9', '#FF4D4F', '#FF9900', '#F5C542', '#52C41A', '#3370FF']
const BG_COLORS_ROW2 = ['#FFE6E6', '#FFECD2', '#FFF8CC', '#E6FFE6', '#E6F0FF', '#F0E6FF', '#E6FFFA']

interface ColorPickerProps {
  editor: Editor
  onClose: () => void
}

function ColorPicker({ editor, onClose }: ColorPickerProps): ReactNode {
  const currentColor = (editor.getAttributes('textStyle').color as string) || '#333333'

  const setTextColor = (color: string) => {
    editor.chain().focus().setColor(color).run()
    onClose()
  }

  const setHighlightColor = (color: string) => {
    editor.chain().focus().toggleHighlight({ color }).run()
    onClose()
  }

  const resetDefault = () => {
    editor.chain().focus().unsetColor().unsetHighlight().run()
    onClose()
  }

  const swatchStyle = (
    color: string,
    isActive: boolean,
    isBg: boolean
  ): CSSProperties => ({
    width: 24,
    height: 24,
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontWeight: 700,
    fontSize: 13,
    color: isBg ? '#333333' : color,
    background: isBg ? color : 'transparent',
    border: isActive
      ? '2px solid #3370FF'
      : color === '#FFFFFF' && isBg
        ? '1px solid #E0E0E0'
        : '1px solid transparent',
    boxSizing: 'border-box',
    flexShrink: 0
  })

  return (
    <div
      style={{
        ...dropdownContainerStyle,
        width: 220,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12
      }}
    >
      {/* Text color section */}
      <span style={{ fontSize: 12, color: '#666666', fontWeight: 500, fontFamily: 'Inter, system-ui, sans-serif' }}>
        字体颜色
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {TEXT_COLORS.map((c, i) => (
          <div
            key={`tc-${i}`}
            style={swatchStyle(c, currentColor === c, false)}
            onClick={() => setTextColor(c)}
          >
            A
          </div>
        ))}
      </div>

      {/* Background color section */}
      <span style={{ fontSize: 12, color: '#666666', fontWeight: 500, fontFamily: 'Inter, system-ui, sans-serif' }}>
        背景颜色
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {BG_COLORS_ROW1.map((c, i) => (
          <div
            key={`bg1-${i}`}
            style={swatchStyle(c, false, true)}
            onClick={() => setHighlightColor(c)}
          >
            A
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {BG_COLORS_ROW2.map((c, i) => (
          <div
            key={`bg2-${i}`}
            style={swatchStyle(c, false, true)}
            onClick={() => setHighlightColor(c)}
          >
            A
          </div>
        ))}
      </div>

      {/* Reset button */}
      <button
        onClick={resetDefault}
        style={{
          height: 32,
          border: '1px solid #E8E5DE',
          borderRadius: 6,
          background: '#FFFFFF',
          color: '#666666',
          fontSize: 13,
          fontWeight: 500,
          fontFamily: 'Inter, system-ui, sans-serif',
          cursor: 'pointer',
          width: '100%',
          textAlign: 'center'
        }}
      >
        恢复默认
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LinkInputDropdown
// ---------------------------------------------------------------------------

interface LinkInputDropdownProps {
  editor: Editor
  onClose: () => void
}

function LinkInputDropdown({ editor, onClose }: LinkInputDropdownProps): ReactNode {
  const [url, setUrl] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const trimmed = url.trim()
    if (trimmed) {
      const href = trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : `https://${trimmed}`
      editor.chain().focus().setLink({ href }).run()
    }
    onClose()
  }

  return (
    <div
      style={{
        ...dropdownContainerStyle,
        width: 260,
        padding: 10,
        display: 'flex',
        gap: 6,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
        placeholder="输入链接地址..."
        style={{
          flex: 1,
          height: 30,
          border: '1px solid #E0E0E0',
          borderRadius: 6,
          padding: '0 8px',
          fontSize: 13,
          fontFamily: 'Inter, system-ui, sans-serif',
          outline: 'none',
          color: '#333',
          background: '#FAFAFA',
        }}
      />
      <button
        onClick={handleSubmit}
        style={{
          height: 30,
          padding: '0 12px',
          borderRadius: 6,
          border: 'none',
          background: '#3370FF',
          color: '#fff',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        确定
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbar button helper
// ---------------------------------------------------------------------------

interface TbButtonProps {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  style?: CSSProperties
  title?: string
}

function TbButton({ children, active, onClick, style, title }: TbButtonProps): ReactNode {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 28,
        height: 28,
        borderRadius: 4,
        border: 'none',
        background: active ? 'rgba(51,112,255,0.08)' : hovered ? 'rgba(0,0,0,0.05)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
        ...style
      }}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// EditorFloatingToolbar (main export)
// ---------------------------------------------------------------------------

export default function EditorFloatingToolbar({
  editor,
  visible,
  position
}: EditorFloatingToolbarProps): ReactNode {
  const [openDropdown, setOpenDropdown] = useState<DropdownKind>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setOpenDropdown(null)
      }
    },
    []
  )

  useEffect(() => {
    if (!openDropdown) return
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [openDropdown, handleClickOutside])

  // Reset dropdown when toolbar hides
  useEffect(() => {
    if (!visible) setOpenDropdown(null)
  }, [visible])

  if (!visible || !editor) return null

  const toggleDropdown = (kind: DropdownKind) => {
    setOpenDropdown((prev) => (prev === kind ? null : kind))
  }

  const currentColor = (editor.getAttributes('textStyle').color as string) || '#F5C542'

  return (
    <div
      ref={toolbarRef}
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        zIndex: 999
      }}
    >
      {/* ---- The toolbar bar ---- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          background: '#FFFFFF',
          border: '1px solid #E0E0E0',
          borderRadius: 8,
          boxShadow: '0 2px 10px rgba(0,0,0,0.094)',
          padding: '4px 6px',
          height: 36,
          boxSizing: 'border-box'
        }}
      >
        {/* 1. Text Type */}
        <TbButton onClick={() => toggleDropdown('textType')} active={openDropdown === 'textType'} title="文本类型">
          <span style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 14, color: '#333' }}>T</span>
          <ChevronDown size={10} color="#999" style={{ marginLeft: 1 }} />
        </TbButton>

        {/* 2. Separator */}
        <ToolbarSeparator />

        {/* 3. Align */}
        <TbButton onClick={() => toggleDropdown('align')} active={openDropdown === 'align'} title="对齐">
          <AlignLeft size={13} color="#333" />
          <ChevronDown size={10} color="#999" style={{ marginLeft: 1 }} />
        </TbButton>

        {/* 4. Separator */}
        <ToolbarSeparator />

        {/* 5. Bold */}
        <TbButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="加粗"
        >
          <span style={{ fontFamily: 'Inter', fontWeight: 700, fontSize: 14, color: '#333' }}>B</span>
        </TbButton>

        {/* 6. Strikethrough */}
        <TbButton
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="删除线"
        >
          <span
            style={{
              fontFamily: 'Inter',
              fontWeight: 600,
              fontSize: 14,
              color: '#333',
              textDecoration: 'line-through'
            }}
          >
            S
          </span>
        </TbButton>

        {/* 7. Italic */}
        <TbButton
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="斜体"
        >
          <span
            style={{
              fontFamily: 'Inter',
              fontWeight: 500,
              fontSize: 14,
              color: '#333',
              fontStyle: 'italic'
            }}
          >
            I
          </span>
        </TbButton>

        {/* 8. Underline */}
        <TbButton
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title="下划线"
        >
          <span
            style={{
              fontFamily: 'Inter',
              fontWeight: 500,
              fontSize: 14,
              color: '#333',
              textDecoration: 'underline'
            }}
          >
            U
          </span>
        </TbButton>

        {/* 9. Link */}
        <TbButton
          active={editor.isActive('link') || openDropdown === 'link'}
          onClick={() => {
            if (editor.isActive('link')) {
              editor.chain().focus().unsetLink().run()
            } else {
              toggleDropdown('link')
            }
          }}
          title="链接"
        >
          <LinkIcon size={14} color="#333" />
        </TbButton>

        {/* 10. Inline Code */}
        <TbButton
          active={editor.isActive('code')}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="行内代码"
        >
          <span style={{ fontFamily: 'Inter', fontWeight: 600, fontSize: 12, color: '#333' }}>&lt;/&gt;</span>
        </TbButton>

        {/* 11. Color */}
        <TbButton onClick={() => toggleDropdown('color')} active={openDropdown === 'color'} title="颜色">
          <span style={{ fontFamily: 'Inter', fontWeight: 700, fontSize: 14, color: currentColor }}>A</span>
          <ChevronDown size={10} color="#999" style={{ marginLeft: 1 }} />
        </TbButton>

        {/* 12. Separator */}
        <ToolbarSeparator />

        {/* 13. Grid / Table */}
        <TbButton
          onClick={() => alert('表格功能即将上线')}
          title="插入表格"
        >
          <Grid2x2 size={14} color="#333" />
        </TbButton>

        {/* 14. Indent */}
        <TbButton
          onClick={() => editor.chain().focus().sinkListItem('listItem').run()}
          title="增加缩进"
        >
          <IndentIncrease size={14} color="#333" />
        </TbButton>

        {/* 15. Comment */}
        <TbButton
          onClick={() => alert('评论功能即将上线')}
          title="评论"
        >
          <MessageSquare size={14} color="#333" />
        </TbButton>
      </div>

      {/* ---- Dropdowns (rendered below toolbar) ---- */}
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', top: DROPDOWN_GAP, left: 0 }}>
          {openDropdown === 'textType' && (
            <TextTypeDropdown editor={editor} onClose={() => setOpenDropdown(null)} />
          )}
          {openDropdown === 'align' && (
            <AlignDropdown editor={editor} onClose={() => setOpenDropdown(null)} />
          )}
          {openDropdown === 'color' && (
            <ColorPicker editor={editor} onClose={() => setOpenDropdown(null)} />
          )}
          {openDropdown === 'link' && (
            <LinkInputDropdown editor={editor} onClose={() => setOpenDropdown(null)} />
          )}
        </div>
      </div>
    </div>
  )
}
