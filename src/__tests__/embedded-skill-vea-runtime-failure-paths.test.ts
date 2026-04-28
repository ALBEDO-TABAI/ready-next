import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import { SkillHostController } from '../main/modules/skills-runtime/skill-host-controller'
import type { SkillHostRequirements } from '../shared/skill-host-contract'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const READY_COMPAT = join(
  REPO_ROOT,
  'assets',
  'embedded-skills',
  'video-expert-analyzer',
  'scripts',
  'ready_compat.py',
)
const VEA_STATUS_DETECTION: SkillHostRequirements = {
  manifest_version: 1,
  status_detection: {
    method: 'sentinel_file',
    file_path: '${output_dir}/run_state.json',
    json_field: 'status',
    blocked_values: ['blocked', 'pending_review', 'awaiting_input'],
  },
}

async function withRunState(
  state: Record<string, unknown>,
  fn: (outputDir: string) => Promise<void>,
): Promise<void> {
  const outputDir = mkdtempSync(join(tmpdir(), 'vea-runtime-failure-'))
  writeFileSync(join(outputDir, 'run_state.json'), JSON.stringify(state, null, 2), 'utf8')
  try {
    await fn(outputDir)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

test('VEA ready_compat writes blocked structured result from run_state even when subprocess exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'vea-compat-'))
  try {
    const fakeOrchestrator = join(root, 'fake_orchestrator.py')
    const resultPath = join(root, 'result.json')
    const harness = join(root, 'harness.py')

    writeFileSync(fakeOrchestrator, [
      'import json, sys',
      'from pathlib import Path',
      'args = sys.argv[1:]',
      'out_root = Path(args[args.index("-o") + 1]) if "-o" in args else Path.cwd()',
      'video_dir = out_root / "real-video-dir"',
      'video_dir.mkdir(parents=True, exist_ok=True)',
      '(video_dir / "scene_scores.json").write_text("{}", encoding="utf-8")',
      '(video_dir / "run_state.json").write_text(json.dumps({"status":"blocked","last_error":"waiting for agent"}), encoding="utf-8")',
      '(video_dir / "delivery_report.json").write_text(json.dumps({"status":"completed"}), encoding="utf-8")',
      'print("fake stdout marker")',
      'print("fake stderr marker", file=sys.stderr)',
      'raise SystemExit(0)',
      '',
    ].join('\n'), 'utf8')

    writeFileSync(harness, [
      'import importlib.util, os, sys',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location("ready_compat", ${JSON.stringify(READY_COMPAT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'assert spec.loader is not None',
      'spec.loader.exec_module(module)',
      `module.ORCHESTRATOR = Path(${JSON.stringify(fakeOrchestrator)})`,
      `os.environ["READY_SKILL_RESULT_PATH"] = ${JSON.stringify(resultPath)}`,
      `sys.argv = ["ready_compat.py", "--action", "video_expert_pipeline", "--payload-json", ${JSON.stringify(JSON.stringify({ url: 'https://example.test/video', outputDir: join(root, 'outputs') }))}]`,
      'raise SystemExit(module.main())',
      '',
    ].join('\n'), 'utf8')

    execFileSync('python3', [harness], { encoding: 'utf8' })

    const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      ok: boolean
      status: string
      outputs: Record<string, string>
      error?: { message?: string }
      logs?: { stdout?: string; stderr?: string }
    }

    assert.equal(payload.ok, false)
    assert.equal(payload.status, 'blocked')
    const expectedOutputDir = realpathSync(join(root, 'outputs', 'real-video-dir'))
    assert.equal(payload.outputs.outputDir, expectedOutputDir)
    assert.equal(payload.outputs.sceneScoresPath, join(expectedOutputDir, 'scene_scores.json'))
    assert.equal(payload.outputs.runStatePath, join(expectedOutputDir, 'run_state.json'))
    assert.equal(payload.outputs.deliveryReportPath, join(expectedOutputDir, 'delivery_report.json'))
    assert.match(payload.error?.message || '', /waiting for agent/)
    assert.match(payload.logs?.stdout || '', /fake stdout marker/)
    assert.match(payload.logs?.stderr || '', /fake stderr marker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('VEA ready_compat does not complete when run_state has no status', () => {
  const root = mkdtempSync(join(tmpdir(), 'vea-compat-missing-status-'))
  try {
    const fakeOrchestrator = join(root, 'fake_orchestrator.py')
    const resultPath = join(root, 'result.json')
    const harness = join(root, 'harness.py')

    writeFileSync(fakeOrchestrator, [
      'import json, sys',
      'from pathlib import Path',
      'args = sys.argv[1:]',
      'out_root = Path(args[args.index("-o") + 1]) if "-o" in args else Path.cwd()',
      'video_dir = out_root / "real-video-dir"',
      'video_dir.mkdir(parents=True, exist_ok=True)',
      '(video_dir / "scene_scores.json").write_text("{}", encoding="utf-8")',
      '(video_dir / "run_state.json").write_text(json.dumps({"message":"failed but no status"}), encoding="utf-8")',
      '(video_dir / "delivery_report.json").write_text(json.dumps({"status":"completed","missing_outputs":[],"missing_screenshot_scenes":[],"missing_sample_scenes":[],"blocked_batches":[],"incomplete_scene_numbers":[],"required_outputs":{}}), encoding="utf-8")',
      'raise SystemExit(0)',
      '',
    ].join('\n'), 'utf8')

    writeFileSync(harness, [
      'import importlib.util, os, sys',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location("ready_compat", ${JSON.stringify(READY_COMPAT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'assert spec.loader is not None',
      'spec.loader.exec_module(module)',
      `module.ORCHESTRATOR = Path(${JSON.stringify(fakeOrchestrator)})`,
      `os.environ["READY_SKILL_RESULT_PATH"] = ${JSON.stringify(resultPath)}`,
      `sys.argv = ["ready_compat.py", "--action", "video_expert_pipeline", "--payload-json", ${JSON.stringify(JSON.stringify({ url: 'https://example.test/video', outputDir: join(root, 'outputs') }))}]`,
      'raise SystemExit(module.main())',
      '',
    ].join('\n'), 'utf8')

    execFileSync('python3', [harness], { encoding: 'utf8' })

    const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      ok: boolean
      status: string
      error?: { message?: string }
    }

    assert.equal(payload.ok, false)
    assert.equal(payload.status, 'failed')
    assert.match(payload.error?.message || '', /run_state\.json.*status|failed but no status/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('VEA ready_compat validates delivery_report before reporting success', () => {
  const root = mkdtempSync(join(tmpdir(), 'vea-compat-bad-delivery-'))
  try {
    const fakeOrchestrator = join(root, 'fake_orchestrator.py')
    const resultPath = join(root, 'result.json')
    const harness = join(root, 'harness.py')

    writeFileSync(fakeOrchestrator, [
      'import json, sys',
      'from pathlib import Path',
      'args = sys.argv[1:]',
      'out_root = Path(args[args.index("-o") + 1]) if "-o" in args else Path.cwd()',
      'video_dir = out_root / "real-video-dir"',
      'video_dir.mkdir(parents=True, exist_ok=True)',
      '(video_dir / "scene_scores.json").write_text("{}", encoding="utf-8")',
      '(video_dir / "run_state.json").write_text(json.dumps({"status":"completed"}), encoding="utf-8")',
      '(video_dir / "delivery_report.json").write_text(json.dumps({"status":"completed","missing_outputs":["storyboard_md"],"missing_screenshot_scenes":[],"missing_sample_scenes":[],"blocked_batches":[],"incomplete_scene_numbers":[],"required_outputs":{}}), encoding="utf-8")',
      'raise SystemExit(0)',
      '',
    ].join('\n'), 'utf8')

    writeFileSync(harness, [
      'import importlib.util, os, sys',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location("ready_compat", ${JSON.stringify(READY_COMPAT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'assert spec.loader is not None',
      'spec.loader.exec_module(module)',
      `module.ORCHESTRATOR = Path(${JSON.stringify(fakeOrchestrator)})`,
      `os.environ["READY_SKILL_RESULT_PATH"] = ${JSON.stringify(resultPath)}`,
      `sys.argv = ["ready_compat.py", "--action", "video_expert_pipeline", "--payload-json", ${JSON.stringify(JSON.stringify({ url: 'https://example.test/video', outputDir: join(root, 'outputs') }))}]`,
      'raise SystemExit(module.main())',
      '',
    ].join('\n'), 'utf8')

    execFileSync('python3', [harness], { encoding: 'utf8' })

    const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      ok: boolean
      status: string
      error?: { message?: string }
    }

    assert.equal(payload.ok, false)
    assert.equal(payload.status, 'failed')
    assert.match(payload.error?.message || '', /missing_outputs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('VEA ready_compat prefers output dir matching READY_SKILL_TASK_ID over newest mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'vea-compat-task-id-'))
  try {
    const fakeOrchestrator = join(root, 'fake_orchestrator.py')
    const resultPath = join(root, 'result.json')
    const harness = join(root, 'harness.py')

    writeFileSync(fakeOrchestrator, [
      'import json, os, sys, time',
      'from pathlib import Path',
      'args = sys.argv[1:]',
      'out_root = Path(args[args.index("-o") + 1]) if "-o" in args else Path.cwd()',
      'target = out_root / "target-video"',
      'other = out_root / "other-video"',
      'for path in (target, other):',
      '    path.mkdir(parents=True, exist_ok=True)',
      '    (path / "scene_scores.json").write_text("{}", encoding="utf-8")',
      '    (path / "delivery_report.json").write_text(json.dumps({"status":"completed","missing_outputs":[],"missing_screenshot_scenes":[],"missing_sample_scenes":[],"blocked_batches":[],"incomplete_scene_numbers":[],"required_outputs":{}}), encoding="utf-8")',
      '(target / "run_state.json").write_text(json.dumps({"task_id":"dst-target","status":"completed"}), encoding="utf-8")',
      'time.sleep(0.02)',
      '(other / "run_state.json").write_text(json.dumps({"task_id":"dst-other","status":"completed"}), encoding="utf-8")',
      'print(f"Output Dir: {out_root}")',
      'raise SystemExit(0)',
      '',
    ].join('\n'), 'utf8')

    writeFileSync(harness, [
      'import importlib.util, os, sys',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location("ready_compat", ${JSON.stringify(READY_COMPAT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'assert spec.loader is not None',
      'spec.loader.exec_module(module)',
      `module.ORCHESTRATOR = Path(${JSON.stringify(fakeOrchestrator)})`,
      `os.environ["READY_SKILL_RESULT_PATH"] = ${JSON.stringify(resultPath)}`,
      'os.environ["READY_SKILL_TASK_ID"] = "dst-target"',
      `sys.argv = ["ready_compat.py", "--action", "video_expert_pipeline", "--payload-json", ${JSON.stringify(JSON.stringify({ url: 'https://example.test/video', outputDir: join(root, 'outputs') }))}]`,
      'raise SystemExit(module.main())',
      '',
    ].join('\n'), 'utf8')

    execFileSync('python3', [harness], { encoding: 'utf8' })

    const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      ok: boolean
      outputs: Record<string, string>
    }

    assert.equal(payload.ok, true)
    assert.equal(payload.outputs.outputDir, realpathSync(join(root, 'outputs', 'target-video')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('VEA ready_compat skips mismatched root output when matching child exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'vea-compat-root-mismatch-'))
  try {
    const fakeOrchestrator = join(root, 'fake_orchestrator.py')
    const resultPath = join(root, 'result.json')
    const harness = join(root, 'harness.py')

    writeFileSync(fakeOrchestrator, [
      'import json, sys',
      'from pathlib import Path',
      'args = sys.argv[1:]',
      'out_root = Path(args[args.index("-o") + 1]) if "-o" in args else Path.cwd()',
      'target = out_root / "target-video"',
      'target.mkdir(parents=True, exist_ok=True)',
      'for path in (out_root, target):',
      '    (path / "scene_scores.json").write_text("{}", encoding="utf-8")',
      '    (path / "delivery_report.json").write_text(json.dumps({"status":"completed","missing_outputs":[],"missing_screenshot_scenes":[],"missing_sample_scenes":[],"blocked_batches":[],"incomplete_scene_numbers":[],"required_outputs":{}}), encoding="utf-8")',
      '(out_root / "run_state.json").write_text(json.dumps({"task_id":"dst-other","status":"completed"}), encoding="utf-8")',
      '(target / "run_state.json").write_text(json.dumps({"task_id":"dst-target","status":"completed"}), encoding="utf-8")',
      'print(f"Output Dir: {out_root}")',
      'raise SystemExit(0)',
      '',
    ].join('\n'), 'utf8')

    writeFileSync(harness, [
      'import importlib.util, os, sys',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location("ready_compat", ${JSON.stringify(READY_COMPAT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'assert spec.loader is not None',
      'spec.loader.exec_module(module)',
      `module.ORCHESTRATOR = Path(${JSON.stringify(fakeOrchestrator)})`,
      `os.environ["READY_SKILL_RESULT_PATH"] = ${JSON.stringify(resultPath)}`,
      'os.environ["READY_SKILL_TASK_ID"] = "dst-target"',
      `sys.argv = ["ready_compat.py", "--action", "video_expert_pipeline", "--payload-json", ${JSON.stringify(JSON.stringify({ url: 'https://example.test/video', outputDir: join(root, 'outputs') }))}]`,
      'raise SystemExit(module.main())',
      '',
    ].join('\n'), 'utf8')

    execFileSync('python3', [harness], { encoding: 'utf8' })

    const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      ok: boolean
      outputs: Record<string, string>
    }

    assert.equal(payload.ok, true)
    assert.equal(payload.outputs.outputDir, realpathSync(join(root, 'outputs', 'target-video')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime-manager treats structured ok:false as a failed direct action even when process exits 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-structured-result-'))
  try {
    const runtimeRoot = join(root, 'runtime')
    const skillId = 'structured-result-fixture'
    const skillDir = join(runtimeRoot, 'custom-skills', skillId)
    const outputDir = join(root, 'output')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })

    const scriptPath = join(skillDir, 'write-result.sh')
    writeFileSync(scriptPath, [
      '#!/bin/sh',
      'cat > "$READY_SKILL_RESULT_PATH" <<JSON',
      JSON.stringify({
        ok: false,
        status: 'failed',
        outputs: { outputDir, sceneScoresPath: join(outputDir, 'scene_scores.json') },
        artifacts: [],
        logs: { stdout: 'structured stdout', stderr: 'structured stderr' },
        error: { message: 'structured failure' },
      }),
      'JSON',
      'exit 0',
      '',
    ].join('\n'), 'utf8')
    chmodSync(scriptPath, 0o755)

    writeFileSync(join(skillDir, 'ready-skill.json'), JSON.stringify({
      id: skillId,
      name: 'Structured Result Fixture',
      description: 'fixture',
      version: '1.0.0',
      source: 'custom',
      runtime: 'shell',
      defaultAction: 'run',
      sourcePath: skillDir,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actions: [
        {
          name: 'run',
          description: 'run',
          runtime: 'shell',
          entry: 'write-result.sh',
          visibility: 'internal',
          params: [],
        },
      ],
    }, null, 2), 'utf8')

    const manager = new SkillsRuntimeManager({
      runtimeRoot,
      embeddedSkillsRoot: join(root, 'embedded-skills'),
      startBackgroundTasks: false,
    })

    const result = await manager.runSkill({ skillId, action: 'run', params: {} })

    assert.equal(result.success, false)
    assert.equal(result.status, 'error')
    assert.equal(result.outputDir, outputDir)
    assert.equal(result.outputs?.outputDir, outputDir)
    assert.equal(result.error, 'structured failure')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('VEA run_state provider 401 is treated as a failed skill run', async () => {
  const controller = new SkillHostController()

  await withRunState({
    status: 'failed',
    error_kind: 'provider_unauthorized_401',
    message: 'provider returned HTTP 401',
  }, async (outputDir) => {
    const status = await controller.detectStatus(
      VEA_STATUS_DETECTION,
      { exitCode: 0, stdout: '', stderr: '' },
      outputDir,
    )

    assert.equal(status.status, 'error')
    assert.equal(status.detail, 'failed')
  })
})

test('VEA run_state provider_missing is not mistaken for done just because the shell exited 0', async () => {
  const controller = new SkillHostController()

  await withRunState({
    status: 'failed',
    error_kind: 'provider_missing',
    message: 'agent provider config is missing',
  }, async (outputDir) => {
    const status = await controller.detectStatus(
      VEA_STATUS_DETECTION,
      { exitCode: 0, stdout: '', stderr: '' },
      outputDir,
    )

    assert.equal(status.status, 'error')
    assert.equal(status.detail, 'failed')
  })
})
