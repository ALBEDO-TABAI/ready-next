import { z } from 'zod'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { CanvasIdSchema, NodeReadySchema, assertAcyclic, validateCanvasCollection, type CanvasNode, type NodeReady, type ReadyCanvas } from './schema'
import { rewriteMarkdownMediaRefs } from '../markdown-asset-refs'
import { createImport, type CanvasConversion, type ImportOptions } from './import-common'

const number = z.number().finite()
const metaSchema = z.looseObject({
  packed: z.boolean().optional(), titleLevel: z.literal('p').optional(),
  dock: z.object({ l: CanvasIdSchema.optional(), t: CanvasIdSchema.optional() }).nullable().optional(),
  titleAlign: z.enum(['left', 'center', 'right']).optional(), titleWeight: z.enum(['light', 'regular', 'medium']).optional(),
  displayWidth: number.positive().optional(), titleFontScale: number.positive().optional(), frameH: number.positive().optional(),
  url: z.string().optional(), domain: z.string().optional(), linkTitle: z.string().optional(), linkImage: z.string().optional(),
  linkDescription: z.string().optional(), linkSite: z.string().optional(), previewUpdatedAt: number.optional(),
  aspectRatio: number.positive().optional(), lightImage: z.boolean().optional(), rotation: number.int().optional(),
  crop: z.object({ x: number.min(0).max(100), y: number.min(0).max(100), w: number, h: number }).nullable().optional(),
  originalFilename: z.string().optional(), poster: z.string().optional(), transcript: z.string().optional(),
})
const noteSchema = z.looseObject({
  id: CanvasIdSchema, type: z.enum(['text', 'image', 'link', 'folder', 'audio', 'video']), title: z.string(), text: z.string(),
  createdAt: number, updatedAt: number, canvasX: number, canvasY: number, parentId: CanvasIdSchema.nullable(), deletedAt: number.nullable(),
  mediaUrl: z.string().optional(), audioUrl: z.string().optional(), duration: z.string().optional(), metadata: metaSchema,
})
export interface StillroomImportOptions extends ImportOptions {
  sourceKind: 'complete-zip' | 'autosave-json'
  childObjectIds: Readonly<Record<string, string>>
}
const iso = (value: number) => new Date(value).toISOString()

