import { randomUUID } from 'crypto'
import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import type {
  SkillActionDefinition,
  SkillActionResult,
  SkillDefinition,
  SkillRuntimeKind,
} from '../../../shared/skill-execution-types'
import { detectMissingRuntimeDependency } from '../../../shared/model-pack-types'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import type {
  SkillHostController,
  SpawnContextHandle,
} from './skill-host-controller'
import type { SkillLoader } from './skill-loader'
import { spawnWithTreeKill, type SpawnWithTreeKillError } from '../process-cleanup/spawn-with-tree-kill'
import {
  DEFAULT_TIMEOUT_MS,
  DIRECT_ACTION_INMEMORY_CAP,
  MAX_COMMAND_BUFFER,
  mergeSkillRunStatus,
  normalizeSkillRunStatus,
  truncateOutput,
} from './runtime-manager-helpers'
import type {
  SkillId,
  SkillInstallResult,
  SkillRunRequest,
  SkillRunResult,
  SkillTriggerType,
} from './runtime-manager-types'

// B8-D M2 (2026-07-05) — delegated extraction from SkillsRuntimeManager
// (surgery map §2.3 D 表, execution engine 缝). Method bodies moved verbatim;
// the only edits are the mechanical `this.X` → `this.deps.X` rewrites for the
// injected dependency face below. Job bookkeeping (recordJobStart/Finish),
// host prep, external env and output-dir resolution stay owned by their home
// clusters on the manager and are injected as callbacks so this file never
// imports runtime-manager (防环).

export interface SkillExecutionEngineDeps {
  runtimeRoot: string
  outputsRoot: string
  ensureRuntimeDirs: () => void
  ensureSkillInstalled: (skillId: SkillId) => Promise<SkillInstallResult>
  getSkillLoader: () => SkillLoader
  getSkillRuntimePath: (skillId: SkillId) => string
  getHostController: () => SkillHostController
  shouldPrepareSkillHost: (requirements: import('../../../shared/skill-host-contract').SkillHostRequirements | null) => boolean
  resolveConfiguredAgentContext: (definition: SkillDefinition) => AgentSpawnContext | null
  resolveExternalEnv: (definition: SkillDefinition) => Promise<Record<string, string>>
  cleanupExportedVideoCookieFile: (cookiePath: string | undefined) => void
  resolveOutputDir: (candidate: string | null, skillId: SkillId, jobId?: string) => string
  getBaseEnv: (options?: { allowPackaged?: boolean }) => NodeJS.ProcessEnv
  recordJobStart: (params: {
    skillId: SkillId
    action: string
    params?: Record<string, unknown>
    triggerType: SkillTriggerType
    scheduleId: string | null
  }) => string
  recordJobFinish: (jobId: string, result: SkillRunResult) => void
  parseJson: <T>(raw: string, fallback: T) => T
}

export class SkillExecutionEngine {
  constructor(private readonly deps: SkillExecutionEngineDeps) {}

  /**
   * Phase 5 — child-runner internal entry. The skill child runner calls
   * this so its inner action dispatch can never accidentally trip a
   * recursive child-loop wrap (Team 5). For now it's a thin alias of
   * `runSkill`; the wrap routing for "should this be wrapped in a child
   * run?" lives upstream in `skills-tools.ts` (Team 6) anyway, so this
   * method just provides a stable surface the runner can rely on as
   * upstream wrap routing evolves.
   */
  async runSkillFromChildRunner(request: SkillRunRequest): Promise<SkillRunResult> {
    return this.runSkill(request)
  }

