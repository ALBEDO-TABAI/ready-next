import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import type { DomainAdapter } from '../main/modules/agent-control/domain-adapters/domain-adapter'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

test('fragment-inline-asset-ref declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'fragment-inline-asset-ref transitive sqlite load')
})

const SCOPE: ConversationScope = {
  id: 's1',
  agent: 'butler',
  title: '测试会话',
  sourceKind: 'local',
  sourceId: 'app',
  threadKey: '',
  meta: {},
}

// Minimal coordinator carrying a single prompt fragment. Neutral id → module
// undefined → never skipped by intent gating, keeping the test deterministic.
function coordinatorWith(refs: Array<Record<string, unknown>>, matches = () => true): DomainAdapter {
  return {
    id: 'test-domain',
    contributePromptFragment: () => [
      { id: 'frag-1', label: 'frag', priority: 70, blocking: false, matches, refs },
    ],
  } as unknown as DomainAdapter
}

async function injectedText(svc: PromptAssemblyService, coordinator: DomainAdapter): Promise<string> {
  const result = await svc.buildForScopedRun({ scope: SCOPE, message: '帮我处理一下', coordinators: [coordinator] })
  return [result.systemPrompt, ...result.bootstrapMessages].join('\n')
}

test('inline asset text is injected directly (no file read)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-frag-'))
  try {
    const svc = new PromptAssemblyService({ getMemoryRoot: () => root, getScopeMessages: () => [] })
    const out = await injectedText(svc, coordinatorWith([
      { path: null, title: '浏览器纪律', summary: 's', text: 'INLINE_DISCIPLINE_MARKER 五步配方' },
    ]))
    assert.ok(out.includes('INLINE_DISCIPLINE_MARKER'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy path ref still reads from the memory root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-frag-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'rule.md'), 'PATH_BODY_MARKER 来自文件', 'utf-8')
    const svc = new PromptAssemblyService({ getMemoryRoot: () => root, getScopeMessages: () => [] })
    const out = await injectedText(svc, coordinatorWith([
      { path: 'docs/rule.md', title: '规则', summary: 's' },
    ]))
    assert.ok(out.includes('PATH_BODY_MARKER'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-matching fragment is not injected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-frag-'))
  try {
    const svc = new PromptAssemblyService({ getMemoryRoot: () => root, getScopeMessages: () => [] })
    const out = await injectedText(svc, coordinatorWith(
      [{ path: null, title: 't', summary: 's', text: 'SHOULD_NOT_APPEAR' }],
      () => false,
    ))
    assert.ok(!out.includes('SHOULD_NOT_APPEAR'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inline asset text is counted by the context bill (L2_triggers)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-frag-'))
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((e) => { if (e.metric === 'context_bill') events.push(e) })
  try {
    const svc = new PromptAssemblyService({ getMemoryRoot: () => root, getScopeMessages: () => [] })
    await injectedText(svc, coordinatorWith([
      { path: null, title: '纪律', summary: 's', text: 'BILLED_INLINE_TEXT' },
    ]))
    assert.equal(events.length, 1)
    const sections = events[0].sections as Record<string, number>
    assert.ok((sections.L2_triggers ?? 0) > 0, 'L2_triggers must count the inline fragment text')
  } finally {
    __setMetricSinkForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})
