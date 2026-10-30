import { basename, join, relative } from 'node:path'
import { isInside } from '../object-service/registry'
import { checkedPath, ensureDirectory } from '../document-drafts/files'
import type { FastCardBoardPort } from '../fastcard/transfer-service'
import type { CanvasService } from './canvas-service'

export function fastCardBoardPort(canvas: CanvasService): FastCardBoardPort {
  const root = canvas.root, handles = new Map<string, string>()
  return {
      list: async () => canvas.registry.list().filter(o => o.kind === 'canvas' && o.status === 'present' && o.current_path && isInside(root, o.current_path))
        .map(o => ({ objectId: o.id, title: basename(o.current_path!, '.canvas') })),
      create: async input => {
        const parent = input.parentObjectId ? canvas.registry.get(input.parentObjectId) : undefined
        if (input.parentObjectId && (!parent?.current_path || parent.status !== 'present')) throw new Error('目标位置不可用')
        const directory = checkedPath(root, parent?.current_path ? parent.current_path.replace(/\.(md|canvas)$/i, '') : input.parentPath || root)
        if (!input.title.trim() || /[/\\]/.test(input.title) || [...input.title].some(char => char.charCodeAt(0) < 32)) throw new Error('画板名称无效')
        ensureDirectory(root, directory)
        const opened = await canvas.create({ path: relative(root, join(directory, `${input.title}.canvas`)), operationId: input.operationId,
          canvas: { nodes: [], edges: [], ready: { schemaVersion: 1, id: input.objectId, title: input.title } } })
        canvas.release(opened.handleId); return { objectId: opened.objectId, title: input.title }
      },
      open: async id => { const handle = handles.get(id), opened = handle ? await canvas.read(handle) : await canvas.open(id); handles.set(id, opened.handleId); return { ...opened, libraryRoot: root, relativePath: opened.path, title: opened.canvas.ready.title || basename(opened.path, '.canvas') } },
      apply: request => canvas.write(request),
  }
}
