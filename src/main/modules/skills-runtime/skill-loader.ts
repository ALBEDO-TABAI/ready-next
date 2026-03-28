import { existsSync } from 'fs'
import { join } from 'path'
import type { SkillDefinition } from '../../../shared/skill-execution-types'
import { type EmbeddedSkillManifest, EMBEDDED_SKILLS } from './manifest'
import { compileSkillDefinition } from './skill-compiler'
import { getManagedCustomSkill, listManagedCustomSkills } from './custom-skill-registry'

export class SkillLoader {
  constructor(
    private readonly embeddedSkillsRoot: string,
    private readonly customSkillsRoot: string,
  ) {}

  listEmbeddedSkills(): SkillDefinition[] {
    return EMBEDDED_SKILLS.flatMap((skill) => {
      const loaded = this.loadEmbeddedSkill(skill.id)
      return loaded ? [loaded] : []
    })
  }

  loadEmbeddedSkill(skillId: string): SkillDefinition | null {
    const meta = EMBEDDED_SKILLS.find((entry) => entry.id === skillId)
    if (!meta) return null
    return this.compileEmbeddedSkill(meta)
  }

  listCustomSkills(): SkillDefinition[] {
    return listManagedCustomSkills(this.customSkillsRoot).flatMap((skill) => {
      const loaded = this.loadCustomSkill(skill.id)
      return loaded ? [loaded] : []
    })
  }

  loadCustomSkill(skillId: string): SkillDefinition | null {
    const record = getManagedCustomSkill(this.customSkillsRoot, skillId)
    if (!record) return null
    return compileSkillDefinition({
      folderPath: record.managedPath,
      source: 'custom',
      managedPath: record.managedPath,
      sourcePath: record.sourcePath,
    })
  }

  loadSkill(skillId: string, preferredRoot?: string): SkillDefinition | null {
    if (preferredRoot && existsSync(preferredRoot)) {
      try {
        return compileSkillDefinition({
          folderPath: preferredRoot,
          source: EMBEDDED_SKILLS.some((entry) => entry.id === skillId) ? 'embedded' : 'custom',
          managedPath: preferredRoot,
          sourcePath: preferredRoot,
        })
      } catch {
        // fall through to standard roots
      }
    }
    return this.loadEmbeddedSkill(skillId) || this.loadCustomSkill(skillId)
  }

  private compileEmbeddedSkill(skill: EmbeddedSkillManifest): SkillDefinition | null {
    const folderPath = join(this.embeddedSkillsRoot, skill.id)
    if (!existsSync(folderPath)) return null
    return compileSkillDefinition({
      folderPath,
      source: 'embedded',
      sourcePath: folderPath,
      fallbackMeta: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        requirementsFile: skill.requirementsFile,
      },
    })
  }
}
