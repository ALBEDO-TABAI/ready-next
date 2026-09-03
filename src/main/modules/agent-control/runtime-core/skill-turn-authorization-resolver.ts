import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import { resolveLarkCliCandidatePrimitives } from '../codex-runtime/codex-lark-cli-candidate'
import {
  getSkillShellConsent,
  isEmbeddedSkill,
  resolveSkillShellAllowed,
} from '../../skills-runtime/skill-shell-consent'
import { PRIMITIVE_TOOL_NAME_SET } from '../../tools/skill-primitives/tool-defs'
import type { RunMessage } from '../contracts/run-contracts'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import {
  buildLocalSendImSkillAuthorization,
  hasLocalSendImIntentForTurn,
} from './agent-sdk-foundation-utils'
import {
  allowedPrimitiveToolsForSdkSkillTurn,
  filterSkillManifestToolsForTurn,
  readSkillReferenceApplicableToolNames,
  readSkillReferenceNames,
  resolveExplicitReferenceSkillExecutableSurface,
  resolveManifestBoundSkillTools,
  shouldSuppressSkillAskUserForArtifactDelivery,
  skillAuthorizationTextCandidates,
} from './agent-sdk-skill-intent-utils'
import type { SkillContextOrchestratorLike } from './agent-sdk-types'

function registeredSkillOrFallback(skillId: string, fallback: unknown): unknown {
  try {
    return getSkillsRuntimeManager().listSkills()
      .find((candidate) => candidate.id === skillId) ?? fallback
  } catch {
    return fallback
  }
}

