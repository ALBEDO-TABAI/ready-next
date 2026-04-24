/**
 * B Phase 2 — video-copy-analyzer migration e2e smoke.
 *
 * Asserts the mechanical properties of the migration without booting the full
 * runtime-manager or spawning any Python:
 *   1. The embedded manifest compiles to `executionMode: 'advisory'` with a
 *      reference `read_skill` action (i.e. it conforms to the Claude Skill
 *      protocol — markdown + frontmatter, no custom state-machine).
 *   2. `skill.workflow.json` no longer exists on disk.
 *   3. SKILL.md carries the `when-to-use` frontmatter field.
 *   4. `SkillContextOrchestrator` inline-injects the SKILL.md (no tool_use
 *      round-trip) and registers the reference-skill hint so primitives
 *      (`skill_run_shell` / `skill_write_artifact` / `skill_read_artifact`)
 *      get gated ON for the next turn.
 *
 * Per user steer: the test does NOT assert specific shell commands — how the
 * agent chooses to invoke bundled scripts is the model's decision, not
 * something to freeze in a contract here.
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

test('manifest compiles to reference/advisory with a single read_skill action', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  assert.equal(def.executionMode, 'advisory', 'execution mode must be advisory post-migration')
  assert.equal(def.workflow, undefined, 'no workflow object should be compiled')
  assert.equal(def.defaultAction, 'read_skill', 'defaultAction points at the reference entry')
  assert.equal(def.actions.length, 1, 'only read_skill remains')
  const action = def.actions[0]
  assert.equal(action.name, 'read_skill')
  assert.equal(action.runtime, 'reference')
  assert.equal(action.visibility, 'internal', 'LLM should not see a dynamic skill_<id>_read_skill tool')
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
  const skillState: any = {
    id: 'video-copy-analyzer',
    name: 'Video Copy Analyzer',
    description: 'Extract subtitles and generate transcript-oriented copy deliverables from a short video.',
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
    ],
  }

  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skillState],
    resolveSkillToolByAction: () => ({
      name: 'skill_video_copy_analyzer_read_skill',
      action: 'read_skill',
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
