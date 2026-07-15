/**
 * Derive SkillParamDefinition[] from a Zod ZodObject.
 *
 * Used by skill-execution-tool-defs.ts so the 6 control tool param lists are
 * generated from their Zod schemas rather than hand-authored. Kills drift
 * between the runtime validator (safeParse) and the LLM-facing JSONSchema.
 *
 * Supported node types: ZodString, ZodBoolean, ZodObject, ZodRecord, ZodArray,
 * ZodOptional, ZodDefault, ZodEnum, ZodUnion (maps to first concrete member's
 * effective type — a lenient-boolean union falls out as 'boolean'). Any other
 * Zod node throws a loud error so missing coverage surfaces in tests.
 *
 * Pure module — no electron, no side effects.
 */

import {
  z,
  type ZodObject,
  type ZodRawShape,
  type ZodTypeAny,
} from 'zod'

import type { SkillParamDefinition } from '../../../shared/skill-execution-types'

type ResolvedParam = {
  type: string
  enum?: string[]
  items?: Record<string, unknown>
  additionalProperties?: boolean
}

function getDef(node: ZodTypeAny): Record<string, unknown> | null {
  const anyNode = node as unknown as { _def?: Record<string, unknown>; def?: Record<string, unknown> }
  return (anyNode._def as Record<string, unknown> | undefined) ?? (anyNode.def as Record<string, unknown> | undefined) ?? null
}

function getTypeName(node: ZodTypeAny): string {
  const def = getDef(node)
  if (!def) return ''
  const typeName = (def.typeName as string | undefined)
    || (def.type as string | undefined)
    || ''
  return typeName
}

function metaAdditionalPropertiesOf(node: ZodTypeAny): boolean | undefined {
  // Allow per-field opt-in via .meta({ additionalProperties: true }) for the
  // rare case where the LLM-facing schema needs to advertise that extra keys
  // are accepted (e.g. browser_start_task.payload). Default Zod records map
  // to {type:'object'} without this flag — adding it unconditionally would
  // change the LLM-facing output for every earlier-migrated domain.
  const metaFn = (node as unknown as { meta?: () => Record<string, unknown> | undefined }).meta
  if (typeof metaFn === 'function') {
    const meta = metaFn.call(node)
    if (meta && typeof meta === 'object') {
      const value = (meta as Record<string, unknown>).additionalProperties
      if (typeof value === 'boolean') return value
    }
  }
  return undefined
}

function describeOf(node: ZodTypeAny): string | undefined {
  // Zod v4 exposes `description` as a getter on the schema instance. It does
  // NOT propagate through wrappers (ZodOptional / ZodDefault), so callers
  // check both the outer node and the unwrapped inner.
  const direct = (node as unknown as { description?: string }).description
  if (typeof direct === 'string' && direct.length > 0) return direct
  const metaFn = (node as unknown as { meta?: () => Record<string, unknown> | undefined }).meta
  if (typeof metaFn === 'function') {
    const meta = metaFn.call(node)
    const fromMeta = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).description : undefined
    if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta
  }
  const def = getDef(node)
  if (def && typeof def.description === 'string' && (def.description as string).length > 0) {
    return def.description as string
  }
  return undefined
}

function innerOf(node: ZodTypeAny): ZodTypeAny | null {
  const def = getDef(node)
  if (!def) return null
  const inner = (def.innerType as ZodTypeAny | undefined)
    ?? (def.schema as ZodTypeAny | undefined)
  return inner ?? null
}

function unwrap(node: ZodTypeAny): { inner: ZodTypeAny; optional: boolean } {
  let current: ZodTypeAny = node
  let optional = false
  // Unwrap ZodDefault → ZodOptional → any further optional/default chain.
  while (true) {
    const name = getTypeName(current)
    if (name === 'ZodDefault' || name === 'default') {
      const inner = innerOf(current)
      if (!inner) break
      current = inner
      continue
    }
    if (name === 'ZodOptional' || name === 'optional' || name === 'ZodNullable' || name === 'nullable') {
      optional = true
      const inner = innerOf(current)
      if (!inner) break
      current = inner
      continue
    }
    break
  }
  return { inner: current, optional }
}

