import { join } from 'path'
import { readdirSync, statSync } from 'fs'
import { sweepExpiredReferenceSkillHints } from '../agent-control/skills/skill-reference-hints'
import {
  sweepChildRunLogs,
  sweepOutputDirs,
} from './output-dir-sweep'
import { listManagedCustomSkills } from './custom-skill-registry'
import { EMBEDDED_SKILL_IDS, type EmbeddedSkillId } from './manifest'
import type { SkillHostController } from './skill-host-controller'
import { envNumber, RETIRED_EMBEDDED_SKILL_IDS } from './runtime-manager-helpers'

// B8-D M1 (2026-07-05) — delegated extraction from SkillsRuntimeManager
// (surgery map §2.3 D 表, 缝 F). Method bodies moved verbatim; the only edits
// are the mechanical `this.X` → `this.deps.X` rewrites for the injected
// dependency face below. The four sweep timers + the orphan-cleanup latch
// migrated with the cluster; the boot-delay / interval constants stay declared
// on SkillsRuntimeManager (tool-error-metrics-contract.test.ts pins their
// assignment text there) and are injected by value. Timer lifecycle
// (start/stop pairing, double-start warn + skip) is unchanged.

export interface MaintenanceSweepsDeps {
  runtimeRoot: string
  skillsRoot: string
  customSkillsRoot: string
  bootDelayMs: number
  sweepIntervalMs: number
  retiredEmbeddedSkillIds?: ReadonlySet<string>
  ensureRuntimeDirs: () => void
  getHostController: () => SkillHostController
}

export class MaintenanceSweeps {
  private referenceHintBootTimer: NodeJS.Timeout | null = null
  private referenceHintIntervalTimer: NodeJS.Timeout | null = null
  private outputDirSweepBootTimer: NodeJS.Timeout | null = null
  private outputDirSweepIntervalTimer: NodeJS.Timeout | null = null
  private orphanCleanupRan = false

  constructor(private readonly deps: MaintenanceSweepsDeps) {}

  /**
   * Phase 4 — prune idle reference-skill hints on an independent cadence now
   * that the skill_executions state machine (and its TTL sweep) is retired.
   * Runs once 30s after boot to avoid blocking startup, then hourly.
   * Best-effort; a failure logs to stderr and the next tick retries. The
   * metric name changed from `skill_executions_ttl_swept` to
   * `skill_reference_hint_ttl_swept` — see CHANGELOG.md.
   */
  startReferenceHintSweep(): void {
    if (this.referenceHintBootTimer || this.referenceHintIntervalTimer) {
      console.warn('[SkillsRuntimeManager] reference-hint sweep already running; start skipped')
      return
    }
    const sweep = (): void => {
      try {
        sweepExpiredReferenceSkillHints()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[SkillsRuntimeManager] reference-hint sweep failed:', message)
      }
    }
    this.referenceHintBootTimer = setTimeout(
      sweep,
      this.deps.bootDelayMs,
    )
    this.referenceHintIntervalTimer = setInterval(
      sweep,
      this.deps.sweepIntervalMs,
    )
  }

  stopReferenceHintSweep(): void {
    if (this.referenceHintBootTimer) {
      clearTimeout(this.referenceHintBootTimer)
      this.referenceHintBootTimer = null
    }
    if (this.referenceHintIntervalTimer) {
      clearInterval(this.referenceHintIntervalTimer)
      this.referenceHintIntervalTimer = null
    }
  }

