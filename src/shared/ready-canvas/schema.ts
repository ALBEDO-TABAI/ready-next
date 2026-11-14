import { z } from 'zod'
import { ReadyRefSchema, parseReadyUri } from '../ready-ref'

export const CanvasIdSchema = z.string().min(1).refine(value => !/[\s/\\\p{Cc}\uD800-\uDFFF]/u.test(value), 'Invalid object/node ID')
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const finite = z.number().finite()
const integer = finite.int().safe()
const date = z.iso.datetime({ offset: true })
const color = z.string().regex(/^(#[a-f\d]{3,8}|[a-zA-Z]+|(?:rgb|hsl)a?\([\d.,%\s+-]+\))$/i)
const canvasColor = z.string().regex(/^(#[a-f\d]{6}|[1-6])$/i)
export function isCanvasPath(value: string): boolean {
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return false }
  if (/%[a-f\d]{2}/i.test(decoded)) return false
  return [value, decoded].every(path => path.length > 0 && !/[\\:\p{Cc}?#]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
}
export const CanvasPathSchema = z.string().refine(isCanvasPath, 'Expected a safe library-relative path')
export const AssetPathSchema = CanvasPathSchema.refine(path => path.split('/').slice(0, -1).some(part => part.endsWith('.assets')), 'Expected a .assets path')
const sourceUri = z.string().refine(value => parseReadyUri(value).ok || ReadyRefSchema.safeParse({ kind: 'web', url: value }).success, 'Invalid source URI')
export const TrashSchema = z.strictObject({ operationId: CanvasIdSchema, deletedAt: date })
export const AppearanceSchema = z.strictObject({
  fontScale: finite.positive().max(16).optional(), align: z.enum(['left', 'center', 'right']).optional(),
  weight: z.enum(['light', 'regular', 'medium', 'bold']).optional(), color: color.optional(), background: color.optional(),
  radius: finite.min(0).max(4096).optional(), collapsed: z.boolean().optional(), rotation: finite.min(-360).max(360).optional(),
  crop: z.union([
    z.strictObject({ mode: z.literal('rect'), x: finite.min(0).max(1), y: finite.min(0).max(1), w: finite.positive().max(1), h: finite.positive().max(1) })
      .refine(c => c.x + c.w <= 1 && c.y + c.h <= 1, 'Crop exceeds image'),
    z.strictObject({ mode: z.literal('position'), x: finite.min(0).max(100), y: finite.min(0).max(100) }),
  ]).optional(),
})
const stroke = { stroke: color, strokeWidth: finite.positive().max(4096) }
export const GraphicSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('rect'), fill: color, ...stroke }),
  z.strictObject({ type: z.literal('arrow'), x2: finite, y2: finite, ...stroke }),
  z.strictObject({ type: z.literal('path'), points: z.array(z.strictObject({ x: finite, y: finite })).min(2), ...stroke }),
])
export const NodeReadySchema = z.strictObject({
  kind: z.enum(['text', 'note', 'image', 'video', 'audio', 'document', 'link', 'group', 'subcanvas', 'graphic', 'draft']),
  ref: ReadyRefSchema.optional(),
  sources: z.array(z.strictObject({ uri: sourceUri, title: z.string().optional(), capturedAt: date.optional(), method: z.string().min(1), fastCardId: CanvasIdSchema.optional() })).optional(),
  fastCard: z.strictObject({ id: CanvasIdSchema, kind: z.enum(['text', 'image', 'video', 'translation', 'image-description']), createdAt: date,
    originalText: z.string().optional(), targetLanguage: z.string().optional() }).optional(),
  media: z.strictObject({ mime: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/), sha256: Sha256Schema, originalName: z.string().optional(),
    durationMs: finite.nonnegative().optional(), transcript: z.string().optional(), poster: AssetPathSchema.optional() }).optional(),
  preview: z.strictObject({ title: z.string().optional(), description: z.string().optional(), site: z.string().optional(), image: AssetPathSchema.optional(), fetchedAt: date.optional() }).optional(),
  appearance: AppearanceSchema.optional(), dock: z.strictObject({ left: CanvasIdSchema.optional(), top: CanvasIdSchema.optional() }).optional(),
  groupId: CanvasIdSchema.optional(), graphic: GraphicSchema.optional(), draftId: CanvasIdSchema.optional(), draftLibraryId: CanvasIdSchema.optional(), trash: TrashSchema.optional(),
})
const base = { id: CanvasIdSchema, x: integer, y: integer, width: integer.positive(), height: integer.positive(), color: canvasColor.optional() }
const standardVariants = [
  z.looseObject({ ...base, type: z.literal('text'), text: z.string() }),
  z.looseObject({ ...base, type: z.literal('file'), file: CanvasPathSchema, subpath: z.string().startsWith('#').min(2).optional() }),
  z.looseObject({ ...base, type: z.literal('link'), url: z.url() }),
  z.looseObject({ ...base, type: z.literal('group'), label: z.string().optional(), background: CanvasPathSchema.optional(), backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional() }),
] as const
function standardFields(node: z.infer<typeof standardVariants[number]>, ctx: z.RefinementCtx): void {
  const fields = { text: ['text'], file: ['file', 'subpath'], link: ['url'], group: ['label', 'background', 'backgroundStyle'] }
  for (const key of Object.values(fields).flat()) if (key in node && !fields[node.type].includes(key)) {
    ctx.addIssue({ code: 'custom', message: `Standard field ${key} is invalid on ${node.type}` })
  }
}
export const StandardNodeSchema = z.discriminatedUnion('type', standardVariants).superRefine(standardFields)
export const CanvasNodeSchema = z.discriminatedUnion('type', [
  standardVariants[0].extend({ ready: NodeReadySchema }), standardVariants[1].extend({ ready: NodeReadySchema }),
  standardVariants[2].extend({ ready: NodeReadySchema }), standardVariants[3].extend({ ready: NodeReadySchema }),
]).superRefine((node, ctx) => {
  standardFields(node, ctx)
  const r = node.ready
  const kinds = { text: ['text', 'note', 'draft'], file: ['image', 'video', 'audio', 'document', 'subcanvas', 'graphic'], link: ['link'], group: ['group'] }
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['ready'] })
  if (!kinds[node.type].includes(r.kind)) fail('kind does not match standard node type')
  if ((r.kind === 'graphic') !== (r.graphic !== undefined)) fail('graphic requires kind=graphic and parameters')
  if (r.kind === 'graphic' && node.type === 'file' && !node.file.endsWith('.svg')) fail('Graphic file must be SVG')
  if (r.kind === 'draft' ? !r.draftId || !r.draftLibraryId : r.draftId !== undefined || r.draftLibraryId !== undefined) fail('Invalid draft identity')
  if (r.media && !['image', 'video', 'audio'].includes(r.kind)) fail('media only belongs to media nodes')
  if (r.media && !r.media.mime.startsWith(`${r.kind}/`)) fail('Media MIME does not match kind')
  if (r.kind === 'subcanvas' && (r.ref?.kind !== 'canvas' || r.ref.node !== undefined || node.type !== 'file' || !node.file.endsWith('.canvas'))) fail('Subcanvas requires a whole canvas reference and .canvas file')
  if (node.type === 'file' && r.ref && !['page', 'file', 'canvas'].includes(r.ref.kind)) fail('Invalid document reference')
  if (node.type === 'file' && r.ref) {
    const anchor = 'anchor' in r.ref ? r.ref.anchor : r.ref.kind === 'canvas' && r.ref.node ? `node=${r.ref.node}` : undefined
    if (node.subpath !== (anchor === undefined ? undefined : `#${anchor}`)) fail('ref and subpath disagree')
  }
})
const edgeBase = {
  id: CanvasIdSchema, fromNode: CanvasIdSchema, toNode: CanvasIdSchema,
  fromSide: z.enum(['top', 'right', 'bottom', 'left']).optional(), toSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
  fromEnd: z.enum(['none', 'arrow']).optional(), toEnd: z.enum(['none', 'arrow']).optional(), color: canvasColor.optional(), label: z.string().optional(),
}
export const CanvasEdgeSchema = z.looseObject({ ...edgeBase, ready: z.strictObject({ trash: TrashSchema.optional() }).optional() })
const StandardEdgeSchema = z.looseObject(edgeBase)
export const RootReadySchema = z.strictObject({ schemaVersion: z.literal(1), id: CanvasIdSchema, title: z.string().optional() })

