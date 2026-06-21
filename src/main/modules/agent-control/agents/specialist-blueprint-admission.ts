import type { AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import { parseTriggersValue } from '../knowledge/belief-card-store'
import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintAdmissionVerdict,
  SpecialistBlueprintQualityCheck,
} from '../../../../shared/agent-specialist-blueprint'
import { evaluateSpecialistBlueprintQuality } from './specialist-blueprint-quality'

const DERIVED_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/
const UNSAFE_RE = /(盗取|窃取|绕过|破解|木马|恶意|密码|credential|steal|bypass|malware)/i
const BROAD_DOMAIN_RE = /^(全部|所有|任何|通用|全能|创作|工作|助理|agent|assistant|general|everything|all)$/i

export interface SpecialistBlueprintAdmissionRegistry {
  get(id: string): AgentRegistryRecord | null
  list?(): AgentRegistryRecord[]
}

export interface SpecialistBlueprintAdmissionResult {
  verdict: SpecialistBlueprintAdmissionVerdict
  missing: string[]
  qualityChecks: SpecialistBlueprintQualityCheck[]
}

function trim(value: unknown): string {
  return String(value || '').trim()
}

function hasCreateIntent(text: string): boolean {
  const target = /(专项\s*agent|专门\s*agent|专项\s*智能体|agent|智能体)/i
  if (!target.test(text)) return false
  const explicitCreate = /(创建|新建|想建|帮我建|帮我创建|做一个|想做一个|帮我做一个|搭一个|生成).*(专项\s*agent|专门\s*agent|专项\s*智能体|agent|智能体)/i
  if (explicitCreate.test(text)) return true
  const requestedOne = /(我要|我想要|想要|需要|帮我).{0,16}(一个|个|一位).{0,80}(专项\s*agent|专门\s*agent|专项\s*智能体|agent|智能体)/i
  return requestedOne.test(text)
}

function collectMissing(blueprint: SpecialistAgentBlueprint): string[] {
  const missing: string[] = []
  if (!trim(blueprint.specialistId)) missing.push('specialistId')
  if (!trim(blueprint.displayName)) missing.push('displayName')
  if (!trim(blueprint.charter)) missing.push('charter')
  if (!trim(blueprint.intendedDomain)) missing.push('intendedDomain')
  if (blueprint.nonGoals.length === 0) missing.push('nonGoals')
  if (blueprint.recurringTasks.length === 0) missing.push('recurringTasks')
  if (blueprint.requiredInputs.length === 0) missing.push('requiredInputs')
  if (blueprint.expectedOutputs.length === 0) missing.push('expectedOutputs')
  if (!trim(blueprint.seedRulesText)) missing.push('seedRulesText')
  return missing
}

function duplicateByTrigger(registry: SpecialistBlueprintAdmissionRegistry, triggers: readonly string[]): AgentRegistryRecord | null {
  const agents = registry.list?.() ?? []
  for (const agent of agents) {
    const charterParts = [agent.id, agent.name, agent.charter ?? ''].join('\n')
    if (triggers.some((trigger) => charterParts.toLowerCase().includes(trigger.toLowerCase()))) return agent
  }
  return null
}

export function evaluateSpecialistBlueprintAdmission(
  registry: SpecialistBlueprintAdmissionRegistry,
  blueprint: SpecialistAgentBlueprint,
): SpecialistBlueprintAdmissionResult {
  const quality = evaluateSpecialistBlueprintQuality(blueprint)
  const specialistId = trim(blueprint.specialistId || blueprint.inferredScope.slug)
  const userRequest = trim(blueprint.userRequestVerbatim || blueprint.provenance.userRequestVerbatim)
  const combinedText = [
    userRequest,
    blueprint.displayName,
    blueprint.charter,
    blueprint.intendedDomain,
  ].join('\n')

  if (UNSAFE_RE.test(combinedText)) {
    return { verdict: { kind: 'reject_unsafe', reason: 'requested specialist crosses a blocked safety boundary' }, missing: [], qualityChecks: quality.checks }
  }
  if (blueprint.source === 'conversation' && !hasCreateIntent(userRequest)) {
    return { verdict: { kind: 'reject_premature', reason: 'user has not explicitly asked to create a specialist agent' }, missing: [], qualityChecks: quality.checks }
  }
  if (!DERIVED_AGENT_ID.test(specialistId)) {
    return { verdict: { kind: 'clarify', missing: ['specialistId'] }, missing: ['specialistId'], qualityChecks: quality.checks }
  }
  const existing = registry.get(specialistId)
  if (existing) {
    return { verdict: { kind: 'reject_duplicate', existingAgentId: existing.id }, missing: [], qualityChecks: quality.checks }
  }

  const triggers = parseTriggersValue(blueprint.routingTriggers)
  if (!triggers.ok) {
    return { verdict: { kind: 'clarify', missing: ['routingTriggers'] }, missing: ['routingTriggers'], qualityChecks: quality.checks }
  }
  const duplicateTrigger = duplicateByTrigger(registry, triggers.triggers ?? [])
  if (duplicateTrigger) {
    return { verdict: { kind: 'reject_duplicate', existingAgentId: duplicateTrigger.id }, missing: [], qualityChecks: quality.checks }
  }

  if (BROAD_DOMAIN_RE.test(trim(blueprint.intendedDomain)) || blueprint.recurringTasks.length > 6 || blueprint.expectedOutputs.length > 6) {
    return { verdict: { kind: 'reject_too_broad', reason: 'specialist scope is too broad for a focused agent' }, missing: [], qualityChecks: quality.checks }
  }
  const missing = collectMissing(blueprint)
  if (missing.length > 0) {
    return { verdict: { kind: 'clarify', missing }, missing, qualityChecks: quality.checks }
  }
  if (!quality.passed) {
    return {
      verdict: { kind: 'clarify', missing: quality.blockingIssueIds },
      missing: quality.blockingIssueIds,
      qualityChecks: quality.checks,
    }
  }
  return { verdict: { kind: 'admit' }, missing: [], qualityChecks: quality.checks }
}
