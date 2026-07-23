import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** True when the skill's managed folder contains a `scripts/` directory. */
export function skillDirHasScripts(managedPath: string | undefined | null): boolean {
  if (!managedPath) return false
  try {
    return existsSync(join(managedPath, 'scripts'))
  } catch {
    return false
  }
}

export function skillHasExecutableSurface(skill: {
  managedPath?: string | null
  requiredBins?: readonly string[] | null
} | null | undefined): boolean {
  if (!skill) return false
  return skillDirHasScripts(skill.managedPath)
    || skillHasDeclaredBins(skill)
}

export function skillHasDeclaredBins(skill: {
  requiredBins?: readonly string[] | null
} | null | undefined): boolean {
  return Boolean(skill?.requiredBins?.some((value) => typeof value === 'string' && value.trim()))
}

export function buildSkillShellBaseAllowlist(input: {
  baseAllowlist: ReadonlySet<string>
  requiredBins?: readonly string[] | null
  allowSkillScripts: boolean
}): Set<string> {
  const allowlist = input.allowSkillScripts
    ? new Set(input.baseAllowlist)
    : new Set<string>()
  for (const bin of input.requiredBins || []) {
    if (typeof bin === 'string' && bin.trim()) allowlist.add(bin)
  }
  return allowlist
}
