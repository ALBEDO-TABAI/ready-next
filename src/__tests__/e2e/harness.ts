import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../../main/modules/repositories/skill-task-run-repository'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const PYTHON_CANDIDATES = [
  process.env.READY_E2E_PYTHON,
  'python3.12',
  'python3.11',
  'python3.10',
  'python3',
].filter((value): value is string => Boolean(value && value.trim()))
let cachedPythonExecutable: string | null | undefined

export const fixtureVideoPath = join(__dirname, 'fixtures', 'sample-video.mp4')

export interface VeaMaterialsOutput {
  actualOutputDir: string
  sceneScoresPath: string
  actualRunStatePath: string
  rootRunStatePath: string
  sceneClipPath: string
  sceneDetectionAdvancedBeforeAi: boolean
}

export interface VeaE2eRuntime {
  manager: SkillsRuntimeManager
  calls: SkillRunRequest[]
  materialsOutput: VeaMaterialsOutput | null
}

export interface VeaE2eHarness {
  runtimeRoot: string
  outputDir: string
  repository: SkillTaskRunRepository
  runtime: VeaE2eRuntime
  cleanup: () => Promise<void>
}

export async function hasFfmpeg(): Promise<boolean> {
  return canRun('ffmpeg', ['-version'])
}

export async function hasPySceneDetect(): Promise<boolean> {
  const python = await resolveE2ePython()
  return Boolean(python) && canRun(python, ['-c', 'import scenedetect'], 15_000)
}

export async function createVeaE2eHarness(): Promise<VeaE2eHarness> {
  const runtimeRoot = await mkdtempCompat('ready-vea-e2e-')
  const outputDir = join(runtimeRoot, 'outputs', 'video-expert-analyzer', `vea-${randomUUID().slice(0, 8)}`)
  await mkdir(outputDir, { recursive: true })
  const runtime = makeRecordingRuntime(runtimeRoot, outputDir)
  return {
    runtimeRoot,
    outputDir,
    repository: makeRepository(),
    runtime,
    cleanup: async () => {
      await rm(runtimeRoot, { recursive: true, force: true })
    },
  }
}

async function canRun(command: string, args: string[], timeoutMs = 5_000): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

async function resolveE2ePython(): Promise<string | null> {
  if (cachedPythonExecutable !== undefined) return cachedPythonExecutable
  for (const candidate of PYTHON_CANDIDATES) {
    const ok = await canRun(
      candidate,
      ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'],
    )
    if (ok) {
      cachedPythonExecutable = candidate
      return candidate
    }
  }
  cachedPythonExecutable = null
  return null
}

async function mkdtempCompat(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), prefix))
}

