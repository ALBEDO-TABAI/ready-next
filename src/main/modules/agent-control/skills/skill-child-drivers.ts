/**
 * Phase 5 — Skill Child Driver registry.
 *
 * A driver owns the "what action runs next" decision for a long-running
 * skill. The runner (`skill-child-runner.ts`) hands the driver the current
 * state and asks for either a `SkillChildDriverAction` (run this internal
 * action) or a `SkillChildCloseEvent` (we're done — emit this close).
 *
 * Drivers are registered at module load. The registry is module-scoped so
 * tests can swap drivers with `registerSkillChildDriver(...)`; duplicate
 * registrations log a warning and the newer driver wins (keeps tests
 * predictable without throwing during hot-reload).
 *
 * Source plan: §3.2 Runtime Decisions, §5.5 Admission Rules, §Phase 5.
 */

import type { SkillRunResult } from '../../skills-runtime/runtime-manager'

import type { SkillRunContract } from '../contracts/run-contracts'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildDriverState,
  SkillChildLaunchParams,
} from './skill-child-run-types'

export interface SkillChildDriver {
  readonly skillId: string
  /** Optional per-instance ownership predicate — exposed so the parent turn
   *  engine can ask "is this skill child-owned now?" without consulting the
   *  registry. Default is `id === this.skillId`. */
  ownsSkill?(skillId: string): boolean
  canStart(input: Record<string, unknown>): boolean
  canResume(contract: SkillRunContract): boolean
  createInitialState(params: SkillChildLaunchParams): Promise<SkillChildDriverState>
  planNextAction(
    state: SkillChildDriverState,
  ): Promise<SkillChildDriverAction | SkillChildCloseEvent>
  observeAfterAction(
    state: SkillChildDriverState,
    result: SkillRunResult,
  ): Promise<SkillChildDriverState>
}

const driverRegistry = new Map<string, SkillChildDriver>()

export const __breaksInvariants = [
  'singleton.skill-child-driver-registry.never-reset-mid-session',
] as const

export function registerSkillChildDriver(driver: SkillChildDriver): void {
  if (driverRegistry.has(driver.skillId)) {
    console.warn(
      `[skill-child-drivers] duplicate driver registration for ${driver.skillId}; newer wins`,
    )
  }
  driverRegistry.set(driver.skillId, driver)
}

export function getSkillChildDriver(skillId: string): SkillChildDriver | null {
  return driverRegistry.get(skillId) ?? null
}

export function listRegisteredSkillChildDrivers(): readonly string[] {
  return Array.from(driverRegistry.keys())
}

/**
 * Phase 5 — convenience predicate for the parent turn-engine. Returns true
 * when ANY registered driver claims ownership of `skillId`. A driver can
 * claim ownership of multiple skill ids by overriding `ownsSkill`; the
 * default match is by `skillId` equality.
 */
export function isChildOwnedSkill(skillId: string): boolean {
  for (const driver of driverRegistry.values()) {
    const owns = driver.ownsSkill ? driver.ownsSkill(skillId) : driver.skillId === skillId
    if (owns) return true
  }
  return false
}

/** Test helper — clears the registry. NOT exported from index/runtime; only
 *  used in unit tests that want a clean slate. */
export function __resetSkillChildDriversForTests(): void {
  driverRegistry.clear()
}
