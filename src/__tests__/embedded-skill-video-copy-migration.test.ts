/**
 * B Phase 2 / 3 — video-copy-analyzer hybrid reference + retained internal action.
 *
 * Hybrid migration parallel to lets-go-rss (Phase 3 PR2): the manifest is now
 * `execution.mode: 'advisory'` with a `read_skill` reference action AND a
 * retained `video_copy_analyze` python action kept at `visibility: 'internal'`
 * because production code still calls it directly:
 *   - `src/main/modules/rss-engine/item-analysis-manager.ts::runCopyFlow`
 *     calls `runtime.runSkill({ skillId: 'video-copy-analyzer',
 *     action: 'video_copy_analyze', params: { input, outputDir, model,
 *     language } })` for every RSS item that looks like a video link.
 *
 * Why `internal` (not `public`): the LLM should NEVER see / pick this action;
 * it's a product-side dependency only. The reference path (read_skill) is the
 * sole LLM-facing entry, identical to the pure-reference Phase 2 contract.
 *
 * Per user steer: the test does NOT assert specific shell commands inside
 * SKILL.md — how the agent chooses to invoke bundled scripts is the model's
 * decision, not something to freeze in a contract here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import { SkillContextOrchestrator } from '../main/modules/agent-control/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
} from '../main/modules/agent-control/skill-reference-hints'

const __dirname = dirname(fileURLToPath(import.meta.url))
// src/__tests__ → repo root → assets/embedded-skills/video-copy-analyzer
const SKILL_DIR = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'video-copy-analyzer')

test('manifest compiles to advisory with read_skill default + retained internal video_copy_analyze action', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  assert.equal(def.executionMode, 'advisory', 'execution mode must be advisory post-migration')
  assert.equal(def.workflow, undefined, 'no workflow object should be compiled')
  assert.equal(def.defaultAction, 'read_skill', 'defaultAction points at the reference entry')

  // 1 reference + 1 retained internal python = 2 actions total
  assert.equal(def.actions.length, 2, 'read_skill + video_copy_analyze (internal, for item-analysis-manager)')

  const readSkill = def.actions.find((a) => a.name === 'read_skill')
  assert.ok(readSkill, 'read_skill present')
  assert.equal(readSkill!.runtime, 'reference')
  assert.equal(readSkill!.visibility, 'internal', 'LLM should not see a dynamic skill_<id>_read_skill tool')

  const copyAnalyze = def.actions.find((a) => a.name === 'video_copy_analyze')
  assert.ok(copyAnalyze, 'video_copy_analyze action retained for production caller')
  assert.equal(copyAnalyze!.runtime, 'python')
  assert.equal(copyAnalyze!.visibility, 'internal', 'kept hidden from LLM; only product code dispatches it')
  assert.equal(copyAnalyze!.inputMode, 'json', 'json payload mode (--payload-json)')
  assert.equal(copyAnalyze!.entry, 'scripts/ready_extract_subtitle.py')
})

test('video_copy_analyze action contract matches item-analysis-manager call site', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const action = def.actions.find((a) => a.name === 'video_copy_analyze')
  assert.ok(action, 'video_copy_analyze present')

  // The four params actually sent by item-analysis-manager.ts::runCopyFlow.
  // If item-analysis-manager grows a new param, this test will surface the
  // missing manifest declaration (or the unused manifest entry).
  const callSiteParams = ['input', 'outputDir', 'model', 'language']
  for (const name of callSiteParams) {
    const param = action!.params.find((p) => p.name === name)
    assert.ok(param, `param "${name}" declared (used by item-analysis-manager)`)
  }

  // input is the only required param — everything else has runtime defaults.
  const inputParam = action!.params.find((p) => p.name === 'input')!
  assert.equal(inputParam.required, true, 'input is required (URL or path)')
  for (const name of ['outputDir', 'model', 'language']) {
    const p = action!.params.find((x) => x.name === name)!
    assert.equal(p.required, false, `${name} optional (manager passes a value but script has defaults)`)
  }

  // model values must include 'small' (the literal value at the call site).
  const modelParam = action!.params.find((p) => p.name === 'model')!
  assert.ok(modelParam.enum?.includes('small'), `model enum must include "small" (passed by item-analysis-manager)`)
  // language values must include 'auto' (the literal value at the call site).
  const langParam = action!.params.find((p) => p.name === 'language')!
  assert.ok(langParam.enum?.includes('auto'), `language enum must include "auto" (passed by item-analysis-manager)`)
})

test('skill.workflow.json has been removed from disk', () => {
  const workflowPath = join(SKILL_DIR, 'skill.workflow.json')
  assert.equal(existsSync(workflowPath), false, 'skill.workflow.json must not exist after migration')
})

test('SKILL.md frontmatter declares when-to-use per Claude Skill protocol', () => {
  const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
  const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatterMatch, 'SKILL.md must start with YAML frontmatter')
  const frontmatter = frontmatterMatch![1]
  assert.ok(/\bname:\s*video-copy-analyzer/.test(frontmatter), 'name field required')
  assert.ok(/\bdescription:/.test(frontmatter), 'description field required')
  assert.ok(/\bwhen-to-use:/.test(frontmatter), 'when-to-use field required for Claude Skill protocol')
})

test('orchestrator inline-injects SKILL.md and arms the primitive-gating hint', async () => {
  _resetLastReferenceSkillHintsForTests()

  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const skillState: any = {
    id: 'video-copy-analyzer',
    name: 'Video Copy Analyzer',
    description: def.description,
    defaultAction: def.defaultAction,
    executionMode: def.executionMode,
    managedPath: SKILL_DIR,
    actions: def.actions.map((a) => ({
      name: a.name,
      visibility: a.visibility,
      runtime: a.runtime,
      params: a.params || [],
    })),
  }

  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skillState],
    resolveSkillToolByAction: (_skillId, actionName) => ({
      name: actionName === 'read_skill'
        ? 'skill_video_copy_analyzer_read_skill'
        : `skill_video_copy_analyzer_${actionName}`,
      action: actionName,
      params: [],
    }) as any,
  })

  const session: any = { messages: [] }
  let toolCalls = 0
  await orchestrator.maybeInjectExplicitSkillContext({
    userText: '用 video-copy-analyzer 分析这个视频 https://example.com/video.mp4',
    session,
    sessionId: 'test-session-videocopy',
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
  // Content should include both the skill-header guidance and a recognisable
  // slice of the skill's own text (frontmatter keywords are fine proxies).
  assert.ok(injected.content.includes('已加载技能'), 'injection header present')
  assert.ok(injected.content.includes('video-copy-analyzer'), 'skill name rendered')
  assert.ok(
    injected.content.includes('FunASR') || injected.content.includes('视频文案'),
    'SKILL.md body was inlined, not truncated out',
  )

  const hint = getLastReferenceSkill('test-session-videocopy')
  assert.equal(hint?.id, 'video-copy-analyzer', 'hint arms primitive gating for next turn')
})
