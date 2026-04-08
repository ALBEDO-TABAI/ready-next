import { z } from 'zod'

interface DefinedComponentConfig<T extends z.ZodObject<any>, C> {
  name: string
  props: T
  description: string
  component: C
}

interface DefinedComponent<T extends z.ZodObject<any>, C> extends DefinedComponentConfig<T, C> {
  ref: z.ZodType<unknown>
}

interface PromptOptions {
  preamble?: string
  additionalRules?: string[]
  examples?: string[]
}

interface LibraryInput<C> {
  components: Array<DefinedComponent<z.ZodObject<any>, C>>
}

function describeField(name: string, schema: z.ZodTypeAny): string {
  const def = (schema.def || {}) as { type?: string; innerType?: z.ZodTypeAny; entries?: unknown }
  const isOptional = def.type === 'optional'
  const inner = isOptional ? (def.innerType || schema) : schema
  const innerDef = ((inner as z.ZodTypeAny).def || {}) as { type?: string; entries?: unknown }

  let typeLabel = innerDef.type
  if (innerDef.type === 'string') typeLabel = 'string'
  if (innerDef.type === 'number') typeLabel = 'number'
  if (innerDef.type === 'boolean') typeLabel = 'boolean'
  if (innerDef.type === 'array') typeLabel = 'array'
  if (innerDef.type === 'enum') {
    const values = Array.isArray(innerDef.entries)
      ? innerDef.entries
      : Object.keys((innerDef.entries as Record<string, unknown> | undefined) || {})
    typeLabel = values.map((value) => `"${value}"`).join(' | ')
  }

  return `${name}${isOptional ? '?' : ''}: ${typeLabel}`
}

function buildPrompt<C>(
  components: Record<string, DefinedComponent<z.ZodObject<any>, C>>,
  options: PromptOptions = {},
): string {
  const lines = [
    options.preamble?.trim() || 'You generate OpenUI-like document widget specs.',
    '',
    '## Approved Components',
    ...Object.values(components).flatMap((component) => {
      const shape = component.props.shape
      const fields = Object.entries(shape).map(([name, schema]) => describeField(name, schema as z.ZodTypeAny))

      return [
        `- ${component.name}: ${component.description}`,
        fields.length > 0 ? `  props: ${fields.join(', ')}` : '  props: none',
      ]
    }),
  ]

  if (options.additionalRules?.length) {
    lines.push('', '## Additional Rules', ...options.additionalRules.map((rule) => `- ${rule}`))
  }

  if (options.examples?.length) {
    lines.push('', '## Examples', ...options.examples.map((example) => `- ${example}`))
  }

  return lines.join('\n')
}

export function defineComponent<T extends z.ZodObject<any>, C>(
  config: DefinedComponentConfig<T, C>,
): DefinedComponent<T, C> {
  ;(config.props as z.ZodTypeAny).register(z.globalRegistry as never, { id: config.name } as never)
  return {
    ...config,
    ref: config.props,
  }
}

export function createLibrary<C>(input: LibraryInput<C>) {
  const components = Object.fromEntries(
    input.components.map((component) => [component.name, component]),
  ) as Record<string, DefinedComponent<z.ZodObject<any>, C>>

  return {
    components,
    prompt(options?: PromptOptions): string {
      return buildPrompt(components, options)
    },
    toJSONSchema(): object {
      const combinedSchema = z.object(
        Object.fromEntries(
          Object.entries(components).map(([name, component]) => [name, component.props]),
        ),
      )
      return z.toJSONSchema(combinedSchema)
    },
  }
}
