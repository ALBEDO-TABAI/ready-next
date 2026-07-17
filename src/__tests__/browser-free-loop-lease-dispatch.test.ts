import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import { noteBrowserActionSession } from '../main/modules/browser-engine/browser-action-session'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-free-loop-lease-dispatch declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-free-loop-lease-dispatch transitive sqlite load')
})

function createController(overrides?: Partial<BrowserController>): BrowserController {
  const mock: Partial<BrowserController> = {
    getTabList: () => [{ id: 'tab-1', title: 'T', url: 'https://www.xiaohongshu.com/x', active: true }],
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url: 'https://www.xiaohongshu.com/x', active: true }) as never,
    getPageContent: async () => 'visible feed text',
    goBack: () => ({ success: true }),
    startTask: async () => ({ taskId: 'task-1', kind: 'visible_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } }) as never,
    startNoteCollection: async () => ({ taskId: 'browser-task-note-1', kind: 'note_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } }) as never,
    ...(overrides || {}),
  }
  return mock as BrowserController
}

function ctx(controller: BrowserController, turnLease: BrowserTurnLease | null): ToolContext {
  return {
    browserController: controller,
    browserLease: turnLease,
    allowedToolNames: null,
    sessionId: 's1',
    runId: 'r1',
  }
}

function outputText(out: unknown): string {
  const o = out as { text?: unknown; output?: unknown }
  if (typeof o.text === 'string') return o.text
  if (typeof o.output === 'string') return o.output
  if (typeof out === 'string') return out
  return JSON.stringify(out)
}

function parseError(out: unknown): { errorCode?: string } | null {
  const text = outputText(out)
  try {
    const obj = JSON.parse(text)
    return isAgentBrowserError(obj) ? obj : null
  } catch {
    return null
  }
}

describe('free-loop browser dispatch lease gating (WP2)', () => {
  it('read tools pass without acquiring a lease even under takeover', async () => {
    const service = new BrowserWriteLeaseService()
    // Surface taken over by the user.
    service.acquire({ surface: 'user-view', taskId: 'prev', runId: 'r0' })
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)

    const out = await executeToolCall('browser_read', {}, ctx(createController(), turnLease))
    assert.match(outputText(out), /visible feed text/)
  })

  it('write tools acquire the turn lease and pass when free', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(createController(), turnLease))
    assert.equal(parseError(out), null, 'write with an acquirable lease must pass')
    assert.equal(service.getState('user-view'), 'held')
  })

  it('write tools without a turn surface are refused before browser dispatch', async () => {
    const controller = createController({
      goBack: () => {
        throw new Error('goBack must not dispatch')
      },
    })
    const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, null))
    assert.equal(parseError(out)?.errorCode, 'browser_surface_undeclared')
  })

  it('write tools are blocked with lease_takeover after the user takes over mid-turn', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    // First write acquires the turn lease.
    await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    // User takes over.
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    const err = parseError(out)
    assert.ok(err, `expected structured lease error, got: ${outputText(out)}`)
    assert.equal(err?.errorCode, 'lease_takeover')
  })

  it('browser_collect visible mode hands off the surface (releases the turn lease)', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    // Hold the turn lease via a prior write.
    await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    assert.equal(service.getState('user-view'), 'held')
    // Launching a background collect releases the turn lease so the task can own it.
    await executeToolCall('browser_collect', { mode: 'visible', template: 'card_list' }, ctx(controller, turnLease))
    assert.equal(service.getState('user-view'), 'idle', 'surface handed off to the background task')
  })

  it('browser_collect notes mode hands off instead of being blocked by the turn user-view lease', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const started: Array<Record<string, unknown>> = []
    const controller = createController({
      createSyntheticVisibleCollection: async () => ({
        taskId: 'browser-task-synthetic-lease',
        kind: 'visible_collect',
        status: 'completed',
        progress: { total: 1, completed: 0, failed: 0, currentLabel: null },
      }) as never,
      startCardLoopCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'browser-task-card-1', kind: 'card_loop', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })
    await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    assert.equal(service.getState('user-view'), 'held')

    const out = await executeToolCall('browser_collect', {
      mode: 'notes',
      target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc',
      notes: [{ url: 'https://www.xiaohongshu.com/note/1', title: '笔记一' }],
      output_root_dir: '/tmp/out',
    }, {
      ...ctx(controller, turnLease),
      currentUserText: '请采集 https://www.xiaohongshu.com/note/1',
    })

    assert.equal(parseError(out), null, `collect_notes must not return a lease error: ${outputText(out)}`)
    assert.match(outputText(out), /browser-task-card-1/)
    assert.equal(started.length, 1)
    assert.equal(service.getState('user-view'), 'idle', 'surface handed off before dispatching the agent-view task')
  })

  it('browser_task resume hands off instead of locking the task it resumes', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const resumed: string[] = []
    const controller = createController({
      resumeTask: async (taskId: string) => {
        resumed.push(taskId)
        return { taskId, kind: 'card_loop', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })
    await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    assert.equal(service.getState('user-view'), 'held')

    const out = await executeToolCall('browser_task', { action: 'resume', task_id: 'browser-task-card-1' }, ctx(controller, turnLease))

    assert.equal(parseError(out), null, `resume_task must not return a lease error: ${outputText(out)}`)
    assert.deepEqual(resumed, ['browser-task-card-1'])
    assert.equal(service.getState('user-view'), 'idle', 'surface handed off before resuming the background task')
  })

  it('when visible_collect is the turn FIRST action, a later takeover is NOT stolen back', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    // First action of the turn is the background collect (no prior acquire).
    await executeToolCall('browser_collect', { mode: 'visible', template: 'card_list' }, ctx(controller, turnLease))
    // Background task takes the surface, then the user takes over.
    const bg = service.acquire({ surface: 'user-view', taskId: 'collect', runId: 'rc' })
    assert.ok(!isAgentBrowserError(bg))
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')
    // A later foreground write must NOT clear takeover and steal the surface.
    const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    assert.equal(parseError(out)?.errorCode, 'lease_takeover', 'must not steal a taken-over surface')
    assert.equal(service.getState('user-view'), 'takeover')
  })

  it('after handoff, the background task owns the surface and a foreground write is blocked (single writer)', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    await executeToolCall('browser_collect', { mode: 'visible', template: 'card_list' }, ctx(controller, turnLease))
    // The background task acquires its own lease for the surface.
    const bg = service.acquire({ surface: 'user-view', taskId: 'collect', runId: 'rc' })
    assert.ok(!isAgentBrowserError(bg))
    // A subsequent foreground write in the same turn is now blocked.
    const out = await executeToolCall('browser_navigate', { action: 'back' }, ctx(controller, turnLease))
    assert.equal(parseError(out)?.errorCode, 'lease_held', 'foreground write blocked while the bg task owns the surface')
  })

  it('inherits the browser action session target for omitted Power tab ids', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r-power-target' }, 'user-view', service)
    const sessionId = 's-browser-target-inherit'
    let cdpTabId: string | null = null
    noteBrowserActionSession(sessionId, {
      targetTabId: 'tab-bound',
      currentUrl: 'https://example.com/publish',
      lastAction: 'browser_click',
      nextSuggestedAction: 'read map again',
    })
    const controller = createController({
      getTabList: () => [
        { id: 'tab-active', title: 'Active', url: 'https://example.com/active', active: true },
        { id: 'tab-bound', title: 'Bound', url: 'https://example.com/publish', active: false },
      ] as never,
      getActiveTab: () => ({ id: 'tab-active', title: 'Active', url: 'https://example.com/active', active: true }) as never,
      sendCdpCommand: async (tabId) => {
        cdpTabId = tabId
        return { result: { value: 'ok' } }
      },
      executeJS: async () => ({ title: 'Bound', text: '' }),
    })

    const out = await executeToolCall('browser_cdp', {
      method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true },
      purpose: 'read title',
    }, {
      ...ctx(controller, turnLease),
      sessionId,
      runId: 'r-power-target',
      currentUserText: '用 Power Browser 帮我发小红书，继续检查发布页。',
    })

    assert.equal(parseError(out), null, `power cdp should pass: ${outputText(out)}`)
    assert.equal(cdpTabId, 'tab-bound')
  })

  it('does not inherit the browser action session target outside transaction turns', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r-power-observe' }, 'user-view', service)
    const sessionId = 's-browser-target-observe'
    let cdpTabId: string | null = 'not-called'
    noteBrowserActionSession(sessionId, {
      targetTabId: 'tab-bound',
      currentUrl: 'https://example.com/publish',
      lastAction: 'browser_click',
      nextSuggestedAction: 'read map again',
    })
    const controller = createController({
      getTabList: () => [
        { id: 'tab-active', title: 'Active', url: 'https://example.com/active', active: true },
        { id: 'tab-bound', title: 'Bound', url: 'https://example.com/publish', active: false },
      ] as never,
      getActiveTab: () => ({ id: 'tab-active', title: 'Active', url: 'https://example.com/active', active: true }) as never,
      sendCdpCommand: async (tabId) => {
        cdpTabId = tabId
        return { result: { value: 'ok' } }
      },
      executeJS: async () => ({ title: 'Active', text: '' }),
    })

    const out = await executeToolCall('browser_cdp', {
      method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true },
      purpose: 'read title',
    }, {
      ...ctx(controller, turnLease),
      sessionId,
      runId: 'r-power-observe',
      currentUserText: '用 Power Browser 看一下当前网页标题。',
    })

    assert.equal(parseError(out), null, `power cdp should pass: ${outputText(out)}`)
    assert.equal(cdpTabId, null)
  })
})
