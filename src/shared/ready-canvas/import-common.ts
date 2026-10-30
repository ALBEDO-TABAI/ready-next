import { z } from 'zod'
import { CanvasIdSchema, CanvasPathSchema, NodeReadySchema, ReadyCanvasSchema, type CanvasNode, type ReadyCanvas } from './schema'
import { sha256, stableJson } from './serialization'

export interface ImportAsset { source: string; bytes: Uint8Array; mime: string; originalName?: string }
export interface ImportOptions {
  objectId: string; canvasPath: string; sourceUri: string; assets: readonly ImportAsset[]
}
export interface CanvasConversion {
  canvas: ReadyCanvas
  subcanvases: Array<{ path: string; canvas: ReadyCanvas }>
  attachments: Array<{ source: string; path: string; mime: string; sha256: string; bytes: Uint8Array }>
  identityMap: Array<{ sourceId: string; canvasId: string; nodeId?: string }>
  sourceFingerprint: string
  incomplete: Array<{ sourceId: string; reason: string }>
  transformations: string[]
  localState: unknown
}
export async function createImport(source: string, options: ImportOptions, title?: string) {
  CanvasIdSchema.parse(options.objectId); CanvasPathSchema.parse(options.canvasPath)
  if (!options.canvasPath.endsWith('.canvas')) throw new Error('Target must be .canvas')
  const sources = NodeReadySchema.shape.sources.unwrap().parse([{ uri: options.sourceUri, method: 'import' }])
  const assets = new Map<string, ImportAsset>()
  for (const asset of options.assets) {
    if (assets.has(asset.source)) throw new Error(`Duplicate attachment source: ${asset.source}`)
    z.instanceof(Uint8Array).parse(asset.bytes)
    assets.set(asset.source, asset)
  }
  const manifest = await Promise.all(options.assets.map(async asset => ({ source: asset.source, sha256: await sha256(asset.bytes), mime: asset.mime, originalName: asset.originalName ?? null })))
  const result: CanvasConversion = {
    canvas: { nodes: [], edges: [], ready: { schemaVersion: 1, id: options.objectId, ...(title === undefined ? {} : { title }) } },
    subcanvases: [], attachments: [], identityMap: [],
    sourceFingerprint: await sha256(stableJson({ source, assets: manifest.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0) })),
    incomplete: [], transformations: [], localState: null,
  }
  const assetRoot = options.canvasPath.replace(/\.canvas$/, '.assets')
  async function attachment(sourcePath: string, sourceId: string, ownerPath = options.canvasPath): Promise<CanvasConversion['attachments'][number] | undefined> {
    const asset = assets.get(sourcePath)
    if (!asset) {
      const reason = `Missing attachment: ${sourcePath}`
      if (!result.incomplete.some(item => item.sourceId === sourceId && item.reason === reason)) result.incomplete.push({ sourceId, reason })
      return undefined
    }
    const hash = await sha256(asset.bytes)
    let name = (asset.originalName ?? sourcePath.split('/').pop() ?? 'media').replace(/[^\p{L}\p{N}._-]/gu, '_')
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' }
    if (!/\.[a-z0-9]+$/i.test(name) && extensions[asset.mime]) name += `.${extensions[asset.mime]}`
    const path = `${ownerPath.replace(/\.canvas$/, '.assets')}/${hash}-${name}`
    const existing = result.attachments.find(a => a.path === path)
    if (existing) {
      if (existing.mime !== asset.mime) throw new Error(`Conflicting attachment MIME: ${sourcePath}`)
      return existing
    }
    const item = { source: sourcePath, path, mime: asset.mime, sha256: hash, bytes: Uint8Array.from(asset.bytes) }
    result.attachments.push(item); return item
  }
  function geometry(id: string, x: number, y: number, width: number, height: number) {
    const original = { x, y, width, height }
    for (const number of Object.values(original)) if (!Number.isFinite(number)) throw new Error(`Invalid geometry: ${id}`)
    const rounded = { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
    if (width <= 0 || height <= 0) throw new Error(`Invalid dimensions: ${id}`)
    if (Object.entries(original).some(([key, value]) => value !== Reflect.get(rounded, key))) result.transformations.push(`${id}: rounded geometry ${JSON.stringify(original)} -> ${JSON.stringify(rounded)}`)
    return rounded
  }
  function add(canvas: ReadyCanvas, sourceId: string, node: CanvasNode) {
    canvas.nodes.push(node); result.identityMap.push({ sourceId, canvasId: canvas.ready.id, nodeId: node.id })
  }
  function finish(): CanvasConversion {
    result.canvas = ReadyCanvasSchema.parse(result.canvas)
    for (const child of result.subcanvases) child.canvas = ReadyCanvasSchema.parse(child.canvas)
    return result
  }
  return { result, sources, assetRoot, attachment, geometry, add, finish }
}
