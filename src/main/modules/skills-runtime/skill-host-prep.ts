import { randomUUID } from 'crypto'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import {
  getSkillHostController,
  type SkillHostController,
} from './skill-host-controller'
import {
  execFileAsync,
  MAX_COMMAND_BUFFER,
  DEFAULT_TIMEOUT_MS,
  truncateOutput,
} from './runtime-manager-helpers'

// B8-D M1 (2026-07-05) — delegated extraction from SkillsRuntimeManager
// (surgery map §2.3 D 表). Method bodies moved verbatim; the only edits are
// the mechanical `this.X` → `this.deps.X` rewrites for the injected dependency
// face below. The `hostControllerOverride` field (constructor option seam used
// by skill-host-controller-wiring.test.ts) migrated with the cluster.

export interface SkillHostPrepDeps {
  runtimeRoot: string
  hostControllerOverride?: SkillHostController
  ensureRuntimeDirs: () => void
  ensurePythonVenv: () => Promise<string>
  getBaseEnv: () => NodeJS.ProcessEnv
}

export class SkillHostPrep {
  constructor(private readonly deps: SkillHostPrepDeps) {}

  getHostController(): SkillHostController {
    return this.deps.hostControllerOverride ?? getSkillHostController()
  }

  shouldPrepareSkillHost(requirements: import('../../../shared/skill-host-contract').SkillHostRequirements | null): boolean {
    return Boolean(requirements?.spawn_context || requirements?.concurrency)
  }

  async runEmbeddedPython(params: {
    code?: string
    scriptPath?: string
    args?: string[]
    cwd?: string
    timeoutMs?: number
  }): Promise<{ success: boolean; stdout: string; stderr: string; command: string[]; error?: string }> {
    this.deps.ensureRuntimeDirs()
    const venvPython = await this.deps.ensurePythonVenv()
    let scriptPath = params.scriptPath || ''
    if (!scriptPath) {
      const code = String(params.code || '').trim()
      if (!code) {
        return { success: false, stdout: '', stderr: '', command: [], error: 'Missing code or scriptPath' }
      }
      const scriptDir = join(this.deps.runtimeRoot, 'tmp-python')
      mkdirSync(scriptDir, { recursive: true })
      scriptPath = join(scriptDir, `ready-embedded-${randomUUID()}.py`)
      writeFileSync(scriptPath, `${code}\n`, 'utf-8')
    }
    const command = [venvPython, scriptPath, ...((params.args || []).map((item) => String(item)))]
    try {
      const { stdout, stderr } = await execFileAsync(venvPython, [scriptPath, ...((params.args || []).map((item) => String(item)))], {
        cwd: params.cwd || this.deps.runtimeRoot,
        timeout: Math.max(1_000, params.timeoutMs || DEFAULT_TIMEOUT_MS),
        maxBuffer: MAX_COMMAND_BUFFER,
        env: this.deps.getBaseEnv(),
      })
      return {
        success: true,
        stdout: truncateOutput(stdout || ''),
        stderr: truncateOutput(stderr || ''),
        command,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      return {
        success: false,
        stdout: truncateOutput(err.stdout || ''),
        stderr: truncateOutput(err.stderr || ''),
        command,
        error: err.message,
      }
    }
  }
}
