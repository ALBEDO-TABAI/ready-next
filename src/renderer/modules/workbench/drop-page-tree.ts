import { readReadyRefTransfers, type ReadyRef } from '../../../shared/ready-ref'

export async function dropPageTreeReference(data: Pick<DataTransfer, 'getData'>, destination: { root?: string; parentObjectId?: string; parentPath?: string }): Promise<boolean> {
  const dropped = readReadyRefTransfers(data)
  if (!dropped.length || dropped.some(({ ref }) => (ref.kind !== 'page' && ref.kind !== 'file') || ref.anchor !== undefined)) return false
  let root = destination.root
  if (!root) {
    const vault = await window.electronAPI.vault.get()
    if (vault.status !== 'ready') throw new Error('请先配置资料库')
    root = vault.root
  }
  for (const { ref } of dropped) if (ref.kind === 'page' || ref.kind === 'file') await moveReference(ref, { ...destination, root })
  return true
}
async function moveReference(ref: Extract<ReadyRef, { kind: 'page' | 'file' }>, destination: { root: string; parentObjectId?: string; parentPath?: string }): Promise<void> {
  if (ref.kind === 'file') {
    const api = window.electronAPI, source = await api.objects.locate(ref.id)
    if (!source) throw new Error('文件已不存在')
    const parent = destination.parentObjectId ? await api.objects.locate(destination.parentObjectId) : null
    const directory = destination.parentPath || parent?.path.replace(/\.(md|markdown)$/i, '')
    if (!directory) throw new Error('目标位置已不存在')
    const stat = await api.document.stat(directory)
    if (!stat.success) {
      const created = await api.document.mkdir(directory)
      if (!created.success) throw new Error(created.error || '无法创建子页面目录')
    }
    const result = await api.document.moveItem(source.path, `${directory}/${source.path.split(/[\\/]/).pop()}`)
    if (!result.success) throw new Error(result.error || '文件移动失败')
    return
  }
  const result = await window.electronAPI.documentPages.operate({ type: 'move', operationId: crypto.randomUUID(), objectId: ref.id, ...destination })
  if (!result.ok) throw new Error(result.message)
}
