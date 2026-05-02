/**
 * B-arch-3 — SkillHostController.
 *
 * Reads a skill manifest's optional `host_requirements` block and prepares the
 * declarative spawn environment a skill needs (config files, secondary files,
 * env overrides), then restores everything on completion. Also exposes status
 * detection, shell-allowlist extension and per-skill mutex so the rest of the
 * runtime can stay generic.
 *
 * Source of truth for the contract: `src/shared/skill-host-contract.ts`.
 * Templater: `./contract-templater.ts`.
 * Agent context: `./agent-context-source.ts`.
 *
 * Safety invariants enforced here (test coverage in
 * `src/__tests__/skill-host-controller.test.ts`):
 *   - In-memory backup of any pre-existing config file BEFORE write
 *   - Per-skill mutex when `concurrency.model === 'serialized'`
 *   - Path traversal rejection AFTER `path.resolve` — paths must stay inside
 *     home / system temp / a small set of allowed roots
 *   - Restore is idempotent and never throws (best-effort logging)
 *   - api_key is never logged (we never log resolved values, only paths +
 *     errors)
 */

import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'

import type { AgentSpawnContext, SkillHostRequirements } from '../../../shared/skill-host-contract'
import { atomicWriteText } from '../agent-control/atomic-write'
import { getCurrentAgentContext } from './agent-context-source'
import {
  TemplateError,
  makeTemplateContext,
  renderConfigFileContent,
  renderTemplate,
  type TemplateContext,
} from './contract-templater'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpawnContextHandle {
  jobId: string
  skillId: string
  /**
   * Backup of the config file before we wrote it. `existed=false` means there
   * was no file at the path; `restoreSpawnContext` will then `unlink` ours.
   * `existed=true` means we'll write `content` back byte-for-byte.
   */
  configFileBackup?: { path: string; existed: boolean; content: string | null }
  /** Paths of secondary files we created — to remove on restore. */
  secondaryFilesCreated: string[]
  /** Spawn-time env overrides (unused by the controller itself; for the caller). */
  envOverrides?: Record<string, string>
  /** Releases the per-skill mutex (no-op for shared-concurrency skills). */
  releaseLock: () => void
}

