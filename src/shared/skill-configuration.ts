import type { ExternalServiceKind } from './external-services'

export type SkillConfigFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select'
export type SkillConfigValue = string | number | boolean | null

export interface SkillConfigSelectOption {
  value: string
  label: string
}

export interface SkillConfigFieldDefinition {
  id: string
  label: string
  description?: string
  type: SkillConfigFieldType
  required?: boolean
  defaultValue?: SkillConfigValue
  options?: SkillConfigSelectOption[]
}

export interface SkillServiceBindingDefinition {
  id: string
  label: string
  description?: string
  required?: boolean
  allowedKinds: ExternalServiceKind[]
  defaultServiceId?: string
}

export interface SkillConfigurationDefinition {
  version: 1
  serviceBindings: SkillServiceBindingDefinition[]
  fields: SkillConfigFieldDefinition[]
}

export interface SkillConfigurationValues {
  serviceBindings: Record<string, string>
  fields: Record<string, SkillConfigValue>
}

export interface SkillConfigurationView {
  skillId: string
  definition: SkillConfigurationDefinition | null
  values: SkillConfigurationValues
}

export interface SkillConfigurationUpdateInput {
  skillId: string
  serviceBindings?: Record<string, string>
  fields?: Record<string, SkillConfigValue>
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeKinds(value: unknown): ExternalServiceKind[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return raw
    .map((item) => String(item).trim())
    .filter((item): item is ExternalServiceKind => (
      item === 'tavily'
      || item === 'anysearch'
      || item === 'duckduckgo'
      || item === 'jina'
      || item === 'rsshub'
      || item === 'bilibili'
      || item === 'github'
      || item === 'vision-model'
    ))
}

function normalizeFieldValue(value: unknown): SkillConfigValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return undefined
}

export function normalizeSkillConfiguration(raw: unknown): SkillConfigurationDefinition | undefined {
  const input = asObject(raw)
  if (Object.keys(input).length === 0) return undefined

  const rawBindings = Array.isArray(input.serviceBindings)
    ? input.serviceBindings
    : Array.isArray(input.service_bindings)
      ? input.service_bindings
      : []
  const serviceBindings = rawBindings.flatMap((entry): SkillServiceBindingDefinition[] => {
    const item = asObject(entry)
    const id = asString(item.id)
    const label = asString(item.label)
    const allowedKinds = normalizeKinds(item.allowedKinds ?? item.allowed_kinds ?? item.kind)
    if (!id || !label || allowedKinds.length === 0) return []
    return [{
      id,
      label,
      description: asString(item.description) || undefined,
      required: asBoolean(item.required),
      allowedKinds,
      defaultServiceId: asString(item.defaultServiceId ?? item.default_service_id) || undefined,
    }]
  })

  const rawFields = Array.isArray(input.fields) ? input.fields : []
  const fields = rawFields.flatMap((entry): SkillConfigFieldDefinition[] => {
    const item = asObject(entry)
    const id = asString(item.id)
    const label = asString(item.label)
    const type = asString(item.type) as SkillConfigFieldType
    if (!id || !label || !['text', 'password', 'number', 'boolean', 'select'].includes(type)) return []
    const rawOptions = Array.isArray(item.options) ? item.options : []
    return [{
      id,
      label,
      description: asString(item.description) || undefined,
      type,
      required: asBoolean(item.required),
      defaultValue: normalizeFieldValue(item.defaultValue ?? item.default_value),
      options: rawOptions.flatMap((rawOption): SkillConfigSelectOption[] => {
        const option = asObject(rawOption)
        const value = asString(option.value)
        const optionLabel = asString(option.label)
        return value && optionLabel ? [{ value, label: optionLabel }] : []
      }),
    }]
  })

  return {
    version: 1,
    serviceBindings,
    fields,
  }
}

export function buildDefaultSkillConfigurationValues(
  definition: SkillConfigurationDefinition | null | undefined,
): SkillConfigurationValues {
  const serviceBindings: Record<string, string> = {}
  const fields: Record<string, SkillConfigValue> = {}
  for (const binding of definition?.serviceBindings || []) {
    if (binding.defaultServiceId) serviceBindings[binding.id] = binding.defaultServiceId
  }
  for (const field of definition?.fields || []) {
    if (field.defaultValue !== undefined) fields[field.id] = field.defaultValue
  }
  return { serviceBindings, fields }
}

export function mergeSkillConfigurationValues(
  definition: SkillConfigurationDefinition | null | undefined,
  raw: unknown,
): SkillConfigurationValues {
  const defaults = buildDefaultSkillConfigurationValues(definition)
  const input = asObject(raw)
  const rawBindings = asObject(input.serviceBindings)
  const rawFields = asObject(input.fields)

  for (const binding of definition?.serviceBindings || []) {
    const value = asString(rawBindings[binding.id])
    if (value) defaults.serviceBindings[binding.id] = value
  }
  for (const field of definition?.fields || []) {
    const value = normalizeFieldValue(rawFields[field.id])
    if (value !== undefined) defaults.fields[field.id] = value
  }
  return defaults
}
