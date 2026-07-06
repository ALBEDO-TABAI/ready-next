/**
 * P0-4（自动化代理）—— 复现 2026-07-06 真机失败轮的工具面解析全链：
 *   executor 默认面（含 P0-3 文档读取地板保留）
 *   → orchestrator 本地文档收窄（P0-2：保留 isLocalDocument ∪ skillFloor）
 *   → orchestrator 空面回退（P0-2 T2）
 * 断言 P0-4 验收 bar：toolCount≥7、tools 同时含 skill_read_artifact+skill_run_shell+
 * file_read_excerpt、且不触发空面回退。
 *
 * 说明：交互式真机 dogfood（npm run dev + 真模型回合真正写出 HTML）需用户执行，
 * 步骤见交付的测试文档；本代理只在代码层证明工具面机制已通。
 * 母合同：2026-07-06 skill-envelope §5 P0-4。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import type { AIModelConfig } from '../shared/ai-providers'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { SkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  clearLastReferenceSkill,
  getLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import {
  isLocalDocumentToolDefinition,
  recoverEmptyToolSurface,
  selectedSkillFloorToolNames,
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

test('P0-4 proxy: failing-round tool surface resolves to a non-empty skill+document floor', () => {
  const rawUserText = [
    '用@[BV1vs411e7QF_audiovisual_analysis.md]的内容来生成一个人文感风格 ppt 在相同目录下@[ready-human-touch-ppt]',
    '',
    '--- 附件: BV1vs411e7QF_audiovisual_analysis.md ---',
    '- 路径: /tmp/BV1vs411e7QF_audiovisual_analysis.md',
  ].join('\n')
  const primaryInstruction = '用 BV1vs411e7QF_audiovisual_analysis.md 的内容来生成一个人文感风格 ppt 在相同目录下'
  const sessionId = 'scope-p0-4-dogfood-proxy'
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')
  clearLastReferenceSkill(sessionId)
  const requestEnvelope = {
    rawUserText,
    pureUserText: primaryInstruction,
    primaryInstruction,
    resources: [{
      id: 'attach-analysis',
      kind: 'file_reference',
      source: 'attachment',
      name: 'BV1vs411e7QF_audiovisual_analysis.md',
      path: '/tmp/BV1vs411e7QF_audiovisual_analysis.md',
      text: '',
      summary: null,
      order: 0,
      canRead: true,
      canWrite: true,
    }],
  }
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) =>
        text.includes('@[ready-human-touch-ppt]') || text.includes('ready-human-touch-ppt')
          ? [{ id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt', managedPath: skillRoot }]
          : [],
      buildPreferredSkillToolNames: (text: string) =>
        text.includes('@[ready-human-touch-ppt]') || text.includes('ready-human-touch-ppt')
          ? ['skill_ask_user', 'skill_run_shell', 'skill_write_artifact', 'skill_read_artifact', 'skill_export_artifact']
          : [],
      rememberExplicitReferenceSkillHint: (text: string, sid?: string) => {
        if (!text.includes('ready-human-touch-ppt')) return false
        rememberLastReferenceSkill(sid, { id: 'ready-human-touch-ppt', name: 'ready-human-touch-ppt' })
        return true
      },
      getCurrentReferenceSkillHint: (sid?: string) => {
        const hint = getLastReferenceSkill(sid)
        return hint ? { id: hint.id, name: hint.name } : null
      },
    } as any,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string,
      sessionId?: string,
      requestEnvelope?: unknown,
    ) => SkillToolAuthorization
    toolExecutor: {
      listDefaultToolDefinitionsForTurn: (params: {
        message: string
        sessionId?: string
        scopeId?: string
        config: AIModelConfig
        browserHostAvailable: boolean
        feishuConnected: boolean
        authorization: SkillToolAuthorization
        requestEnvelope?: unknown
      }) => Array<{ name: string; domain?: string }>
    }
  }

  try {
    const authorization = privateRuntime.resolveSkillAuthorizationForTurn(
      primaryInstruction,
      sessionId,
      requestEnvelope,
    )
    assert.equal(authorization.mode, 'selected', 'D1: explicit skill mention must survive attachment markers')

    // Executor default surface — P0-3 doc-read floor preservation happens here.
    const executorDefinitions = privateRuntime.toolExecutor.listDefaultToolDefinitionsForTurn({
      message: primaryInstruction,
      sessionId,
      scopeId: sessionId,
      config: BASE_CONFIG,
      browserHostAvailable: true,
      feishuConnected: false,
      authorization,
      requestEnvelope,
    })
    const preNarrowing = executorDefinitions

    // Orchestrator local-document narrowing (P0-2): keep local-document tools ∪ skill floor.
    const skillFloor = selectedSkillFloorToolNames(authorization)
    const narrowed = executorDefinitions.filter((definition) =>
      isLocalDocumentToolDefinition(definition as never) || skillFloor.has(definition.name))

    // Orchestrator empty-surface recovery (P0-2 T2).
    const recovery = recoverEmptyToolSurface(narrowed, preNarrowing)
    const finalNames = recovery.definitions.map((definition) => (definition as { name: string }).name)
    const surfaceDump = `executor=${executorDefinitions.map((d) => `${d.name}[${d.domain}]`).join(',')} | final=${finalNames.join(',')}`

    assert.equal(recovery.recovered, false, `empty-surface recovery must NOT trigger on the fixed pipeline. ${surfaceDump}`)
    assert.ok(finalNames.length >= 7, `P0-4 bar: toolCount must be >= 7, got ${finalNames.length}. ${surfaceDump}`)
    for (const required of ['skill_read_artifact', 'skill_run_shell', 'file_read_excerpt']) {
      assert.ok(finalNames.includes(required), `P0-4 bar: ${required} must be present. ${surfaceDump}`)
    }
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})
