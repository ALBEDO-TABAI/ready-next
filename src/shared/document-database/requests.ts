import { z } from 'zod'
import { DatabaseDefinitionSchema, StorageKeySchema } from './schema'
const identity = z.string().min(1)
const base = { databaseId: identity }
const fields = z.record(z.string(), z.unknown())
export const UserStateSchema = z.object({ currentViewId: identity.optional(), widths: z.record(z.string(), z.number().finite().positive()).optional(), scroll: z.object({ x: z.number().finite(), y: z.number().finite() }).optional() }).strict()
export const DatabaseRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('query'), viewId: identity, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1000).default(1000) }).strict(),
  z.object({ ...base, type: z.literal('read') }).strict(),
  z.object({ ...base, type: z.literal('setFields'), rowId: identity, expectedVersion: identity, set: fields, remove: z.array(identity).optional() }).strict(),
  z.object({ ...base, type: z.literal('createRow'), operationId: identity, title: identity, values: fields, body: z.string().default('') }).strict(),
  z.object({ ...base, type: z.literal('deleteRow'), operationId: identity, rowId: identity }).strict(),
  z.object({ ...base, type: z.literal('setDefinition'), expectedVersion: identity, definition: DatabaseDefinitionSchema }).strict(),
  z.object({ ...base, type: z.literal('renameKey'), operationId: identity, expectedVersion: identity, fieldId: identity, key: StorageKeySchema }).strict(),
  z.object({ ...base, type: z.literal('getState') }).strict(),
  z.object({ ...base, type: z.literal('setState'), state: UserStateSchema }).strict(),
  z.object({ ...base, type: z.literal('operation'), operationId: identity }).strict(),
])
export type DatabaseRequest = z.input<typeof DatabaseRequestSchema>
export type DatabaseReply = { ok: true; value: unknown } | { ok: false; code: string; message: string }
