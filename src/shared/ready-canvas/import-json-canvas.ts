import { rewriteMarkdownMediaRefs } from '../markdown-asset-refs'
import { createImport, type CanvasConversion, type ImportOptions } from './import-common'
import { ReadyCanvasSchema, StandardCanvasSchema, readCanvas } from './schema'

/** An already identified Ready canvas never receives a replacement identity. */
export async function importJsonCanvas(source: string, options: ImportOptions): Promise<CanvasConversion> {
  const raw: unknown = JSON.parse(source)
  const standard = StandardCanvasSchema.parse(raw)
  const existing = standard.ready === undefined ? undefined : readCanvas(raw)
  if (existing?.mode === 'readonly') throw new Error(`Readonly Ready schema version: ${existing.schemaVersion}`)
  const imported = await createImport(source, { ...options, objectId: existing?.canvas.ready.id ?? options.objectId }, existing?.canvas.ready.title)
  imported.result.canvas = existing?.canvas ?? ReadyCanvasSchema.parse({ ...standard,
    nodes: (standard.nodes ?? []).map(node => ({ ...node, ready: node.ready ?? { kind: node.type === 'file' ? 'document' : node.type, sources: imported.sources } })),
    edges: standard.edges ?? [], ready: { schemaVersion: 1, id: options.objectId },
  })
  async function resource(path: string, id: string, copy: boolean): Promise<string> {
    if (copy && options.assets.some(asset => asset.source === path)) {
      const asset = await imported.attachment(path, id)
      if (asset) return asset.path
    }
    imported.result.incomplete.push({ sourceId: id, reason: `Library file requires Main verification: ${path}` })
    return path
  }
  for (const node of imported.result.canvas.nodes) {
    imported.result.identityMap.push({ sourceId: node.id, canvasId: imported.result.canvas.ready.id, nodeId: node.id })
    if (node.type === 'file') {
      node.file = await resource(node.file, node.id, !node.ready.ref)
      const copied = imported.result.attachments.find(asset => asset.path === node.file)
      if (copied && node.ready.media && copied.sha256 !== node.ready.media.sha256) throw new Error(`Media hash mismatch: ${node.id}`)
    }
    if (node.type === 'group' && node.background) node.background = await resource(node.background, node.id, true)
    if (node.ready.preview?.image) node.ready.preview.image = await resource(node.ready.preview.image, node.id, true)
    if (node.ready.media?.poster) node.ready.media.poster = await resource(node.ready.media.poster, node.id, true)
    if (node.type === 'text') {
      const paths = new Set<string>(), rewrites = new Map<string, string>()
      rewriteMarkdownMediaRefs(node.text, ref => { if (ref.localCandidate) paths.add(ref.rawDest); return null })
      for (const path of paths) rewrites.set(path, await resource(path, node.id, true))
      node.text = rewriteMarkdownMediaRefs(node.text, ref => rewrites.get(ref.rawDest) ?? null)
    }
  }
  return imported.finish()
}
