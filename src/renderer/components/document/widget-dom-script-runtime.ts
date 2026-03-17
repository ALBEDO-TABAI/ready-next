export function collectInlineHandlerNames(container: HTMLElement): Set<string> {
  const handlerNames = new Set<string>()

  const walkNode = (element: Element) => {
    for (const attr of Array.from(element.attributes)) {
      if (!attr.name.startsWith('on')) continue
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
  event?: Event,
): boolean {
  const normalized = String(expression || '').trim()
  if (!normalized) return false

  const match = normalized.match(/^([A-Za-z_$][\w$]*)\((?:\s*event\s*)?\)$/)
  if (!match?.[1]) return false

  const candidate = widgetWindow[match[1]]
  if (typeof candidate !== 'function') return false

  candidate.call(widgetWindow, event)
  return true
}
