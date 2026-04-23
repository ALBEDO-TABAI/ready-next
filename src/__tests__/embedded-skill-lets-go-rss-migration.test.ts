/**
 * B Phase 3 PR2 — lets-go-rss reference migration e2e smoke.
 *
 * lets-go-rss is a HYBRID migration (vs Phase 2 video-copy which removed
 * all action handlers). The 5 typed `skill_rss_*` actions stay public
 * because production callers still depend on them:
 *   - SkillsCenterPanel.tsx UI shortcut (`/skill lets-go-rss rss_update {…}`)
 *   - rss-domain-adapter.ts routing (`skill_rss_*` is in the preferred prefix list)
 *   - Slash command power users
 *
 * What changes:
 *   - `read_skill` (reference, internal) is added so the orchestrator
 *     inline-injects SKILL.md when the user mentions the skill by name —
 *     critical for the "Bot 推送规范" rules that the LLM must obey verbatim.
 *   - `defaultAction` flips from `rss_update` to `read_skill` so bare
 *     `/skill lets-go-rss` shows the docs (consistent with video-copy /
 *     video-expert reference skills) instead of running an update.
 *   - SKILL.md frontmatter gains `when-to-use` per Claude Skill protocol.
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
const SKILL_DIR = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'lets-go-rss')

test('manifest compiles to advisory with read_skill default + 5 retained public python actions', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  assert.equal(def.executionMode, 'advisory')
  assert.equal(def.workflow, undefined)
  assert.equal(def.defaultAction, 'read_skill', 'bare `/skill lets-go-rss` should show docs (consistent with reference skills)')

  // 1 reference + 5 public python = 6 actions total
  assert.equal(def.actions.length, 6, 'read_skill + 5 retained python actions for production callers')

  const readSkill = def.actions.find((a) => a.name === 'read_skill')
  assert.ok(readSkill, 'read_skill present')
  assert.equal(readSkill!.runtime, 'reference')
  assert.equal(readSkill!.visibility, 'internal')

  for (const name of ['rss_add', 'rss_update', 'rss_status', 'rss_list', 'rss_stats']) {
    const action = def.actions.find((a) => a.name === name)
    assert.ok(action, `${name} action retained for production callers`)
    assert.equal(action!.runtime, 'python')
    assert.equal(action!.visibility, 'public', `${name} stays LLM-visible (rss-domain-adapter prefers skill_rss_*)`)
  }
})

test('skill.workflow.json is absent (lets-go-rss never had one)', () => {
  // Sanity: lets-go-rss was already advisory before Phase 3; this test pins
  // the contract so a future regression cannot silently re-introduce one.
  assert.equal(existsSync(join(SKILL_DIR, 'skill.workflow.json')), false)
})

test('SKILL.md frontmatter declares name / description / when-to-use per Claude Skill protocol', () => {
  const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
  const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatterMatch, 'SKILL.md must start with YAML frontmatter')
  const frontmatter = frontmatterMatch![1]
  assert.ok(/\bname:\s*lets-go-rss/.test(frontmatter), 'name field required')
  assert.ok(/\bdescription:/.test(frontmatter), 'description field required')
  assert.ok(/\bwhen-to-use:/.test(frontmatter), 'when-to-use field required for Claude Skill protocol')
})

test('orchestrator inline-injects SKILL.md, arms primitive hint, creates no skill_executions row', async () => {
  _resetLastReferenceSkillHintsForTests()

  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const skillState: any = {
    id: 'lets-go-rss',
    name: "Let's Go RSS",
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

  const executionLog: Array<unknown> = []

  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skillState],
    listExecutions: () => executionLog as any,
    resolveSkillToolByAction: (skillId, actionName) => ({
      name: actionName === 'read_skill'
        ? 'skill_lets_go_rss_read_skill'
        : `skill_${actionName}`,
      action: actionName,
      params: [],
    }) as any,
  })

  const session: any = { messages: [] }
  let toolCalls = 0
  await orchestrator.maybeInjectExplicitSkillContext({
    userText: '用 lets-go-rss 看一下今天有什么新更新',
    session,
    sessionId: 'test-session-letsgorss',
    emitOutput: () => {},
    emitToolAction: () => { toolCalls += 1 },
    executeTool: async () => {
      toolCalls += 1
      return { text: '', shape: 'text', data: null, projectionPatch: null, interactionHint: null }
    },
  })

  assert.equal(toolCalls, 0, 'reference defaultAction → direct read, no tool round-trip')
  assert.equal(session.messages.length, 1, 'exactly one system-role injection')
  const injected = session.messages[0] as { role: string; content: string }
  assert.equal(injected.role, 'system')
  assert.ok(injected.content.includes('已加载技能'), 'injection header present')
  assert.ok(injected.content.includes('lets-go-rss') || injected.content.includes("Let's Go RSS"))
  // SKILL.md body keywords — proves inlining (not truncated to header only).
  assert.ok(
    injected.content.includes('Bot 汇报规范') || injected.content.includes('--status'),
    'SKILL.md body was inlined',
  )

  const hint = getLastReferenceSkill('test-session-letsgorss')
  assert.equal(hint?.id, 'lets-go-rss', 'hint arms primitive gating for next turn')

  assert.equal(executionLog.length, 0, 'no skill_executions row on the reference path')
})
