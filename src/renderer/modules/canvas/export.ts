import type { ReadyCanvas } from '../../../shared/ready-canvas/schema'
import { activeCanvasContent } from '../../../shared/ready-canvas/operations'

/** A path written relative to the board's own folder, as a Markdown file beside it would link it. */
function relativeTo(boardPath: string, file: string): string {
  const from = boardPath.replace(/\\/g, '/').split('/').slice(0, -1), to = file.replace(/\\/g, '/').split('/')
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/')
}

/**
 * The board (or the chosen cards) as Markdown in reading order: rows from top to bottom, cards left to right
 * within a row (W4 §2.2 导出). Text and notes keep their source; links, images, documents and sub-boards become
 * links; shapes and groups have no text and are left out.
 */
export function boardMarkdown(canvas: ReadyCanvas, boardPath: string, ids?: ReadonlySet<string>): string {
  const nodes = activeCanvasContent(canvas).nodes
    .filter(node => (!ids || ids.has(node.id)) && node.type !== 'group' && node.ready.kind !== 'graphic')
    .sort((a, b) => Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x)
  const parts = nodes.map(node => {
    if (node.type === 'text') return node.text.trim()
    if (node.type === 'link') return `[${node.ready.preview?.title || node.url}](${node.url})`
    if (node.type !== 'file') return ''
    const href = encodeURI(relativeTo(boardPath, node.file))
    const label = node.ready.preview?.title || node.file.split('/').pop()!.replace(/\.(md|canvas)$/i, '')
    return node.ready.kind === 'image' ? `![${label}](${href})` : `[${label}](${href})`
  }).filter(Boolean)
  return `# ${canvas.ready.title || boardPath.split('/').pop()!.replace(/\.canvas$/i, '') || '画板'}\n\n${parts.join('\n\n')}\n`
}
