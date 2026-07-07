/**
 * P3-2 — per-skill `skill_run_shell` consent policy.
 *
 * Embedded skills ship with the app and pass the CI security contract, so they may run scripts by
 * default. Custom/imported skills require EXPLICIT per-skill consent (a settings toggle) before the
 * agent is allowed to run their scripts. This does not change the sandbox/allowlist — a granted skill
 * still runs under the same shell fences; consent only gates whether `skill_run_shell` is authorized.
 *
 * The pure policy (`parseShellConsentMap` / `resolveSkillShellAllowed` / `skillDirHasScripts`) is
 * unit-testable; `getSkillShellConsent` / `setSkillShellConsent` are thin DB-backed wrappers.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

/** True when the skill's managed folder contains a `scripts/` directory. */
export function skillDirHasScripts(managedPath: string | undefined | null): boolean {
  if (!managedPath) return false
  try {
    return existsSync(join(managedPath, 'scripts'))
  } catch {
    return false
  }
}

/** Pure P3-2 policy: shell is allowed only when the skill has scripts AND (is embedded OR consented). */
export function resolveSkillShellAllowed(params: {
  hasScripts: boolean
  isEmbedded: boolean
  hasConsent: boolean
}): boolean {
  return params.hasScripts && (params.isEmbedded || params.hasConsent)
}
