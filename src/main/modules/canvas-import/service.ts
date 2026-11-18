import { relativeFileReference } from '../../utils/platform'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { CanvasIdSchema, CanvasPathSchema, StandardCanvasSchema, importJsonCanvas, importReadyboard, importStillroom, stableJson, serializeCanvas, type ImportAsset, type ReadyboardImportOptions } from '../../../shared/ready-canvas'
import { READY_BOARD_STATE_SCRIPT_ID } from '../../../shared/ready-board'
import { checkedPath, hashBytes, missing, vaultRoot } from '../document-drafts/files'
import { CanvasService, type CanvasPlan } from '../board-engine/canvas-service'
import { rewriteMarkdownMediaRefs } from '../../../shared/markdown-asset-refs'
import { readSpaceZip } from './zip'
export const ImportSchema = z.strictObject({ operationId: CanvasIdSchema, sourcePath: z.string().min(1), targetPath: CanvasPathSchema.refine(p => p.endsWith('.canvas')), kind: z.enum(['readyboard', 'stillroom-zip', 'stillroom-json', 'json-canvas']), mediaDirectory: z.string().min(1).optional() })
export type CanvasImportRequest = z.infer<typeof ImportSchema>
interface ImportPlan { root: string; externalReceipts?: ReadyboardImportOptions['externalReceipts']; request: CanvasImportRequest; sourceHash: string; source: string; objectId: string; childObjectIds: Record<string, string>; assets: Array<{ source: string; content: string; mime: string; originalName: string }>; bundle?: CanvasPlan }
export interface CanvasImportReceipt { operationId: string; objectId: string; path: string; status: 'complete' | 'incomplete'; incomplete: Array<{ sourceId: string; reason: string }> }
const mime = (path: string): string => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.md': 'text/markdown' })[extname(path).toLowerCase()] ?? 'application/octet-stream'
export class CanvasImportService {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(readonly canvases: CanvasService) {}
  import(input: CanvasImportRequest): Promise<CanvasImportReceipt> {
    const request = ImportSchema.parse(input), result = this.tail.then(() => this.execute(request))
    this.tail = result.catch(() => undefined); return result
  }
  private async execute(request: CanvasImportRequest): Promise<CanvasImportReceipt> {
    const db = this.canvases.registry.db, inputHash = hashBytes(stableJson(request))
    const prior = db.prepare('SELECT * FROM canvas_imports WHERE id=?').get<{ input_hash: string; plan_json: string; result_json: string | null }>(request.operationId)
    if (prior && prior.input_hash !== inputHash) throw new Error('operation_id_reused')
    if (prior?.result_json) return JSON.parse(prior.result_json)
    let plan: ImportPlan
    if (prior) { plan = JSON.parse(prior.plan_json); if (plan.root !== this.canvases.root) throw new Error('Import belongs to another library') }
    else {
      const original = await readFile(request.sourcePath), assets: ImportPlan['assets'] = []
      let source = original.toString('utf8')
      if (request.kind === 'stillroom-zip') {
        const entries = readSpaceZip(original); source = entries.get('space.json')!.toString('utf8')
        for (const [path, bytes] of entries) if (path.startsWith('media/')) assets.push({ source: path, content: bytes.toString('base64'), mime: mime(path), originalName: path.slice(6) })
      } else {
        if (request.kind === 'readyboard' && !source.trimStart().startsWith('{')) {
          const match = new RegExp(`<script[^>]*id=["']${READY_BOARD_STATE_SCRIPT_ID}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i').exec(source)
          if (!match) throw new Error('Missing readyboard state')
          source = match[1]
        }
        const directory = request.mediaDirectory ?? (request.kind === 'readyboard' ? dirname(request.sourcePath) : undefined)
        if (directory) {
          const root = vaultRoot(directory)
          const walk = async (path: string): Promise<void> => {
            for (const entry of await readdir(path, { withFileTypes: true })) {
              const file = checkedPath(root, join(path, entry.name))
              if (entry.isDirectory()) { if (request.mediaDirectory || relativeFileReference(root, file).startsWith('assets')) await walk(file) }
              else if ((await lstat(file)).isFile() && (request.mediaDirectory || relativeFileReference(root, file).startsWith('assets/'))) {
                const key = relativeFileReference(root, file), bytes = await readFile(file)
                assets.push({ source: request.kind === 'stillroom-json' ? `media/${key}` : key, content: bytes.toString('base64'), mime: mime(file), originalName: entry.name })
              }
            }
          }
          await walk(root)
        }
      }
      let externalReceipts: ReadyboardImportOptions['externalReceipts']
      if (request.kind === 'readyboard') {
        const location = checkedPath(vaultRoot(dirname(request.sourcePath)), join(dirname(request.sourcePath), 'assets', `.${basename(request.sourcePath)}.pending-external-assets.json`))
        try {
          const parsed = z.object({ receipts: z.array(z.object({ id: CanvasIdSchema, asset: z.object({ src: CanvasPathSchema, kind: z.enum(['image', 'video', 'markdown']), name: z.string(), width: z.number().optional(), height: z.number().optional(), title: z.string().optional(), excerpt: z.string().optional() }) })) }).parse(JSON.parse(await readFile(location, 'utf8')))
          externalReceipts = parsed.receipts
        } catch (error) { if (!missing(error)) throw error }
      }
      if (request.kind === 'json-canvas' && !request.mediaDirectory) {
        const canvas = StandardCanvasSchema.parse(JSON.parse(source)), paths = new Set<string>(), root = vaultRoot(dirname(request.sourcePath))
        for (const node of canvas.nodes ?? []) {
          if (node.type === 'file') paths.add(node.file)
          if (node.type === 'group' && node.background) paths.add(node.background)
          if (node.type === 'text') rewriteMarkdownMediaRefs(node.text, ref => { if (ref.localCandidate) paths.add(ref.rawDest); return null })
        }
        for (const path of paths) {
          CanvasPathSchema.parse(path)
          try { const bytes = await readFile(checkedPath(root, join(root, path))); assets.push({ source: path, content: bytes.toString('base64'), mime: mime(path), originalName: basename(path) }) }
          catch (error) { if (!missing(error)) throw error }
        }
      }
      const childObjectIds: Record<string, string> = {}
      if (request.kind.startsWith('stillroom')) {
        const space = z.object({ notes: z.array(z.object({ id: CanvasIdSchema, type: z.string(), mediaUrl: z.string().optional(), audioUrl: z.string().optional(), metadata: z.object({ originalFilename: z.string().optional() }).optional() })) }).parse(JSON.parse(source))
        for (const note of space.notes) {
          const key = note.mediaUrl ?? note.audioUrl
          const asset = assets.find(a => a.source === (key?.startsWith('idb:') ? `media/${key.slice(4)}` : key))
          if (asset && ['image', 'video', 'audio'].includes(note.type)) {
            if (note.metadata?.originalFilename) asset.originalName = note.metadata.originalFilename
            const declared = mime(asset.originalName)
            asset.mime = declared === 'application/octet-stream' ? `${note.type}/octet-stream` : declared
          }
        }
        for (const note of space.notes) if (note.type === 'folder') childObjectIds[note.id] = randomUUID()
      }
      plan = { root: this.canvases.root, request, sourceHash: hashBytes(original), source, objectId: randomUUID(), childObjectIds, assets, ...(externalReceipts ? { externalReceipts } : {}) }
      for (const previous of db.prepare('SELECT plan_json,result_json FROM canvas_imports WHERE result_json IS NOT NULL').all<{ plan_json: string; result_json: string }>()) {
        const recorded: ImportPlan = JSON.parse(previous.plan_json)
        if (recorded.bundle?.root === this.canvases.root && recorded.request.targetPath === request.targetPath && recorded.sourceHash === plan.sourceHash && stableJson({ assets: recorded.assets, receipts: recorded.externalReceipts ?? [] }) === stableJson({ assets: plan.assets, receipts: plan.externalReceipts ?? [] })) {
          const receipt: CanvasImportReceipt = { ...JSON.parse(previous.result_json), operationId: request.operationId }
          db.prepare('INSERT INTO canvas_imports VALUES (?,?,?,?)').run(request.operationId, inputHash, JSON.stringify({ ...recorded, request }), JSON.stringify(receipt))
          return receipt
        }
      }
      db.prepare('INSERT INTO canvas_imports VALUES (?,?,?,NULL)').run(request.operationId, inputHash, JSON.stringify(plan))
    }
    if (!plan.bundle) {
      const assets: ImportAsset[] = plan.assets.map(asset => ({ source: asset.source, bytes: Buffer.from(asset.content, 'base64'), mime: asset.mime, originalName: asset.originalName }))
      const options = { objectId: plan.objectId, canvasPath: request.targetPath, sourceUri: `ready://canvas/${plan.objectId}`, assets }
      const converted = request.kind === 'readyboard' ? await importReadyboard(plan.source, { ...options, externalReceipts: plan.externalReceipts }) : request.kind === 'json-canvas' ? await importJsonCanvas(plan.source, options)
        : await importStillroom(plan.source, { ...options, sourceKind: request.kind === 'stillroom-zip' ? 'complete-zip' : 'autosave-json', childObjectIds: plan.childObjectIds })
      const incomplete: Array<{ sourceId: string; reason: string }> = []
      for (const item of converted.incomplete) {
        const prefix = 'Library file requires Main verification: '
        if (item.reason.startsWith(prefix)) {
          const path = checkedPath(this.canvases.root, join(this.canvases.root, CanvasPathSchema.parse(item.reason.slice(prefix.length))))
          try { if ((await lstat(path)).isFile()) continue } catch (error) { if (!missing(error)) throw error }
        }
        incomplete.push(item)
      }
      plan.bundle = { root: this.canvases.root, path: request.targetPath, objectId: converted.canvas.ready.id, operationId: request.operationId, original: null, content: serializeCanvas(converted.canvas), affectedNodeIds: converted.canvas.nodes.map(n => n.id), incomplete,
        files: [...converted.attachments.map(a => ({ path: a.path, content: Buffer.from(a.bytes).toString('base64'), sha256: a.sha256 })), ...converted.subcanvases.map(c => { const content = serializeCanvas(c.canvas); return { path: c.path, content: Buffer.from(content).toString('base64'), sha256: hashBytes(content) } })] }
      db.prepare('UPDATE canvas_imports SET plan_json=? WHERE id=?').run(JSON.stringify(plan), request.operationId)
    }
    const result = await this.canvases.publishBundle(plan.bundle, hashBytes(stableJson({ inputHash, sourceHash: plan.sourceHash, assets: plan.assets })))
    if (result.state !== 'completed') throw new Error(JSON.stringify(result))
    const receipt: CanvasImportReceipt = { operationId: request.operationId, objectId: result.objectId, path: request.targetPath, status: plan.bundle.incomplete?.length ? 'incomplete' : 'complete', incomplete: plan.bundle.incomplete ?? [] }
    db.prepare('UPDATE canvas_imports SET result_json=? WHERE id=?').run(JSON.stringify(receipt), request.operationId)
    return receipt
  }
  async recover(): Promise<Array<{ operationId: string; status: 'recovered' | 'pending'; message?: string }>> {
    const results: Array<{ operationId: string; status: 'recovered' | 'pending'; message?: string }> = []
    for (const row of this.canvases.registry.db.prepare('SELECT plan_json FROM canvas_imports WHERE result_json IS NULL').all<{ plan_json: string }>()) {
      const plan: ImportPlan = JSON.parse(row.plan_json)
      if (plan.root !== this.canvases.root) continue
      try { await this.import(plan.request); results.push({ operationId: plan.request.operationId, status: 'recovered' }) }
      catch (error) { results.push({ operationId: plan.request.operationId, status: 'pending', message: String(error) }) }
    }
    return results
  }
}
