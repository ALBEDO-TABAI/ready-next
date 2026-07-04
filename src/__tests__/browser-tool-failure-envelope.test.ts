import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { __setBrowserCollectionConsentStoreForTests } from '../main/modules/tools/browser-collection-tools'
import { createBrowserStructuredOutput } from '../main/modules/tools/browser-failure-output'
import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-tool-failure-envelope declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-tool-failure-envelope transitive sqlite load')
})

function makeController(overrides: Partial<BrowserController> = {}): BrowserController {
  return {
    getActiveTab: () => ({ id: 'tab-1', title: 'Example', url: 'https://example.com/', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com/', active: true }] as never,
    executeJS: async () => null,
    getPageContent: async () => '',
    getTask: async () => null,
    getTaskPayload: () => null,
    startTask: async () => ({ taskId: 'task-1', status: 'queued' }) as never,
    startNoteCollection: async () => ({ ok: true, taskId: 'note-1' }) as never,
    ...overrides,
  } as BrowserController
}

function writeContext(controller: BrowserController): ToolContext {
  const service = new BrowserWriteLeaseService()
  return writeContextWithLease(controller, service)
}

function writeContextWithLease(controller: BrowserController, service: BrowserWriteLeaseService): ToolContext {
  return {
    invoker: 'host',
    browserController: controller,
    browserLease: new BrowserTurnLease({ taskId: 'task-test', runId: 'run-test' }, 'user-view', service),
    allowedToolNames: null,
    sessionId: 'browser-failure-envelope-test',
    runId: 'run-test',
  } as ToolContext
}

function noLeaseContext(controller: BrowserController): ToolContext {
  return {
    invoker: 'host',
    browserController: controller,
    allowedToolNames: null,
    sessionId: 'browser-failure-envelope-test',
    runId: 'run-test',
  } as ToolContext
}

test('high-control script refusal returns structured browser failure data and envelope', async () => {
  const output = await executeToolCall(
    'browser_execute_js',
    { code: 'document.body.click()' },
    writeContext(makeController({
      getActiveTab: () => ({ id: 'tab-xhs', title: 'XHS', url: 'https://www.xiaohongshu.com/explore/1', active: true }) as never,
      getTabList: () => [{ id: 'tab-xhs', title: 'XHS', url: 'https://www.xiaohongshu.com/explore/1', active: true }] as never,
      executeJS: async () => {
        throw new Error('executeJS must not run for high-control script refusal')
      },
    })),
  )

  assert.equal(output.data?.errorKind, 'script_blocked')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'denied_by_policy')
})

test('browser structured output keeps errorKind as a bounded token', () => {
  const output = createBrowserStructuredOutput({
    ok: false,
    reason: '附件文件不存在: /Users/example/private.png',
  })

  assert.equal(output.data?.errorKind, 'browser_tool_failed')
  assert.equal(output.data?.reason, '附件文件不存在: /Users/example/private.png')
})

test('browser write without surface binding returns structured browser failure data', async () => {
  const output = await executeToolCall(
    'browser_click',
    { selector: '#submit' },
    noLeaseContext(makeController()),
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'browser_surface_undeclared')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('browser write with held lease returns structured browser failure data', async () => {
  const service = new BrowserWriteLeaseService()
  service.acquire({ surface: 'user-view', taskId: 'other-task', runId: 'other-run' })
  const output = await executeToolCall(
    'browser_click',
    { selector: '#submit' },
    writeContextWithLease(makeController(), service),
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'lease_held')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('legacy browser Error string returns are structured at dispatcher exit', async () => {
  const output = await executeToolCall(
    'browser_go_back',
    {},
    writeContext(makeController({
      goBack: () => ({ success: false, error: 'cannot go back' }),
    })),
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'browser_tool_failed')
  assert.equal(output.data?.message, 'cannot go back')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('wrong browser task id results are structured failures', async () => {
  const output = await executeToolCall(
    'browser_get_task',
    { task_id: 'task-not-a-browser-task' },
    writeContext(makeController({
      getTask: async () => null,
    })),
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'wrong_browser_task_id_type')
  assert.equal(output.data?.status, 'wrong_id_type')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('browser_act_on_target action failure returns an error envelope, not ok text', async () => {
  const controller = makeController({
    executeJS: async (_tabId: string | null, script: string) => {
      if (script.includes('__READY_AGENT_PAGE_MAP__')) {
        return {
          viewport: { width: 800, height: 600 },
          rawRoots: [
            { role: 'button', name: 'Open', backendDOMNodeId: 42, frameId: '0' },
            { role: 'button', name: 'Filler A', backendDOMNodeId: 91, frameId: '0' },
            { role: 'button', name: 'Filler B', backendDOMNodeId: 92, frameId: '0' },
            { role: 'button', name: 'Filler C', backendDOMNodeId: 93, frameId: '0' },
            { role: 'button', name: 'Filler D', backendDOMNodeId: 94, frameId: '0' },
          ],
        }
      }
      if (script.includes('__READY_AGENT_TARGET_PROBE__')) {
        return {
          matchCount: 1,
          disabled: false,
          target: { role: 'button', name: 'Open', value: 'Open', states: {} },
        }
      }
      if (script.includes('__READY_AGENT_ACT_ON_TARGET__')) {
        return { ok: false, errorCode: 'selector_click_failed' }
      }
      return null
    },
  })
  const context = writeContext(controller)
  await executeToolCall('browser_read_page_map', {}, context)

  const output = await executeToolCall(
    'browser_act_on_target',
    { target_id: '1:0:42', action: 'click', read_back: 'none' },
    context,
  )

  assert.equal(output.data?.ok, false)
  assert.equal(output.data?.errorKind, 'selector_click_failed')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

test('browser_collect_notes source handoff mismatch returns structured envelope', async () => {
  __setBrowserCollectionConsentStoreForTests({
    hasConsent: () => false,
  } as never)
  try {
    const output = await executeToolCall(
      'browser_collect_notes',
      {
        source_task_id: 'source-task-1',
        target_profile_url: 'https://example.com/profile',
        output_root_dir: '/tmp/other-output-root',
      },
      writeContext(makeController({
        getTask: async () => ({
          taskId: 'source-task-1',
          kind: 'visible_collect',
          status: 'completed',
          progress: { total: 1, completed: 1, failed: 0, currentLabel: null },
          result: {
            discoveryStatus: 'complete',
            noteCandidates: [{ url: 'https://example.com/a', title: 'A' }],
          },
        }) as never,
        getTaskPayload: () => ({
          scopeId: 'browser-failure-envelope-test',
          outputRootDir: '/tmp/original-output-root',
        }),
      })),
    )

    assert.equal(output.data?.ok, false)
    assert.equal(output.data?.errorKind, 'stale_source_task_output')
    assert.equal(output.envelope?.ok, false)
    assert.equal(output.envelope?.kind, 'internal_error')
  } finally {
    __setBrowserCollectionConsentStoreForTests(null)
  }
})
