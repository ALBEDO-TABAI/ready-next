/**
 * Session gate for skill primitive tools.
 *
 * This module provides session-based filtering and exposure control for
 * skill primitive tools, particularly skill_ask_user.
 */

import { SkillsRuntimeManager } from '../skills-runtime/runtime-manager'

export function shouldExposeAskUserPrimitive(sessionId: string): boolean {
  const ephemeralStore = SkillsRuntimeManager.getEphemeralStore()
  return ephemeralStore.hasActiveAsk(sessionId)
}

export function filterSkillPrimitivesBySession(
  toolNames: string[],
  sessionId: string
): string[] {
  const STATIC_SKILL_PRIMITIVE_TOOL_NAMES = [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
  ]

  if (!sessionId) {
    return toolNames.filter((name) => !STATIC_SKILL_PRIMITIVE_TOOL_NAMES.includes(name))
  }

  const hasActiveAsk = shouldExposeAskUserPrimitive(sessionId)

  return toolNames.filter((name) => {
    if (!STATIC_SKILL_PRIMITIVE_TOOL_NAMES.includes(name)) {
      return true // Non-primitive tools are always exposed
    }

    // Only expose skill_ask_user if there's an active ask for this session
    if (name === 'skill_ask_user') {
      return hasActiveAsk
    }

    // Other primitives (run_shell, write_artifact, read_artifact) are always exposed
    return true
  })
}

export function hasActiveEphemeralAsk(sessionId: string): boolean {
  return shouldExposeAskUserPrimitive(sessionId)
}
