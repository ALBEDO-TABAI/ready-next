import { useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { CanvasNode, CanvasOperation } from '../../../../shared/ready-canvas'
import type { EditorBuffer } from '../../../modules/document/block-editor/editor-buffer'
import { BufferedBlockEditor } from '../../../modules/document/block-editor/ReadyBlockEditor'
import { CanvasEditorLifecycle } from '../surface/editor-lifecycle'
import { NodeBuffer } from './node-buffer'

export interface CardEditorHost { buffer: EditorBuffer }
export function TextCard({ node, commit, renderEditor }: {
  node: Extract<CanvasNode, { type: 'text' }>
  commit(operations: CanvasOperation[]): Promise<boolean>
  renderEditor?: (host: CardEditorHost) => ReactNode
}) {
  const registerFinish = useContext(CanvasEditorLifecycle)
  const latest = useRef(commit); latest.current = commit
  const buffer = useMemo(() => new NodeBuffer(node, operations => latest.current(operations)), [node.id]) // eslint-disable-line react-hooks/exhaustive-deps -- body updates enter observe, never replace history
  useLayoutEffect(() => registerFinish?.(() => buffer.finish()), [buffer, registerFinish])
  useLayoutEffect(() => buffer.observe(node.text), [buffer, node.text])
  return <div data-canvas-ui className="note-preview-shell" aria-label="文字卡编辑">
    {renderEditor ? renderEditor({ buffer }) : <BufferedBlockEditor buffer={buffer} renderSource={block => <pre>{block.raw}</pre>} />}
    <small>未提供画板文件路径，页面链接选择器和子页面暂不可用；文字卡不提供保存到和复制块引用。</small>
  </div>
}
