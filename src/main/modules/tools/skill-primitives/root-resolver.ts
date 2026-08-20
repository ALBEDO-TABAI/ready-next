/**
 * Tiny adapter that maps a (skillId, sessionId?) into the two sandbox roots
 * Phase 1 primitives care about:
 *
 *   assetRoot     = <managedPath>                      — skill-bundled code/assets (READ-ONLY in sandbox sense)
 *   artifactRoot  = <outputsRoot>/<skillId>/           — per-skill write target
 *
 * Implementation deliberately thin so unit tests can inject their own
 * `lookupSkillRoots` callback without pulling in the SkillsRuntimeManager
 * singleton (which imports `electron`).
 */

import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'

export interface SkillRootSet {
  skillId: string
  assetRoot: string
  artifactRoot: string
}

export type LookupSkillRoots = (skillId: string) => SkillRootSet | null

export const READY_FOLDER_EXPORT_SKILL_ID = 'ready-folder-export'

export function lookupHostFolderExportRoots(runId?: string | null): SkillRootSet | null {
  const manager = getSkillsRuntimeManager()
  const info = manager.getRuntimeInfo()
  const safeRun = String(runId || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'session'
  const assetRoot = join(info.outputsRoot, READY_FOLDER_EXPORT_SKILL_ID)
  const artifactRoot = join(assetRoot, safeRun)
  mkdirSync(artifactRoot, { recursive: true })
  return { skillId: READY_FOLDER_EXPORT_SKILL_ID, assetRoot, artifactRoot }
}

/**
 * Production resolver — reads from the live SkillsRuntimeManager. Creates
 * the artifactRoot on demand so the first write doesn't ENOENT.
 */
export const defaultLookupSkillRoots: LookupSkillRoots = (skillId) => {
  const id = typeof skillId === 'string' ? skillId.trim() : ''
  if (!id) return null
  if (id === READY_FOLDER_EXPORT_SKILL_ID) return lookupHostFolderExportRoots()
  const manager = getSkillsRuntimeManager()
  const info = manager.getRuntimeInfo()
  const skill = manager.listSkills().find((entry) => entry.id === id)
  if (!skill) return null
  const assetRoot = skill.managedPath || skill.sourcePath
  if (!assetRoot) return null
  const artifactRoot = join(info.outputsRoot, id)
  mkdirSync(artifactRoot, { recursive: true })
  return { skillId: id, assetRoot, artifactRoot }
}
