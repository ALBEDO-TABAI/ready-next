/**
 * Embedded skill manifest (P2-3) — a directory SCAN of `assets/embedded-skills/*`,
 * NOT a hardcoded compile-time union. Dropping a folder with a valid `ready-skill.json`
 * OR a `SKILL.md` (frontmatter name + description) registers the skill with zero source
 * edits (母合同 §4 T5 drop-in contract). `EmbeddedSkillId` is now `string` — the union
 * is retired; consumers keep their import names unchanged.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseSkillFrontmatter } from './skill-frontmatter'

// Electron's Node entry is a CJS string-export, so ESM `import { app } from 'electron'`
// breaks tsx/ESM tests that load this file directly (embedded-skill-* tests). `createRequire`
// succeeds in the real Electron runtime (named members populated) and in plain Node (a string
// yields `undefined`, guarded by the optional chaining + try/catch below). Same pattern as runtime-manager.ts.
const electronModule = (() => {
  try {
    return createRequire(import.meta.url)('electron') as typeof import('electron')
  } catch {
    return {} as typeof import('electron')
  }
})()
const { app } = electronModule

export type EmbeddedSkillId = string

export interface EmbeddedSkillManifest {
  id: EmbeddedSkillId
  name: string
  description: string
  version: string
  requirementsFile: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Mirror of runtime-manager.resolveEmbeddedSkillsRoot's 3 candidates
 * (resourcesPath → app path → cwd), but every electron access is guarded — a plain
 * node/tsx test process has no `resourcesPath` and `app` is undefined, so those
 * candidates are skipped instead of throwing. Returns null if none exist (boot-safe:
 * EMBEDDED_SKILLS becomes [] rather than crashing main-process startup).
 */
function resolveEmbeddedSkillsRootStatic(): string | null {
  const candidates: string[] = []
  try {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resourcesPath) candidates.push(join(resourcesPath, 'embedded-skills'))
  } catch {
    /* no resourcesPath outside a packaged electron app */
  }
  try {
    const appPath = app?.getAppPath?.()
    if (appPath) candidates.push(join(appPath, 'assets', 'embedded-skills'))
  } catch {
    /* electron app not ready / absent in test process */
  }
  try {
    candidates.push(join(process.cwd(), 'assets', 'embedded-skills'))
  } catch {
    /* cwd should always resolve */
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore an unreadable candidate */
    }
  }
  return null
}

/**
 * Scan `rootDir` for embedded skills. Per subdir:
 *   - `ready-skill.json` present → id/displayName||name/description/version from it.
 *   - else `SKILL.md` present → id = dir name; name/description from frontmatter
 *     (version from frontmatter `metadata.version` if any, else '0.0.0').
 *   - unparseable / missing both → skipped with a console.warn (tolerant, never throws).
 * Output is sorted by directory name (deterministic). Missing/unreadable root → [].
 */
export function buildEmbeddedSkillManifests(rootDir: string): EmbeddedSkillManifest[] {
  let entries: string[]
  try {
    entries = readdirSync(rootDir).sort()
  } catch {
    return []
  }
  const manifests: EmbeddedSkillManifest[] = []
  for (const dirName of entries) {
    const dir = join(rootDir, dirName)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }

    const jsonPath = join(dir, 'ready-skill.json')
    if (existsSync(jsonPath)) {
      try {
        const json = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>
        const id = asString(json.id) || dirName
        manifests.push({
          id,
          name: asString(json.displayName) || asString(json.name) || id,
          description: asString(json.description),
          version: asString(json.version) || '0.0.0',
          requirementsFile: 'requirements.txt',
        })
      } catch (error) {
        console.warn(`[embedded-skills] skip ${dirName}: unreadable ready-skill.json (${(error as Error).message})`)
      }
      continue
    }

    const skillMdPath = join(dir, 'SKILL.md')
    if (existsSync(skillMdPath)) {
      try {
        const { metadata } = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf-8'))
        const name = asString(metadata.name)
        const description = asString(metadata.description)
        if (!name || !description) {
          console.warn(`[embedded-skills] skip ${dirName}: SKILL.md frontmatter missing name/description`)
          continue
        }
        manifests.push({
          id: dirName,
          name,
          description,
          version: asString(metadata.version) || '0.0.0',
          requirementsFile: 'requirements.txt',
        })
      } catch (error) {
        console.warn(`[embedded-skills] skip ${dirName}: unreadable SKILL.md (${(error as Error).message})`)
      }
      continue
    }

    console.warn(`[embedded-skills] skip ${dirName}: no ready-skill.json or SKILL.md`)
  }
  return manifests
}

const resolvedEmbeddedSkillsRoot = resolveEmbeddedSkillsRootStatic()
if (!resolvedEmbeddedSkillsRoot) {
  console.warn('[embedded-skills] no embedded-skills root found; EMBEDDED_SKILLS is empty')
}
export const EMBEDDED_SKILLS: EmbeddedSkillManifest[] = resolvedEmbeddedSkillsRoot
  ? buildEmbeddedSkillManifests(resolvedEmbeddedSkillsRoot)
  : []

export const EMBEDDED_SKILL_IDS = new Set<EmbeddedSkillId>(EMBEDDED_SKILLS.map((skill) => skill.id))

export function getEmbeddedSkillManifest(skillId: string): EmbeddedSkillManifest | null {
  return EMBEDDED_SKILLS.find((skill) => skill.id === skillId) || null
}
