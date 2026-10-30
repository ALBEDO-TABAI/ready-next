import { readCanvas, activeCanvasContent } from '../../../shared/ready-canvas'
import { toReadyUri } from '../../../shared/ready-ref'
import type { ExtractedObjectLink } from '../../../shared/object-links'
import { extractObjectLinks, linkTarget } from './object-link-extract'

/** Shared by file observation, writes and full rebuild. Node IDs never depend on drawing order. */
export function extractCanvasLinks(raw: string): ExtractedObjectLink[] {
  const parsed = readCanvas(JSON.parse(raw))
  if (parsed.mode === 'readonly') return []
  const result: ExtractedObjectLink[] = []
  for (const node of activeCanvasContent(parsed.canvas).nodes) {
    const links: ExtractedObjectLink[] = []
    if (node.ready.ref) links.push(linkTarget(toReadyUri(node.ready.ref), 'canvas-node', null, null))
    else if (node.type === 'file') links.push(linkTarget(node.file, 'canvas-node', null, null))
    if (node.type === 'link') links.push(linkTarget(node.url, 'canvas-node', null, null))
    if (node.type === 'text') links.push(...extractObjectLinks(node.text))
    for (const source of node.ready.sources ?? []) links.push(linkTarget(source.uri, 'card-source', null, null))
    result.push(...links.map(link => ({ ...link, sourceNodeId: node.id })))
  }
  return result
}
