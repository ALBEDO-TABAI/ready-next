import { AppSettingsRepository } from '../repositories/app-settings-repository'
import type { SkillDefinition } from '../../../shared/skill-execution-types'
import {
  buildDefaultSkillConfigurationValues,
  mergeSkillConfigurationValues,
  type SkillConfigurationUpdateInput,
  type SkillConfigurationValues,
  type SkillConfigurationView,
} from '../../../shared/skill-configuration'

export const SKILL_CONFIGURATION_SETTINGS_KEY = 'skill_configuration_values_v1'

function parseJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export class SkillConfigurationStore {
  constructor(private readonly repository = new AppSettingsRepository()) {}

  private readAll(): Record<string, unknown> {
    return parseJson(this.repository.getSetting(SKILL_CONFIGURATION_SETTINGS_KEY))
  }

  private writeAll(value: Record<string, unknown>): void {
    this.repository.setSetting(SKILL_CONFIGURATION_SETTINGS_KEY, JSON.stringify(value))
  }

  getValues(definition: SkillDefinition): SkillConfigurationValues {
    const all = this.readAll()
    return mergeSkillConfigurationValues(definition.configuration, all[definition.id])
  }

  getView(definition: SkillDefinition): SkillConfigurationView {
    return {
      skillId: definition.id,
      definition: definition.configuration || null,
      values: this.getValues(definition),
    }
  }

  updateValues(definition: SkillDefinition, input: SkillConfigurationUpdateInput): SkillConfigurationView {
    if (input.skillId !== definition.id) throw new Error('Skill id mismatch')
    if (!definition.configuration) throw new Error(`Skill ${definition.id} has no configurable settings`)

    const current = this.getValues(definition)
    const allowedBindingIds = new Set(definition.configuration.serviceBindings.map((item) => item.id))
    const allowedFieldIds = new Set(definition.configuration.fields.map((item) => item.id))
    const next: SkillConfigurationValues = {
      serviceBindings: { ...current.serviceBindings },
      fields: { ...current.fields },
    }

    for (const [key, value] of Object.entries(input.serviceBindings || {})) {
      if (allowedBindingIds.has(key)) next.serviceBindings[key] = String(value || '').trim()
    }
    for (const [key, value] of Object.entries(input.fields || {})) {
      if (allowedFieldIds.has(key)) next.fields[key] = value
    }

    const all = this.readAll()
    all[definition.id] = next
    this.writeAll(all)
    return {
      skillId: definition.id,
      definition: definition.configuration,
      values: next,
    }
  }
}
