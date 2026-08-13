import { existsSync, statSync } from 'node:fs'

import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import type { SkillState } from '../skills-runtime/runtime-manager'
import { skillDirHasScripts } from '../skills-runtime/skill-executable-surface'
import { PRIMITIVE_TOOL_DEFS } from './skill-primitives/tool-defs'
import { getStaticSkillToolNameForAction } from './skills-tools-static'

function sanitizeToolToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'skill'
}

function buildToolName(skillId: string, actionName: string): string {
  return getStaticSkillToolNameForAction(skillId, actionName)
    || `skill_${sanitizeToolToken(skillId)}_${sanitizeToolToken(actionName)}`
}

export function isCodexSafeHostSkillPrimitiveDefinition(
  toolName: string,
  skill: SkillState,
): boolean {
  const action = skill.actions.find((candidate) => buildToolName(skill.id, candidate.name) === toolName) || null
  if (action || !PRIMITIVE_TOOL_DEFS.some((candidate) => candidate.name === toolName)) return false
  const root = skill.managedPath || skill.sourcePath
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) return false
  if (skillDirHasScripts(root)) return false
  // Codex currently has no immutable snapshot executor for arbitrary skill
  // programs. Keep its skill surface on host-native primitives only. The
  // one shell primitive needed by E6 is additionally pinned to the global
  // lark-cli payload by its dedicated executable authority.
  if (toolName === 'skill_run_shell' && skill.id !== 'lark-cli') return false
  return true
}

export function isCodexSafeHostSkillPrimitive(toolName: string, skillId: string): boolean {
  try {
    const skill = getSkillsRuntimeManager().listSkills().find((candidate) => candidate.id === skillId)
    if (!skill) return false
    return isCodexSafeHostSkillPrimitiveDefinition(toolName, skill)
  } catch {
    return false
  }
}
