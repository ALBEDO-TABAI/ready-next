import { randomUUID } from 'crypto'
import { join, delimiter } from 'path'
import { existsSync, readFileSync, rmSync, symlinkSync } from 'fs'
import { getDatabase } from '../database'
import { atomicWriteJson } from '../agent-control/atomic-write'
import { logAgentMetric } from '../agent-control/metrics'
import { getWhichCommand } from '../../utils/platform'
import type { EmbeddedSkillManifest } from './manifest'
import {
  buildReadyPythonRuntimeNotFoundMessage,
  buildReadyPythonCandidates,
  isSupportedReadyPythonSslVersion,
  isSupportedReadyPythonVersion,
  parsePythonVersionText,
  type PythonVersionInfo,
} from './python-runtime-version'
import {
  buildPackagedSkillRuntimeEnv,
  getPackagedSkillPythonPath,
  type PackagedSkillRuntimeManifest,
} from './packaged-runtime'
import {
  execFileAsync,
  PYTHON_RUNTIME_STATE_FILENAME,
  MAX_COMMAND_BUFFER,
  truncateOutput,
} from './runtime-manager-helpers'
import type {
  PythonRuntimeState,
  SkillId,
  SkillRunResult,
} from './runtime-manager-types'

// B8-D M2 (2026-07-05) — delegated extraction from SkillsRuntimeManager
// (surgery map §2.3 D 表, python-runtime 缝). Method bodies moved verbatim;
// the only edits are the mechanical `this.X` → `this.deps.X` rewrites for the
// injected dependency face below. `getBaseEnv` stays the shared env entry: the
// manager keeps a same-name one-line delegate, so every `() => this.getBaseEnv()`
// callback injected into the M1 services keeps resolving here. The FunASR env
// builders live in ModelPackManager and are injected as callbacks so this file
// never imports runtime-manager (防环). `ensureRuntimeToolchain` stays on the
// manager (install-pipeline caller + packaged-tool source pins) and reaches
// `linkIfFound` through the manager delegate.

export interface PythonRuntimeProvisionerDeps {
  venvRoot: string
  runtimeBin: string
  cacheRoot: string
  pipCache: string
  packagedRuntimeRoot: string | null
  packagedRuntimeManifest: PackagedSkillRuntimeManifest | null
  buildFunasrNanoRuntimeEnv: () => Record<string, string>
  buildFunasrFallbackModelEnv: (options: { packaged: boolean }) => Record<string, string>
  getSkillRuntimePath: (skillId: SkillId) => string
}

export class PythonRuntimeProvisioner {
  constructor(private readonly deps: PythonRuntimeProvisionerDeps) {}

