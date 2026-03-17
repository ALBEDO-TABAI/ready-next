import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
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
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Markdown } from 'tiptap-markdown'
import { createRoot } from 'react-dom/client'
import DocumentWidgetBlockCard from './DocumentWidgetBlockCard'
import { tryParseWidgetPayload } from './widget-fence-parser'

export interface TiptapEditorProps {
  content: string
  onChange?: (markdown: string) => void
  onSelectionChange?: (hasSelection: boolean) => void
  onRequestPreview?: (title: string) => void
  onRequestAgentUpdate?: (title: string, widgetCode: string) => void
  editable?: boolean
  className?: string
  revealTarget?: {
    selection?: string
    lineStart?: number
    lineEnd?: number
    requestedAt: number
  } | null
  onRevealHandled?: () => void
}

export interface TiptapEditorRef {
  editor: Editor | null
}

const revealHighlightPluginKey = new PluginKey<{ from: number; to: number } | null>('ready-doc-reveal-highlight')
const widgetBlockPluginKey = new PluginKey<Set<string>>('ready-doc-widget-block')
const widgetSourceVisibilityMemory = new Set<string>()

function buildWidgetFenceSource(title: string, widgetCode: string): string {
  return [
    '```show-widget',
    JSON.stringify({
      title,
      widget_code: widgetCode,
    }),
    '```',
  ].join('\n')
}

function getWidgetModeLabel(widgetCode: string): string {
  if (/<script\b/i.test(widgetCode)) return '脚本交互'
  if (/<svg\b/i.test(widgetCode)) return 'SVG widget'
  return 'HTML widget'
}

function getWidgetMemoryKey(title: string, widgetCode: string): string {
  return `${title}::${widgetCode.slice(0, 160)}`
}

function createWidgetBlockExtension(
  getEditor: () => Editor | null,
  onRequestPreview?: (title: string) => void,
  onRequestAgentUpdate?: (title: string, widgetCode: string) => void,
): Extension {
  return Extension.create({
    name: 'readyDocWidgetBlock',
    addProseMirrorPlugins() {
      return [
        new Plugin<Set<string>>({
          key: widgetBlockPluginKey,
          state: {
            init: () => new Set<string>(widgetSourceVisibilityMemory),
            apply(tr, value) {
              const next = new Set<string>(value)
              const meta = tr.getMeta(widgetBlockPluginKey) as { type: 'toggle'; key: string } | undefined
              if (meta?.type === 'toggle') {
                if (next.has(meta.key)) {
                  next.delete(meta.key)
                  widgetSourceVisibilityMemory.delete(meta.key)
                } else {
                  next.add(meta.key)
                  widgetSourceVisibilityMemory.add(meta.key)
                }
              }

              return next
            },
          },
          props: {
            decorations(state) {
              const expanded = (widgetBlockPluginKey.getState(state) || new Set<string>()) as Set<string>
              const decorations: Decoration[] = []

              state.doc.descendants((node, pos) => {
                if (node.type.name !== 'codeBlock') return true
                const language = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
                if (language !== 'show-widget') return true

                const widget = tryParseWidgetPayload(node.textContent, node.textContent)
                if (!widget) return true

                const title = widget.title || `widget_${pos}`
                const widgetKey = getWidgetMemoryKey(title, widget.widgetCode)
                const sourceVisible = expanded.has(widgetKey)
                const dom = document.createElement('div')
                const root = createRoot(dom)

                root.render(
                  <DocumentWidgetBlockCard
                    title={title}
                    modeLabel={getWidgetModeLabel(widget.widgetCode)}
                    widgetCode={widget.widgetCode}
                    sourceVisible={sourceVisible}
                    onRequestPreview={onRequestPreview}
                    onRequestAgentUpdate={onRequestAgentUpdate ? () => onRequestAgentUpdate(title, widget.widgetCode) : undefined}
                    onToggleSource={() => {
                      const currentEditor = getEditor()
                      if (!currentEditor) return
                      currentEditor.view.dispatch(
                        currentEditor.state.tr.setMeta(widgetBlockPluginKey, { type: 'toggle', key: widgetKey }),
                      )
                    }}
                    onCopySource={() => {
                      void navigator.clipboard?.writeText(buildWidgetFenceSource(title, widget.widgetCode))
                    }}
                    onDelete={() => {
                      const currentEditor = getEditor()
                      if (!currentEditor) return
                      currentEditor.view.dispatch(currentEditor.state.tr.delete(pos, pos + node.nodeSize))
                      currentEditor.view.focus()
                    }}
                  />,
                )

                decorations.push(
                  Decoration.widget(pos, dom, {
                    side: -1,
                    key: `ready-doc-widget-card-${pos}-${title}`,
                    stopEvent: () => true,
                    ignoreSelection: true,
                    destroy: () => root.unmount(),
                  }),
                )
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: sourceVisible
                      ? 'ready-doc-widget-codeblock is-expanded'
                      : 'ready-doc-widget-codeblock is-collapsed',
                  }),
                )

                return true
              })

              return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null
            },
          },
        }),
      ]
    },
  })
}

const RevealHighlightExtension = Extension.create({
  name: 'readyDocRevealHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<{ from: number; to: number } | null>({
        key: revealHighlightPluginKey,
        state: {
          init: () => null as { from: number; to: number } | null,
          apply(tr, value: { from: number; to: number } | null) {
            const meta = tr.getMeta(revealHighlightPluginKey) as
              | { type: 'show'; from: number; to: number }
              | { type: 'clear' }
              | undefined

            if (meta?.type === 'show') {
              return {
                from: meta.from,
                to: meta.to,
              }
            }

            if (meta?.type === 'clear') {
              return null
            }

            if (value && tr.docChanged) {
              return {
                from: tr.mapping.map(value.from),
                to: tr.mapping.map(value.to),
              }
            }

            return value
          },
        },
        props: {
          decorations(state) {
            const value = revealHighlightPluginKey.getState(state)
            if (!value) return null

            return DecorationSet.create(state.doc, [
              Decoration.inline(value.from, Math.max(value.from + 1, value.to), {
                class: 'ready-doc-reveal-highlight',
              }),
            ])
          },
        },
      }),
    ]
  },
})

