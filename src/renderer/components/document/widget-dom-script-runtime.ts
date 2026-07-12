export function collectInlineHandlerNames(container: HTMLElement): Set<string> {
  const handlerNames = new Set<string>()

  const walkNode = (element: Element) => {
    for (const attr of Array.from(element.attributes)) {
      if (!attr.name.startsWith('on') && !attr.name.startsWith('data-ready-on')) continue
      const match = attr.value.match(/([A-Za-z_$][\w$]*)\s*\(/)
      if (match?.[1]) {
        handlerNames.add(match[1])
      }
    }
  }

  walkNode(container)
  Array.from(container.querySelectorAll('*')).forEach(walkNode)
  return handlerNames
}

function splitInlineHandlerArguments(source: string): string[] | null {
  if (!source.trim()) return []
  const args: string[] = []
  let current = ''
  let quote = ''
  let escaped = false
  for (const char of source) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') {
      current += char
      escaped = true
    } else if (quote) {
      current += char
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === ',') {
      args.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (quote || escaped) return null
  args.push(current.trim())
  return args
}

function resolveInlineHandlerArgument(
  raw: string,
  event?: Event | Record<string, unknown>,
  target?: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false } {
  if (raw === 'event') return { ok: true, value: event }
  if (raw === 'this') return { ok: true, value: target }
  if (raw === 'this.value') return { ok: true, value: target?.value }
  if (raw === 'event.target.value') {
    const eventTarget = event && typeof event === 'object'
      ? (event as { target?: { value?: unknown } }).target
      : undefined
    return { ok: true, value: eventTarget?.value }
  }
  if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' }
  if (raw === 'null') return { ok: true, value: null }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return { ok: true, value: Number(raw) }
  const first = raw.at(0)
  const last = raw.at(-1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return { ok: true, value: raw.slice(1, -1) }
  }
  return { ok: false }
}

export function buildScopedWidgetInlineScript(scriptContent: string, exportedHandlerNames: Set<string>): string {
  const exportLines = Array.from(exportedHandlerNames)
    .map((name) => `if (typeof ${name} === 'function') window.${name} = ${name};`)
    .join('\n')

  return [
    '(function(){',
    scriptContent,
    exportLines,
    '})();',
  ].join('\n')
}

export function invokeInlineHandlerExpression(
  expression: string | null | undefined,
  widgetWindow: Record<string, unknown>,
  event?: Event | Record<string, unknown>,
  target?: Record<string, unknown>,
): boolean {
  const normalized = String(expression || '').trim()
  if (!normalized) return false

  const match = normalized.match(/^(?:return\s+)?(?:window\.)?([A-Za-z_$][\w$]*)\(([\s\S]*)\)\s*;?$/)
  if (!match?.[1]) return false

  const candidate = widgetWindow[match[1]]
  if (typeof candidate !== 'function') return false

  const rawArgs = splitInlineHandlerArguments(match[2] || '')
  if (!rawArgs) return false
  const args: unknown[] = []
  for (const raw of rawArgs) {
    const resolved = resolveInlineHandlerArgument(raw, event, target)
    if (!resolved.ok) return false
    args.push(resolved.value)
  }

  const result = (candidate as (...values: unknown[]) => unknown).apply(target ?? widgetWindow, args)
  if (result === false && event && typeof event === 'object') {
    const cancelableEvent = event as { preventDefault?: () => void; stopPropagation?: () => void }
    cancelableEvent.preventDefault?.()
    cancelableEvent.stopPropagation?.()
  }
  return true
}
