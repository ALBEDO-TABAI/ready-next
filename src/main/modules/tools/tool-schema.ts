export interface ToolParamSchemaSpec {
  name: string
  type: string
  description: string
  required: boolean
  enum?: string[]
  items?: Record<string, unknown>
  additionalProperties?: boolean
}

function normalizeSchemaObject(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    normalized[key] = normalizeToolJsonSchema(value)
  }

  const rawType = normalized.type
  const isArraySchema = rawType === 'array'
    || (Array.isArray(rawType) && rawType.includes('array'))

  if (isArraySchema && typeof normalized.items === 'undefined') {
    normalized.items = {}
  }

  return normalized
}

export function normalizeToolJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeToolJsonSchema(entry))
  }

  if (!schema || typeof schema !== 'object') {
    return schema
  }

  return normalizeSchemaObject(schema as Record<string, unknown>)
}

export function buildToolParamSchema(param: ToolParamSchemaSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: param.type,
    description: param.description,
  }

  if (param.enum) schema.enum = param.enum
  if (param.type === 'array') schema.items = normalizeToolJsonSchema(param.items || {}) as Record<string, unknown>
  if (param.type === 'object' && typeof param.additionalProperties !== 'undefined') {
    schema.additionalProperties = param.additionalProperties
  }

  return normalizeSchemaObject(schema)
}

export function normalizeOpenAIToolSchema(tool: Record<string, unknown>): Record<string, unknown> {
  if (tool.type !== 'function') return tool

  const fn = tool.function && typeof tool.function === 'object'
    ? tool.function as Record<string, unknown>
    : {}

  return {
    ...tool,
    function: {
      ...fn,
      parameters: normalizeToolJsonSchema(fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} }),
    },
  }
}

export function normalizeAnthropicToolSchema(tool: Record<string, unknown>): Record<string, unknown> {
  const inputSchema = tool.input_schema && typeof tool.input_schema === 'object'
    ? tool.input_schema
    : { type: 'object', properties: {} }

  return {
    ...tool,
    input_schema: normalizeToolJsonSchema(inputSchema),
  }
}
