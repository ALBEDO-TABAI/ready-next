import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import type { SessionRecallCapsule } from '../shared/session-recall'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

function createScope(): ConversationScope {
  return {
    id: 'scope-budget-coverage',
    agent: 'butler',
    title: '预算覆盖测试',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'thread-budget-coverage',
    meta: {},
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    lastMessageAt: '2026-06-20T00:00:00.000Z',
  }
}

function capsule(id: string, title: string): SessionRecallCapsule {
  return {
    conversationId: id,
    lineageRootId: id,
    resumeTitle: title,
    title,
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: `${id}-thread`,
    summary: `历史摘要 ${title}，包含上次工具调用和任务进度。`,
    latestTaskTitle: `${title} 任务`,
    latestTaskSummary: `${title} 最近任务摘要`,
    attachmentNames: [`${title}.md`],
    updatedAt: '2026-06-20T00:00:00.000Z',
  }
}

test('PromptBudgetReport covers every injected context_bill section', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-prompt-budget-coverage-'))
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'RULES.md'), '只输出可验证结论。', 'utf8')
    writeFileSync(join(root, 'docs', 'budget-trigger.md'), '触发规则正文。', 'utf8')

    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [
        { role: 'user', content: '上一轮用户请求：继续处理预算缺口。' },
        { role: 'assistant', content: '上一轮助手回复：已开始核对 context_bill。' },
      ],
      getBeliefCardStore: () => ({
        renderKnowledgeIndex: () => ({
          text: '- active-card: 预算报告必须覆盖知识索引。',
          renderedCount: 1,
          omittedCount: 0,
        }),
        listRoutingCards: () => [
          {
            relPath: 'agents/writer/routing/budget.md',
            title: '预算路由',
            description: '预算和压缩问题交给写作专家',
            targetAgentId: 'writer',
          },
        ],
      }),
      getAgentRoster: () => [
        { id: 'butler', name: '主 agent', charter: null, status: 'active' },
        { id: 'writer', name: '写作专家', charter: '处理长上下文和文档审查', status: 'active' },
      ],
      getScopeSessionRecallCapsules: () => [capsule('manual-recall', '手动回看')],
      getAutoSessionRecallCapsules: () => [capsule('auto-recall', '自动回看')],
      isKnowledgeSystemEnabled: () => true,
      now: () => new Date('2026-06-20T00:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope(),
      message: '请触发 budget-trigger 并继续处理上下文预算。',
      coordinators: [
        {
          id: 'budget-test',
          contributePromptFragment: () => [
            {
              id: 'budget-trigger',
              label: 'Budget Trigger',
              priority: 100,
              matches: ({ userText }: { userText: string }) => userText.includes('budget-trigger'),
              blocking: false,
              refs: [
                {
                  path: 'docs/budget-trigger.md',
                  title: 'Budget Trigger Rules',
                  summary: 'Budget trigger rule',
                },
              ],
            },
          ],
        },
      ] as never,
    })

    const bill = events.find((event) => event.metric === 'context_bill') as
      | (AgentMetricEvent & { sections?: Record<string, number>; total?: number; truncations?: string[] })
      | undefined
    assert.ok(bill, 'context_bill metric emitted')

    const requiredSections = [
      'L0',
      'L0_rules',
      'L1_summary',
      'L1_5_knowledge_index',
      'L1_5_agent_routing',
      'recall',
      'autoRecall',
      'L2_triggers',
    ]
    for (const key of requiredSections) {
      assert.ok((bill.sections?.[key] ?? 0) > 0, `${key} emitted in context_bill`)
      assert.equal(result.contextBudget.sectionBytes[key], bill.sections?.[key], `${key} bytes mirrored in contextBudget`)
      assert.ok((result.contextBudget.sectionChars[key] ?? 0) > 0, `${key} chars mirrored in contextBudget`)
    }

    assert.equal(result.contextBudget.totalBytes, bill.total)
    assert.deepEqual(result.contextBudget.truncations, bill.truncations)
    assert.equal(result.contextBudget.rulesChars, result.contextBudget.sectionChars.L0_rules)
    assert.equal(result.contextBudget.knowledgeIndexChars, result.contextBudget.sectionChars.L1_5_knowledge_index)
    assert.equal(result.contextBudget.agentRoutingChars, result.contextBudget.sectionChars.L1_5_agent_routing)
    assert.equal(result.contextBudget.recallChars, result.contextBudget.sectionChars.recall)
    assert.equal(result.contextBudget.autoRecallChars, result.contextBudget.sectionChars.autoRecall)

    const legacySubtotal =
      result.contextBudget.l0Chars
      + result.contextBudget.l1Chars
      + result.contextBudget.l2Chars
    assert.ok(
      result.contextBudget.totalChars > legacySubtotal,
      'totalChars includes non-L0/L1/L2 injected sections',
    )
  } finally {
    __setMetricSinkForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})