/** ZIP extraction/limits and original archive hashing belong to Main, before this pure conversion. */
export async function importStillroom(source: string, options: StillroomImportOptions): Promise<CanvasConversion> {
  z.enum(['complete-zip', 'autosave-json']).parse(options.sourceKind)
  const space = z.looseObject({ app: z.literal('stillroom'), version: z.literal(1), notes: z.array(noteSchema), cam: z.unknown().optional(), prefs: z.unknown().optional() }).parse(JSON.parse(source))
  const notes = new Map(space.notes.map(n => [n.id, n]))
  if (notes.size !== space.notes.length) throw new Error('Duplicate Stillroom note ID')
  const graph = new Map<string, string[]>()
  for (const note of space.notes) {
    if (note.parentId && notes.get(note.parentId)?.type !== 'folder') throw new Error(`Missing parent folder: ${note.id}`)
    graph.set(note.id, note.parentId ? [note.parentId] : [])
  }
  assertAcyclic(graph)
  const imported = await createImport(source, options)
  imported.result.localState = { cam: space.cam ?? null, prefs: space.prefs ?? null }
  if (options.sourceKind === 'autosave-json') imported.result.incomplete.push({ sourceId: 'space', reason: 'Autosave JSON is not a complete space ZIP, even with separate media' })
  const boards = new Map<string | null, { path: string; canvas: ReadyCanvas }>([[null, { path: options.canvasPath, canvas: imported.result.canvas }]])
  function board(folderId: string | null): { path: string; canvas: ReadyCanvas } {
    const existing = boards.get(folderId)
    if (existing) return existing
    const folder = notes.get(folderId!)!
    const parent = board(folder.parentId), objectId = CanvasIdSchema.parse(options.childObjectIds[folder.id])
    const path = `${parent.path.replace(/\.canvas$/, '')}/${encodeURIComponent(folder.id)}.canvas`
    const child: ReadyCanvas = { nodes: [], edges: [], ready: { schemaVersion: 1, id: objectId, title: folder.title } }
    const entry = { path, canvas: child }
    boards.set(folder.id, entry); imported.result.subcanvases.push(entry)
    imported.result.identityMap.push({ sourceId: folder.id, canvasId: objectId })
    return entry
  }
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' }).use(gfm).remove(['script', 'style', 'iframe'])
  for (const note of space.notes) {
    const owner = board(note.parentId), meta = note.metadata
    const hasBody = !!note.text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    const packed = note.type === 'text' && (meta.packed ?? hasBody)
    const width = meta.displayWidth ?? (['image', 'video'].includes(note.type) ? 320 : 260)
    const fs = 18 * (meta.titleFontScale ?? 1)
    const textHeight = Math.max(66, Math.round(Math.max(1, Math.ceil(0.5 * (note.title || ' ').length * fs / Math.max(1, width - 34))) * fs * 1.2 + 34))
    const height = note.type === 'image' || note.type === 'video' ? width * (meta.aspectRatio ?? (note.type === 'image' ? 0.75 : 0.5625))
      : note.type === 'folder' ? width : note.type === 'link' ? width * 0.75 : note.type === 'audio' ? 140
        : meta.frameH ?? (packed ? Math.min(195, textHeight + 60) : textHeight)
    imported.result.transformations.push(`${note.id}: size estimated from Stillroom layout; no measured DOM size in archive`)
    const geometry = imported.geometry(note.id, note.canvasX, note.canvasY, width, height)
    const ready: NodeReady = { kind: note.type === 'folder' ? 'subcanvas' : note.type, sources: imported.sources.map(s => ({ ...s, capturedAt: iso(note.createdAt) })), appearance: {} }
    const appearance = ready.appearance!
    if (meta.titleAlign !== undefined) appearance.align = meta.titleAlign
    if (meta.titleWeight !== undefined) appearance.weight = meta.titleWeight
    appearance.fontScale = (meta.titleLevel === 'p' ? 12 : 18) / 24 * (meta.titleFontScale ?? 1)
    if (meta.rotation !== undefined) appearance.rotation = ((meta.rotation % 4) + 4) % 4 * 90
    if (meta.crop) {
      appearance.crop = { mode: 'position', x: meta.crop.x, y: meta.crop.y }
      if (meta.crop.w !== 1 || meta.crop.h !== 1) imported.result.incomplete.push({ sourceId: note.id, reason: `Unused Stillroom crop dimensions: ${JSON.stringify(meta.crop)}` })
    }
    if (note.type === 'text') {
      appearance.collapsed = packed
      appearance.align ??= packed || meta.titleLevel === 'p' ? 'left' : 'center'
      appearance.weight ??= 'regular'
    }
    if (meta.lightImage !== undefined) imported.result.incomplete.push({ sourceId: note.id, reason: `Stillroom lightImage has no active rendering rule: ${meta.lightImage}` })
    if (meta.dock) ready.dock = { ...(meta.dock.l ? { left: meta.dock.l } : {}), ...(meta.dock.t ? { top: meta.dock.t } : {}) }
    if (note.deletedAt !== null) ready.trash = { operationId: `import-${note.id}`, deletedAt: iso(note.deletedAt) }
    ready.preview = { title: meta.linkTitle ?? note.title,
      ...(meta.linkDescription === undefined ? {} : { description: meta.linkDescription }),
      ...(meta.linkSite === undefined ? {} : { site: meta.linkSite }),
      ...(meta.previewUpdatedAt === undefined ? {} : { fetchedAt: iso(meta.previewUpdatedAt) }),
    }
    const unknownMeta = Object.keys(meta).filter(key => !(key in metaSchema.shape))
    for (const key of unknownMeta) imported.result.incomplete.push({ sourceId: note.id, reason: `Unconverted Stillroom metadata ${key}: ${JSON.stringify(meta[key])}` })
    for (const key of Object.keys(note).filter(key => !(key in noteSchema.shape))) imported.result.incomplete.push({ sourceId: note.id, reason: `Unconverted Stillroom field ${key}: ${JSON.stringify(note[key])}` })
    const mediaSource = (value: string) => value.startsWith('idb:') ? `media/${value.slice(4)}` : value
    for (const [value, field] of [[meta.linkImage, 'image'], [meta.poster, 'poster']] as const) if (value) {
      const asset = await imported.attachment(mediaSource(value), note.id, owner.path)
      if (asset && field === 'image') ready.preview.image = asset.path
      // Poster is attached below, after primary media has been verified.
    }
    if (/<(?:script|style|iframe|object|video|audio|svg)\b|\sstyle\s*=/i.test(note.text)) imported.result.incomplete.push({ sourceId: note.id, reason: `HTML styling or embedded content cannot be fully represented: ${note.text}` })
    let markdown = turndown.turndown(note.text)
    const refs = new Set<string>()
    rewriteMarkdownMediaRefs(markdown, ref => { refs.add(ref.rawDest); return null })
    const rewritten = new Map<string, string>()
    for (const ref of refs) {
      const asset = await imported.attachment(mediaSource(ref), note.id, owner.path)
      if (asset) rewritten.set(ref, asset.path)
    }
    markdown = rewriteMarkdownMediaRefs(markdown, ref => rewritten.get(ref.rawDest) ?? null)
    const common = { id: note.id, ...geometry, ready }
    let node: CanvasNode
    const title = note.title.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&')
    if (note.type === 'text') node = { ...common, type: 'text', text: [note.title ? `${meta.titleLevel === 'p' ? '' : '# '}${title}` : '', markdown].filter(Boolean).join('\n\n') }
    else if (note.type === 'folder') {
      const child = board(note.id)
      ready.ref = { kind: 'canvas', id: child.canvas.ready.id }
      node = { ...common, type: 'file', file: child.path }
    } else if (note.type === 'link') {
      const url = meta.url ?? note.mediaUrl
      if (!url) throw new Error(`Link has no URL: ${note.id}`)
      ready.sources = NodeReadySchema.shape.sources.unwrap().parse([...ready.sources!, { uri: url, title: note.title, capturedAt: iso(note.createdAt), method: 'import' }])
      node = { ...common, type: 'link', url }
    } else {
      const ref = note.type === 'audio' ? note.audioUrl : note.mediaUrl
      const asset = await imported.attachment(ref ? mediaSource(ref) : `missing:${note.id}`, note.id, owner.path)
      if (asset) {
        ready.media = { mime: asset.mime, sha256: asset.sha256,
          ...(meta.originalFilename === undefined ? {} : { originalName: meta.originalFilename }),
          ...(meta.transcript === undefined ? {} : { transcript: meta.transcript }),
        }
        if (meta.poster) {
          const poster = await imported.attachment(mediaSource(meta.poster), note.id, owner.path)
          if (poster) ready.media.poster = poster.path
        }
        if (note.duration) {
          const match = /^(\d+):([0-5]\d)$/.exec(note.duration)
          if (!match) imported.result.incomplete.push({ sourceId: note.id, reason: `Invalid audio duration: ${note.duration}` })
          else ready.media.durationMs = (Number(match[1]) * 60 + Number(match[2])) * 1000
        }
      }
      node = { ...common, type: 'file', file: asset?.path ?? `${owner.path.replace(/\.canvas$/, '.assets')}/missing-${encodeURIComponent(note.id)}` }
    }
    if (note.type !== 'text' && markdown) {
      // Non-text cards have no standard body; preserve the full converted body as their description.
      ready.preview.description = [ready.preview.description, markdown].filter(Boolean).join('\n\n')
    }
    imported.add(owner.canvas, note.id, node)
  }
  const result = imported.finish()
  validateCanvasCollection([{ path: options.canvasPath, canvas: result.canvas }, ...result.subcanvases])
  return result
}