  startOutputDirSweep(): void {
    if (this.outputDirSweepBootTimer || this.outputDirSweepIntervalTimer) {
      console.warn('[SkillsRuntimeManager] outputDir sweep already running; start skipped')
      return
    }
    const sweep = (): void => {
      void (async () => {
        try {
          await sweepOutputDirs({
            runtimeRoot: this.deps.runtimeRoot,
            retentionDays: envNumber('READY_OUTPUT_DIR_RETENTION_DAYS', 7),
            legacyGraceDays: envNumber('READY_OUTPUT_DIR_LEGACY_GRACE_DAYS', 30),
          })
          await sweepChildRunLogs({
            runtimeRoot: this.deps.runtimeRoot,
            retentionDays: envNumber('READY_CHILD_RUN_LOG_RETENTION_DAYS', 30),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error('[SkillsRuntimeManager] outputDir sweep failed:', message)
        }
      })()
    }
    this.outputDirSweepBootTimer = setTimeout(
      sweep,
      this.deps.bootDelayMs,
    )
    this.outputDirSweepIntervalTimer = setInterval(
      sweep,
      this.deps.sweepIntervalMs,
    )
  }

  stopOutputDirSweep(): void {
    if (this.outputDirSweepBootTimer) {
      clearTimeout(this.outputDirSweepBootTimer)
      this.outputDirSweepBootTimer = null
    }
    if (this.outputDirSweepIntervalTimer) {
      clearInterval(this.outputDirSweepIntervalTimer)
      this.outputDirSweepIntervalTimer = null
    }
  }

  /**
   * B-arch-4 — one-shot orphan-skill artifact cleanup. Scans the runtime
   * skills directory for sub-folders that are NOT in the current embedded
   * manifest list AND NOT registered in the custom-skill registry. Each
   * candidate is then gated against `RETIRED_EMBEDDED_SKILL_IDS` (a small
   * explicit allowlist of ids we know used to ship embedded but no longer do)
   * before invoking `controller.cleanupSkillArtifacts`. This avoids
   * accidentally rm'ing a custom skill the user is actively using or an
   * embedded skill we're about to re-add.
   *
   * Logs every action — including no-ops — so a curious operator can verify
   * the sweep ran. Idempotent: only runs once per process. Marked `public` so
   * tests can invoke it deterministically without relying on the constructor
   * side-effect; production callers should not invoke it directly (the
   * constructor handles it under `startBackgroundTasks !== false`).
   */
  async cleanupOrphanedSkillArtifactsOnce(): Promise<void> {
    if (this.orphanCleanupRan) return
    this.orphanCleanupRan = true
    this.deps.ensureRuntimeDirs()
    const controller = this.deps.getHostController()
    const customIds = new Set<string>(
      listManagedCustomSkills(this.deps.customSkillsRoot).map((skill) => skill.id),
    )

    let dirNames: string[]
    try {
      dirNames = readdirSync(this.deps.skillsRoot)
    } catch (error) {
      console.warn('[SkillsRuntimeManager] orphan cleanup: failed to scan skills root:', error instanceof Error ? error.message : String(error))
      return
    }

    const candidates: string[] = []
    for (const name of dirNames) {
      if (EMBEDDED_SKILL_IDS.has(name as EmbeddedSkillId)) continue
      if (customIds.has(name)) continue
      try {
        if (!statSync(join(this.deps.skillsRoot, name)).isDirectory()) continue
      } catch {
        continue
      }
      candidates.push(name)
    }

    if (candidates.length === 0) {
      console.log('[SkillsRuntimeManager] orphan cleanup: no candidates found')
      return
    }

    const retiredIds = this.deps.retiredEmbeddedSkillIds ?? RETIRED_EMBEDDED_SKILL_IDS
    for (const skillId of candidates) {
      const isRetired = retiredIds.has(skillId)
      if (!isRetired) {
        console.log('[SkillsRuntimeManager] orphan cleanup: skipping', skillId, '(not in RETIRED_EMBEDDED_SKILL_IDS)')
        continue
      }
      const skillAssetRoot = join(this.deps.skillsRoot, skillId)
      try {
        const result = await controller.cleanupSkillArtifacts(skillId, skillId, skillAssetRoot, null)
        console.log(
          '[SkillsRuntimeManager] orphan cleanup: ran cleanupSkillArtifacts for',
          skillId,
          '— removed:',
          result.removedPaths.length,
          'errors:',
          result.errors.length,
        )
      } catch (error) {
        console.warn(
          '[SkillsRuntimeManager] orphan cleanup: cleanupSkillArtifacts threw for',
          skillId,
          ':',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
}
