import { useMemo, useRef, type KeyboardEvent, type CompositionEvent } from 'react'
import { textAreaContent, textAreaOffset } from './text-edit'
import { getTabBuffer } from './tab-buffer'

/** Source textarea and page editor use exactly the same tab history. */
export function useSourceHistory(tabId: string, report: (message: string) => void) {
  const buffer = useMemo(() => getTabBuffer(tabId), [tabId])
  const composition = useRef<string | undefined>(undefined)
  const counter = useRef(0)
  return {
    buffer,
    change(content: string, selection: number) {
      buffer.replace(content, composition.current ? 'composition' : 'typing', composition.current,
        { anchor: selection, focus: selection })
    },
    onCompositionStart() { composition.current = `source:${tabId}:${++counter.current}` },
    onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>) {
      const content = textAreaContent(buffer.snapshot.content, event.currentTarget.value)
      buffer.replace(content, 'composition', composition.current,
        { anchor: textAreaOffset(content, event.currentTarget.selectionStart), focus: textAreaOffset(content, event.currentTarget.selectionEnd) })
      composition.current = undefined
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (composition.current || event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      event.preventDefault(); event.stopPropagation()
      try {
        const selection = buffer.travel(event.shiftKey ? 'redo' : 'undo')
        const editor = event.currentTarget
        if (selection) {
          const normalized = (at: number) => buffer.snapshot.content.slice(0, at).replace(/\r\n?/g, '\n').length
          requestAnimationFrame(() => editor.setSelectionRange(normalized(selection.anchor), normalized(selection.focus)))
        }
      } catch (error) { console.warn('[use-source-history] travel source history failed:', error instanceof Error ? error.message : String(error)); report(error instanceof Error ? error.message : String(error)) }
    },
  }
}
