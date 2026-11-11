import { readReadyRefTransfer, readReadyRefTransfers, writeReadyRefTransfer, toReadyUri } from '../../../shared/ready-ref'
import type { CanvasNode, CanvasOperation } from '../../../shared/ready-canvas'
import { eventCard } from '../../../shared/calendar-linkage'
import { referenceMarkdown } from '../workbench/capture'
import { loadObjectPreview } from '../workbench/object-ui/preview'

export async function dropCanvasReference(data: Pick<DataTransfer, 'getData'>, at: { x: number; y: number }, target: {
  objectId: string; root: string; write(operations: CanvasOperation[]): Promise<void>; refresh(): Promise<void>
}): Promise<boolean> {
  const all = readReadyRefTransfers(data)
  if (all.length > 1) {
    if (all.every(item => item.ref.kind === 'fastcard')) {
      const result = await window.electronAPI.fastCard.transfer({ operationId: crypto.randomUUID(), itemIds: all.map(item => { if (item.ref.kind !== 'fastcard') throw new Error('Invalid card'); return item.ref.id }), target: { kind: 'existing', objectId: target.objectId }, position: at })
      if (!result.success) throw new Error(result.error || '未存入画板')
      await target.refresh()
    } else {
      if (all.some(item => item.ref.kind === 'fastcard')) throw new Error('请分开拖入暂存与其他引用')
      const operations: CanvasOperation[] = []
      for (const [index, item] of all.entries()) {
        const values = new Map<string, string>()
        writeReadyRefTransfer({ setData: (key, value) => { values.set(key, value) } }, item.ref, item.title)
        await dropCanvasReference({ getData: key => values.get(key) || '' }, { x: at.x + index * 320, y: at.y }, { ...target, write: async commands => { operations.push(...commands) } })
      }
      await target.write(operations)
    }
    return true
  }
  const dropped = readReadyRefTransfer(data)
  if (!dropped) return false
  const { ref, title } = dropped, api = window.electronAPI
  if (ref.kind === 'fastcard') {
    const result = await api.fastCard.transfer({ operationId: crypto.randomUUID(), itemIds: [ref.id], target: { kind: 'existing', objectId: target.objectId }, position: at })
    if (!result.success) throw new Error(result.error || '未存入画板')
    await target.refresh()
    return true
  }
  const frame = { id: crypto.randomUUID(), x: Math.round(at.x), y: Math.round(at.y), width: 300, height: 180 }
  const sources = [{ uri: toReadyUri(ref), title, method: 'reference' }]
  let node: CanvasNode
  if (ref.kind === 'event') node = eventCard(ref, frame)
  else if ((ref.kind === 'page' || ref.kind === 'file') && !ref.anchor?.startsWith('^hl-')) {
    const location = await api.objects.locate(ref.id)
    if (!location || !location.path.startsWith(target.root + '/')) throw new Error('页面或文件不在当前资料库')
    node = { ...frame, type: 'file', file: location.path.slice(target.root.length + 1), ...(ref.anchor ? { subpath: `#${ref.anchor}` } : {}), ready: { kind: 'document', ref, sources } }
  } else if (ref.kind === 'web' || ref.kind === 'rss-item') {
    const preview = ref.kind === 'rss-item' ? await loadObjectPreview(ref) : null
    if (preview && (preview.state !== 'ready' || preview.data?.kind !== 'rss-item')) throw new Error('文章引用已失效')
    const url = ref.kind === 'web' ? ref.url : preview?.state === 'ready' && preview.data?.kind === 'rss-item' ? preview.data.article.link : toReadyUri(ref)
    node = { ...frame, type: 'link', url, ready: { kind: 'link', ref, sources } }
  } else {
    const preview = await loadObjectPreview(ref)
    if (preview.state !== 'ready') throw new Error(preview.message)
    node = { ...frame, type: 'text', text: `${preview.body}\n\n${referenceMarkdown(ref, title || preview.title)}`, ready: { kind: 'note', ref, sources } }
  }
  await target.write([{ type: 'addNode', node }])
  return true
}
