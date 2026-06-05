import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

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

    const out = await executeToolCall('browser_read_page', {}, ctx(createController(), turnLease))
    assert.match(outputText(out), /visible feed text/)
  })

  it('write tools acquire the turn lease and pass when free', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const out = await executeToolCall('browser_go_back', {}, ctx(createController(), turnLease))
    assert.equal(parseError(out), null, 'write with an acquirable lease must pass')
    assert.equal(service.getState('user-view'), 'held')
  })

  it('write tools are blocked with lease_takeover after the user takes over mid-turn', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    // First write acquires the turn lease.
    await executeToolCall('browser_go_back', {}, ctx(controller, turnLease))
    // User takes over.
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    const out = await executeToolCall('browser_go_back', {}, ctx(controller, turnLease))
    const err = parseError(out)
    assert.ok(err, `expected structured lease error, got: ${outputText(out)}`)
    assert.equal(err?.errorCode, 'lease_takeover')
  })

  it('browser_visible_collect hands off the surface (releases the turn lease)', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    // Hold the turn lease via a prior write.
    await executeToolCall('browser_go_back', {}, ctx(controller, turnLease))
    assert.equal(service.getState('user-view'), 'held')
    // Launching a background collect releases the turn lease so the task can own it.
    await executeToolCall('browser_visible_collect', { template: 'card_list' }, ctx(controller, turnLease))
    assert.equal(service.getState('user-view'), 'idle', 'surface handed off to the background task')
  })

  it('browser_collect_notes hands off instead of being blocked by the turn user-view lease', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const started: Array<Record<string, unknown>> = []
    const controller = createController({
      startNoteCollection: async (plan: Record<string, unknown>) => {
        started.push(plan)
        return { taskId: 'browser-task-note-1', kind: 'note_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
      },
    })
    await executeToolCall('browser_go_back', {}, ctx(controller, turnLease))
    assert.equal(service.getState('user-view'), 'held')

    const out = await executeToolCall('browser_collect_notes', {
      target_profile_url: 'https://www.xiaohongshu.com/user/profile/abc',
      notes: [{ url: 'https://www.xiaohongshu.com/note/1', title: '笔记一' }],
      output_root_dir: '/tmp/out',
    }, ctx(controller, turnLease))

    assert.equal(parseError(out), null, `collect_notes must not return a lease error: ${outputText(out)}`)
    assert.match(outputText(out), /browser-task-note-1/)
    assert.equal(started.length, 1)
    assert.equal(service.getState('user-view'), 'idle', 'surface handed off before dispatching the agent-view task')
  })

  it('when visible_collect is the turn FIRST action, a later takeover is NOT stolen back', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    // First action of the turn is the background collect (no prior acquire).
    await executeToolCall('browser_visible_collect', { template: 'card_list' }, ctx(controller, turnLease))
    // Background task takes the surface, then the user takes over.
    const bg = service.acquire({ surface: 'user-view', taskId: 'collect', runId: 'rc' })
    assert.ok(!isAgentBrowserError(bg))
    service.recordUserSignal({ surface: 'user-view', source: 'keyboard' })
    assert.equal(service.getState('user-view'), 'takeover')
    // A later foreground write must NOT clear takeover and steal the surface.
    const out = await executeToolCall('browser_go_back', {}, ctx(controller, turnLease))
    assert.equal(parseError(out)?.errorCode, 'lease_takeover', 'must not steal a taken-over surface')
    assert.equal(service.getState('user-view'), 'takeover')
  })

  it('after handoff, the background task owns the surface and a foreground write is blocked (single writer)', async () => {
    const service = new BrowserWriteLeaseService()
    const turnLease = new BrowserTurnLease({ taskId: 't', runId: 'r1' }, 'user-view', service)
    const controller = createController()
    await executeToolCall('browser_go_back', {}, ctx(controller, turnLease))
    await executeToolCall('browser_visible_collect', { template: 'card_list' }, ctx(controller, turnLease))
    // The background task acquires its own lease for the surface.
    const bg = service.acquire({ surface: 'user-view', taskId: 'collect', runId: 'rc' })
    assert.ok(!isAgentBrowserError(bg))
    // A subsequent foreground write in the same turn is now blocked.
    const out = await executeToolCall('browser_go_back', {}, ctx(controller, turnLease))
    assert.equal(parseError(out)?.errorCode, 'lease_held', 'foreground write blocked while the bg task owns the surface')
  })
})
