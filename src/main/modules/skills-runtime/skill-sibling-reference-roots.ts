import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseSiblingSkillReferenceIds } from './skill-sibling-references'

interface SiblingReferenceSkill {
  id: string
  managedPath?: string
  sourcePath?: string
  executionMode?: string
  actions?: readonly { runtime?: string }[]
}

function isReferenceSkill(skill: SiblingReferenceSkill): boolean {
  return skill.executionMode === 'advisory'
    || skill.actions?.some((action) => action.runtime === 'reference') === true
}

function canonicalDirectory(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null
  try {
    const canonical = realpathSync.native(path)
    return statSync(canonical).isDirectory() ? canonical : null
  } catch {
    // silent-catch: a path that cannot be resolved or stat'ed is not a usable skill directory
    return null
  }
}

export function resolveDeclaredSiblingSkillReadRoots(input: {
  selectedSkillId: string
  skills: readonly SiblingReferenceSkill[]
}): string[] {
  try {
    const selected = input.skills.find((skill) => skill.id === input.selectedSkillId)
    const selectedRoot = canonicalDirectory(selected?.managedPath || selected?.sourcePath)
    if (!selectedRoot) return []
    const documentPath = join(selectedRoot, 'SKILL.md')
    if (!existsSync(documentPath)) return []
    const referencedIds = new Set(parseSiblingSkillReferenceIds(readFileSync(documentPath, 'utf8')))
    if (referencedIds.size === 0) return []
    return input.skills
      .filter((skill) =>
        referencedIds.has(skill.id)
        && skill.id !== input.selectedSkillId
        && isReferenceSkill(skill))
      .map((skill) => canonicalDirectory(skill.managedPath || skill.sourcePath))
      .filter((path): path is string => Boolean(path))
  } catch {
    // silent-catch: an unreadable SKILL.md or skill entry grants no sibling read roots (fails closed)
    return []
  }
}