function topology(nodes: Array<{ id: string }>, edges: Array<{ id: string; fromNode: string; toNode: string }>, ctx: z.RefinementCtx): void {
  const ids = new Set<string>()
  for (const item of [...nodes, ...edges]) {
    if (ids.has(item.id)) ctx.addIssue({ code: 'custom', message: `Duplicate ID: ${item.id}` })
    ids.add(item.id)
  }
  const nodeIds = new Set(nodes.map(n => n.id))
  for (const e of edges) if (!nodeIds.has(e.fromNode) || !nodeIds.has(e.toNode)) ctx.addIssue({ code: 'custom', message: `Dangling edge: ${e.id}` })
}
export function assertAcyclic(graph: Map<string, string[]>): void {
  const visiting = new Set<string>(), done = new Set<string>()
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Ownership cycle: ${id}`)
    if (done.has(id)) return
    visiting.add(id)
    for (const next of graph.get(id) ?? []) visit(next)
    visiting.delete(id); done.add(id)
  }
  for (const id of graph.keys()) visit(id)
}
export const StandardCanvasSchema = z.looseObject({ nodes: z.array(StandardNodeSchema).optional(), edges: z.array(StandardEdgeSchema).optional() })
  .superRefine((value, ctx) => topology(value.nodes ?? [], value.edges ?? [], ctx))
export const ReadyCanvasSchema = z.looseObject({ nodes: z.array(CanvasNodeSchema), edges: z.array(CanvasEdgeSchema), ready: RootReadySchema })
  .superRefine((canvas, ctx) => {
    topology(canvas.nodes, canvas.edges, ctx)
    const nodes = new Map(canvas.nodes.map(n => [n.id, n]))
    const graph = new Map<string, string[]>()
    for (const n of canvas.nodes) {
      const r = n.ready, refs = [r.dock?.left, r.dock?.top, r.groupId].filter((id): id is string => id !== undefined)
      graph.set(n.id, refs)
      for (const id of refs) if (!nodes.has(id)) ctx.addIssue({ code: 'custom', message: `Dangling membership: ${n.id} -> ${id}` })
      if (r.groupId && nodes.get(r.groupId)?.type !== 'group') ctx.addIssue({ code: 'custom', message: `groupId is not a group: ${n.id}` })
      if (r.kind === 'subcanvas' && r.ref?.kind === 'canvas' && r.ref.id === canvas.ready.id) ctx.addIssue({ code: 'custom', message: 'Subcanvas owns itself' })
    }
    try { assertAcyclic(graph) } catch (error) { ctx.addIssue({ code: 'custom', message: String(error) }) }
  })
export type ReadyCanvas = z.infer<typeof ReadyCanvasSchema>
export type CanvasNode = z.infer<typeof CanvasNodeSchema>
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>
export type NodeReady = z.infer<typeof NodeReadySchema>
export type Graphic = z.infer<typeof GraphicSchema>
export type Appearance = z.infer<typeof AppearanceSchema>
export type Trash = z.infer<typeof TrashSchema>
export type CanvasReadResult = { mode: 'editable'; canvas: ReadyCanvas } | { mode: 'readonly'; schemaVersion: number; raw: unknown }

/** Unknown Ready versions remain opaque. Never pass their data to a v1 writer. */
export function readCanvas(input: unknown): CanvasReadResult {
  const envelope = z.looseObject({ ready: z.looseObject({ schemaVersion: integer.positive() }) }).parse(input)
  if (envelope.ready.schemaVersion !== 1) {
    StandardCanvasSchema.parse(input)
    return { mode: 'readonly', schemaVersion: envelope.ready.schemaVersion, raw: structuredClone(input) }
  }
  return { mode: 'editable', canvas: ReadyCanvasSchema.parse(input) }
}

/** Caller supplies a verified library snapshot; paths are library-relative, not OS paths. */
export function validateCanvasCollection(entries: Array<{ path: string; canvas: ReadyCanvas }>, objects: ReadonlyMap<string, string> = new Map(), recycled: ReadonlySet<string> = new Set()): void {
  const paths = new Map(objects), graph = new Map<string, string[]>(), parents = new Map<string, string>()
  const seen = new Set<string>(), seenPaths = new Set<string>()
  const subpaths: Array<{ path: string; file: string; id: string }> = []
  for (const entry of entries) {
    CanvasPathSchema.parse(entry.path); ReadyCanvasSchema.parse(entry.canvas)
    const id = entry.canvas.ready.id
    if (seen.has(id) || seenPaths.has(entry.path)) throw new Error(`Duplicate canvas identity/path: ${id}`)
    if (paths.has(id) && paths.get(id) !== entry.path) throw new Error(`Canvas identity conflicts with object snapshot: ${id}`)
    seen.add(id); seenPaths.add(entry.path); paths.set(id, entry.path)
  }
  for (const { path, canvas } of entries) {
    const children: string[] = []
    for (const node of canvas.nodes) {
      if (node.type !== 'file' || !node.ready.ref) continue
      // A sub-board card in the bin: its file is in the library bin with it (M4 §9.3), so there is nothing to resolve.
      // The same holds for a card whose sub-board was recycled from the library (`recycled`): the card waits for it.
      if (node.ready.kind === 'subcanvas' && (node.ready.trash || (node.ready.ref.kind === 'canvas' && recycled.has(node.ready.ref.id)))) continue
      const ref = node.ready.ref
      if (!('id' in ref) || paths.get(ref.id) !== node.file) throw new Error(`Unresolved or mismatched ref/file: ${node.id}`)
      if (node.ready.kind !== 'subcanvas') continue
      subpaths.push({ path, file: node.file, id: node.id })
      if (parents.has(ref.id)) throw new Error(`Multiple subcanvas owners: ${ref.id}`)
      parents.set(ref.id, canvas.ready.id); children.push(ref.id)
    }
    graph.set(canvas.ready.id, children)
  }
  assertAcyclic(graph)
  for (const item of subpaths) if (!item.file.startsWith(`${item.path.replace(/\.canvas$/, '')}/`)) throw new Error(`Subcanvas outside parent directory: ${item.id}`)
}
