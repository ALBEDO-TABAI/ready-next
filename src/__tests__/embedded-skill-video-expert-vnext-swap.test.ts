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

test('vnext YouTube download path supports Ready cookies and yt-dlp JS challenge components', () => {
  const pipelinePath = join(SKILL_DIR, 'scripts', 'pipeline_enhanced.py')
  // eslint-disable-next-line ready/no-source-grep-test -- Packaging contract: these yt-dlp flags are assembled inside the Python downloader, and exercising them directly would require a networked YouTube run.
  const source = readFileSync(pipelinePath, 'utf-8')
  assert.match(source, /YOUTUBE_COOKIE_FILE/, 'Ready-exported YouTube cookies must be passed to yt-dlp')
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
    "duration_seconds": 30,
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