export interface StatusReport {
  status: 'done' | 'error' | 'blocked'
  detail?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` (literal) to `os.homedir()`. Other tildes are left alone. */
function expandHomeTilde(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return homedir() + input.slice(1)
  }
  return input
}

/**
 * Render a template, expand a leading `~`, then `path.resolve` to an absolute
 * path. Throws if the resolved path contains `..` segments after resolution
 * (path-traversal guard) or escapes the allowed root set.
 *
 * Allowed roots: HOME, system temp, XDG_CONFIG_HOME (if set). This is the same
 * surface the templater exposes via `${env.*}`, so we don't widen the attack
 * surface beyond what the contract already allows.
 */
function resolveAndGuardPath(template: string, ctx: TemplateContext): string {
  const rendered = renderTemplate(template, ctx)
  const expanded = expandHomeTilde(rendered)
  const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(expanded)

  // After resolve, `..` segments are collapsed. If any survived (e.g. the
  // resolved path contains `..` because the input was malformed and resolve
  // could not fold it), reject.
  const segments = absolute.split(sep)
  if (segments.some((s) => s === '..')) {
    throw new SkillHostPathError(
      `path contains parent traversal after resolve: ${absolute}`,
    )
  }

  // Allowed roots: HOME, tmpdir(), XDG_CONFIG_HOME (if set).
  const allowedRoots: string[] = [resolvePath(homedir()), resolvePath(tmpdir())]
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && xdg.length > 0) {
    allowedRoots.push(resolvePath(xdg))
  }

  const isInside = allowedRoots.some((root) => {
    if (absolute === root) return true
    return absolute.startsWith(root + sep)
  })
  if (!isInside) {
    throw new SkillHostPathError(
      `path escapes allowed roots (home/tmp/xdg): ${absolute}`,
    )
  }

  return absolute
}

export class SkillHostPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillHostPathError'
  }
}

export class SkillHostContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillHostContextError'
  }
}

// ---------------------------------------------------------------------------
// SkillHostController
// ---------------------------------------------------------------------------

export interface SkillHostControllerOptions {
  /** Override the agent-context reader (tests inject a stub). */
  readAgentContext?: typeof getCurrentAgentContext
  /** Optional warn sink (defaults to console.warn). */
  warn?: (message: string) => void
}

export class SkillHostController {
  // Per-skill mutex chain. Each entry is the tail of the chain — new
  // `prepareSpawnContext` calls await the tail and replace it with a fresh
  // promise that resolves when the caller releases the lock.
  private readonly skillLockChains = new Map<string, Promise<void>>()
  private readonly readAgentContext: typeof getCurrentAgentContext
  private readonly warn: (message: string) => void

  constructor(options: SkillHostControllerOptions = {}) {
    this.readAgentContext = options.readAgentContext ?? getCurrentAgentContext
    this.warn = options.warn ?? ((msg) => { console.warn(`[skill-host-controller] ${msg}`) })
  }

  // ---------------------------------------------------------------------
  // prepareSpawnContext
  // ---------------------------------------------------------------------

  async prepareSpawnContext(
    skillId: string,
    skillName: string,
    skillAssetRoot: string,
    requirements: SkillHostRequirements | null,
    jobId: string,
    outputDir?: string,
    agentContext?: AgentSpawnContext | null,
  ): Promise<SpawnContextHandle> {
    const concurrencyMode = requirements?.concurrency?.model ?? 'serialized'
    const releaseLock = concurrencyMode === 'serialized'
      ? await this.acquireSkillLock(skillId)
      : (() => {})

    let lockReleased = false
    const safeRelease = (): void => {
      if (lockReleased) return
      lockReleased = true
      try { releaseLock() } catch { /* swallow */ }
    }

    try {
      // Read agent context (must succeed — skills cannot spawn without it).
      const agent = agentContext ?? await this.readAgentContext()
      if (!agent) {
        throw new SkillHostContextError(
          `cannot prepare spawn context for skill '${skillId}': no active AI config`,
        )
      }

      const ctx = makeTemplateContext({
        skill: { id: skillId, name: skillName, assetRoot: skillAssetRoot },
        agent,
        output_dir: outputDir,
      })

      const handle: SpawnContextHandle = {
        jobId,
        skillId,
        secondaryFilesCreated: [],
        envOverrides: requirements?.spawn_context?.env
          ? this.renderEnvMap(requirements.spawn_context.env, ctx)
          : undefined,
        releaseLock: safeRelease,
      }

      // ---- Config file ------------------------------------------------
      const configSpec = requirements?.spawn_context?.config_file
      if (configSpec) {
        const targetPath = resolveAndGuardPath(configSpec.path, ctx)

        // 1) Read existing content into in-memory backup BEFORE any write.
        let existed = false
        let originalContent: string | null = null
        if (existsSync(targetPath)) {
          existed = true
          try {
            originalContent = readFileSync(targetPath, 'utf8')
          } catch (err) {
            // If we can't read it, we still record `existed=true` but with
            // null content — restore will then unlink rather than overwrite
            // with an unknown payload. We surface this via the warn sink.
            originalContent = null
            this.warn(
              `failed to read existing config at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        handle.configFileBackup = { path: targetPath, existed, content: originalContent }

