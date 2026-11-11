import { registerBeforeQuitFlushHandler } from '../../../modules/app/beforeQuitFlushRegistry'
import { trackCanvasWrite } from '../../../modules/canvas/pending-writes'
import { useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { CanvasNode, CanvasOperation } from '../../../../shared/ready-canvas'
import type { EditorBuffer } from '../../../modules/document/block-editor/editor-buffer'
import { BufferedBlockEditor } from '../../../modules/document/block-editor/ReadyBlockEditor'
import { CanvasEditorLifecycle } from '../surface/editor-lifecycle'
import { NodeBuffer } from './node-buffer'
import type { EditorLinkBase } from '../../../modules/document/block-editor/references'

export interface CardEditorHost { buffer: EditorBuffer; canvasPath?: string; linkBase?: EditorLinkBase }
export function TextCard({ node, commit, renderEditor, canvasPath }: {
  node: Extract<CanvasNode, { type: 'text' }>
  canvasPath?: string
  commit(operations: CanvasOperation[]): Promise<boolean>
  renderEditor?: (host: CardEditorHost) => ReactNode
}) {
  const linkBase = useMemo(() => canvasPath ? { filePath: canvasPath, parentPath: canvasPath } : undefined, [canvasPath])
  const registerFinish = useContext(CanvasEditorLifecycle)
  const latest = useRef(commit); latest.current = commit
  const buffer = useMemo(() => new NodeBuffer(node, operations => latest.current(operations)), [node.id]) // eslint-disable-line react-hooks/exhaustive-deps -- body updates enter observe, never replace history
  useLayoutEffect(() => registerFinish?.(() => buffer.finish()), [buffer, registerFinish])
  useLayoutEffect(() => {
    const stop = registerBeforeQuitFlushHandler(`canvas-text:${canvasPath}:${node.id}`, () => buffer.finish())
    return () => { stop(); void trackCanvasWrite(buffer.finish()).catch(error => console.error('[canvas] pending text', error)) }
  }, [buffer, canvasPath, node.id])
  useLayoutEffect(() => buffer.observe(node.text), [buffer, node.text])
  return <div data-canvas-ui className="note-preview-shell" aria-label="文字卡编辑">
    {renderEditor ? renderEditor({ buffer, canvasPath, linkBase }) : <BufferedBlockEditor buffer={buffer} linkBase={linkBase} startTyping renderSource={block => <pre>{block.raw}</pre>} />}
    {!canvasPath && <small>尚未提供画板文件路径，无法选择页面链接、新建子页面和复制块引用。</small>}
  </div>
}
