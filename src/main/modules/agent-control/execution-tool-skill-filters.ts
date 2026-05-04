export function isSkillToolName(name: string): boolean {
  return name.startsWith('skill_') || name === 'system_run_embedded_python'
}

export function filterPreferredSkillAnthropicTools(
  tools: Array<Record<string, unknown>>,
  preferredSkillToolNames: string[],
): Array<Record<string, unknown>> {
  const allowed = new Set(preferredSkillToolNames)
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (!isSkillToolName(name)) return true
    return allowed.has(name)
  })
}

export function filterPreferredSkillOpenAITools(
  tools: Array<Record<string, unknown>>,
  preferredSkillToolNames: string[],
): Array<Record<string, unknown>> {
  const allowed = new Set(preferredSkillToolNames)
  return tools.filter((tool) => {
    const fn = (tool.function as { name?: unknown } | undefined)?.name
    if (typeof fn !== 'string') return false
    if (!isSkillToolName(fn)) return true
    return allowed.has(fn)
  })
}

export function mergeForceDocumentAllowedNames(
  baseAllowed: Set<string>,
  preferredSkillToolNames: string[] | null | undefined,
): Set<string> {
  if (!preferredSkillToolNames || preferredSkillToolNames.length === 0) return baseAllowed
  return new Set<string>([...baseAllowed, ...preferredSkillToolNames])
}
