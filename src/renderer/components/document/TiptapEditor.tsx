import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Highlight from '@tiptap/extension-highlight'
import Color from '@tiptap/extension-color'
import { TextStyle } from '@tiptap/extension-text-style'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'

export interface TiptapEditorProps {
  content: string
  onChange?: (markdown: string) => void
  onSelectionChange?: (hasSelection: boolean) => void
  editable?: boolean
  className?: string
}

export interface TiptapEditorRef {
  editor: Editor | null
}

const TiptapEditor = forwardRef<TiptapEditorRef, TiptapEditorProps>(
  ({ content, onChange, onSelectionChange, editable = true, className }, ref) => {
    const lastContentRef = useRef<string>(content)
    const isUpdatingRef = useRef(false)

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
        }),
        Underline,
        TextAlign.configure({
          types: ['heading', 'paragraph'],
          alignments: ['left', 'center', 'right'],
        }),
        Link.configure({
          openOnClick: false,
          autolink: true,
          HTMLAttributes: {
            rel: 'noopener noreferrer nofollow',
          },
        }),
        TaskList,
        TaskItem.configure({
          nested: true,
        }),
        Highlight.configure({
          multicolor: true,
        }),
        Color,
        TextStyle,
        Placeholder.configure({
          placeholder: '开始输入...',
        }),
        Markdown.configure({
          html: true,
          transformPastedText: true,
          transformCopiedText: true,
        }),
      ],
      content,
      editable,
      onUpdate: ({ editor: currentEditor }) => {
        if (isUpdatingRef.current) return
        const md = (currentEditor.storage as Record<string, any>).markdown.getMarkdown() as string
        lastContentRef.current = md
        onChange?.(md)
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        const { from, to } = currentEditor.state.selection
        onSelectionChange?.(from !== to)
      },
    })

    // Expose editor instance via ref
    useImperativeHandle(ref, () => ({ editor }), [editor])

    // Sync editable prop
    useEffect(() => {
      if (editor && editor.isEditable !== editable) {
        editor.setEditable(editable)
      }
    }, [editor, editable])

    // Sync external content changes (e.g. file load)
    useEffect(() => {
      if (!editor) return
      if (content === lastContentRef.current) return

      isUpdatingRef.current = true
      lastContentRef.current = content

      const { from } = editor.state.selection
      editor.commands.setContent(content)

      // Restore cursor position if possible
      const maxPos = editor.state.doc.content.size
      const safePos = Math.min(from, maxPos)
      editor.commands.setTextSelection(safePos)

      isUpdatingRef.current = false
    }, [content, editor])

    return (
      <div className={`tiptap-editor-wrapper ${className || ''}`}>
        <EditorContent editor={editor} />
      </div>
    )
  }
)

TiptapEditor.displayName = 'TiptapEditor'

export default TiptapEditor
