import { ARTIFACT_DELIVERY_TOOL_NAMES } from '../quality/proof-collector'

export type CodexSkillCompletionProfile =
  | 'advisory'
  | 'tool_result'
  | 'research_sources'
  | 'artifact_delivery'
  | 'transaction_confirmed'
  | 'research_artifact_delivery'

const RESEARCH_DISCOVERY_TOOLS = new Set(['web_search', 'browser_search'])
const RESEARCH_CONTENT_TOOLS = new Set(['web_fetch', 'browser_read'])
const TRANSACTION_CONFIRMATION_TOOLS = new Set([
  'tag_forge_apply_batch',
])

export function resolveCodexSkillCompletionProfile(input: {
  requiredByExecutionSurface: boolean
  declaredToolNames?: readonly string[]
  authorizedToolNames?: readonly string[]
}): CodexSkillCompletionProfile {
  const authorized = input.authorizedToolNames
    ? new Set(input.authorizedToolNames)
    : null
  const effectiveDeclaredTools = [...new Set(input.declaredToolNames || [])]
    .filter((name) => !authorized || authorized.has(name))
  const hasResearchSources = effectiveDeclaredTools.some((name) => RESEARCH_DISCOVERY_TOOLS.has(name))
    && effectiveDeclaredTools.some((name) => RESEARCH_CONTENT_TOOLS.has(name))
  const hasArtifactDelivery = effectiveDeclaredTools.some((name) => ARTIFACT_DELIVERY_TOOL_NAMES.has(name))
  const hasTransactionConfirmation = effectiveDeclaredTools.some((name) => TRANSACTION_CONFIRMATION_TOOLS.has(name))

  if (hasTransactionConfirmation) return 'transaction_confirmed'
  if (hasResearchSources && hasArtifactDelivery) return 'research_artifact_delivery'
  if (hasResearchSources) return 'research_sources'
  if (hasArtifactDelivery) return 'artifact_delivery'
  if (input.requiredByExecutionSurface || effectiveDeclaredTools.length > 0) return 'tool_result'
  return 'advisory'
}
