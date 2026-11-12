import type { ReactNode } from 'react'
import { FileText, Frame, Link2 } from 'lucide-react'
import type { CanvasNode } from '../../../shared/ready-canvas/schema'
import type { PageNode } from '../../../shared/document-pages'
import { openFloat, type FloatAnchor, type MenuEntry } from '../ui'
import { DocumentPicker, LinkForm } from './BoardNewForms'
import { newCardFrame } from './new-card'

// The board's own 新建 entries on the right-click menu (W4 §2.2): a link, a document card, a sub-board. Text and
// note cards and paste come from the surface itself. 链接… and 文档卡… continue in a small float at the same point
// (the shared W1 float, kept inside the board; BoardNewForms.tsx).

export const BOARD_NEW_LINK = 'canvas-new-link', BOARD_NEW_DOCUMENT = 'canvas-new-document'

export function boardNewItems({ at, place, pages, root, boardPath, add, report }: {
  at: { x: number; y: number }; place: { anchor: FloatAnchor; bounds: () => FloatAnchor }
  pages: PageNode[]; root: string; boardPath: string
  add(node: CanvasNode): Promise<void>; report(cause: unknown): void
}): MenuEntry[] {
  const follow = (id: string, label: string, body: (close: () => void) => ReactNode) => openFloat({
    id, label, role: 'dialog', anchor: place.anchor, bounds: place.bounds, placement: 'bottom-start', className: 'canvas-new-float', render: body,
  })
  return [
    { id: 'link', label: '链接…', icon: <Link2 />, onSelect: () => follow(BOARD_NEW_LINK, '添加链接卡', close => <LinkForm at={at} add={add} report={report} close={close} />) },
    { id: 'document', label: '文档卡…', icon: <FileText />, disabled: !pages.length, onSelect: () => follow(BOARD_NEW_DOCUMENT, '添加文档卡', close => <DocumentPicker at={at} pages={pages} root={root} add={add} report={report} close={close} />) },
    { id: 'subcanvas', label: '子画板', icon: <Frame />, onSelect: () => { void addSubBoard(at, root, boardPath, add).catch(report) } },
  ]
}

async function addSubBoard(at: { x: number; y: number }, root: string, boardPath: string, add: (node: CanvasNode) => Promise<void>) {
  const api = window.electronAPI, folder = boardPath.replace(/\\/g, '/').replace(/\.canvas$/i, '')
  let name = '子画板'
  for (let n = 2; (await api.document.stat(`${root}/${folder}/${name}.canvas`))?.success; n++) name = `子画板 ${n}`
  const made = await api.document.mkdir(`${root}/${folder}`)
  if (!made.success) throw new Error(made.error || '无法建立画板文件夹')
  // The sub-board carries its name as its title, so its breadcrumb and label read it.
  const created = await api.canvas.create({ path: `${folder}/${name}.canvas`, operationId: crypto.randomUUID(), canvas: { nodes: [], edges: [], ready: { id: crypto.randomUUID(), schemaVersion: 1, title: name } } })
  if (!created.ok) throw new Error(created.error)
  await api.canvas.release(created.value.handleId)
  await add({ ...newCardFrame(at, 195), type: 'file', file: created.value.path, ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: created.value.objectId } } })
}
