/**
 * Build a Zod ZodObject from a SkillParamDefinition[] (Phase 2.5 PR 12).
 *
 * This is the inverse of zodObjectToParamList. Used by the dynamic
 * skill-action tool pipeline: manifests declare params as SkillParamDefinition
 * arrays, and we need Zod schemas at dispatch entry to validate them before
 * the handler runs. Caching these per `(skillId, actionName)` lets us avoid
 * rebuilding on every tool call.
 *
 * Type mapping:
 * - 'string' + enum → z.enum(enum)
 * - 'string' → z.string()
 * - 'number' → z.number()
 * - 'boolean' → LenientBoolean (accepts true/false/'true'/'false'/'1'/'0'/1/0)
 * - 'object' → z.record(z.string(), z.unknown()) + optional .meta({
 *     additionalProperties: true }) if the legacy param set it
 * - 'array' → z.array(<element>) recursively rebuilt from items, including
 *   structured object properties, required fields, enums and length bounds
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

import type { SkillParamDefinition } from '../../../shared/skill-execution-types'

const LenientBoolean = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
  z.literal(1).transform(() => true),
  z.literal(0).transform(() => false),
])

function describeSchema(
  schema: z.ZodTypeAny,
  definition: Record<string, unknown>,
): z.ZodTypeAny {
  const description = definition.description
  return typeof description === 'string' && description.length > 0
    ? schema.describe(description)
    : schema
}

function buildJsonSchemaNode(definition: Record<string, unknown>): z.ZodTypeAny {
  const type = typeof definition.type === 'string'
    ? definition.type.toLowerCase()
    : ''
  let schema: z.ZodTypeAny

  if (type === 'string') {
    const enumValues = Array.isArray(definition.enum)
      ? definition.enum.filter((value): value is string => typeof value === 'string')
      : []
    if (enumValues.length > 0) {
      schema = z.enum(enumValues as [string, ...string[]])
    } else {
      let stringSchema = z.string()
      if (typeof definition.minLength === 'number') {
        stringSchema = stringSchema.min(definition.minLength)
      }
      if (typeof definition.maxLength === 'number') {
        stringSchema = stringSchema.max(definition.maxLength)
      }
      schema = stringSchema
    }
  } else if (type === 'number' || type === 'integer') {
    let numberSchema = type === 'integer' ? z.number().int() : z.number()
    if (typeof definition.minimum === 'number') {
      numberSchema = numberSchema.min(definition.minimum)
    }
    if (typeof definition.maximum === 'number') {
      numberSchema = numberSchema.max(definition.maximum)
    }
    schema = numberSchema
  } else if (type === 'boolean') {
    schema = z.boolean()
  } else if (type === 'array') {
    const items = definition.items
    const element = items && typeof items === 'object' && !Array.isArray(items)
      ? buildJsonSchemaNode(items as Record<string, unknown>)
      : z.unknown()
    let arraySchema = z.array(element)
    if (typeof definition.minItems === 'number') {
      arraySchema = arraySchema.min(definition.minItems)
    }
    if (typeof definition.maxItems === 'number') {
      arraySchema = arraySchema.max(definition.maxItems)
    }
    schema = arraySchema
  } else if (type === 'object') {
    const properties = definition.properties
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const required = new Set(
        Array.isArray(definition.required)
          ? definition.required.filter((value): value is string => typeof value === 'string')
          : [],
      )
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [name, property] of Object.entries(properties)) {
        if (!property || typeof property !== 'object' || Array.isArray(property)) continue
        const propertyDefinition = property as Record<string, unknown>
        let node = buildJsonSchemaNode(propertyDefinition)
        if (!required.has(name)) {
          node = node.optional()
          node = describeSchema(node, propertyDefinition)
        }
        shape[name] = node
      }
      schema = definition.additionalProperties === true
        ? z.looseObject(shape).meta({ additionalProperties: true })
        : z.object(shape).meta({ additionalProperties: false })
    } else {
      const record = z.record(z.string(), z.unknown())
      schema = definition.additionalProperties === true
        ? record.meta({ additionalProperties: true })
        : record
    }
  } else {
    schema = z.unknown()
  }

  return describeSchema(schema, definition)
}

function buildLeafSchema(param: SkillParamDefinition): z.ZodTypeAny {
  const type = String(param.type || '').toLowerCase()
  if (type === 'string') {
    if (Array.isArray(param.enum) && param.enum.length > 0) {
      return z.enum(param.enum as [string, ...string[]])
    }
    return z.string()
  }
  if (type === 'number' || type === 'integer') return z.number()
  if (type === 'boolean') return LenientBoolean
  if (type === 'object') {
    const base = z.record(z.string(), z.unknown())
    if (param.additionalProperties === true) {
      return base.meta({ additionalProperties: true })
    }
    return base
  }
  if (type === 'array') {
    const items = param.items as Record<string, unknown> | undefined
    if (items) return z.array(buildJsonSchemaNode(items))
    return z.array(z.unknown())
  }
  // Unknown leaf type — accept anything and rely on handler for deeper validation.
  return z.unknown()
}

export function paramListToZodObject(
  params: SkillParamDefinition[],
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const param of params) {
    if (!param || typeof param.name !== 'string' || !param.name) continue
    let node: z.ZodTypeAny = buildLeafSchema(param)
    if (typeof param.description === 'string' && param.description.length > 0) {
      node = node.describe(param.description)
    }
    if (param.required === false) {
      node = node.optional()
      if (typeof param.description === 'string' && param.description.length > 0) {
        node = node.describe(param.description)
      }
    }
    shape[param.name] = node
  }
  return z.object(shape as z.ZodRawShape)
}