  async ensurePythonVenv(options: { allowPackaged?: boolean } = {}): Promise<string> {
    const allowPackaged = options.allowPackaged ?? true
    if (allowPackaged) {
      const packagedPythonPath = await this.resolvePackagedPythonPath()
      if (packagedPythonPath) return packagedPythonPath
    }

    const pythonPath = this.getVenvPythonPath()
    let previousVersionText: string | null = null
    if (existsSync(pythonPath)) {
      const version = await this.getPythonVersion(pythonPath)
      const sslVersionText = await this.getPythonSslVersionText(pythonPath)
      if (isSupportedReadyPythonVersion(version) && isSupportedReadyPythonSslVersion(sslVersionText)) {
        const state = this.readPythonRuntimeState({ allowPackaged })
        if (!state?.venvId || !state.pythonSslVersion) {
          await this.writePythonRuntimeState(pythonPath)
        }
        return pythonPath
      }
      // Phase 1.3 — capture the bad version BEFORE rmSync so the metric +
      // log can show what we replaced. Old behavior was a silent rm + rebuild.
      const versionText = await this.getPythonVersionText(pythonPath)
      previousVersionText = `${versionText || 'unknown'} / ${sslVersionText || 'ssl unknown'}`
      console.warn(
        `[SkillsRuntimeManager] Python venv runtime unsupported (${previousVersionText || 'unknown'}); rebuilding to a Ready-supported runtime.`,
      )
      rmSync(this.deps.venvRoot, { recursive: true, force: true })
    }

    const basePython = await this.findPythonExecutable()
    await execFileAsync(basePython, ['-m', 'venv', this.deps.venvRoot], {
      timeout: 180_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv({ allowPackaged }),
    })

    const venvPython = this.getVenvPythonPath()
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      timeout: 300_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv({ allowPackaged }),
    })
    const state = await this.writePythonRuntimeState(venvPython, basePython)
    if (previousVersionText) {
      // Phase 1.3 — only emit on real rebuild (existing-but-bad → fresh).
      logAgentMetric('python_runtime_rebuilt', {
        previousVersion: previousVersionText,
        newVersion: state.pythonVersion,
        venvId: state.venvId,
      })
    }
    return venvPython
  }

  /**
   * Phase 1.3 — public wrapper used by app startup to proactively detect a
   * stale (e.g. 3.14) venv and rebuild it BEFORE the first skill_run_shell
   * call hits a confused interpreter. Returns a small status snapshot so the
   * caller can log "Python ready: 3.12.x" once during boot.
   *
   * Background: `ensurePythonVenv` previously only ran on first install/run,
   * so a host that had Python 3.14 from a prior install never saw a rebuild
   * until a Python skill was triggered, and even then the rmSync was silent.
   * Calling this from `setupAgentIPC` after `runtime.start()` makes the
   * version invariant a startup contract instead of a lazy invariant.
   *
   * Best-effort: any failure is swallowed and reported via the returned
   * `error` field so it cannot block boot.
   */
  async ensurePythonRuntimeReady(): Promise<{
    ready: boolean
    pythonPath?: string
    version?: string
    error?: string
  }> {
    try {
      const pythonPath = await this.ensurePythonVenv()
      const state = this.readPythonRuntimeState()
      const version = state?.pythonVersion || (await this.getPythonVersionText(pythonPath)) || 'unknown'
      const sslVersion = state?.pythonSslVersion || (await this.getPythonSslVersionText(pythonPath)) || 'unknown ssl'
      console.log(`[SkillsRuntimeManager] Python runtime ready: ${version} / ${sslVersion} at ${pythonPath}`)
      // Phase 5.2 — observability counterpart to `python_runtime_rebuilt`.
      // Always emit so we can count total boots and detect "ensurePythonVenv
      // succeeded but no rebuilt event" (i.e. healthy boot). Pair with the
      // rebuilt metric to compute rebuild rate.
      logAgentMetric('python_runtime_ready', {
        version,
        sslVersion,
        pythonPath,
        venvId: state?.venvId ?? null,
        configuredAt: state?.updatedAt ?? null,
      })
      return { ready: true, pythonPath, version }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[SkillsRuntimeManager] Python runtime not ready: ${message}`)
      logAgentMetric('python_runtime_not_ready', {
        error: message,
      })
      return { ready: false, error: message }
    }
  }

  getVenvPythonPath(): string {
    if (process.platform === 'win32') {
      return join(this.deps.venvRoot, 'Scripts', 'python.exe')
    }
    return join(this.deps.venvRoot, 'bin', 'python')
  }

  async findPythonExecutable(): Promise<string> {
    let configured: string | undefined
    try {
      configured = getDatabase().getSetting('skills_python_path')
    } catch {
      configured = undefined
    }
    const candidates = buildReadyPythonCandidates(configured, process.env)
    let sawSslIncompatibleCandidate = false
    for (const candidate of candidates) {
      try {
        const version = await this.getPythonVersion(candidate)
        if (!isSupportedReadyPythonVersion(version)) continue
        const sslVersionText = await this.getPythonSslVersionText(candidate)
        if (!isSupportedReadyPythonSslVersion(sslVersionText)) {
          sawSslIncompatibleCandidate = true
          continue
        }
        return candidate
      } catch {
        // Continue trying candidates.
      }
    }
    throw new Error(buildReadyPythonRuntimeNotFoundMessage({ sawSslIncompatibleCandidate }))
  }

  async resolvePackagedPythonPath(): Promise<string | null> {
    if (!this.deps.packagedRuntimeRoot) return null
    const pythonPath = getPackagedSkillPythonPath(this.deps.packagedRuntimeRoot)
    if (!existsSync(pythonPath)) {
      throw new Error(`Packaged Python runtime is missing: ${pythonPath}`)
    }
    const runtimeEnv = this.getBaseEnv({ allowPackaged: true })
    const version = await this.getPythonVersion(pythonPath, runtimeEnv)
    const sslVersionText = await this.getPythonSslVersionText(pythonPath, runtimeEnv)
    if (!isSupportedReadyPythonVersion(version)) {
      throw new Error(`Packaged Python runtime has unsupported version: ${await this.getPythonVersionText(pythonPath, runtimeEnv) || 'unknown'}`)
    }
    if (!isSupportedReadyPythonSslVersion(sslVersionText)) {
      throw new Error(`Packaged Python runtime has unsupported OpenSSL: ${sslVersionText || 'unknown'}`)
    }
    return pythonPath
  }

  readPythonRuntimeState(options: { allowPackaged?: boolean } = {}): PythonRuntimeState | null {
    const allowPackaged = options.allowPackaged ?? true
    if (allowPackaged && this.deps.packagedRuntimeRoot) {
      const manifest = this.deps.packagedRuntimeManifest
      return {
        venvId: `packaged:${manifest?.runtimeId || manifest?.createdAt || 'unknown'}`,
        pythonPath: getPackagedSkillPythonPath(this.deps.packagedRuntimeRoot),
        pythonVersion: manifest?.pythonVersion || 'packaged',
        pythonSslVersion: manifest?.pythonSslVersion || 'packaged',
        updatedAt: manifest?.createdAt || 'packaged',
        packaged: true,
      }
    }
    try {
      const statePath = join(this.deps.venvRoot, PYTHON_RUNTIME_STATE_FILENAME)
      return JSON.parse(readFileSync(statePath, 'utf-8')) as PythonRuntimeState
    } catch {
      return null
    }
  }

  private async writePythonRuntimeState(venvPython: string, basePython = venvPython): Promise<PythonRuntimeState> {
    const version = await this.getPythonVersionText(venvPython)
    const sslVersion = await this.getPythonSslVersionText(venvPython)
    const state: PythonRuntimeState = {
      venvId: randomUUID(),
      pythonPath: basePython,
      pythonVersion: version || 'unknown',
      pythonSslVersion: sslVersion || 'unknown',
      updatedAt: new Date().toISOString(),
    }
    atomicWriteJson(join(this.deps.venvRoot, PYTHON_RUNTIME_STATE_FILENAME), state)
    return state
  }

  private async getPythonVersion(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<PythonVersionInfo | null> {
    const versionText = await this.getPythonVersionText(pythonBin, env)
    return parsePythonVersionText(versionText || '')
  }

  private async getPythonVersionText(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, ['--version'], { timeout: 10_000, maxBuffer: 1_000_000, env })
      return `${stdout} ${stderr}`.trim()
    } catch {
      return null
    }
  }

  private async getPythonSslVersionText(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(
        pythonBin,
        ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'],
        { timeout: 10_000, maxBuffer: 1_000_000, env },
      )
      return `${stdout} ${stderr}`.trim()
    } catch {
      return null
    }
  }

  async installRequirements(
    venvPython: string,
    requirementsPath: string,
    options: { allowPackaged?: boolean } = {},
  ): Promise<void> {
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath], {
      timeout: 3_600_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(options),
    })
  }

  async linkIfFound(binaryName: string): Promise<void> {
    const destination = join(this.deps.runtimeBin, binaryName)
    if (existsSync(destination)) return

    try {
      const { stdout } = await execFileAsync(getWhichCommand(), [binaryName], { timeout: 10_000 })
      // Windows 'where' may return multiple lines, take the first one
      const source = stdout.trim().split('\n')[0]
      if (!source) return
      symlinkSync(source, destination)
    } catch {
      // Keep silent: certain skills can still run without this binary.
    }
  }

  getBaseEnv(options: { allowPackaged?: boolean } = {}): NodeJS.ProcessEnv {
    const usePackaged = (options.allowPackaged ?? true) && !!this.deps.packagedRuntimeRoot
    if (usePackaged && this.deps.packagedRuntimeRoot) {
      return {
        ...buildPackagedSkillRuntimeEnv(this.deps.packagedRuntimeRoot),
        ...this.deps.buildFunasrNanoRuntimeEnv(),
        ...this.deps.buildFunasrFallbackModelEnv({ packaged: true }),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      }
    }
    const venvBinDir = process.platform === 'win32'
      ? join(this.deps.venvRoot, 'Scripts')
      : join(this.deps.venvRoot, 'bin')
    return {
      ...process.env,
      PATH: [this.deps.runtimeBin, venvBinDir, process.env.PATH || ''].join(delimiter),
      PIP_CACHE_DIR: this.deps.pipCache,
      XDG_CACHE_HOME: this.deps.cacheRoot,
      MODELSCOPE_CACHE: join(this.deps.cacheRoot, 'modelscope'),
      HF_HOME: join(this.deps.cacheRoot, 'huggingface'),
      ...this.deps.buildFunasrNanoRuntimeEnv(),
      ...this.deps.buildFunasrFallbackModelEnv({ packaged: false }),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    }
  }

  private async runPythonScript(
    manifest: EmbeddedSkillManifest,
    venvPython: string,
    scriptRelativePath: string,
    scriptArgs: string[],
    timeoutMs: number,
    outputDir?: string,
    envOverrides?: Record<string, string>,
  ): Promise<SkillRunResult> {
    const skillPath = this.deps.getSkillRuntimePath(manifest.id)
    const scriptPath = join(skillPath, scriptRelativePath)
    const command = [venvPython, scriptPath, ...scriptArgs]

    try {
      const { stdout, stderr } = await execFileAsync(venvPython, [scriptPath, ...scriptArgs], {
        cwd: skillPath,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER,
        env: {
          ...this.getBaseEnv(),
          ...(envOverrides || {}),
        },
      })
      return {
        success: true,
        skillId: manifest.id,
        action: scriptRelativePath,
        stdout: truncateOutput(stdout || ''),
        stderr: truncateOutput(stderr || ''),
        outputDir,
        command,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      return {
        success: false,
        skillId: manifest.id,
        action: scriptRelativePath,
        stdout: truncateOutput(err.stdout || ''),
        stderr: truncateOutput(err.stderr || ''),
        outputDir,
        command,
        error: err.message,
      }
    }
  }
}
