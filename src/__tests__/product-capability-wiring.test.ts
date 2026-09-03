import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import {
  actionObligationEvidenceMatches,
  isReadyActionObligationSet,
  resolveReadyActionObligationSet,
} from '../main/modules/agent-control/codex-runtime/codex-action-obligation'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { digestCodexRootToolSurface } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

function resolve(
  userText: string,
  allowedToolNames: string[],
  productSurfaceTargets?: { rssItemId?: string; rssSourceId?: string },
) {
  const envelope = buildRequestEnvelope({ userText })
  return resolveReadyActionObligationSet({
    intent: classifyIntent(envelope),
    allowedToolNames,
    productSurfaceTargets,
    primaryInstruction: envelope.primaryInstruction,
  })
}

test('plain questions carry no action obligation', () => {
  const obligations = resolve('给我解释一下什么是 RSS', [
    'rss_analyze_item',
    'pet_show_sticky_note',
  ])

  assert.equal(obligations.requirements.length, 0)
  assert.equal(isReadyActionObligationSet(obligations), true)
})

test('only model-visible MCP tool changes invalidate the frozen native thread surface', () => {
  const mcpTool = (description: string): ToolDefinition => ({
    name: 'mcp_fixture_echo_read',
    description,
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    groupId: 'mcp',
    domain: 'mcp',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: null,
    executionVisibility: 'model',
    resultShape: 'json',
  })

  const frozen = digestCodexRootToolSurface([mcpTool('Echo text')])
  assert.equal(digestCodexRootToolSurface([mcpTool('Echo text')]), frozen)
  assert.notEqual(digestCodexRootToolSurface([mcpTool('Echo changed text')]), frozen)
})

test('pet sticky-note intent freezes an exact renderer-applied obligation', () => {
  const obligations = resolve('把这句话贴到宠物便利贴上', ['pet_show_sticky_note'])

  assert.deepEqual(obligations.requirements.map((item) => ({
    domain: item.domain,
    outcome: item.outcome,
    tools: item.allowedToolNames,
    actions: item.allowedProductActions,
  })), [{
    domain: 'pet',
    outcome: 'renderer_applied',
    tools: ['pet_show_sticky_note'],
    actions: ['pet.showStickyNote'],
  }])
})

test('RSS start and completed-report requests freeze different outcomes', () => {
  const start = resolve(
    '开始分析这个 RSS 条目',
    ['rss_analyze_item', 'rss_get_analysis_result'],
    { rssItemId: 'rss-item-1' },
  )
  const completed = resolve(
    '分析这个 RSS 条目并给我报告',
    ['rss_analyze_item', 'rss_get_analysis_result'],
    { rssItemId: 'rss-item-1' },
  )

  assert.equal(start.requirements[0]?.outcome, 'start')
  assert.equal(completed.requirements[0]?.outcome, 'job_terminal_artifact')
  assert.deepEqual(completed.requirements[0]?.allowedToolNames, [
    'rss_analyze_item',
    'rss_get_analysis_result',
  ])
  assert.deepEqual(completed.requirements[0]?.target, {
    kind: 'rss_item',
    id: 'rss-item-1',
  })
})

test('obligation digest rejects post-prepare mutation', () => {
  const obligations = resolve('清空宠物便利贴', ['pet_clear_sticky_notes'])
  const tampered = {
    ...obligations,
    requirements: obligations.requirements.map((item) => ({
      ...item,
      outcome: 'effect',
    })),
  }

  assert.equal(isReadyActionObligationSet(tampered), false)
})

test('terminal evidence must match the exact RSS item and report digest', () => {
  const obligation = resolve(
    '分析这个 RSS 条目并给我报告',
    ['rss_analyze_item', 'rss_get_analysis_result'],
    { rssItemId: 'rss-item-1' },
  ).requirements[0]!

  assert.equal(actionObligationEvidenceMatches(obligation, 'rss_analyze_item', {
    data: {
      ok: true,
      itemId: 'rss-item-1',
      jobId: 'job-1',
      status: 'success',
      reportPath: '/tmp/report.md',
      reportDigest: 'a'.repeat(64),
    },
  }), true)
  assert.equal(actionObligationEvidenceMatches(obligation, 'rss_analyze_item', {
    data: {
      ok: true,
      itemId: 'rss-item-2',
      jobId: 'job-1',
      status: 'success',
      reportPath: '/tmp/report.md',
      reportDigest: 'a'.repeat(64),
    },
  }), false)
})

test('effect obligations require domain readback rather than a generic success flag', () => {
  const rss = resolve('刷新 RSS 订阅', ['rss_fetch_updates']).requirements[0]!
  assert.equal(actionObligationEvidenceMatches(rss, 'rss_fetch_updates', {
    data: { ok: true },
  }), false)
  assert.equal(actionObligationEvidenceMatches(rss, 'rss_fetch_updates', {
    data: { ok: true, status: 'completed_with_warnings', totalItems: 12, unreadItems: 4 },
  }), true)

  const mcp = resolve('请用 mcp_fixture_echo_read', ['mcp_fixture_echo_read']).requirements[0]!
  assert.equal(actionObligationEvidenceMatches(mcp, 'mcp_fixture_echo_read', {
    data: { ok: true, serverId: 'fixture', toolName: 'mcp_fixture_echo_read', output: null },
  }), true)
  assert.equal(actionObligationEvidenceMatches(mcp, 'mcp_fixture_echo_read', {
    data: { ok: true },
  }), false)
})
