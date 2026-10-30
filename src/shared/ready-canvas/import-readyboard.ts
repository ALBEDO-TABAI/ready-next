import { z } from 'zod'
import { CanvasIdSchema, CanvasPathSchema, GraphicSchema, type CanvasNode, type Graphic, type NodeReady } from './schema'
import { createImport, type CanvasConversion, type ImportAsset, type ImportOptions } from './import-common'
import { graphicSvg, graphicFrame } from './graphics'
import { sha256 } from './serialization'

const number = z.number().finite()
const base = { id: CanvasIdSchema, x: number, y: number, width: number.positive(), height: number.positive(), rotation: number.optional() }
const sourcePath = CanvasPathSchema.refine(path => path.startsWith('assets/'), 'Expected old assets/ reference')
const nodes = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('text'), text: z.string(), fontSize: number.positive(), color: z.string() }),
  z.object({ ...base, type: z.literal('note'), text: z.string(), color: z.string(), background: z.string() }),
  z.object({ ...base, type: z.literal('image'), src: sourcePath, title: z.string().optional(), alt: z.string().optional(), externalReceiptId: CanvasIdSchema.optional() }),
  z.object({ ...base, type: z.literal('video'), src: sourcePath, title: z.string().optional() }),
  z.object({ ...base, type: z.literal('markdown'), src: sourcePath, title: z.string(), excerpt: z.string() }),
  z.object({ ...base, type: z.literal('rect'), fill: z.string(), stroke: z.string() }),
  z.object({ ...base, type: z.literal('arrow'), x2: number, y2: number, stroke: z.string(), strokeWidth: number }),
  z.object({ ...base, type: z.literal('path'), points: z.array(z.object({ x: number, y: number })), stroke: z.string(), strokeWidth: number }),
])
const stateSchema = z.object({ version: z.literal(1), engineVersion: z.string(), title: z.string(),
  viewport: z.object({ x: number, y: number, zoom: number.positive() }), nodes: z.array(nodes), updatedAt: z.string(),
})
export interface ReadyboardImportOptions extends ImportOptions {
  externalReceipts?: Array<{ id: string; asset: { src: string; kind: 'image' | 'video' | 'markdown'; name: string; width?: number; height?: number; title?: string; excerpt?: string } }>
}

/** Input is the old HTML's extracted state JSON, never its executable document. */
export async function importReadyboard(source: string, options: ReadyboardImportOptions): Promise<CanvasConversion> {
  const state = stateSchema.parse(JSON.parse(source))
  if (new Set(state.nodes.map(n => n.id)).size !== state.nodes.length) throw new Error('Duplicate old node ID')
  const imported = await createImport(source, options, state.title)
  imported.result.localState = { viewport: state.viewport }
  const pending = [...state.nodes]
  const receiptIds = new Set<string>()
  for (const receipt of options.externalReceipts ?? []) {
    CanvasIdSchema.parse(receipt.id)
    if (receiptIds.has(receipt.id)) throw new Error(`Duplicate external receipt: ${receipt.id}`)
    receiptIds.add(receipt.id)
    if (pending.some(n => 'src' in n && (n.src === receipt.asset.src || (n.type === 'image' && n.externalReceiptId === receipt.id)))) continue
    const asset = receipt.asset
    pending.push(nodes.parse({ id: `receipt-${receipt.id}`, type: asset.kind, src: asset.src, title: asset.title ?? asset.name,
      excerpt: asset.excerpt ?? '', x: 0, y: 0, width: asset.width ?? 320, height: asset.height ?? 240,
      ...(asset.kind === 'image' ? { externalReceiptId: receipt.id } : {}),
    }))
  }
  for (const old of pending) {
    const geometry = imported.geometry(old.id, old.x, old.y, old.width, old.height)
    const appearance: NonNullable<NodeReady['appearance']> = { ...(old.rotation === undefined ? {} : { rotation: old.rotation }) }
    const common = { id: old.id, ...geometry }
    let node: CanvasNode
    if (old.type === 'text' || old.type === 'note') {
      appearance.color = old.color
      if (old.type === 'text') appearance.fontScale = old.fontSize / 24
      else appearance.background = old.background
      node = { ...common, type: 'text', text: old.text, ready: { kind: old.type, appearance, sources: imported.sources } }
    } else if ('src' in old) {
      const asset = await imported.attachment(old.src, old.id)
      const ready: NodeReady = { kind: old.type === 'markdown' ? 'document' : old.type, appearance, sources: imported.sources }
      if (old.title !== undefined) ready.preview = { title: old.title, ...(old.type === 'markdown' ? { description: old.excerpt } : {}) }
      if (old.type === 'image' && old.alt) ready.preview = { ...ready.preview, description: old.alt }
      if (asset && old.type !== 'markdown') ready.media = { mime: asset.mime, sha256: asset.sha256 }
      node = { ...common, type: 'file', file: asset?.path ?? `${imported.assetRoot}/missing-${encodeURIComponent(old.id)}-${old.src.split('/').pop()}`, ready }
    } else {
      let graphic: Graphic
      if (old.type === 'rect') graphic = { type: 'rect', fill: old.fill, stroke: old.stroke, strokeWidth: 1 }
      else if (old.type === 'arrow') graphic = { type: 'arrow', x2: old.x2, y2: old.y2, stroke: old.stroke, strokeWidth: old.strokeWidth }
      else graphic = { type: 'path', points: old.points, stroke: old.stroke, strokeWidth: old.strokeWidth }
      graphic = GraphicSchema.parse(graphic)
      const bytes = new TextEncoder().encode(graphicSvg(graphic, geometry.width, geometry.height))
      const path = `${imported.assetRoot}/${await sha256(bytes)}.svg`
      if (!imported.result.attachments.some(a => a.path === path)) imported.result.attachments.push({ source: `generated:${old.id}`, path, mime: 'image/svg+xml', sha256: await sha256(bytes), bytes })
      const frame = graphicFrame(graphic, geometry.width, geometry.height)
      const bounds = graphic.type === 'arrow' ? imported.geometry(old.id, old.x + frame.x, old.y + frame.y, frame.width, frame.height) : geometry
      node = { ...common, ...bounds, type: 'file', file: path, ready: { kind: 'graphic', graphic, appearance, sources: imported.sources } }
    }
    imported.add(imported.result.canvas, old.id, node)
  }
  // Receipts affect replay identity even when their image already has a node.
  imported.result.sourceFingerprint = await sha256(imported.result.sourceFingerprint + JSON.stringify(options.externalReceipts ?? []))
  return imported.finish()
}
export type { ImportAsset }
