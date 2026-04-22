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
 * - 'array' → z.array(<element>) where element is picked from items.type
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

function elementTypeOf(param: SkillParamDefinition): string {
  const raw = param.items && typeof param.items === 'object'
    ? (param.items as Record<string, unknown>).type
    : undefined
  return typeof raw === 'string' ? raw : 'unknown'
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
    const element = elementTypeOf(param)
    if (element === 'string') return z.array(z.string())
    if (element === 'number' || element === 'integer') return z.array(z.number())
    if (element === 'boolean') return z.array(z.boolean())
    if (element === 'object') {
      const inner = z.record(z.string(), z.unknown())
      const items = param.items as Record<string, unknown> | undefined
      if (items && items.additionalProperties === true) {
        return z.array(inner.meta({ additionalProperties: true }))
      }
      return z.array(inner)
    }
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
