// Stage N (Phase 0.3) — pure helper for the manifest⇔driver +
// manifest⇔static-name boot invariants. Extracted from `runtime.ts` so
// tests can verify the throw shape without constructing a full
// `AgentControlRuntime` (which requires DB + IPC wiring).
//
// The runtime constructor invokes `assertStageNChildLoopInvariants(...)`
// AFTER the existing best-effort `configureSkillChildRunner` try/catch so
// a violation throws uncaught and aborts boot via the global
// unhandledRejection handler. Tests can call this function directly with
// fake skill / driver lists.

import { getStaticSkillToolNameForAction } from '../tools/skills-tools-static'

export interface StageNSkillSnapshot {
  id: string
  source: 'embedded' | 'custom'
  childLoop?: { actions?: string[] | null } | null
}

export interface StageNAssertionInputs {
  skills: ReadonlyArray<StageNSkillSnapshot>
  registeredDriverSkillIds: ReadonlyArray<string>
  /**
   * Override the default static-name lookup. Used by self-tests to inject
   * a fake `STATIC_SKILL_TOOL_NAMES_BY_ACTION` map. Production callers
   * should leave this undefined — the default reads the live map.
   */
  staticToolNameLookup?: (skillId: string, actionName: string) => string | null
  /**
   * Optional warn sink for the "custom skill declares child_loop" branch
   * (which should never fire in production after Phase 0.4 compile-time
   * stripping). Defaults to `console.warn`.
   */
  warn?: (message: string) => void
}

export function assertStageNChildLoopInvariants(inputs: StageNAssertionInputs): void {
  const lookup = inputs.staticToolNameLookup ?? getStaticSkillToolNameForAction
  const warn = inputs.warn ?? ((m) => console.warn(m))

  const drivers = new Set(inputs.registeredDriverSkillIds)
  const driverOrphans: string[] = []
  const staticNameOrphans: Array<{ skillId: string; action: string }> = []
  const customWithChildLoop: string[] = []

  for (const skill of inputs.skills) {
    const childLoopActions = skill.childLoop?.actions || []
    if (childLoopActions.length === 0) continue

    if (skill.source !== 'embedded') {
      customWithChildLoop.push(skill.id)
      continue
    }

    if (!drivers.has(skill.id)) {
      driverOrphans.push(skill.id)
    }
    for (const action of childLoopActions) {
      const toolName = lookup(skill.id, action)
      if (!toolName) {
        staticNameOrphans.push({ skillId: skill.id, action })
      }
    }
  }

  if (customWithChildLoop.length > 0) {
    warn(
      `[AgentControlRuntime] custom skills declare child_loop (Phase 0.4 should have dropped these at compile; reaching this branch indicates a test that bypassed skill-compiler): ${customWithChildLoop.join(', ')}`,
    )
  }

  const violations: string[] = []
  if (driverOrphans.length > 0) {
    violations.push(
      `embedded manifests declare child_loop but no driver registered: ${driverOrphans.join(', ')}`,
    )
  }
  if (staticNameOrphans.length > 0) {
    violations.push(
      `embedded manifest child_loop actions missing in STATIC_SKILL_TOOL_NAMES_BY_ACTION: ${
        staticNameOrphans.map(({ skillId, action }) => `${skillId}:${action}`).join(', ')
      }`,
    )
  }
  if (violations.length > 0) {
    throw new Error(`[Stage N invariant] ${violations.join('; ')}`)
  }
}
