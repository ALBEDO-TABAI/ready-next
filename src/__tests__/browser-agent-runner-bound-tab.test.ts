import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentBrowserSurface } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { BrowserAgentRunner } from '../main/modules/tools/browser-agent-runner'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type RunnerProbe = {
  boundTabId: string | null
  boundSurface: AgentBrowserSurface | null
  prepareToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> | null
  probeDomState(): Promise<{ bodyStateText: string }>
  probePromptSubmissionState(expectedPrompt: string): Promise<{ submitEvidence: string[] }>
  probeUploadState(attachmentName?: string): Promise<{ evidence: string[] }>
}

function createRunnerProbe(tabIds: string[], onExecuteJS?: () => void): RunnerProbe {
  const controller = {
    getTabList: () => tabIds.map((id) => ({
      id,
      url: `https://example.com/${id}`,
      title: id,
      domain: 'example.com',
      favicon: null,
      owner: 'agent',
      required: false,
      activity: 'idle',
      lastAuditedAt: null,
      active: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    })),
    getActiveTab: () => ({
      id: 'active-user-tab',
      url: 'https://example.com/active',
      title: 'active',
    }),
    executeJS: async () => {
      onExecuteJS?.()
      return null
    },
  } as unknown as BrowserController
  return new BrowserAgentRunner(controller) as unknown as RunnerProbe
}

describe('BrowserAgentRunner bound tab target resolution', () => {
  it('declares transitive sqlite ABI coverage', (t) => {
    skipIfSqliteUnavailable(t, 'browser-agent-runner-bound-tab transitive sqlite load')
  })

  it('injects the bound tab when it still exists', () => {
    const runner = createRunnerProbe(['agent-tab'])
    runner.boundSurface = 'agent-view'
    runner.boundTabId = 'agent-tab'

    assert.deepEqual(runner.prepareToolArgs('browser_click', {}), { tab_id: 'agent-tab' })
  })

  it('does not fall back to the active user tab when a bound tab is gone', () => {
    const runner = createRunnerProbe([])
    runner.boundSurface = 'agent-view'
    runner.boundTabId = 'agent-tab'

    assert.equal(runner.prepareToolArgs('browser_click', {}), null)
  })

  it('does not allow a bound user-view workflow to run without its captured tab', () => {
    const runner = createRunnerProbe([])
    runner.boundSurface = 'user-view'
    runner.boundTabId = null

    assert.equal(runner.prepareToolArgs('browser_type', {}), null)
  })

  it('does not run internal DOM probes on the active user tab when the bound tab is gone', async () => {
    let executeCalls = 0
    const runner = createRunnerProbe([], () => {
      executeCalls += 1
    })
    runner.boundSurface = 'agent-view'
    runner.boundTabId = 'missing-agent-tab'

    assert.equal((await runner.probeDomState()).bodyStateText, 'bound_tab_unavailable')
    assert.deepEqual((await runner.probePromptSubmissionState('hello')).submitEvidence, ['bound_tab_unavailable'])
    assert.deepEqual((await runner.probeUploadState('image.png')).evidence, ['bound_tab_unavailable'])
    assert.equal(executeCalls, 0)
  })
})
