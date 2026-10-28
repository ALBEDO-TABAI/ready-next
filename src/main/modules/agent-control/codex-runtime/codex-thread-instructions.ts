import { realpathSync } from 'node:fs'

import type { SkillState } from '../../skills-runtime/runtime-manager-types'
import { readReferenceSkillDocCapped } from '../../skills-runtime/reference-skill-doc'
import { skillHasExecutableSurface } from '../../skills-runtime/skill-executable-surface'
import {
  resolveCodexSkillCompletionProfile,
  type CodexSkillCompletionProfile,
} from './codex-skill-completion-profile'

export const CODEX_HOST_OVERLAY = 'Ready provides the dynamic product tools declared for this thread. Treat successful tool responses as the authority for external effects. Never claim an external effect without a successful tool response.'

export type CodexSelectedSkillMethodology = {
  skillId: string
  skillName: string
  skillDescription: string
  documentBasename: string
  documentText: string
  truncated: boolean
}

export type CodexNativeSkillInput = {
  skillId: string
  name: string
  path: string
  completionProfile: CodexSkillCompletionProfile
}

function isReferenceLikeSkill(skill: SkillState): boolean {
  return skill.executionMode === 'advisory'
    || skill.actions.some((action) => action.runtime === 'reference')
}

function skillCompletionProfile(
  skill: SkillState,
  authorizedToolNames?: readonly string[],
): CodexNativeSkillInput['completionProfile'] {
  const hasPublicExecutableAction = skill.actions.some((action) => (
    action.visibility !== 'internal' && action.runtime !== 'reference'
  ))
  return resolveCodexSkillCompletionProfile({
    requiredByExecutionSurface: skill.executionMode !== 'advisory'
      || hasPublicExecutableAction
      || skillHasExecutableSurface(skill),
    declaredToolNames: skill.allowedTools,
    authorizedToolNames,
  })
}

export function resolveCodexSelectedSkillMethodology(input: {
  skillId: string
  skills: readonly SkillState[]
}): CodexSelectedSkillMethodology | null {
  const skill = input.skills.find((candidate) => candidate.id === input.skillId)
  if (!skill || !skill.installed || !skill.manifestValid) {
    throw new Error('codex_selected_skill_unavailable')
  }
  if (!isReferenceLikeSkill(skill)) return null
  const document = readReferenceSkillDocCapped(skill.managedPath || skill.sourcePath)
  if (!document) throw new Error('codex_selected_skill_methodology_unavailable')
  return {
    skillId: skill.id,
    skillName: skill.name,
    skillDescription: skill.description,
    documentBasename: document.basename,
    documentText: document.text,
    truncated: document.truncated,
  }
}

export function resolveCodexNativeSkillInput(input: {
  skillId?: string
  path?: string
  authorizedToolNames?: readonly string[]
  skills: readonly SkillState[]
}): CodexNativeSkillInput | null {
  const requestedPath = String(input.path || '').trim()
  let canonicalRequestedPath = ''
  if (requestedPath && !input.skillId) {
    try {
      canonicalRequestedPath = realpathSync(requestedPath)
    } catch {
      throw new Error('codex_selected_skill_unavailable')
    }
  }
  const skill = input.skills.find((candidate) => {
    if (!candidate.installed || !candidate.manifestValid) return false
    if (input.skillId && candidate.id !== input.skillId) return false
    if (!canonicalRequestedPath) return Boolean(input.skillId && candidate.id === input.skillId)
    const skillPath = candidate.managedPath || candidate.sourcePath
    if (!skillPath) return false
    try {
      return realpathSync(skillPath) === canonicalRequestedPath
    } catch {
      // silent-catch: an installed skill whose path no longer resolves cannot match the requested skill path
      return false
    }
  })
  if (!skill) return null
  const skillPath = skill.managedPath || skill.sourcePath
  if (!skillPath) throw new Error('codex_selected_skill_unavailable')
  return {
    skillId: skill.id,
    name: skill.name,
    path: realpathSync(skillPath),
    completionProfile: skillCompletionProfile(skill, input.authorizedToolNames),
  }
}

export function buildCodexThreadDeveloperInstructions(
  _methodology: CodexSelectedSkillMethodology | null = null,
): string {
  return CODEX_HOST_OVERLAY
}