function resolveParamType(node: ZodTypeAny): ResolvedParam {
  const typeName = getTypeName(node)
  switch (typeName) {
    case 'ZodString':
    case 'string':
      return { type: 'string' }
    case 'ZodBoolean':
    case 'boolean':
      return { type: 'boolean' }
    case 'ZodNumber':
    case 'number':
      return { type: 'number' }
    case 'ZodObject':
    case 'object':
      return { type: 'object' }
    case 'ZodRecord':
    case 'record':
      return { type: 'object' }
    case 'ZodArray':
    case 'array': {
      // Zod v4 arrays expose the element schema at def.element (some versions
      // also expose def.type as a ZodType). Try both and fall back to an empty
      // items object so the schema normalizer still emits items: {} downstream.
      const def = getDef(node) || {}
      const element = (def.element as ZodTypeAny | undefined)
        ?? (def.type as ZodTypeAny | undefined)
        ?? (def.schema as ZodTypeAny | undefined)
      if (element && typeof element === 'object') {
        try {
          const unwrapped = unwrap(element).inner
          const elemResolved = resolveParamType(unwrapped)
          if (elemResolved.type === 'object' && ['ZodObject', 'object'].includes(getTypeName(unwrapped))) {
            const { $schema: _schema, ...items } = z.toJSONSchema(unwrapped) as Record<string, unknown>
            return { type: 'array', items }
          }
          const items: Record<string, unknown> = { type: elemResolved.type }
          if (elemResolved.additionalProperties !== undefined) {
            items.additionalProperties = elemResolved.additionalProperties
          }
          const elementMetaAdditional = metaAdditionalPropertiesOf(element as ZodTypeAny)
            ?? metaAdditionalPropertiesOf(unwrapped)
          if (elementMetaAdditional !== undefined) {
            items.additionalProperties = elementMetaAdditional
          }
          return { type: 'array', items }
        } catch {
          // Unknown element type — fall through to untyped items.
        }
      }
      return { type: 'array' }
    }
    case 'ZodEnum':
    case 'enum': {
      const def = getDef(node) || {}
      const raw = (def.values as unknown) ?? (def.entries as unknown) ?? (def.options as unknown)
      const values = Array.isArray(raw)
        ? raw.map((v) => String(v))
        : raw && typeof raw === 'object'
          ? Object.keys(raw as Record<string, unknown>)
          : []
      return { type: 'string', enum: values.length > 0 ? values : undefined }
    }
    case 'ZodLiteral':
    case 'literal': {
      const def = getDef(node) || {}
      const value = def.value
      if (typeof value === 'boolean') return { type: 'boolean' }
      if (typeof value === 'number') return { type: 'number' }
      return { type: 'string' }
    }
    case 'ZodUnion':
    case 'union': {
      // Map union to the first member's resolved type. This is how the
      // lenient-boolean union (boolean | 'true' | 'false' | ...) collapses
      // to a single param type=boolean for the LLM schema.
      const def = getDef(node) || {}
      const options = (def.options as ZodTypeAny[] | undefined) || []
      if (options.length === 0) break
      const first = unwrap(options[0]!).inner
      return resolveParamType(first)
    }
    case 'ZodPipeline':
    case 'pipe':
    case 'pipeline': {
      // transform/coerce pipelines: inspect the input schema.
      const def = getDef(node) || {}
      const input = (def.in as ZodTypeAny | undefined) ?? (def.input as ZodTypeAny | undefined)
      if (input) return resolveParamType(unwrap(input).inner)
      break
    }
  }
  throw new Error(
    `zod-param-derivation: unsupported Zod node type "${typeName || 'unknown'}" — add a branch in resolveParamType`,
  )
}

/**
 * Convert a ZodObject to the legacy SkillParamDefinition[] used by the
 * LLM-facing JSONSchema builder. Optional fields → required=false.
 * ZodUnion collapses to the first member's type (see lenient-boolean).
 */
export function zodObjectToParamList(
  schema: ZodObject<ZodRawShape>,
  opts: { requireDescriptions?: boolean } = {},
): SkillParamDefinition[] {
  const requireDescriptions = opts.requireDescriptions !== false
  const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape
  const params: SkillParamDefinition[] = []
  for (const [name, node] of Object.entries(shape)) {
    const { inner, optional } = unwrap(node)
    const description = describeOf(node) ?? describeOf(inner) ?? ''
    if (requireDescriptions && !description) {
      throw new Error(`zod-param-derivation: field "${name}" is missing .describe()`)
    }
    const resolved = resolveParamType(inner)
    const param: SkillParamDefinition = {
      name,
      type: resolved.type,
      description,
      required: !optional,
    }
    if (resolved.enum) {
      param.enum = resolved.enum
    }
    if (resolved.items) {
      param.items = resolved.items
    }
    if (resolved.additionalProperties !== undefined) {
      param.additionalProperties = resolved.additionalProperties
    }
    const fieldMetaAdditional = metaAdditionalPropertiesOf(node)
      ?? metaAdditionalPropertiesOf(inner)
    if (fieldMetaAdditional !== undefined) {
      param.additionalProperties = fieldMetaAdditional
    }
    params.push(param)
  }
  return params
}
