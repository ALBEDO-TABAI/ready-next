import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'
import { BUILTIN_AGENT_PRESETS } from './builtin-agent-presets'
import { renderSpecialistFoundationMarkdown } from './specialist-blueprint-quality'

export function isAgentFoundationReady(input: {
  agentId: string
  foundation: string
  blueprints: readonly SpecialistAgentBlueprint[]
}): boolean {
  const content = input.foundation.trim()
  if (!content) return false
  const preset = BUILTIN_AGENT_PRESETS[input.agentId as keyof typeof BUILTIN_AGENT_PRESETS]
  if (preset) return content === preset.foundation.trim()
  const blueprint = input.blueprints.find((candidate) =>
    candidate.status === 'confirmed'
    && candidate.adoption?.createdAgentId === input.agentId
    && candidate.adoption.foundationRelPath === `agents/${input.agentId}/FOUNDATION.md`
  )
  return Boolean(blueprint && content === renderSpecialistFoundationMarkdown(blueprint).trim())
}
