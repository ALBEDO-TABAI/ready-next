import { z } from 'zod'
import { AppearanceSchema, CanvasEdgeSchema, CanvasIdSchema, CanvasNodeSchema, CanvasPathSchema, GraphicSchema, ReadyCanvasSchema, Sha256Schema, TrashSchema } from '../../../shared/ready-canvas'
const id = CanvasIdSchema, geometry = z.strictObject({ x: z.number().int().optional(), y: z.number().int().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() })
const operation = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('addNode'), node: CanvasNodeSchema, index: z.number().int().nonnegative().optional() }),
  z.strictObject({ type: z.literal('replaceNode'), node: CanvasNodeSchema }),
  z.strictObject({ type: z.literal('deleteNode'), id }),
  z.strictObject({ type: z.literal('geometry'), id, geometry }),
  z.strictObject({ type: z.literal('addEdge'), edge: CanvasEdgeSchema, index: z.number().int().nonnegative().optional() }),
  z.strictObject({ type: z.literal('replaceEdge'), edge: CanvasEdgeSchema }),
  z.strictObject({ type: z.literal('deleteEdge'), id }),
  z.strictObject({ type: z.literal('group'), ids: z.array(id), groupId: id.nullable() }),
  z.strictObject({ type: z.literal('appearance'), id, appearance: AppearanceSchema.nullable() }),
  z.strictObject({ type: z.literal('graphic'), id, graphic: GraphicSchema, file: CanvasPathSchema }),
  z.strictObject({ type: z.literal('textRanges'), id, expectedTextVersion: z.string().min(1), ranges: z.array(z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), expectedText: z.string(), replacement: z.string() })) }),
  z.strictObject({ type: z.literal('trash'), ids: z.array(id), edgeIds: z.array(id).optional(), trash: TrashSchema }),
  z.strictObject({ type: z.literal('restore'), ids: z.array(id), edgeIds: z.array(id).optional() }),
])
export const WriteSchema = z.object({ objectId: id, handleId: id, expectedVersion: Sha256Schema, operationId: id, commands: z.array(z.union([operation,
  z.strictObject({ type: z.literal('batch'), operations: z.array(operation) }),
  z.strictObject({ type: z.literal('importAttachment'), sourceToken: id, node: CanvasNodeSchema }),
  z.strictObject({ type: z.literal('createSubcanvas'), path: CanvasPathSchema, canvas: ReadyCanvasSchema, node: CanvasNodeSchema }),
])) })
export const CreateSchema = z.object({ path: CanvasPathSchema.refine(p => p.endsWith('.canvas')), operationId: id, canvas: ReadyCanvasSchema.optional() })
export const BufferSchema = z.strictObject({ objectId: id, tabId: id, openGeneration: z.number().int().nonnegative(), bufferVersion: z.number().int().nonnegative(), baseVersion: Sha256Schema, canvas: ReadyCanvasSchema })
export type CanvasBuffer = z.infer<typeof BufferSchema>
