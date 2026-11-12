import { useEffect, useState } from 'react'
import { readReadyRefTransfers, type ReadyRef } from '../../../shared/ready-ref'

// Dragstart cannot await IPC: prepare identity while a file is displayed. Drop actions locate it again in Main.
const identities = new Map<string, { ref: ReadyRef; path: string; directory: boolean }>()
export async function prepareFileDragRef(path: string, directory = false): Promise<ReadyRef> {
  const location = await window.electronAPI.objects.resolvePath(path)
  const ref: ReadyRef = { kind: directory ? 'file' : /\.canvas$/i.test(path) ? 'canvas' : /\.(md|markdown)$/i.test(path) ? 'page' : 'file', id: location.objectId }
  identities.set(path, { ref, path: location.path, directory })
  return ref
}
export function useFileDragRef(path: string | undefined, directory = false, revision?: number): ReadyRef | null {
  const [ready, setReady] = useState<{ path: string; ref: ReadyRef } | null>(null)
  useEffect(() => {
    let disposed = false
    if (path) void prepareFileDragRef(path, directory).then(ref => { if (!disposed) setReady({ path, ref }) }, error => { console.warn('[drag] prepare file identity failed', error) })
    return () => { disposed = true }
  }, [path, directory, revision])
  return ready && ready.path === path ? ready.ref : null
}
export function fileDragRef(path: string): ReadyRef {
  const ready = identities.get(path)
  if (!ready) throw new Error('文件身份尚未就绪，请稍后再拖动')
  return ready.ref
}
export function knownDraggedPath(data: Pick<DataTransfer, 'getData'>): string | null {
  return knownDraggedPaths(data)[0] ?? null
}
export function knownDraggedPaths(data: Pick<DataTransfer, 'getData'>): string[] {
  return readReadyRefTransfers(data).flatMap(({ ref }) => {
    if (!['page', 'file', 'canvas'].includes(ref.kind) || !('id' in ref)) return []
    const path = [...identities.values()].find(item => !item.directory && 'id' in item.ref && item.ref.id === ref.id)?.path
    return path ? [path] : []
  })
}
