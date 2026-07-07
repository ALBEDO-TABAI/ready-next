/**
 * P3-1 — neutral-directory skill discovery (~/.agents/skills), suggest-import model.
 *
 * READ-ONLY scan for skills sitting in the cross-tool neutral directory
 * `~/.agents/skills` (the agentskills.io convention shared by Claude Code / Codex / etc.).
 * It NEVER imports or writes anything — it only surfaces candidates so the skills center can
 * offer an explicit "import" button (Ready's consent posture: background discovery + settings
 * confirmation, never auto-import / foreground interruption).
 *
 * Scope note: only the user home directory is scanned. The workspace-level `<root>/.agents/skills`
 * is DEFERRED — this repo has no single authoritative workspace-root accessor in the main modules
 * (only the DB worker carries a `workspaceRoot`), so per the plan the workspace side is left to a
 * follow-up rather than guessing a root.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseSkillFrontmatter } from './skill-frontmatter'

export interface ExternalSkillCandidate {
  /** Absolute (realpath-resolved) path of the skill directory. */
  path: string
  /** Skill id/name from the SKILL.md frontmatter (the identity for a bare SKILL.md skill). */
  name: string
  description: string
  source: 'user_agents_dir'
  /** True when this candidate's id already matches a registered skill, or its realpath is already managed. */
  alreadyImported: boolean
}

/**
 * List importable skill candidates under `~/.agents/skills` (only direct subdirs with a valid
 * SKILL.md: frontmatter name + description). Symlinks are de-duped by realpath. Missing directory
 * → []. Pure read; deterministic order (by name).
 */
export function listExternalSkillCandidates(params: {
  homeDir?: string
  existingSkillIds: ReadonlySet<string>
  existingManagedRealPaths?: ReadonlySet<string>
}): ExternalSkillCandidate[] {
  const skillsDir = join(params.homeDir ?? homedir(), '.agents', 'skills')
  let entries: string[]
  try {
    if (!existsSync(skillsDir)) return []
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }

  const candidates: ExternalSkillCandidate[] = []
  const seenRealPaths = new Set<string>()
  for (const entry of entries.sort()) {
    const rawPath = join(skillsDir, entry)
    let realPath: string
    try {
      if (!statSync(rawPath).isDirectory()) continue
      realPath = realpathSync(rawPath)
    } catch {
      continue
    }
    if (seenRealPaths.has(realPath)) continue

    const skillMdPath = join(realPath, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    let name = ''
    let description = ''
    try {
      const { metadata } = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf-8'))
      name = (metadata.name || '').trim()
      description = (metadata.description || '').trim()
    } catch {
      continue
    }
    if (!name || !description) continue

    seenRealPaths.add(realPath)
    candidates.push({
      path: realPath,
      name,
      description,
      source: 'user_agents_dir',
      alreadyImported:
        params.existingSkillIds.has(name) || (params.existingManagedRealPaths?.has(realPath) ?? false),
    })
  }
  return candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