  async runSkill(request: SkillRunRequest): Promise<SkillRunResult> {
    const triggerType = request.triggerType || 'manual'
    const jobId = this.deps.recordJobStart({
      skillId: request.skillId,
      action: request.action,
      params: request.params,
      triggerType,
      scheduleId: request.scheduleId || null,
    })
    const finish = (result: SkillRunResult): SkillRunResult => {
      const withJobId = { ...result, jobId }
      this.deps.recordJobFinish(jobId, withJobId)
      return withJobId
    }

    try {
      const resolved = await this.resolveSkillForExecution(request.skillId)
      if (!resolved) {
        return finish(this.invalidParams(request.skillId, request.action, `Unknown skill: ${request.skillId}`))
      }

      const action = resolved.definition.actions.find((item) => item.name === request.action)
      if (!action) {
        return finish(this.invalidParams(resolved.definition.id, request.action, `Unknown action: ${request.action}`))
      }

      // Phase 4: workflow-start branch retired. All skill actions now run
      // through runDefinitionActionDirect. Callers that still pass
      // executionMode='workflow' get a direct run — the requested semantics
      // mapped 1:1 onto direct runs for Phase 2/3 migrated embedded skills
      // anyway, since there are no skill.workflow.json files left.

      // B-arch-4 — Skill Host Contract wiring. Only requirements that need a
      // real host wrapper prepare the declarative spawn environment (config
      // file write, secondary files, env overrides, mutex acquisition) BEFORE
      // running the action. Timeout-only manifests still flow through
      // getEffectiveActionTimeout / detectStatus, but skip the agent-context
      // read cost.
      const controller = this.deps.getHostController()
      const hostRequirements = resolved.definition.hostRequirements ?? null
      const shouldPrepareHost = this.deps.shouldPrepareSkillHost(hostRequirements)
      const skillAssetRoot = resolved.installResult.skillPath || ''
      const effectiveTimeout = Math.max(
        3_000,
        controller.getEffectiveActionTimeout(
          hostRequirements,
          request.timeoutMs || action.timeoutMs,
          DEFAULT_TIMEOUT_MS,
        ),
      )

      let spawnHandle: SpawnContextHandle | null = null
      const rawOutputDir = request.params?.outputDir
      const requestedOutputDir = typeof rawOutputDir === 'string' && rawOutputDir.trim()
        ? rawOutputDir.trim()
        : null
      const actionDeclaresOutputDir = action.inputMode === 'json'
        && action.params.some((param) => param.name === 'outputDir')
      const shouldPrepareOutputDir = shouldPrepareHost || Boolean(requestedOutputDir) || actionDeclaresOutputDir
      const preparedOutputDir = shouldPrepareOutputDir
        ? this.deps.resolveOutputDir(requestedOutputDir, resolved.definition.id, jobId)
        : undefined
      let actionParams = preparedOutputDir && action.inputMode === 'json' && !requestedOutputDir
        ? { ...(request.params || {}), outputDir: preparedOutputDir }
        : (request.params || {})
      const childRunContext = request.params?.__childRunContext && typeof request.params.__childRunContext === 'object'
        ? request.params.__childRunContext as Record<string, unknown>
        : null
      const childRunId = typeof childRunContext?.childRunId === 'string' && childRunContext.childRunId.trim()
        ? childRunContext.childRunId.trim()
        : ''
      const configuredAgentContext = this.deps.resolveConfiguredAgentContext(resolved.definition)
      const effectiveAgentContext = configuredAgentContext ?? request.agentContext ?? null
      if (shouldPrepareHost) {
        spawnHandle = await controller.prepareSpawnContext(
          resolved.definition.id,
          resolved.definition.name,
          skillAssetRoot,
          hostRequirements,
          jobId,
          preparedOutputDir,
          effectiveAgentContext,
        )
      }

      const externalEnv = await this.deps.resolveExternalEnv(resolved.definition)
      const mergedEnv = {
        ...(spawnHandle?.envOverrides || {}),
        ...externalEnv,
        READY_SKILL_TASK_ID: jobId,
        ...(childRunId ? { READY_SKILL_CHILD_RUN_ID: childRunId } : {}),
        ...(request.env || {}),
      }

      try {
        const result = await this.runDefinitionActionDirect(
          resolved.definition,
          action,
          actionParams,
          effectiveTimeout,
          mergedEnv,
          resolved.installResult.venvPython,
          hostRequirements,
          request.signal,
          preparedOutputDir,
        )
        return finish(result)
      } finally {
        for (const cookiePath of new Set([
          externalEnv.READY_VIDEO_COOKIE_FILE,
          externalEnv.VIDEO_COOKIE_FILE,
          externalEnv.YOUTUBE_COOKIE_FILE,
        ])) {
          this.deps.cleanupExportedVideoCookieFile(cookiePath)
        }
        if (spawnHandle) {
          try {
            await controller.restoreSpawnContext(spawnHandle)
          } catch (error) {
            console.warn(
              '[SkillsRuntimeManager] restoreSpawnContext failed for',
              resolved.definition.id,
              ':',
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      }
    } catch (error) {
      return finish(this.invalidParams(
        request.skillId,
        request.action,
        error instanceof Error ? error.message : String(error),
      ))
    }
  }

  private invalidParams(skillId: SkillId, action: string, error: string): SkillRunResult {
    return {
      success: false,
      skillId,
      action,
      stdout: '',
      stderr: '',
      command: [],
      error,
      status: 'error',
    }
  }

  private buildActionArgs(params: Record<string, unknown>, action: SkillActionDefinition): string[] {
    const args = [...(action.baseArgs || [])]
    if (action.inputMode === 'json') {
      if (Object.keys(params).length > 0) {
        args.push('--payload-json', JSON.stringify(params))
      }
      return args
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`
      if (typeof value === 'boolean') {
        if (value) args.push(flag)
        continue
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          args.push(flag, String(entry))
        }
        continue
      }
      if (typeof value === 'object') {
        args.push(flag, JSON.stringify(value))
        continue
      }
      args.push(flag, String(value))
    }
    return args
  }

  private async resolveSkillForExecution(skillId: SkillId): Promise<{ definition: SkillDefinition; installResult: SkillInstallResult } | null> {
    this.deps.ensureRuntimeDirs()
    const installResult = await this.deps.ensureSkillInstalled(skillId)
    if (!installResult.success || !installResult.skillPath) {
      if (installResult.error && !installResult.error.startsWith(`Unknown skill: ${skillId}`)) {
        throw new Error(`Skill install failed for ${skillId}: ${installResult.error}`)
      }
      return null
    }
    const definition = this.deps.getSkillLoader().loadSkill(skillId, installResult.skillPath)
    if (!definition) {
      return null
    }
    return { definition, installResult }
  }

  private async runDefinitionActionDirect(
    definition: SkillDefinition,
    action: SkillActionDefinition,
    params: Record<string, unknown>,
    timeoutMs: number,
    envOverrides?: Record<string, string>,
    venvPython?: string,
    hostRequirements?: import('../../../shared/skill-host-contract').SkillHostRequirements | null,
    signal?: AbortSignal,
    preparedOutputDir?: string,
  ): Promise<SkillRunResult> {
    const skillPath = definition.source === 'embedded'
      ? this.deps.getSkillRuntimePath(definition.id)
      : (definition.managedPath || definition.sourcePath)
    const entryPath = join(skillPath, action.entry)

    let result: SkillRunResult
    if (action.runtime === 'reference') {
      // Reference skills are advisory/guidance loads — readFileSync of SKILL.md
      // with no subprocess, no side-effects, no execution state to track. The
      // previous implementation faked `command: ['read', path]` which caused
      // formatRunResult to wrap the content in "Command: read .../SKILL.md\n
      // STDOUT:\n..." — confusing the model into thinking a shell executed and
      // sometimes triggering a follow-up `skill_get_state` probe for an
      // execution that never exists. `mode: 'reference'` lets formatRunResult
      // render the file content with a compact guidance header instead.
      try {
        const stdout = readFileSync(entryPath, 'utf-8')
        result = {
          success: true,
          skillId: definition.id,
          action: action.name,
          stdout: truncateOutput(stdout),
          stderr: '',
          command: [],
          mode: 'reference',
        }
      } catch (error) {
        result = {
          success: false,
          skillId: definition.id,
          action: action.name,
          stdout: '',
          stderr: '',
          command: [],
          error: error instanceof Error ? error.message : String(error),
          mode: 'reference',
        }
      }
    } else {
      const args = this.buildActionArgs(params, action)
      if (action.runtime === 'python') {
        if (!venvPython) {
          return this.invalidParams(definition.id, action.name, 'Python skill runtime is unavailable')
        }
        result = await this.runDirectScript(
          definition.id,
          skillPath,
          action,
          venvPython,
          [entryPath, ...args],
          timeoutMs,
          envOverrides,
          signal,
          definition.source === 'embedded',
        )
      } else if (action.runtime === 'node') {
        result = await this.runDirectScript(
          definition.id,
          skillPath,
          action,
          'node',
          [entryPath, ...args],
          timeoutMs,
          envOverrides,
          signal,
          definition.source === 'embedded',
        )
      } else {
        result = await this.runDirectScript(
          definition.id,
          skillPath,
          action,
          entryPath,
          args,
          timeoutMs,
          envOverrides,
          signal,
          definition.source === 'embedded',
        )
      }
    }

    // B-arch-4 — backfill SkillRunResult.status via the host controller's
    // detectStatus. Without host_requirements this defaults to exit_code
    // mapping (success → 'done', failure → 'error'), preserving legacy
    // semantics. With host_requirements declaring `status_detection`, the
    // controller can return 'blocked' even when exitCode === 0 — e.g. a
    // staged pipeline that wrote `{"status":"blocked"}` to its sentinel
    // file because it's waiting on a user decision. Reference actions go
    // through this path too so a reference skill that declares
    // status_detection still benefits from the override (rare but allowed).
    try {
      const controller = this.deps.getHostController()
      const inferredExitCode = result.success ? 0 : 1
      const status = await controller.detectStatus(
        hostRequirements ?? null,
        { exitCode: inferredExitCode, stdout: result.stdout || '', stderr: result.stderr || '' },
        result.outputDir || preparedOutputDir,
      )
      result.status = mergeSkillRunStatus(result.status, status.status)
    } catch (error) {
      // detectStatus must never break the skill run — fall back to legacy
      // success-mapping. Telemetry surfaces via the warn log.
      console.warn(
        '[SkillsRuntimeManager] detectStatus failed for',
        definition.id,
        action.name,
        ':',
        error instanceof Error ? error.message : String(error),
      )
      result.status = result.status || (result.success ? 'done' : 'error')
    }
    if (!result.outputDir && preparedOutputDir) {
      result.outputDir = preparedOutputDir
    }
    return result
  }

  private async runDirectScript(
    skillId: SkillId,
    cwd: string,
    action: SkillActionDefinition,
    commandBin: string,
    commandArgs: string[],
    timeoutMs: number,
    envOverrides?: Record<string, string>,
    signal?: AbortSignal,
    allowPackagedRuntime?: boolean,
  ): Promise<SkillRunResult> {
    const executed = await this.executeProcessWithStructuredResult({
      skillId,
      actionName: action.name,
      runtime: action.runtime,
      cwd,
      commandBin,
      commandArgs,
      timeoutMs,
      envOverrides,
      signal,
      allowPackagedRuntime,
      preferStructuredResult: true,
    })
    return this.toDirectRunResult(skillId, action.name, executed)
  }

  // Phase 4: executeWorkflowRuntimeAction removed along with the
  // skill_executions state machine. All skill actions run through
  // runDefinitionActionDirect now.

  private createStructuredResultPath(skillId: string, actionName: string): string {
    const dir = join(this.deps.runtimeRoot, 'results')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${skillId}-${actionName}-${randomUUID()}.json`)
  }

  private async executeProcessWithStructuredResult(params: {
    skillId: string
    actionName: string
    runtime: SkillRuntimeKind
    cwd: string
    commandBin: string
    commandArgs: string[]
    timeoutMs: number
    envOverrides?: Record<string, string>
    signal?: AbortSignal
    allowPackagedRuntime?: boolean
    preferStructuredResult: boolean
  }): Promise<{
    success: boolean
    stdout: string
    stderr: string
    command: string[]
    error?: string
    outputDir?: string
    structuredResult?: SkillActionResult
    /**
     * C6 — populated when stdout/stderr exceeded the in-memory cap and surplus
     * was spilled to a per-action `.logs/` artifact under
     * `<runtimeRoot>/outputs/<skillId>/`. `*Error` is populated instead when
     * the disk write itself failed; the command result is still returned in
     * either case so the caller never sees a thrown error from a log spill.
     */
    stdoutArtifactPath?: string
    stderrArtifactPath?: string
    stdoutArtifactError?: string
    stderrArtifactError?: string
  }> {
    const command = [params.commandBin, ...params.commandArgs]
    const resultPath = params.preferStructuredResult ? this.createStructuredResultPath(params.skillId, params.actionName) : null
    const env = {
      ...this.deps.getBaseEnv({ allowPackaged: params.allowPackagedRuntime ?? true }),
      ...(params.envOverrides || {}),
      ...(resultPath ? { READY_SKILL_RESULT_PATH: resultPath } : {}),
    }

    // C6 — overflow-to-disk plumbing. We pre-compute the per-stream artifact
    // paths under `<outputsRoot>/<skillId>/.logs/` and lazy-create the directory
    // on the first spilled chunk (so skills whose output stays under 1 MiB
    // never touch the filesystem). The sinks close over the dir-creation state
    // so a single mkdir failure short-circuits subsequent appends without
    // taking the command down with it.
    const logId = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const logsDir = join(this.deps.outputsRoot, params.skillId, '.logs')
    const stdoutLogPath = join(logsDir, `skill-action-${logId}-stdout.txt`)
    const stderrLogPath = join(logsDir, `skill-action-${logId}-stderr.txt`)

    let logsDirReady: boolean | null = null // null = untried; true = ok; false = mkdir failed
    let logsDirError: string | null = null
    const ensureLogsDir = (): boolean => {
      if (logsDirReady !== null) return logsDirReady
      try {
        mkdirSync(logsDir, { recursive: true })
        logsDirReady = true
      } catch (err) {
        logsDirReady = false
        logsDirError = err instanceof Error ? err.message : String(err)
        console.warn('[SkillsRuntimeManager] failed to create skill log dir', logsDir, ':', logsDirError)
      }
      return logsDirReady
    }

    let stdoutWritten = false
    let stderrWritten = false
    let stdoutWriteError: string | null = null
    let stderrWriteError: string | null = null

    const stdoutSink = (chunk: string): void => {
      if (!ensureLogsDir()) {
        if (!stdoutWriteError) stdoutWriteError = logsDirError || 'logs directory unavailable'
        return
      }
      try {
        appendFileSync(stdoutLogPath, chunk, 'utf-8')
        stdoutWritten = true
      } catch (err) {
        if (!stdoutWriteError) stdoutWriteError = err instanceof Error ? err.message : String(err)
      }
    }
    const stderrSink = (chunk: string): void => {
      if (!ensureLogsDir()) {
        if (!stderrWriteError) stderrWriteError = logsDirError || 'logs directory unavailable'
        return
      }
      try {
        appendFileSync(stderrLogPath, chunk, 'utf-8')
        stderrWritten = true
      } catch (err) {
        if (!stderrWriteError) stderrWriteError = err instanceof Error ? err.message : String(err)
      }
    }

    // NOTE: switched from execFileAsync's built-in `timeout` to spawnWithTreeKill
    // because execFile only sends SIGTERM to the immediate child. Skill scripts
    // routinely fork ffmpeg / yt-dlp / browsers, and those grandchildren get
    // orphaned on timeout. The shared helper spawns with `detached:true` on
    // Unix so we can `process.kill(-pid, SIGTERM)` the whole group, then
    // escalate to SIGKILL after a 5s grace. Windows falls back to `child.kill`
    // (no process groups). Return shape kept identical for upstream callers.
    //
    // C6 — also wires per-stream caps + sinks so output beyond 1 MiB per
    // stream spills to `<outputsRoot>/<skillId>/.logs/skill-action-<id>-<stream>.txt`
    // instead of buffering up to 24 MiB in memory (or worse, OOMing on a
    // multi-hour ffmpeg run).
    // Truncate first, THEN append the marker — `truncateOutput` (the legacy
    // 18K-char head used by tool-result envelopes) would otherwise eat the
    // marker because `raw` is up to 1 MiB.
    const buildResultStdout = (raw: string, overflowed: boolean): string => {
      const head = truncateOutput(raw)
      if (!overflowed) return head
      const target = stdoutWritten
        ? `(... output truncated; full log at: ${stdoutLogPath})`
        : stdoutWriteError
          ? `(... output truncated; overflow log write failed: ${stdoutWriteError})`
          : `(... output truncated)`
      return `${head}\n${target}`
    }
    const buildResultStderr = (raw: string, overflowed: boolean): string => {
      const head = truncateOutput(raw)
      if (!overflowed) return head
      const target = stderrWritten
        ? `(... output truncated; full log at: ${stderrLogPath})`
        : stderrWriteError
          ? `(... output truncated; overflow log write failed: ${stderrWriteError})`
          : `(... output truncated)`
      return `${head}\n${target}`
    }

    try {
      const result = await spawnWithTreeKill(params.commandBin, params.commandArgs, {
        cwd: params.cwd,
        env,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        maxBuffer: MAX_COMMAND_BUFFER,
        inMemoryStdoutCap: DIRECT_ACTION_INMEMORY_CAP,
        inMemoryStderrCap: DIRECT_ACTION_INMEMORY_CAP,
        stdoutOverflowSink: stdoutSink,
        stderrOverflowSink: stderrSink,
      })
      const structuredResult = resultPath && existsSync(resultPath)
        ? this.deps.parseJson<SkillActionResult>(readFileSync(resultPath, 'utf-8'), undefined as never)
        : undefined
      const outputDir = structuredResult?.outputs && typeof structuredResult.outputs.outputDir === 'string'
        ? structuredResult.outputs.outputDir
        : undefined
      return {
        success: true,
        stdout: buildResultStdout(result.stdout || structuredResult?.logs.stdout || '', result.stdoutOverflowed),
        stderr: buildResultStderr(result.stderr || structuredResult?.logs.stderr || '', result.stderrOverflowed),
        command,
        outputDir,
        structuredResult,
        stdoutArtifactPath: stdoutWritten ? stdoutLogPath : undefined,
        stderrArtifactPath: stderrWritten ? stderrLogPath : undefined,
        stdoutArtifactError: result.stdoutOverflowed && !stdoutWritten ? (stdoutWriteError ?? undefined) : undefined,
        stderrArtifactError: result.stderrOverflowed && !stderrWritten ? (stderrWriteError ?? undefined) : undefined,
      }
    } catch (error) {
      // silent-catch: spawn failure is converted into the structured failure result below
      const err = error as SpawnWithTreeKillError
      const structuredResult = resultPath && existsSync(resultPath)
        ? this.deps.parseJson<SkillActionResult>(readFileSync(resultPath, 'utf-8'), undefined as never)
        : undefined
      const outputDir = structuredResult?.outputs && typeof structuredResult.outputs.outputDir === 'string'
        ? structuredResult.outputs.outputDir
        : undefined
      return {
        success: structuredResult?.ok || false,
        stdout: buildResultStdout((err.stdout as string | undefined) || structuredResult?.logs.stdout || '', err.stdoutOverflowed === true),
        stderr: buildResultStderr((err.stderr as string | undefined) || structuredResult?.logs.stderr || '', err.stderrOverflowed === true),
        command,
        outputDir,
        structuredResult,
        error: params.runtime === 'node' && err.message.includes('ENOENT')
          ? 'Node.js runtime not found. Please install Node.js or use python/shell based custom skills.'
          : (structuredResult?.error?.message || err.message),
        stdoutArtifactPath: stdoutWritten ? stdoutLogPath : undefined,
        stderrArtifactPath: stderrWritten ? stderrLogPath : undefined,
        stdoutArtifactError: err.stdoutOverflowed && !stdoutWritten ? (stdoutWriteError ?? undefined) : undefined,
        stderrArtifactError: err.stderrOverflowed && !stderrWritten ? (stderrWriteError ?? undefined) : undefined,
      }
    }
  }

  toDirectRunResult(
    skillId: string,
    actionName: string,
    executed: {
      success: boolean
      stdout: string
      stderr: string
      command: string[]
      error?: string
      outputDir?: string
      structuredResult?: SkillActionResult
      stdoutArtifactPath?: string
      stderrArtifactPath?: string
      stdoutArtifactError?: string
      stderrArtifactError?: string
    },
  ): SkillRunResult {
    const structured = executed.structuredResult
    const success = structured ? structured.ok === true : executed.success
    const outputs = structured?.outputs || {}
    const stringOutputs = Object.fromEntries(
      Object.entries(outputs)
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
    ) as Record<string, string>
    const extraStdout = [
      typeof outputs.outputDir === 'string' ? `Output directory: ${outputs.outputDir}` : '',
      ...Object.entries(outputs)
        .filter(([key, value]) => key !== 'outputDir' && typeof value === 'string' && value.length > 0)
        .map(([key, value]) => `${key}: ${value}`),
    ].filter(Boolean).join('\n')

    const result: SkillRunResult = {
      success,
      skillId,
      action: actionName,
      stdout: [executed.stdout, extraStdout].filter(Boolean).join('\n').trim(),
      stderr: executed.stderr,
      outputDir: executed.outputDir,
      outputs: Object.keys(stringOutputs).length > 0 ? stringOutputs : undefined,
      command: executed.command,
      error: success ? undefined : (structured?.error?.message || executed.error),
      status: normalizeSkillRunStatus(structured?.status, success),
      mode: 'direct',
      stdoutArtifactPath: executed.stdoutArtifactPath,
      stderrArtifactPath: executed.stderrArtifactPath,
      stdoutArtifactError: executed.stdoutArtifactError,
      stderrArtifactError: executed.stderrArtifactError,
    }

    // Phase 1 (model packs) — single detection point for the structured
    // `__READY_ASR_MODEL_PACK_MISSING__` marker the subtitle extractor prints
    // when required on-demand models are absent in packaged (offline) mode.
    // Every typed-action caller (inline `video_copy_analyze` + child-loop
    // `video_expert_pipeline`) builds its result here, so both surface the same
    // signal. The detailed subprocess error stays in `stderr`; we rewrite
    // `error` to actionable guidance that points the user at the download page.
    if (!result.success) {
      const missing = detectMissingRuntimeDependency(`${result.stdout}\n${result.stderr}`)
      if (missing) {
        result.missingRuntimeDependency = missing
        result.error = '缺少字幕识别所需的本地语音模型，请前往「设置 › 模型与运行时」下载后重试。'
      }
    }

    return result
  }

  // Phase 4: toWorkflowRunResult removed along with the skill_executions
  // state machine.
}
