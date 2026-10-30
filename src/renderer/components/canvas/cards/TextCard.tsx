import { useRef, useState, type ReactNode } from 'react'
import type { CanvasNode, CanvasOperation } from '../../../../shared/ready-canvas'
import type { BlockEdit, DocumentBuffer, DocumentSelection } from '../../../../shared/document-blocks'
import { cardTextEdit } from './text-adapter'

/** Required public M3 host contract. ReadyBlockEditor currently only accepts a document tab;
 * F/T4 must expose this boundary before supplying the renderer. No synthetic document tabs. */
export interface CardEditorHost {
  buffer: DocumentBuffer; selection: DocumentSelection
  apply(edit: BlockEdit): Promise<boolean>
}
export function TextCard({ node, commit, renderEditor }: {
  node: Extract<CanvasNode, { type: 'text' }>
  commit(operations: CanvasOperation[]): Promise<boolean>
  renderEditor?: (host: CardEditorHost) => ReactNode
}) {
  const version = useRef({ text: node.text, value: 0 })
  if (version.current.text !== node.text) version.current = { text: node.text, value: version.current.value + 1 }
  const [selection, setSelection] = useState<DocumentSelection>({ anchor: 0, focus: 0 })
  const [error, setError] = useState(''), pending = useRef(false)
  const bodyVersion = version.current.value
  const apply = async (edit: BlockEdit) => {
    if (pending.current) return false
    pending.current = true
    try {
      const change = cardTextEdit(node, bodyVersion, edit)
      const accepted = await commit([change.operation])
      if (accepted) { setSelection(change.selection); setError('') }
      return accepted
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false }
    finally { pending.current = false }
  }
  return <div data-canvas-ui aria-label="文字卡编辑">
    {renderEditor ? renderEditor({ buffer: { content: node.text, version: bodyVersion }, selection, apply })
      : <><p>{node.text}</p><p role="status">文字卡编辑尚未接通</p></>}
    {error && <p role="alert">{error}</p>}
  </div>
}