        // 2) Render and write the new content.
        const rendered = renderConfigFileContent(configSpec, originalContent, ctx)
        atomicWriteText(targetPath, rendered)
      }

      // ---- Secondary files -------------------------------------------
      const secondaries = requirements?.spawn_context?.secondary_files ?? []
      for (const spec of secondaries) {
        const targetPath = resolveAndGuardPath(spec.path, ctx)
        const content = renderTemplate(spec.content_template, ctx)
        atomicWriteText(targetPath, content)
        handle.secondaryFilesCreated.push(targetPath)
      }

      return handle
    } catch (err) {
      // If anything fails between lock acquisition and a successful return,
      // we MUST release the lock here — the caller never receives the handle
      // and therefore cannot call restoreSpawnContext.
      safeRelease()
      throw err
    }
  }

  // ---------------------------------------------------------------------
  // restoreSpawnContext (idempotent — safe to call twice)
  // ---------------------------------------------------------------------

  async restoreSpawnContext(handle: SpawnContextHandle): Promise<void> {
    // Delete created secondary files first.
    while (handle.secondaryFilesCreated.length > 0) {
      const path = handle.secondaryFilesCreated.pop()!
      try {
        unlinkSync(path)
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException | null)?.code
        if (code === 'ENOENT') {
          // Already gone — fine.
        } else {
          this.warn(
            `failed to remove secondary file ${path}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }

    // Restore the config file, if any.
    const backup = handle.configFileBackup
    if (backup) {
      try {
        if (backup.existed && backup.content !== null) {
          atomicWriteText(backup.path, backup.content)
        } else {
          // No prior file, or we couldn't read it → unlink ours.
          try {
            unlinkSync(backup.path)
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException | null)?.code
            if (code !== 'ENOENT') {
              throw err
            }
          }
        }
      } catch (err) {
        this.warn(
          `failed to restore config file ${backup.path}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      // Mark the backup consumed so a second call is a true no-op.
      handle.configFileBackup = undefined
    }

    // Always release the lock last.
    try { handle.releaseLock() } catch { /* swallow */ }
  }

  // ---------------------------------------------------------------------
  // getEffectiveShellAllowlist
  // ---------------------------------------------------------------------

  /**
   * Returns the effective allowlist for the current session.
   *   - If session has a reference-skill hint matching skillId, the skill's
   *     extensions are merged in.
   *   - Otherwise the base allowlist is returned untouched (we never pollute
   *     non-skill sessions with command extensions).
   *
   * Note: the controller does not itself read the reference-hint store —
   * callers are expected to pass `referenceSkillId` (the resolved hint id, or
   * null). This keeps the controller decoupled from session lifetime.
   */
  getEffectiveShellAllowlist(
    sessionId: string | undefined,
    referenceSkillId: string | null,
    baseAllowlist: ReadonlySet<string>,
    requirements: SkillHostRequirements | null,
  ): Set<string> {
    const merged = new Set<string>(baseAllowlist)
    if (!sessionId) return merged
    if (!referenceSkillId) return merged
    const extensions = requirements?.shell_allowlist_extensions
    if (!extensions || extensions.length === 0) return merged
    for (const cmd of extensions) {
      if (typeof cmd === 'string' && cmd.length > 0) {
        merged.add(cmd)
      }
    }
    return merged
  }

  // ---------------------------------------------------------------------
  // getEffectiveActionTimeout
  // ---------------------------------------------------------------------

  getEffectiveActionTimeout(
    requirements: SkillHostRequirements | null,
    actionTimeoutMs: number | undefined,
    fallbackDefault: number,
  ): number {
    if (typeof actionTimeoutMs === 'number' && Number.isFinite(actionTimeoutMs) && actionTimeoutMs > 0) {
      return actionTimeoutMs
    }
    const declared = requirements?.default_action_timeout_ms
    if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) {
      return declared
    }
    return fallbackDefault
  }

  // ---------------------------------------------------------------------
  // detectStatus
  // ---------------------------------------------------------------------

  async detectStatus(
    requirements: SkillHostRequirements | null,
    processResult: { exitCode: number | null; stdout: string; stderr: string },
    outputDir?: string,
  ): Promise<StatusReport> {
    const detection = requirements?.status_detection
    const method = detection?.method ?? 'exit_code'
    const blockedValues = detection?.blocked_values ?? ['blocked', 'pending_review', 'awaiting_input']
    const errorValues = detection?.error_values ?? ['error', 'failed']

    if (method === 'exit_code') {
      if (processResult.exitCode === 0) return { status: 'done' }
      return { status: 'error', detail: `exit_code=${processResult.exitCode}` }
    }

    if (method === 'stdout_json_line') {
      if (!detection?.json_field) {
        // Misconfigured — fall back to exit code.
        return processResult.exitCode === 0
          ? { status: 'done' }
          : { status: 'error', detail: `exit_code=${processResult.exitCode}` }
      }
      const fieldValue = this.findLastJsonFieldInStdout(
        processResult.stdout,
        detection.json_field,
      )
      if (fieldValue === null) {
        return processResult.exitCode === 0
          ? { status: 'done' }
          : { status: 'error', detail: `exit_code=${processResult.exitCode}` }
      }
      const valueStr = String(fieldValue)
      if (blockedValues.includes(valueStr)) {
        return { status: 'blocked', detail: valueStr }
      }
      if (errorValues.includes(valueStr)) {
        return { status: 'error', detail: valueStr }
      }
      if (valueStr === 'running' || valueStr === 'in_progress' || valueStr === 'waiting_for_batches') {
        return { status: 'blocked', detail: valueStr }
      }
      return { status: 'done', detail: valueStr }
    }

    if (method === 'sentinel_file') {
      if (!detection?.file_path) {
        return processResult.exitCode === 0
          ? { status: 'done' }
          : { status: 'error', detail: `exit_code=${processResult.exitCode}` }
      }
      // Build a minimal template context for the sentinel-file path. We have
      // no agent context here (we're post-spawn) — but the templater requires
      // one. Use a stub agent (status detection should not reference it).
      const ctx: TemplateContext = {
        skill: { id: 'unused', name: 'unused', assetRoot: '/' },
        agent: {
          provider: '', model_id: '', base_url: '', api_key: '', api_kind: 'openai-completions', fallback_chain: [],
        },
        spawn: { job_id: 'unused', tmp_dir: tmpdir(), timestamp: '' },
        output_dir: outputDir,
      }

      let resolvedPath: string
      try {
        resolvedPath = resolveAndGuardPath(detection.file_path, ctx)
      } catch (err) {
        return {
          status: 'error',
          detail: `sentinel_path_invalid: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      if (!existsSync(resolvedPath)) {
        return processResult.exitCode === 0
          ? { status: 'done' }
          : { status: 'error', detail: `exit_code=${processResult.exitCode}` }
      }
      let raw: string
      try {
        raw = readFileSync(resolvedPath, 'utf8')
      } catch (err) {
        return {
          status: 'error',
          detail: `sentinel_read_failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { status: 'error', detail: 'sentinel_parse_failed' }
      }
      const fieldName = detection.json_field
      let value: unknown = parsed
      if (fieldName && typeof parsed === 'object' && parsed !== null) {
        value = (parsed as Record<string, unknown>)[fieldName]
      }
      if (value === undefined || value === null) {
        const detail = `sentinel_field_missing: ${fieldName || '<root>'}`
        return processResult.exitCode === 0
          ? { status: 'done', detail }
          : { status: 'error', detail: `${detail}; exit_code=${processResult.exitCode}` }
      }
      const valueStr = String(value)
      if (blockedValues.includes(valueStr)) {
        return { status: 'blocked', detail: valueStr }
      }
      if (errorValues.includes(valueStr)) {
        return { status: 'error', detail: valueStr }
      }
      return { status: 'done', detail: valueStr }
    }

    // Unknown method — defensive default.
    return processResult.exitCode === 0
      ? { status: 'done' }
      : { status: 'error', detail: `exit_code=${processResult.exitCode}` }
  }

  // ---------------------------------------------------------------------
  // cleanupSkillArtifacts
  // ---------------------------------------------------------------------

  async cleanupSkillArtifacts(
    skillId: string,
    skillName: string,
    skillAssetRoot: string,
    requirements: SkillHostRequirements | null,
  ): Promise<{ removedPaths: string[]; errors: Array<{ path: string; error: string }> }> {
    const removedPaths: string[] = []
    const errors: Array<{ path: string; error: string }> = []

    const paths = requirements?.lifecycle?.on_uninstall_remove ?? []
    if (paths.length === 0) return { removedPaths, errors }

    // Minimal template context — no agent (skill is being uninstalled, the
    // agent context is not relevant). Templates that reference `agent.*` will
    // fail; this is intentional.
    const ctx: TemplateContext = {
      skill: { id: skillId, name: skillName, assetRoot: skillAssetRoot },
      agent: {
        provider: '', model_id: '', base_url: '', api_key: '', api_kind: 'openai-completions', fallback_chain: [],
      },
      spawn: { job_id: 'uninstall', tmp_dir: tmpdir(), timestamp: new Date().toISOString() },
    }

    for (const template of paths) {
      let resolved: string
      try {
        resolved = resolveAndGuardPath(template, ctx)
      } catch (err) {
        errors.push({ path: template, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      try {
        rmSync(resolved, { recursive: true, force: true })
        removedPaths.push(resolved)
      } catch (err) {
        errors.push({ path: resolved, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return { removedPaths, errors }
  }

  // ---------------------------------------------------------------------
  // Internal: per-skill mutex
  // ---------------------------------------------------------------------

  private async acquireSkillLock(skillId: string): Promise<() => void> {
    const previousTail = this.skillLockChains.get(skillId)
    let resolveNext!: () => void
    const nextTail = new Promise<void>((res) => { resolveNext = res })
    this.skillLockChains.set(skillId, nextTail)
    if (previousTail) {
      // Wait for the previous lock-holder to release before we proceed.
      try { await previousTail } catch { /* swallow */ }
    }
    return () => {
      // Release: resolve our tail so the next waiter unblocks. Also remove
      // our entry if we are still the current tail (no further waiters).
      resolveNext()
      if (this.skillLockChains.get(skillId) === nextTail) {
        this.skillLockChains.delete(skillId)
      }
    }
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private renderEnvMap(map: Record<string, string>, ctx: TemplateContext): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, valueTemplate] of Object.entries(map)) {
      out[key] = renderTemplate(valueTemplate, ctx)
    }
    return out
  }

  /**
   * Scan stdout for the LAST line that parses as JSON and contains the named
   * field. Returns the field's value or `null` if not found. Lines are
   * separated by \n. We iterate in reverse so cheap stop on first hit.
   */
  private findLastJsonFieldInStdout(stdout: string, fieldName: string): unknown {
    const lines = stdout.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      if (!line.startsWith('{') || !line.endsWith('}')) continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && fieldName in parsed) {
          return parsed[fieldName]
        }
      } catch {
        // Not JSON — keep scanning.
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let singleton: SkillHostController | null = null

export function getSkillHostController(): SkillHostController {
  if (!singleton) {
    singleton = new SkillHostController()
  }
  return singleton
}

// Test-only reset.
export function _resetSkillHostControllerForTests(): void {
  singleton = null
}