export function resolveSemanticSkillAuthorizationForTurn(input: {
  mode: 'observe' | 'commit'
  message: RunMessage
  sessionId?: string
  messageVisibilityEpoch?: number
  requestEnvelope?: unknown
  forceLocalSendImIntent?: boolean
  skillHintRelevantForTurn?: boolean
  observedReferenceHint?: { id: string; name: string; applicableToolNames?: string[] } | null
  orchestrator: SkillContextOrchestratorLike | null
  log?: (message: string) => void
}): SkillToolAuthorization {
  const localSendImIntent = Boolean(input.forceLocalSendImIntent)
    || hasLocalSendImIntentForTurn(input.message, input.requestEnvelope)
  const orchestrator = input.orchestrator
  if (!orchestrator) {
    if (localSendImIntent) return buildLocalSendImSkillAuthorization('local_send_im_intent')
    const candidate = resolveLarkCliCandidatePrimitives()
    return candidate
      ? buildExplicitNoSkillAuthorization('no_skill_signal', { candidateSkillPrimitives: candidate })
      : buildExplicitNoSkillAuthorization('no_skill_signal')
  }
  const observedHint = input.mode === 'observe'
    ? input.observedReferenceHint !== undefined
      ? input.observedReferenceHint
      : orchestrator.observeCurrentReferenceSkillHint?.(input.sessionId) || null
    : undefined
  const userTextCandidates = skillAuthorizationTextCandidates(
    input.message,
    input.requestEnvelope,
  )
  if (!localSendImIntent) {
    for (const skillName of readSkillReferenceNames(input.requestEnvelope)) {
      const syntheticMention = `@[${skillName}]`
      const matchedSkill = (orchestrator.findExplicitlyRequestedSkills?.(syntheticMention) || [])
        .find((skill) => skill && (skill.id || skill.skillId))
      const skillId = matchedSkill?.id || matchedSkill?.skillId
      if (!matchedSkill || !skillId) continue
      if (input.mode === 'commit') {
        try {
          orchestrator.rememberExplicitReferenceSkillHint?.(
            syntheticMention,
            input.sessionId,
            input.messageVisibilityEpoch,
          )
        } catch (error) {
          input.log?.(`rememberExplicitReferenceSkillHint failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const preferredTexts = [...userTextCandidates, syntheticMention]
      const typedActions = Array.from(new Set(
        preferredTexts
          .flatMap((text) => orchestrator.buildPreferredSkillToolNames?.(
            text,
            input.sessionId,
            input.mode === 'observe' ? observedHint : undefined,
          ) || [])
          .filter((toolName) => toolName.startsWith('skill_') && !PRIMITIVE_TOOL_NAME_SET.has(toolName)),
      ))
      const executableSurface = resolveExplicitReferenceSkillExecutableSurface(
        matchedSkill,
        typedActions,
      )
      const allowRunShell = resolveSkillShellAllowed({
        ...executableSurface,
        isEmbedded: isEmbeddedSkill(skillId),
        hasConsent: getSkillShellConsent(skillId),
      })
      const allowAskUser = !shouldSuppressSkillAskUserForArtifactDelivery(preferredTexts)
      const manifestTools = filterSkillManifestToolsForTurn(
        resolveManifestBoundSkillTools(
          registeredSkillOrFallback(skillId, matchedSkill),
          typedActions,
          allowedPrimitiveToolsForSdkSkillTurn({ skillId, allowRunShell, allowAskUser }),
        ),
        preferredTexts,
        [
          ...readSkillReferenceApplicableToolNames(input.requestEnvelope, skillName),
          ...((input.mode === 'observe'
            ? observedHint
            : orchestrator.peekCurrentReferenceSkillHint?.(input.sessionId))
            ?.applicableToolNames ?? []),
        ],
      )
      if (input.mode === 'commit') {
        orchestrator.rememberReferenceSkillToolApplicability?.(
          skillId,
          [...manifestTools.typedActions, ...manifestTools.primitives],
          input.sessionId,
          input.messageVisibilityEpoch,
        )
      }
      input.log?.(`[skill_authorization] source=typed_ref skill=${skillId}`)
      return buildSelectedSkillToolAuthorization({
        skillId,
        allowedTypedActions: manifestTools.typedActions,
        allowedPrimitives: manifestTools.primitives,
        source: 'explicit',
        reason: 'typed_ref:explicit_user_mention',
      })
    }
  }
  if (userTextCandidates.length === 0) {
    const candidate = resolveLarkCliCandidatePrimitives()
    return candidate
      ? buildExplicitNoSkillAuthorization('no_skill_signal', { candidateSkillPrimitives: candidate })
      : buildExplicitNoSkillAuthorization('no_skill_signal')
  }
  const explicitSkillMatches: Array<{
    text: string
    skill: {
      id?: string
      skillId?: string
      name?: string
      managedPath?: string
      requiredBins?: readonly string[]
    }
  }> = []
  for (const text of userTextCandidates) {
    for (const skill of orchestrator.findExplicitlyRequestedSkills?.(text) || []) {
      if (!skill) continue
      const skillId = skill.id || skill.skillId
      if (!skillId) continue
      if (explicitSkillMatches.some((entry) => (entry.skill.id || entry.skill.skillId) === skillId)) {
        continue
      }
      explicitSkillMatches.push({ text, skill })
    }
  }
  const explicitEntry = explicitSkillMatches[0] || null
  const explicitSkill = explicitEntry?.skill || null
  const explicitSkillId = explicitSkill?.id || explicitSkill?.skillId
    || (localSendImIntent ? 'send-im' : null)
  if (explicitSkillId && input.mode === 'commit') {
    try {
      orchestrator.rememberExplicitReferenceSkillHint?.(
        explicitEntry?.text || userTextCandidates[0],
        input.sessionId,
        input.messageVisibilityEpoch,
      )
    } catch (error) {
      input.log?.(`rememberExplicitReferenceSkillHint failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!localSendImIntent && !explicitSkillId && !input.skillHintRelevantForTurn) {
    const candidate = resolveLarkCliCandidatePrimitives()
    return candidate
      ? buildExplicitNoSkillAuthorization('no_skill_signal', { candidateSkillPrimitives: candidate })
      : buildExplicitNoSkillAuthorization('no_skill_signal')
  }

  const referenceHint = input.mode === 'observe'
    ? observedHint || null
    : orchestrator.getCurrentReferenceSkillHint?.(input.sessionId) || null
  const preferredToolNames = userTextCandidates.flatMap((text) =>
    orchestrator.buildPreferredSkillToolNames?.(
      text,
      input.sessionId,
      input.mode === 'observe' ? observedHint : undefined,
    ) || [],
  )
  const typedActionNames = new Set(
    preferredToolNames.filter((name) =>
      name.startsWith('skill_') && !PRIMITIVE_TOOL_NAME_SET.has(name)),
  )
  if (localSendImIntent) typedActionNames.add('skill_send_im_file')
  const typedActions = Array.from(typedActionNames)
  const skillId = explicitSkillId
    || (input.skillHintRelevantForTurn ? referenceHint?.id || null : null)
  if (!skillId) {
    const candidate = resolveLarkCliCandidatePrimitives()
    return candidate
      ? buildExplicitNoSkillAuthorization('no_skill_signal', { candidateSkillPrimitives: candidate })
      : buildExplicitNoSkillAuthorization('no_skill_signal')
  }
  const selectedSkillCandidate = explicitSkill
    ?? (orchestrator.findExplicitlyRequestedSkills?.(`@[${skillId}]`) || [])
      .find((candidate) => (candidate.id || candidate.skillId) === skillId)
  const executableSurface = resolveExplicitReferenceSkillExecutableSurface(
    selectedSkillCandidate || null,
    typedActions,
  )
  const allowRunShell = resolveSkillShellAllowed({
    ...executableSurface,
    isEmbedded: isEmbeddedSkill(skillId),
    hasConsent: getSkillShellConsent(skillId),
  })
  const allowAskUser = !shouldSuppressSkillAskUserForArtifactDelivery(userTextCandidates)
  const manifestTools = filterSkillManifestToolsForTurn(
    resolveManifestBoundSkillTools(
      registeredSkillOrFallback(skillId, selectedSkillCandidate),
      typedActions,
      allowedPrimitiveToolsForSdkSkillTurn({ skillId, allowRunShell, allowAskUser }),
    ),
    userTextCandidates,
    referenceHint?.applicableToolNames ?? [],
  )
  if (input.mode === 'commit') {
    orchestrator.rememberReferenceSkillToolApplicability?.(
      skillId,
      [...manifestTools.typedActions, ...manifestTools.primitives],
      input.sessionId,
      input.messageVisibilityEpoch,
    )
  }
  input.log?.(`[skill_authorization] source=text_fallback skill=${skillId}`)
  return buildSelectedSkillToolAuthorization({
    skillId,
    allowedTypedActions: manifestTools.typedActions,
    allowedPrimitives: manifestTools.primitives,
    source: explicitSkillId ? 'explicit' : 'active_task',
    reason: explicitSkillId ? 'explicit_user_mention' : 'reference_hint',
  })
}
