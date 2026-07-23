/**
 * P3-2 — per-skill `skill_run_shell` consent policy.
 *
 * Binaries explicitly declared through Agent Skills `metadata.requires.bins` are available without
 * a second Ready-specific toggle. Embedded skills may also run their bundled scripts by default;
 * custom/imported bundled scripts still require per-skill consent.
 *
 * The pure policy (`parseShellConsentMap` / `resolveSkillShellAllowed`) is
 * unit-testable; `getSkillShellConsent` / `setSkillShellConsent` are thin DB-backed wrappers.
 */
import { getDatabase } from '../database'
import { EMBEDDED_SKILL_IDS } from './manifest'

const SHELL_CONSENT_SETTING_KEY = 'skill_shell_consent'

/** Parse the persisted `{ [skillId]: true }` consent map; any bad/absent/non-object JSON → {}. */
export function parseShellConsentMap(raw: string | null | undefined): Record<string, true> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const map: Record<string, true> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === true && key) map[key] = true
  }
  return map
}

export function getSkillShellConsent(skillId: string): boolean {
  if (!skillId) return false
  try {
    return parseShellConsentMap(getDatabase().getSetting(SHELL_CONSENT_SETTING_KEY))[skillId] === true
  } catch {
    return false
  }
}

export function setSkillShellConsent(skillId: string, granted: boolean): void {
  if (!skillId) return
  const map = parseShellConsentMap(getDatabase().getSetting(SHELL_CONSENT_SETTING_KEY))
  if (granted) map[skillId] = true
  else delete map[skillId]
  getDatabase().setSetting(SHELL_CONSENT_SETTING_KEY, JSON.stringify(map))
}

/** Embedded skills are shipped + CI-reviewed → shell allowed by default. */
export function isEmbeddedSkill(skillId: string): boolean {
  return EMBEDDED_SKILL_IDS.has(skillId)
}

/** Declared local binaries are immediate; bundled scripts retain the existing trust boundary. */
export function resolveSkillShellAllowed(params: {
  hasScripts: boolean
  hasDeclaredBins: boolean
  isEmbedded: boolean
  hasConsent: boolean
}): boolean {
  return params.hasDeclaredBins
    || (params.hasScripts && (params.isEmbedded || params.hasConsent))
}
