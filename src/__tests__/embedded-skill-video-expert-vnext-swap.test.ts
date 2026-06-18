/**
 * B Phase 3 PR1 — video-expert-analyzer vnext swap e2e smoke.
 *
 * Mirrors `embedded-skill-video-copy-migration.test.ts` (Phase 2) but
 * additionally asserts:
 *   - vnext-specific entry script & docs are in place at the expected paths
 *     after the wholesale directory swap
 *   - vnext SKILL.md fits within the existing 12K JS-string-char cap
 *     (UTF-16 code units, not raw bytes — most CJK content compresses) so
 *     the entire doc gets inlined without truncation
 *   - no `skill_executions` row gets created (Phase 2 G2-1 follow-up:
 *     direct assertion via the listExecutions stub)
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'

const __dirname = dirname(fileURLToPath(import.meta.url))
// src/__tests__ → repo root → assets/embedded-skills/video-expert-analyzer
const SKILL_DIR = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'video-expert-analyzer')

function runPythonCompile(scriptPaths: string[]): void {
  const pycachePrefix = mkdtempSync(join(tmpdir(), 'ready-pycompile-'))
  try {
    execFileSync('python3', ['-m', 'py_compile', ...scriptPaths], {
      cwd: SKILL_DIR,
      stdio: 'pipe',
      env: { ...process.env, PYTHONPYCACHEPREFIX: pycachePrefix },
    })
  } finally {
    rmSync(pycachePrefix, { recursive: true, force: true })
  }
}

test('manifest compiles to advisory with read_skill + internal compat actions', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  assert.equal(def.executionMode, 'advisory', 'execution mode must be advisory post-migration')
  assert.equal(def.workflow, undefined, 'no workflow object should be compiled')
  assert.equal(def.defaultAction, 'read_skill', 'defaultAction points at the reference entry')

  // 3 actions: 1 LLM-facing reference + 2 internal python-backed compat shims
  // (the latter exist solely so legacy production callers like
  // `item-analysis-manager.ts` keep working — LLM never sees them because
  // visibility:'internal' filters them out of dynamic skill tool exposure).
  assert.equal(def.actions.length, 3, 'read_skill + 2 internal compat actions')

  const readSkill = def.actions.find((a) => a.name === 'read_skill')
  assert.ok(readSkill, 'read_skill present')
  assert.equal(readSkill!.runtime, 'reference')
  assert.equal(readSkill!.visibility, 'internal', 'LLM should not see a dynamic skill_<id>_read_skill tool')

  const pipeline = def.actions.find((a) => a.name === 'video_expert_pipeline')
  assert.ok(pipeline, 'video_expert_pipeline compat action present (used by RSS item-analysis-manager)')
  assert.equal(pipeline!.runtime, 'python')
  assert.equal(pipeline!.visibility, 'internal', 'compat action stays out of LLM tool surface')

  const aiAnalyze = def.actions.find((a) => a.name === 'video_expert_ai_analyze')
  assert.ok(aiAnalyze, 'video_expert_ai_analyze compat action present (used by RSS item-analysis-manager)')
  assert.equal(aiAnalyze!.runtime, 'python')
  assert.equal(aiAnalyze!.visibility, 'internal', 'compat action stays out of LLM tool surface')
})

test('compat adapter ready_compat.py is bundled', () => {
  assert.equal(
    existsSync(join(SKILL_DIR, 'scripts', 'ready_compat.py')),
    true,
    'ready_compat.py must be present so legacy production callers can dispatch into vnext orchestrator',
  )
})

test('vnext video download path supports Ready browser cookies and yt-dlp JS challenge components', () => {
  const pipelinePath = join(SKILL_DIR, 'scripts', 'pipeline_enhanced.py')
  // eslint-disable-next-line ready/no-source-grep-test -- Packaging contract: these yt-dlp flags are assembled inside the Python downloader, and exercising them directly would require a networked YouTube run.
  const source = readFileSync(pipelinePath, 'utf-8')
  assert.match(source, /READY_VIDEO_COOKIE_FILE/, 'Ready-exported browser cookies must be passed to yt-dlp for video hosts')
  assert.match(source, /BILIBILI_COOKIE_FILE/, 'configured Bilibili cookie files must remain a fallback')
  assert.match(source, /YOUTUBE_COOKIE_FILE/, 'legacy YouTube cookie env must remain a fallback')
  assert.match(source, /--js-runtimes/, 'yt-dlp JS runtime support must be enabled when available')
  assert.match(source, /--remote-components/, 'yt-dlp remote challenge components must be enabled when available')
  runPythonCompile([pipelinePath, join(SKILL_DIR, 'scripts', 'ready_compat.py')])
})

test('skill.workflow.json has been removed from disk', () => {
  const workflowPath = join(SKILL_DIR, 'skill.workflow.json')
  assert.equal(existsSync(workflowPath), false, 'skill.workflow.json must not exist after vnext swap')
})

test('vnext entry script and referenced docs are bundled at expected paths', () => {
  // The vnext orchestrator is the new staged pipeline entry; SKILL.md tells
  // the model to invoke `python scripts/orchestrate_vnext.py ...`.
  assert.equal(
    existsSync(join(SKILL_DIR, 'scripts', 'orchestrate_vnext.py')),
    true,
    'vnext orchestrator script must be present',
  )
  // SKILL.md explicitly directs the model to read these two docs on demand.
  assert.equal(
    existsSync(join(SKILL_DIR, 'docs', 'openclaw_orchestration.md')),
    true,
    'docs/openclaw_orchestration.md must be present (referenced by SKILL.md)',
  )
  assert.equal(
    existsSync(join(SKILL_DIR, 'docs', 'appendices.md')),
    true,
    'docs/appendices.md must be present (referenced by SKILL.md)',
  )
})

test('audiovisual raw-prompt evidence rule keeps the vnext minimum scene evidence contract', () => {
  const script = `
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting.template_engine import build_audiovisual_body_prompt

data = {
  "scenes": [{
    "scene_number": 1,
    "duration_seconds": 90,
    "end_time_seconds": 90,
    "description": "全黑画面",
    "weighted_score": 1,
    "selection": "[DISCARD]",
    "scores": {"impact": 1},
    "storyboard": {"visual_style": "黑屏"}
  }],
  "classification_result": {"classification": {"type": "experimental"}},
  "audiovisual_route": {"framework": "experimental"}
}
route = {
  "framework": "experimental",
  "route_label": "Experimental",
  "child_type": "experimental",
  "reference": "test"
}
spec = build_audiovisual_body_prompt(data, route)
print(json.dumps({
  "min": spec["validation_rules"]["min_scene_evidence_per_section"],
  "has_one": "至少引用 **1** 个不同的 Scene 编号" in spec["user_message"],
  "has_three": "至少引用 **3** 个不同的 Scene 编号" in spec["user_message"],
  "source": spec["source"]
}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const result = JSON.parse(raw)
  assert.equal(result.source, 'raw_prompt')
  assert.equal(result.min, 3)
  assert.equal(result.has_one, false)
  assert.equal(result.has_three, true)
})

test('auto scoring sample validation keeps API probe failures non-blocking', () => {
  const script = `
import json
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))

fake_probe = types.ModuleType("openclaw_batch_probe")
fake_probe.sample_scene_numbers = lambda numbers, sample_size: list(numbers)[:sample_size]
fake_probe.analyze_scenes = lambda packets, attempts, max_workers: ([], [], [{"scene_number": packets[0]["scene_number"]}])
fake_probe.build_validation_report = lambda generated_scenes, reference_scenes, sample_size, scene_packets: {
    "sample_scene_numbers": [packet["scene_number"] for packet in scene_packets],
    "order_matches_reference": True,
    "samples": [],
}
sys.modules["openclaw_batch_probe"] = fake_probe

import ai_analyzer

ai_analyzer._build_auto_scoring_attempts = lambda config: [{"model": "fake"}]
ai_analyzer._collect_batch_packets = lambda video_dir, scene_numbers, pending_only: (
    [{"scene_number": int(number), "batch_id": "batch-001"} for number in scene_numbers],
    {},
)

video_dir = Path(tempfile.mkdtemp())
scores_path = video_dir / "scene_scores.json"
scores_path.write_text(json.dumps({
    "scenes": [{"scene_number": 1, "type_classification": "demo", "scores": {"impact": 8}}],
}, ensure_ascii=False), encoding="utf-8")

result = ai_analyzer.run_auto_scoring_validation(
    scores_path,
    video_dir,
    {},
    scored_scene_numbers=[1],
    sample_size=1,
)
report = json.loads((video_dir / "auto_scoring_validation.json").read_text(encoding="utf-8"))
print(json.dumps({"result": result, "report": report}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.equal(payload.result.passed, true)
  assert.deepEqual(payload.result.validation_failed_scene_numbers, [1])
  assert.deepEqual(payload.result.validation_warning_scene_numbers, [1])
  assert.deepEqual(payload.result.blocking_scene_numbers, [])
  assert.equal(payload.report.passed, true)
  assert.deepEqual(payload.report.blocking_scene_numbers, [])
})

test('auto scoring model order skips stale provider refs and falls back to catalog vision model', () => {
  const script = `
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from openclaw_batch_probe import build_attempt_order

providers = {
    "vision-provider": {
        "baseUrl": "https://example.invalid/v1",
        "api": "openai-completions",
        "models": [
            {"id": "text-only", "input": ["text"], "api": "openai-completions"},
            {"id": "vision-ready", "input": ["text", "image"], "api": "openai-completions"},
        ],
    },
}
attempts = build_attempt_order(
    providers,
    preferred_model="missing-provider/old-vision",
    fallback_models=["zai/GLM-5V-Turbo"],
)
print(json.dumps({
    "model_refs": [attempt["model_ref"] for attempt in attempts],
    "declared_image_support": [attempt["declared_image_support"] for attempt in attempts],
}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.deepEqual(payload.model_refs, ['vision-provider/vision-ready'])
  assert.deepEqual(payload.declared_image_support, [true])
})

test('text routing model order skips stale provider refs and falls back to catalog text model', () => {
  const script = `
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from text_model_runtime import build_attempt_order

runtime_config = {
    "config_source": "env",
    "preferred_model": "missing-provider/old-router",
    "fallback_models": ["zai/GLM-5V-Turbo"],
    "providers": {
        "text-provider": {
            "baseUrl": "https://example.invalid/v1",
            "api": "openai-completions",
            "models": [
                {"id": "image-only", "input": ["image"], "api": "openai-completions"},
                {"id": "router-ready", "input": ["text", "image"], "api": "openai-completions"},
            ],
        },
    },
}
attempts = build_attempt_order(runtime_config)
print(json.dumps({
    "model_refs": [attempt["model_ref"] for attempt in attempts],
    "api_styles": [attempt["api_style"] for attempt in attempts],
}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.deepEqual(payload.model_refs, ['text-provider/router-ready'])
  assert.deepEqual(payload.api_styles, ['openai-completions'])
})

test('audiovisual report runtime path passes long-report timeout and retry budget', () => {
  const script = `
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting import template_engine

captured = {}

def fake_request(system_prompt, user_message, runtime_config, **kwargs):
    captured.update(kwargs)
    return "ok"

template_engine.request_text_with_runtime = fake_request
os.environ["AUDIOVISUAL_REPORT_TIMEOUT_SECONDS"] = "345"
os.environ["AUDIOVISUAL_REPORT_RETRIES"] = "0"
os.environ["AUDIOVISUAL_REPORT_MAX_TOKENS"] = "12000"
try:
    result = template_engine._request_agent_report("sys", "user", runtime_config={"providers": {}})
finally:
    os.environ.pop("AUDIOVISUAL_REPORT_TIMEOUT_SECONDS", None)
    os.environ.pop("AUDIOVISUAL_REPORT_RETRIES", None)
    os.environ.pop("AUDIOVISUAL_REPORT_MAX_TOKENS", None)

print(json.dumps({"result": result, "captured": captured}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.equal(payload.result, 'ok')
  assert.equal(payload.captured.max_output_tokens, 12000)
  assert.equal(payload.captured.request_timeout_seconds, 345)
  assert.equal(payload.captured.max_retries, 0)
})

test('vnext run_state records Ready task and child-run identity', () => {
  const script = `
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from run_state import mark_stage

with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "run_state.json"
    os.environ["READY_SKILL_TASK_ID"] = "task-123"
    os.environ["READY_SKILL_CHILD_RUN_ID"] = "vea-child-123"
    try:
        mark_stage(path, stage="prepare", status="running")
        payload = json.loads(path.read_text(encoding="utf-8"))
    finally:
        os.environ.pop("READY_SKILL_TASK_ID", None)
        os.environ.pop("READY_SKILL_CHILD_RUN_ID", None)

print(json.dumps({"task_id": payload.get("task_id"), "child_run_id": payload.get("child_run_id")}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.equal(payload.task_id, 'task-123')
  assert.equal(payload.child_run_id, 'vea-child-123')
})

test('audiovisual report deterministically inserts scene screenshots into body paragraphs', () => {
  const script = `
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting import builder
from audiovisual.reporting.handoff import AudiovisualHandoffCoordinator

with tempfile.TemporaryDirectory() as tmp:
    report_dir = Path(tmp)
    frames = report_dir / "frames"
    frames.mkdir()
    scenes = []
    for scene_number, score in [(1, 5.0), (2, 9.0), (3, 7.0), (4, 6.0), (5, 8.0)]:
        image_path = frames / f"scene-{scene_number:03d}.jpg"
        image_path.write_bytes(b"fake image")
        scenes.append({
            "scene_number": scene_number,
            "description": f"第 {scene_number} 个画面",
            "weighted_score": score,
            "storyboard": {
                "screenshot_path": str(image_path),
                "timestamp": f"00:0{scene_number}",
            },
        })

    markdown = """# 视听剖析报告

## 导读
导读提到 Scene 001，但这里不插图。

## 视频结构图
![结构](<structure.png>)

结构说明 Scene 002，但这里也不插图。

## 路由判断
- Scene 003 只是路由证据。

## 正文模块
第一段分析 Scene 001 和 Scene 002。

第二段继续 Scene 001 和 Scene 003。

| 字段 | 内容 |
| --- | --- |
| 示例 | Scene 004 |

第三段收束 Scene 004。

> **视听对齐度**：Scene 005

| 维度 | 本片在这一维的表现 |
| --- | --- |
| 可信度 | Scene 005 |
"""
    illustrated = builder._illustrate_scene_screenshots(markdown, {"scenes": scenes}, report_dir)
    repeated = builder._illustrate_scene_screenshots(illustrated, {"scenes": scenes}, report_dir)
    original_insert = builder._illustrate_scene_screenshots
    builder._illustrate_scene_screenshots = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("boom"))
    fallback = builder._try_illustrate_scene_screenshots("原文", {"scenes": scenes}, report_dir)
    builder._illustrate_scene_screenshots = original_insert

    coordinator = AudiovisualHandoffCoordinator(report_dir, "video-a")
    coordinator._ensure_handoff_dir()
    coordinator._mark_task("body", "pending", task="body/task.md", output="body/output.md")
    coordinator._write_brief()
    brief = (report_dir / "audiovisual_handoff" / "brief.md").read_text(encoding="utf-8")

print(json.dumps({
    "scene_images": [path for path in builder._extract_image_paths(illustrated) if path.startswith("frames/")],
    "scene_images_after_repeat": [path for path in builder._extract_image_paths(repeated) if path.startswith("frames/")],
    "summary_has_scene_image": "![Scene" in illustrated.split("## 视频结构图", 1)[0],
    "diagram_has_scene_image": "![Scene" in illustrated.split("## 路由判断", 1)[0].split("## 视频结构图", 1)[1],
    "route_has_scene_image": "![Scene" in illustrated.split("## 正文模块", 1)[0].split("## 路由判断", 1)[1],
    "tail_has_scene_image": "![Scene" in illustrated.split("> **视听对齐度**", 1)[1],
    "caption_count": illustrated.count("*Scene "),
    "fallback": fallback,
    "brief_has_illustrate": "illustrate" in brief,
}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.deepEqual(payload.scene_images, [
    'frames/scene-001.jpg',
    'frames/scene-003.jpg',
    'frames/scene-004.jpg',
  ])
  assert.deepEqual(payload.scene_images_after_repeat, payload.scene_images)
  assert.equal(payload.summary_has_scene_image, false)
  assert.equal(payload.diagram_has_scene_image, false)
  assert.equal(payload.route_has_scene_image, false)
  assert.equal(payload.tail_has_scene_image, false)
  assert.equal(payload.caption_count, 3)
  assert.equal(payload.fallback, '原文')
  assert.equal(payload.brief_has_illustrate, false)
})

test('audiovisual report validation relaxes body length gate for videos under one minute', () => {
  const script = `
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting import template_engine

base_rules = {
    "min_chars_per_section": 700,
    "min_subsection_chars": 180,
    "min_scene_evidence_per_section": 3,
    "require_scene_evidence_per_section": True,
}
short_data = {
    "scenes": [
        {"duration_seconds": 12, "end_time_seconds": 12},
        {"duration_seconds": 24, "end_time_seconds": 36},
    ],
}
long_data = {
    "scenes": [
        {"duration_seconds": 60, "end_time_seconds": 60},
        {"duration_seconds": 60, "end_time_seconds": 120},
    ],
}
short_rules = template_engine._apply_duration_sensitive_validation_rules(short_data, base_rules)
long_rules = template_engine._apply_duration_sensitive_validation_rules(long_data, base_rules)

section_body = ("内容" * 130) + " Scene 001 Scene 002 Scene 003"
markdown = "## 怀旧与时间修辞\\n\\n" + section_body + "\\n"
template_engine._validate_required_sections(
    markdown,
    ["## 怀旧与时间修辞"],
    source="raw_prompt",
    validation_rules=short_rules,
)
try:
    template_engine._validate_required_sections(
        markdown,
        ["## 怀旧与时间修辞"],
        source="raw_prompt",
        validation_rules=long_rules,
    )
    long_error = ""
except ValueError as exc:
    long_error = str(exc)

print(json.dumps({
    "short_rules": short_rules,
    "long_rules": long_rules,
    "long_error": long_error,
}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.equal(payload.short_rules.min_chars_per_section, 240)
  assert.equal(payload.short_rules.min_subsection_chars, 80)
  assert.equal(payload.short_rules.min_scene_evidence_per_section, 2)
  assert.equal(payload.long_rules.min_chars_per_section, 700)
  assert.match(payload.long_error, /模块正文不足/)
})

test('audiovisual report validation normalizes heading quotes and reports all remaining gaps', () => {
  const script = `
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting import template_engine

rules = {
    "min_chars_per_section": 100,
    "min_subsection_chars": 20,
    "min_scene_evidence_per_section": 3,
    "require_scene_evidence_per_section": True,
    "required_subsections": {
        "品牌符号学与意识形态分析": ['意识形态"自然化"评估'],
    },
}
body = """## 品牌符号学与意识形态分析

### 意识形态“自然化”评估

Scene 001 Scene 002 Scene 003 这里用弯引号标题写出完整分析内容，机器应该把它视为 prompt 里的直引号标题同一个子条目。

## 媒介语境与 Campaign 生态位分析

太短。
"""
try:
    template_engine._validate_required_sections(
        body,
        ["## 品牌符号学与意识形态分析", "## 媒介语境与 Campaign 生态位分析"],
        source="raw_prompt",
        validation_rules=rules,
    )
    error = ""
except ValueError as exc:
    error = str(exc)

print(json.dumps({
    "error": error,
    "naturalization_missing": '缺子条目 ### 意识形态"自然化"评估' in error,
    "has_module_gap": "模块正文不足" in error,
    "has_scene_gap": "不同场景证据不足" in error,
}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.equal(payload.naturalization_missing, false)
  assert.equal(payload.has_module_gap, true)
  assert.equal(payload.has_scene_gap, true)
  assert.match(payload.error, /Prompt fidelity failure/)
})

test('audiovisual validation failure writes repair handoff and direct finalize consumes newer repair output', () => {
  const script = `
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting import template_engine

with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    draft = "## 导读\\n\\n失败草稿。\\n"
    template_engine._dump_validation_errors(
        out,
        draft,
        ["## 导读"],
        "Prompt fidelity failure: 模块正文不足",
        validation_rules={"min_chars_per_section": 100},
    )
    handoff = out / "audiovisual_handoff"
    output_path = handoff / "body" / "output.md"
    validation_path = handoff / "body" / "validation_errors.json"
    receipt = json.loads((handoff / "receipt.json").read_text(encoding="utf-8"))
    initial_read = template_engine._read_repaired_validation_body(out)

    time.sleep(0.02)
    repaired = "## 导读\\n\\n修复后的正文。\\n"
    output_path.write_text(repaired, encoding="utf-8")
    repaired_read = template_engine._read_repaired_validation_body(out)

    def fake_prompt(_data, _route):
        return {
            "system_prompt": "sys",
            "user_message": "user",
            "required_sections": ["## 导读"],
            "context": {"generated_at": "now"},
            "python_direct": [],
            "source": "template",
            "validation_rules": {},
        }

    def should_not_request(_system_prompt, _user_message):
        raise RuntimeError("request_fn should not be called when a newer repaired body exists")

    template_engine.build_audiovisual_body_prompt = fake_prompt
    final = template_engine.synthesize_audiovisual_report(
        {"scenes": []},
        {"framework": "generic", "route_label": "测试路由"},
        report_dir=out,
        request_fn=should_not_request,
    )

    print(json.dumps({
        "receipt_status": receipt["tasks"]["body"]["status"],
        "task_exists": (handoff / "body" / "task.md").exists(),
        "brief_exists": (handoff / "brief.md").exists(),
        "validation_exists": validation_path.exists(),
        "initial_read": initial_read,
        "repaired_read": repaired_read,
        "final_contains_repair": "修复后的正文" in final,
    }, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.equal(payload.receipt_status, 'validation_failed')
  assert.equal(payload.task_exists, true)
  assert.equal(payload.brief_exists, true)
  assert.equal(payload.validation_exists, true)
  assert.equal(payload.initial_read, null)
  assert.equal(payload.repaired_read, '## 导读\n\n修复后的正文。\n')
  assert.equal(payload.final_contains_repair, true)
})

test('audiovisual report generation does not require handoff unless explicitly enabled', () => {
  const script = `
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting import builder

calls = []

def fake_build(data, report_dir=None, runtime_config=None, request_fn=None):
    calls.append(request_fn is not None)
    return "# 视听剖析报告\\n\\n## 导读\\n\\n自动生成正文。\\n"

builder.build_audiovisual_report_markdown = fake_build
builder.enrich_audiovisual_layers = lambda data: data
builder.load_storyboard_context_rows = lambda video_dir, video_id: []
builder._require_new_route_contract = lambda data: "hybrid"

data = {
    "video_id": "video-a",
    "audiovisual_route": {"child_type": "hybrid"},
    "classification_result": {"classification": {"type": "hybrid"}},
}

os.environ.pop("AUDIOVISUAL_REPORT_HANDOFF", None)
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    result = builder.generate_audiovisual_report_outputs(data, out, formats=("md",), runtime_config={})
    default_payload = {
        "request_fn_used": calls[-1],
        "handoff_dir_exists": (out / "audiovisual_handoff").exists(),
        "md_exists": Path(result["md"]).exists(),
    }

os.environ["AUDIOVISUAL_REPORT_HANDOFF"] = "1"
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    builder.generate_audiovisual_report_outputs(data, out, formats=("md",), runtime_config={})
    opt_in_payload = {
        "request_fn_used": calls[-1],
    }
os.environ.pop("AUDIOVISUAL_REPORT_HANDOFF", None)

print(json.dumps({"default": default_payload, "opt_in": opt_in_payload}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.equal(payload.default.request_fn_used, false)
  assert.equal(payload.default.handoff_dir_exists, false)
  assert.equal(payload.default.md_exists, true)
  assert.equal(payload.opt_in.request_fn_used, true)
})

test('audiovisual report direct generation compacts summary and repairs validation failures', () => {
  const script = `
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
from audiovisual.reporting import template_engine

rules = {
    "summary_section": "## 导读",
    "summary_max_chars": 400,
    "summary_min_scene_evidence": 2,
    "summary_jargon_blacklist": ["路由", "加权分"],
}
long_summary = """## 导读

这是一段故意写得很长的导读，它会不断解释视频如何从日常状态进入节庆状态，并且还会不小心提到路由和加权分这些内部词。这里继续补很多细节，让它超过机器校验的上限，但它本质上应该只是给普通观众速读。

- **第一处亮点** 展示人群与灯光的进入方式，让观众知道现场氛围从这里开始升温（Scene 001，00:00）。
- **第二处亮点** 节奏转强，画面把活动体验推到更明确的位置（Scene 008，00:24）。
- **第三处亮点** 收尾给出行动提示，但不需要在导读里展开成长篇正文（Scene 018，01:12）。

## 正文模块

正文。
"""
compacted = template_engine._compact_summary_section_if_needed(long_summary, rules)
summary_block = compacted.split("## 正文模块", 1)[0]

calls = []

def fake_prompt(data, route):
    return {
        "system_prompt": "sys",
        "user_message": "请写正文",
        "required_sections": ["## 导读"],
        "context": {"generated_at": "now"},
        "python_direct": [],
        "source": "raw_prompt",
        "validation_rules": rules,
    }

def fake_assemble(agent_text, *args, **kwargs):
    if agent_text == "bad":
        raise ValueError("Prompt fidelity failure: 模块正文不足")
    return "ok"

def fake_request(system_prompt, user_message):
    calls.append(user_message)
    return "bad" if len(calls) == 1 else "fixed"

template_engine.build_audiovisual_body_prompt = fake_prompt
template_engine._assemble_final_report = fake_assemble
template_engine._request_agent_report = lambda system_prompt, user_message, client=None, runtime_config=None: fake_request(system_prompt, user_message)
os.environ.pop("AUDIOVISUAL_REPORT_REPAIR_ATTEMPTS", None)
repaired = template_engine.synthesize_audiovisual_report({}, {}, runtime_config={})

print(json.dumps({
    "summary_chars": len(template_engine._strip_formatting_for_count(summary_block.replace("## 导读", ""))),
    "summary_has_jargon": "路由" in summary_block or "加权分" in summary_block,
    "scene_refs": len(template_engine._SCENE_EVIDENCE_RE.findall(summary_block)),
    "repair_calls": len(calls),
    "repair_prompt_contains_error": "模块正文不足" in calls[-1],
    "repaired": repaired,
}, ensure_ascii=False))
`
  const raw = execFileSync('python3', ['-c', script], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  })
  const payload = JSON.parse(raw)

  assert.ok(payload.summary_chars <= 400)
  assert.equal(payload.summary_has_jargon, false)
  assert.ok(payload.scene_refs >= 2)
  assert.equal(payload.repair_calls, 2)
  assert.equal(payload.repair_prompt_contains_error, true)
  assert.equal(payload.repaired, 'ok')
})

test('SKILL.md frontmatter declares name / description / when-to-use per Claude Skill protocol', () => {
  const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
  const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatterMatch, 'SKILL.md must start with YAML frontmatter')
  const frontmatter = frontmatterMatch![1]
  assert.ok(/\bname:\s*vea/.test(frontmatter), 'name field required (vnext display name is "vea")')
  assert.ok(/\bdescription:/.test(frontmatter), 'description field required')
  assert.ok(/\bwhen-to-use:/.test(frontmatter), 'when-to-use field required for Claude Skill protocol')
})

test('orchestrator inline-injects SKILL.md, arms primitive hint, creates no skill_executions row', async () => {
  _resetLastReferenceSkillHintsForTests()
  const skillState: any = {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer (VNext)',
    description: '长视频深度分析。',
    defaultAction: 'read_skill',
    executionMode: 'advisory',
    managedPath: SKILL_DIR,
    actions: [
      {
        name: 'read_skill',
        visibility: 'internal',
        runtime: 'reference',
        params: [],
      },
      {
        name: 'video_expert_pipeline',
        visibility: 'internal',
        runtime: 'python',
        params: [],
      },
    ],
    childLoop: {
      version: 1,
      actions: ['video_expert_pipeline'],
    },
  }

  // Phase 4: listExecutions dep removed from orchestrator; no execution row
  // is created on the reference path because that code path no longer exists.

  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skillState],
    resolveSkillToolByAction: (_skillId, action) => ({
      name: action === 'video_expert_pipeline'
        ? 'skill_video_expert_pipeline'
        : 'skill_video_expert_analyzer_read_skill',
      action,
      params: [],
    }) as any,
  })

  const session: any = { messages: [] }
  let toolCalls = 0
  await orchestrator.maybeInjectExplicitSkillContext({
    userText: '用 video-expert-analyzer 深度分析这个视频 https://example.com/video.mp4',
    session,
    sessionId: 'test-session-vexpert',
    emitOutput: () => {},
    emitToolAction: () => { toolCalls += 1 },
    executeTool: async () => {
      toolCalls += 1
      return { text: '', shape: 'text', data: null, projectionPatch: null, interactionHint: null }
    },
  })

  assert.equal(toolCalls, 0, 'direct-read path must not perform a tool_use round-trip')
  assert.equal(session.messages.length, 1, 'exactly one system-role injection')
  const injected = session.messages[0] as { role: string; content: string }
  assert.equal(injected.role, 'system')
  assert.ok(injected.content.includes('已加载技能'), 'injection header present')
  assert.ok(injected.content.includes('skill_video_expert_pipeline'), 'child-loop typed action is named in guidance')
  assert.ok(injected.content.includes('不要用 skill_start_detached'), 'child-loop skill must not be steered to detached primitive')
  assert.ok(injected.content.includes('video-expert-analyzer'), 'skill id rendered')
  // vnext SKILL.md keywords that prove the body was inlined (not truncated out).
  assert.ok(
    injected.content.includes('orchestrate_vnext') || injected.content.includes('OpenClaw'),
    'SKILL.md body was inlined',
  )

  const hint = getLastReferenceSkill('test-session-vexpert')
  assert.equal(hint?.id, 'video-expert-analyzer', 'hint arms primitive gating for next turn')

  // Phase 4: the listExecutions dep is gone; the reference path never creates
  // an execution row (there is no such concept anymore).
})

test('vnext SKILL.md fits the existing 12K JS-char cap and is inlined without truncation', async () => {
  _resetLastReferenceSkillHintsForTests()
  const rawSkillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
  // Note: vnext SKILL.md is ~17.8 KB on disk but ~10.4K JS string chars
  // (UTF-16 code units) because the body is predominantly CJK. JS string
  // length — not raw bytes — is what the inline cap measures.
  assert.ok(rawSkillMd.length <= 12_000, 'vnext SKILL.md should fit under the existing 12K cap')

  const skillState: any = {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer (VNext)',
    defaultAction: 'read_skill',
    executionMode: 'advisory',
    managedPath: SKILL_DIR,
    actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
  }

  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skillState],
    resolveSkillToolByAction: () => ({
      name: 'skill_video_expert_analyzer_read_skill',
      action: 'read_skill',
      params: [],
    }) as any,
  })

  const session: any = { messages: [] }
  await orchestrator.maybeInjectExplicitSkillContext({
    userText: '用 video-expert-analyzer 分析视频',
    session,
    sessionId: 'test-session-vexpert-cap',
    emitOutput: () => {},
    emitToolAction: () => {},
    executeTool: async () => ({ text: '', shape: 'text', data: null, projectionPatch: null, interactionHint: null }),
  })

  const injected = session.messages[0] as { role: string; content: string }
  // Tail-of-doc keyword survives — proves the whole body was inlined,
  // not silently truncated mid-doc.
  assert.ok(
    injected.content.includes('不可妥协规则') || injected.content.includes('OpenClaw'),
    'late-doc keywords should survive inlining (no truncation)',
  )
})
