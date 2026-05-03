import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isChildOwnedSkill } from '../agent-control/skill-child-drivers'
import { getSkillsRuntimeManager, type SkillState } from '../skills-runtime/runtime-manager'
import { compileSkillDefinition } from '../skills-runtime/skill-compiler'

/**
 * Child-loop owned skill actions. These typed actions are declared by a skill
 * manifest's `child_loop.actions`; Ready core must not carry per-skill action
 * tables because that turns a runtime contract into hidden host behavior.
 */
export function isConfiguredChildLoopSkillActionForSkill(
  skill: Pick<SkillState, 'id' | 'childLoop'> | null | undefined,
  action: string,
): boolean {
  if (!skill || typeof action !== 'string' || !action) return false
  const actions = skill.childLoop?.actions
  return Array.isArray(actions) && actions.includes(action)
}

function findSkillState(skillId: string): SkillState | null {
  try {
    return getSkillsRuntimeManager().listSkills().find((skill) => skill.id === skillId) || null
  } catch {
    return findEmbeddedSkillStateFallback(skillId)
  }
}

function findEmbeddedSkillStateFallback(skillId: string): SkillState | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(skillId)) return null
  const folderPath = join(process.cwd(), 'assets', 'embedded-skills', skillId)
  if (!existsSync(folderPath)) return null
  try {
    const definition = compileSkillDefinition({ folderPath, source: 'embedded' })
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      version: definition.version,
      installed: false,
      installStatePath: '',
      source: definition.source,
      manifestValid: definition.manifestValid,
      defaultAction: definition.defaultAction,
      actions: definition.actions,
      executionMode: definition.executionMode,
      managedPath: definition.managedPath,
      sourcePath: definition.sourcePath,
      hostRequirements: definition.hostRequirements,
      childLoop: definition.childLoop,
    }
  } catch {
    return null
  }
}

export function isChildLoopSkillAction(skillId: string, action: string): boolean {
  if (typeof skillId !== 'string' || !skillId) return false
  if (typeof action !== 'string' || !action) return false
  if (!isChildOwnedSkill(skillId)) return false
  return isConfiguredChildLoopSkillAction(skillId, action)
}

export function isConfiguredChildLoopSkillAction(skillId: string, action: string): boolean {
  if (typeof skillId !== 'string' || !skillId) return false
  if (typeof action !== 'string' || !action) return false
  return isConfiguredChildLoopSkillActionForSkill(findSkillState(skillId), action)
}