function makeRepository(): SkillTaskRunRepository {
  const rows = new Map<string, SkillTaskRunRecord>()
  return {
    createChildRun: (input: Parameters<SkillTaskRunRepository['createChildRun']>[0]) => {
      const now = new Date().toISOString()
      const record: SkillTaskRunRecord = {
        id: input.childRunId,
        scopeId: input.scopeId ?? null,
        sessionId: input.sessionId ?? null,
        agent: null,
        runId: null,
        skillId: input.skillId,
        skillName: input.skillName ?? null,
        action: input.action,
        toolName: null,
        runKind: 'child_run',
        status: 'running',
        interactionState: 'running',
        goalText: null,
        resourceRefs: [],
        params: input.requestedInput,
        steps: [],
        currentStepId: null,
        artifacts: [],
        outputDir: input.outputDir,
        runStatePath: input.runStatePath,
        sceneScoresPath: null,
        deliveryReportPath: null,
        failureKind: null,
        failureDetail: null,
        jobId: null,
        detachedTaskId: null,
        resumePayload: {
          childRun: {
            version: 1,
            childRunId: input.childRunId,
            kind: 'vea',
            parentScopeId: input.scopeId,
            parentSessionId: input.sessionId,
            skillId: input.skillId,
            skillName: input.skillName,
            requestedAction: input.action,
            requestedInput: input.requestedInput,
            singleFlightKey: input.singleFlightKey,
            parentNextHint: input.parentNextHint,
            outputDir: input.outputDir,
            runStatePath: input.runStatePath,
            eventLogPath: input.eventLogPath,
            status: input.status ?? 'running',
            closeEvent: null,
            legacy: { taskRunId: null, detachedTaskId: null, projectionTaskId: null },
          },
        },
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
      }
      rows.set(input.childRunId, record)
      return record
    },
    updateChildRun: (childRunId: string, patch: Record<string, unknown>) => {
      const existing = rows.get(childRunId)
      if (!existing) throw new Error(`missing child run: ${childRunId}`)
      const payload = (existing.resumePayload as { childRun: Record<string, unknown> }).childRun
      existing.resumePayload = { childRun: { ...payload, ...patch } }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
      existing.updatedAt = new Date().toISOString()
    },
    findLatestChildRunByKey: (key: string): SkillTaskRunRecord | null => {
      const active = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked'])
      for (const row of rows.values()) {
        const payload = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (payload?.singleFlightKey === key && active.has(String(payload.status))) return row
      }
      return null
    },
    findLatestChildRunBySkill: () => null,
    get: (id: string) => rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
}

function makeRecordingRuntime(runtimeRoot: string, outputDir: string): VeaE2eRuntime {
  const calls: SkillRunRequest[] = []
  let materialsOutput: VeaMaterialsOutput | null = null
  const manager = {
    getRuntimeInfo: () => ({
      runtimeRoot,
      skillsRoot: join(runtimeRoot, 'skills'),
      customSkillsRoot: join(runtimeRoot, 'custom-skills'),
      outputsRoot: join(runtimeRoot, 'outputs'),
      venvRoot: join(runtimeRoot, 'python'),
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      return manager.runSkillFromChildRunner(request)
    },
    runSkillFromChildRunner: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      calls.push(request)
      if (request.action === 'video_expert_pipeline') {
        materialsOutput = await runRealMaterialsPipeline(request, outputDir)
        return {
          success: true,
          skillId: request.skillId,
          action: request.action,
          stdout: `VEA e2e materials prepared at ${materialsOutput.actualOutputDir}`,
          stderr: '',
          outputDir,
          outputs: {
            outputDir,
            sceneScoresPath: materialsOutput.sceneScoresPath,
            runStatePath: materialsOutput.rootRunStatePath,
          },
          command: ['python3', 'pipeline_enhanced.py'],
          status: 'done',
          mode: 'direct',
        }
      }
      if (request.action === 'video_expert_ai_analyze') {
        await shortCircuitAiStage(outputDir, request, materialsOutput)
        return {
          success: true,
          skillId: request.skillId,
          action: request.action,
          stdout: 'VEA e2e AI stage short-circuited after real ffmpeg/scenedetect output.',
          stderr: '',
          outputDir,
          outputs: {
            outputDir,
            sceneScoresPath: String(request.params?.sceneScoresPath || materialsOutput?.sceneScoresPath || ''),
            runStatePath: join(outputDir, 'run_state.json'),
          },
          command: ['e2e-ai-short-circuit'],
          status: 'done',
          mode: 'direct',
        }
      }
      return {
        success: false,
        skillId: request.skillId,
        action: request.action,
        stdout: '',
        stderr: '',
        command: [],
        error: `unexpected e2e action: ${request.action}`,
        status: 'error',
      }
    },
  } as unknown as SkillsRuntimeManager & {
    runSkillFromChildRunner(request: SkillRunRequest): Promise<SkillRunResult>
  }
  return {
    manager,
    calls,
    get materialsOutput() {
      return materialsOutput
    },
  }
}

async function runRealMaterialsPipeline(
  request: SkillRunRequest,
  childOutputDir: string,
): Promise<VeaMaterialsOutput> {
  const source = String(request.params?.url || '').trim()
  if (!source) throw new Error('VEA e2e pipeline request missing url')
  const sceneThreshold = Number(request.params?.sceneThreshold ?? 1)
  const bestThreshold = Number(request.params?.bestThreshold ?? 7.5)
  const python = await resolveE2ePython()
  if (!python) throw new Error('VEA e2e requires Python 3.10 or newer')
  const script = `
import json
import sys
from pathlib import Path

repo = Path(sys.argv[1])
child_output_dir = Path(sys.argv[2])
source = sys.argv[3]
scene_threshold = float(sys.argv[4])
best_threshold = float(sys.argv[5])
scripts = repo / "assets" / "embedded-skills" / "video-expert-analyzer" / "scripts"
sys.path.insert(0, str(scripts))

from pipeline_enhanced import VideoAnalysisPipeline

pipeline = VideoAnalysisPipeline(
    url=source,
    output_dir=str(child_output_dir),
    scene_threshold=scene_threshold,
    best_threshold=best_threshold,
    openclaw_mode=True,
    auto_select_best=False,
)
pipeline._mark_run_stage("prepare", status="running")
pipeline._step_download_video()
pipeline._step_download_audio()
scene_info = pipeline._step_scene_detection()
pipeline._step_extract_frames(scene_info)
pipeline._step_prepare_scoring(scene_info)
scene_count = int(scene_info.get("scene_count") or 0)
pipeline._mark_run_stage(
    "merge_validate",
    status="ready_to_finalize",
    completed=True,
    total_scenes=scene_count,
    completed_scenes=scene_count,
    coverage_ratio=1.0,
)
scene_files = sorted(str(path) for path in pipeline.scenes_dir.glob("*.mp4"))
root_run_state_path = child_output_dir / "run_state.json"
root_run_state_path.write_text(json.dumps({
    "schema_version": 1,
    "status": "ready_to_finalize",
    "current_stage": "merge_validate",
    "completed_stages": ["prepare", "merge_validate"],
    "total_scenes": scene_count,
    "completed_scenes": scene_count,
    "coverage_ratio": 1.0,
    "scene_scores_path": str(pipeline.scores_path),
    "scores_path": str(pipeline.scores_path),
    "video_dir": str(pipeline.video_output_dir),
    "active_output_dir": str(pipeline.video_output_dir),
    "last_error": "",
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({
    "actualOutputDir": str(pipeline.video_output_dir),
    "sceneScoresPath": str(pipeline.scores_path),
    "actualRunStatePath": str(pipeline.run_state_path),
    "rootRunStatePath": str(root_run_state_path),
    "sceneClipPath": scene_files[0] if scene_files else "",
}, ensure_ascii=False))
`
  const { stdout, stderr } = await execFileAsync(
    python,
    ['-c', script, repoRoot, childOutputDir, source, String(sceneThreshold), String(bestThreshold)],
    {
      timeout: 60_000,
      maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, VEXA_SCENE_BACKENDS: process.env.VEXA_SCENE_BACKENDS || 'opencv' },
    },
  )
  const payload = parseLastJsonObject(stdout)
  const sceneClipPath = String(payload.sceneClipPath || '')
  const sceneScoresPath = String(payload.sceneScoresPath || '')
  const [sceneClipStat, sceneScoresStat] = await Promise.all([
    stat(sceneClipPath),
    stat(sceneScoresPath),
  ])
  if (sceneClipStat.size <= 0) throw new Error(`empty ffmpeg scene clip: ${sceneClipPath}`)
  if (sceneScoresStat.size <= 0) throw new Error(`empty scene scores output: ${sceneScoresPath}`)
  if (stderr) {
    await writeFile(join(childOutputDir, 'vea-e2e-materials.stderr.log'), stderr, 'utf8')
  }
  return {
    actualOutputDir: String(payload.actualOutputDir || ''),
    sceneScoresPath,
    actualRunStatePath: String(payload.actualRunStatePath || ''),
    rootRunStatePath: String(payload.rootRunStatePath || join(childOutputDir, 'run_state.json')),
    sceneClipPath,
    sceneDetectionAdvancedBeforeAi: sceneClipStat.size > 0 && sceneScoresStat.size > 0,
  }
}

async function shortCircuitAiStage(
  childOutputDir: string,
  request: SkillRunRequest,
  materialsOutput: VeaMaterialsOutput | null,
): Promise<void> {
  const sceneScoresPath = String(request.params?.sceneScoresPath || materialsOutput?.sceneScoresPath || '')
  const existing = await readJson(join(childOutputDir, 'run_state.json'))
  await writeFile(
    join(childOutputDir, 'run_state.json'),
    JSON.stringify({
      ...existing,
      status: 'completed',
      current_stage: 'completed',
      completed_stages: ['prepare', 'merge_validate', 'completed'],
      scene_scores_path: sceneScoresPath,
      scores_path: sceneScoresPath,
      coverage_ratio: 1.0,
      last_error: '',
    }, null, 2),
    'utf8',
  )
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parseLastJsonObject(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    return JSON.parse(trimmed) as Record<string, unknown>
  }
  throw new Error(`VEA e2e materials pipeline did not return JSON. stdout=${stdout.slice(-1000)}`)
}
