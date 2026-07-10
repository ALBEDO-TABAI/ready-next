import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, GripVertical, Pencil, Plus, X } from 'lucide-react'

/**
 * Preview-edit (预览内编辑) building blocks: the in-place block editor and the
 * trailing "添加文字" composer. Pure presentation + local editing state — all
 * document mutations happen in the parent through previewEditOperations.
 */

interface PreviewBlockEditorProps {
  initialText: string
  ariaLabel: string
  onCommit: (nextText: string) => void
  onCancel: () => void
}

function autoGrowTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(Math.max(element.scrollHeight + 2, 56), 480)}px`
}

export function PreviewBlockEditor({ initialText, ariaLabel, onCommit, onCancel }: PreviewBlockEditorProps) {
  const [text, setText] = useState(initialText)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const committedRef = useRef(false)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    autoGrowTextarea(textarea)
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  const commit = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    onCommit(text)
  }, [onCommit, text])

  const cancel = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    onCancel()
  }, [onCancel])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
  }, [cancel, commit])

  const handleBlur = useCallback((event: React.FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget as HTMLElement | null
    if (next?.closest('[data-preview-block-editor]')) return
    commit()
  }, [commit])

  return (
    <div className="note-preview-edit-editor" data-preview-block-editor="true">
      <textarea
        ref={textareaRef}
        value={text}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value)
          autoGrowTextarea(event.target)
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      <div className="note-preview-edit-editor__actions">
        <span className="note-preview-edit-editor__hint">⌘/Ctrl+Enter 完成 · Esc 取消</span>
        <button type="button" className="note-preview-edit-editor__button" onMouseDown={(event) => event.preventDefault()} onClick={cancel} title="取消">
          <X size={13} strokeWidth={2} />
          <span>取消</span>
        </button>
        <button type="button" className="note-preview-edit-editor__button note-preview-edit-editor__button--primary" onMouseDown={(event) => event.preventDefault()} onClick={commit} title="完成（⌘/Ctrl+Enter）">
          <Check size={13} strokeWidth={2} />
          <span>完成</span>
        </button>
      </div>
    </div>
  )
}

interface PreviewAppendComposerProps {
  onAppend: (text: string) => void
}

export function PreviewAppendComposer({ onAppend }: PreviewAppendComposerProps) {
  const [composing, setComposing] = useState(false)

  if (!composing) {
    return (
      <button
        type="button"
        className="note-preview-append-trigger"
        onClick={() => setComposing(true)}
        title="在文档末尾添加文字"
      >
        <Plus size={14} strokeWidth={2} />
        <span>添加文字</span>
      </button>
    )
  }

  return (
    <PreviewBlockEditor
      initialText=""
      ariaLabel="在文档末尾添加文字"
      onCommit={(text) => {
        setComposing(false)
        if (text.trim().length > 0) onAppend(text)
      }}
      onCancel={() => setComposing(false)}
    />
  )
}

export interface PreviewDropIndicator {
  blockId: string
  position: 'before' | 'after'
}

interface EditableBlockShellProps {
  blockId: string
  children: React.ReactNode
  /** Block can be opened in the in-place editor. */
  textEditable: boolean
  /** Block can be picked up and moved (standalone image). */
  draggable: boolean
  /** Block can act as a drop anchor for a moved block. */
  dropTargetable: boolean
  isDraggingSelf: boolean
  dropIndicator: PreviewDropIndicator | null
  editHint?: string
  onStartEdit?: () => void
  onDragStartBlock?: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEndBlock?: () => void
  onDragOverBlock?: (event: React.DragEvent<HTMLDivElement>) => void
  onDropBlock?: (event: React.DragEvent<HTMLDivElement>) => void
}

export function EditableBlockShell({
  blockId,
  children,
  textEditable,
  draggable,
  dropTargetable,
  isDraggingSelf,
  dropIndicator,
  editHint,
  onStartEdit,
  onDragStartBlock,
  onDragEndBlock,
  onDragOverBlock,
  onDropBlock,
}: EditableBlockShellProps) {
  const showBefore = dropIndicator?.blockId === blockId && dropIndicator.position === 'before'
  const showAfter = dropIndicator?.blockId === blockId && dropIndicator.position === 'after'
  const interactive = textEditable || draggable

  return (
    <div
      className={[
        'note-preview-edit-block',
        interactive ? 'note-preview-edit-block--interactive' : '',
        isDraggingSelf ? 'note-preview-edit-block--dragging' : '',
      ].filter(Boolean).join(' ')}
      data-preview-block-id={blockId}
      draggable={draggable || undefined}
      onDragStart={draggable ? onDragStartBlock : undefined}
      onDragEnd={draggable ? onDragEndBlock : undefined}
      onDragOver={dropTargetable ? onDragOverBlock : undefined}
      onDrop={dropTargetable ? onDropBlock : undefined}
      onDoubleClick={textEditable && onStartEdit ? (event) => {
        const target = event.target as HTMLElement
        if (target.closest('a, button, input, textarea, [data-preview-block-editor]')) return
        onStartEdit()
      } : undefined}
    >
      {showBefore && <span aria-hidden className="note-preview-edit-drop-line note-preview-edit-drop-line--before" />}
      {showAfter && <span aria-hidden className="note-preview-edit-drop-line note-preview-edit-drop-line--after" />}
      {interactive && (
        <div className="note-preview-edit-block__actions" data-preview-block-editor="true">
          {draggable && (
            <span className="note-preview-edit-block__handle" title="拖拽移动位置">
              <GripVertical size={13} strokeWidth={2} />
            </span>
          )}
          {textEditable && onStartEdit && (
            <button
              type="button"
              className="note-preview-edit-block__edit"
              title={editHint || '编辑此段（也可双击）'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onStartEdit}
            >
              <Pencil size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  )
}