const TiptapEditor = forwardRef<TiptapEditorRef, TiptapEditorProps>(
  ({
    content,
    onChange,
    onSelectionChange,
    onRequestPreview,
    onRequestAgentUpdate,
    editable = true,
    className,
    revealTarget,
    onRevealHandled,
  }, ref) => {
    const lastContentRef = useRef<string>(content.replace(/\r\n?/g, '\n'))
    const isUpdatingRef = useRef(false)
    const revealClearTimerRef = useRef<number | null>(null)
    const editorRef = useRef<Editor | null>(null)
    const widgetBlockExtension = useMemo(
      () => createWidgetBlockExtension(() => editorRef.current, onRequestPreview, onRequestAgentUpdate),
      [onRequestAgentUpdate, onRequestPreview],
    )

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
        RevealHighlightExtension,
        widgetBlockExtension,
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
        const md = ((currentEditor.storage as Record<string, any>).markdown.getMarkdown() as string).replace(/\r\n?/g, '\n')
        lastContentRef.current = md
        onChange?.(md)
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        const { from, to } = currentEditor.state.selection
        onSelectionChange?.(from !== to)
      },
    })

    editorRef.current = editor ?? null

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
      const normalizedContent = content.replace(/\r\n?/g, '\n')
      if (normalizedContent === lastContentRef.current) return

      isUpdatingRef.current = true
      lastContentRef.current = normalizedContent

      const { from } = editor.state.selection
      editor.commands.setContent(normalizedContent)

      // Restore cursor position if possible
      const maxPos = editor.state.doc.content.size
      const safePos = Math.min(from, maxPos)
      editor.commands.setTextSelection(safePos)

      isUpdatingRef.current = false
    }, [content, editor])

    useEffect(() => {
      if (!editor || !revealTarget) return

      const buildIndexedText = () => {
        let plain = ''
        const positions: number[] = []
        let firstBlock = true

        editor.state.doc.descendants((node, pos) => {
          if (node.isBlock && !firstBlock && plain.length > 0 && !plain.endsWith('\n')) {
            plain += '\n'
            positions.push(Math.max(1, pos))
          }

          if (node.isText && node.text) {
            for (let index = 0; index < node.text.length; index += 1) {
              plain += node.text[index]
              positions.push(pos + index)
            }
          }

          if (node.isBlock) {
            firstBlock = false
          }

          return true
        })

        return { plain, positions }
      }

      const locateRange = () => {
        const { plain, positions } = buildIndexedText()
        const selection = revealTarget.selection?.replace(/\r\n?/g, '\n').trim()

        if (selection) {
          const index = plain.indexOf(selection)
          if (index >= 0 && positions[index] != null) {
            const from = positions[index]
            const lastCharIndex = Math.max(index, index + selection.length - 1)
            const toBase = positions[Math.min(lastCharIndex, positions.length - 1)] ?? from
            return { from, to: toBase + 1 }
          }
        }

        if (revealTarget.lineStart && revealTarget.lineStart > 0) {
          const lines = plain.split('\n')
          const lineIndexStart = Math.min(revealTarget.lineStart - 1, Math.max(0, lines.length - 1))
          const lineIndexEnd = Math.min(
            Math.max(lineIndexStart, (revealTarget.lineEnd || revealTarget.lineStart) - 1),
            Math.max(0, lines.length - 1),
          )
          const plainOffsetStart = lines.slice(0, lineIndexStart).reduce((sum, line) => sum + line.length + 1, 0)
          const plainOffsetEnd =
            lines.slice(0, lineIndexEnd + 1).reduce((sum, line) => sum + line.length + 1, 0) - 1
          const from = positions[Math.min(plainOffsetStart, Math.max(0, positions.length - 1))] ?? 1
          const to = positions[Math.min(Math.max(plainOffsetStart, plainOffsetEnd), Math.max(0, positions.length - 1))] ?? from
          return { from, to: to + 1 }
        }

        return null
      }

      const range = locateRange()
      if (!range) {
        onRevealHandled?.()
        return
      }

      requestAnimationFrame(() => {
        editor.commands.focus()
        editor.commands.setTextSelection(range)
        editor.view.dispatch(
          editor.state.tr
            .setMeta(revealHighlightPluginKey, { type: 'show', from: range.from, to: range.to })
            .scrollIntoView(),
        )
        if (revealClearTimerRef.current) {
          window.clearTimeout(revealClearTimerRef.current)
        }
        revealClearTimerRef.current = window.setTimeout(() => {
          if (!editor.isDestroyed) {
            editor.view.dispatch(editor.state.tr.setMeta(revealHighlightPluginKey, { type: 'clear' }))
          }
          revealClearTimerRef.current = null
        }, 1600)
        onRevealHandled?.()
      })
    }, [editor, onRevealHandled, revealTarget])

    useEffect(() => {
      return () => {
        if (revealClearTimerRef.current) {
          window.clearTimeout(revealClearTimerRef.current)
          revealClearTimerRef.current = null
        }
      }
    }, [])

    return (
      <div className={`tiptap-editor-wrapper ${className || ''}`}>
        <EditorContent editor={editor} />
      </div>
    )
  }
)

TiptapEditor.displayName = 'TiptapEditor'

export default TiptapEditor
