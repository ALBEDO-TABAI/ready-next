import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { AgentSystemStudioSnapshot } from '../shared/agent-system-studio'

function snapshot(status: 'staged' | 'applied' = 'staged'): AgentSystemStudioSnapshot {
  return {
    generatedAt: '2026-08-12T00:00:00.000Z',
    agents: [{
      id: 'writer', name: '写作旧档案', charter: '旧资料', status: 'retired', kind: 'specialist',
      parentAgentId: 'butler', derivationReason: null, mergedIntoAgentId: null,
      createdAt: '2026-06-19T00:00:00.000Z',
      rules: { relPath: 'agents/writer/RULES.md', exists: true, preview: '旧规则', content: '旧规则', contentHash: 'rules' },
      foundation: { relPath: 'agents/writer/FOUNDATION.md', exists: true, preview: '旧基础', content: '旧基础', contentHash: 'foundation' },
      knowledgeCards: [],
      contentSummary: { knowledgeCards: 0, stagedContentEdits: status === 'staged' ? 1 : 0 },
      contentEditProposals: [{
        proposalId: 'proposal-1', agentId: 'writer', targetKind: 'knowledge_card',
        targetRelPath: 'agents/writer/knowledge/new.md', baseHash: 'base', baseContent: '',
        proposedContent: '新资料', status,
        provenance: { source: 'task_evolution', sessionId: null, note: '来自明确文件提案' },
        createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
        appliedAt: status === 'applied' ? '2026-08-12T00:01:00.000Z' : null,
      }],
    }],
  }
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost', pretendToBeVisual: true,
  })
  const prior = new Map<string, unknown>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(key, (globalThis as Record<string, unknown>)[key])
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return { dom, restore: () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
      else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    }
    dom.window.close()
  } }
}

test('historical Studio renders honest archive copy and preserves explicit file proposal confirmation', async () => {
  const handle = installDom()
  try {
    let current = snapshot()
    const confirmed: string[] = []
    const rejected: string[] = []
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => ({ success: true, data: current }),
        confirmSystemStudioContentEdit: async (proposalId: string) => {
          confirmed.push(proposalId); current = snapshot('applied'); return { success: true }
        },
        rejectSystemStudioContentEdit: async (proposalId: string) => {
          rejected.push(proposalId); return { success: true }
        },
      },
    }
    const { default: AgentSystemStudioView } = await import('../renderer/components/agent-system/studio/AgentSystemStudioView')
    const host = handle.dom.window.document.getElementById('root')
    assert.ok(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<AgentSystemStudioView />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const initial = host.textContent || ''
    assert.match(initial, /专项资料审计/)
    assert.match(initial, /不会改变当前 Codex/)
    assert.match(initial, /不会自动创建或分配 Agent/)
    assert.match(initial, /待确认文件修改/)
    assert.doesNotMatch(initial, /路由试算|确认创建|生成蓝图|可转办/)

    const confirm = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('确认写入'))
    assert.ok(confirm)
    await act(async () => {
      confirm.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(confirmed, ['proposal-1'])
    assert.deepEqual(rejected, [])
    assert.doesNotMatch(host.textContent || '', /待确认文件修改/)
    await act(async () => root.unmount())
  } finally {
    handle.restore()
  }
})
