import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-high-control-guard declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-high-control-guard transitive sqlite load')
})

function controllerOn(url: string, overrides?: Partial<BrowserController>): BrowserController {
  const mock: Partial<BrowserController> = {
    getActiveTab: () => ({ id: 'tab-1', title: 'T', url, active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'T', url, active: true }],
    getPageContent: async () => 'visible text',
    executeJS: async () => 'js-ran',
    extractStructured: async () => ({ template: 'card_list', items: [], sourceUrl: url }),
    scrollCollect: async () => ({ template: 'card_list', items: [], sourceUrl: url, scrolls: 0, reachedEnd: true }),
    ...(overrides || {}),
  }
  return mock as BrowserController
}

function parseError(out: string | { data?: unknown }): { errorCode?: string } | null {
  if (typeof out !== 'string') {
    return isAgentBrowserError(out.data) ? out.data : null
  }
  try {
    const o = JSON.parse(out)
    return isAgentBrowserError(o) ? o : null
  } catch {
    return null
  }
}

const XHS = 'https://www.xiaohongshu.com/user/profile/abc'
const GENERIC = 'https://example.com/page'

describe('high-control platform script blacklist (WP3)', () => {
  it('blocks browser_execute_js on 小红书 with script_blocked', async () => {
    const out = await executeBrowserTool('browser_execute_js', { code: 'document.title' }, controllerOn(XHS))
    assert.equal(parseError(out)?.errorCode, 'script_blocked')
  })

  it('blocks browser_run_workflow on 小红书', async () => {
    const out = await executeBrowserTool('browser_run_workflow', { steps: [] }, controllerOn(XHS))
    assert.equal(parseError(out)?.errorCode, 'script_blocked')
  })

  it('blocks extract_structured custom_script on 小红书 but allows the template path', async () => {
    const blocked = await executeBrowserTool('browser_extract_structured', { template: 'card_list', custom_script: 'return 1' }, controllerOn(XHS))
    assert.equal(parseError(blocked)?.errorCode, 'script_blocked')

    const allowed = await executeBrowserTool('browser_extract_structured', { template: 'card_list' }, controllerOn(XHS))
    assert.equal(parseError(allowed), null, 'template-path extract must be allowed on high-control platforms')
  })

  it('blocks wait_for_condition custom_js on 小红书', async () => {
    const out = await executeBrowserTool('browser_wait_for_condition', { condition: 'custom_js', custom_js: 'return true' }, controllerOn(XHS))
    assert.equal(parseError(out)?.errorCode, 'script_blocked')
  })

  it('allows visible/read collection on 小红书 (read_page)', async () => {
    const out = await executeBrowserTool('browser_read_page', {}, controllerOn(XHS))
    assert.equal(parseError(out), null)
    assert.match(out, /visible text/)
  })

  it('generic sites reject execute_js freeform code but allow named read-only templates', async () => {
    const blocked = await executeBrowserTool('browser_execute_js', { code: 'document.title' }, controllerOn(GENERIC))
    assert.equal(parseError(blocked)?.errorCode, 'freeform_script_denied', 'P3c blocks ordinary-site freeform scripts')

    const allowed = await executeBrowserTool('browser_execute_js', { template: 'read_meta', name: 'title' }, controllerOn(GENERIC))
    assert.equal(parseError(allowed)?.errorCode, undefined, 'named read-only template must not hit the high-control guard')
    assert.match(allowed, /js-ran/)
  })

  it('blocks a high-control TARGET url even when the active tab is a generic page (no bypass)', async () => {
    // active tab is benign, but the tool targets 小红书 via args.url + custom_script
    const out = await executeBrowserTool(
      'browser_extract_structured',
      { template: 'card_list', url: 'https://www.xiaohongshu.com/explore', custom_script: 'return document.body.innerHTML' },
      controllerOn(GENERIC),
    )
    assert.equal(parseError(out)?.errorCode, 'script_blocked', 'target-url high-control must not be bypassable')
  })

  it('blocks run_workflow whose steps target a high-control platform from a generic active tab', async () => {
    const out = await executeBrowserTool(
      'browser_run_workflow',
      { steps: [{ action: 'navigate', url: 'https://www.douyin.com/user/x' }] },
      controllerOn(GENERIC),
    )
    assert.equal(parseError(out)?.errorCode, 'script_blocked')
  })

  it('blocks execute_js when tab_id points to a high-control page even though the active tab is generic', async () => {
    const controller = {
      getActiveTab: () => ({ id: 'tab-generic', title: 'G', url: GENERIC, active: true }),
      getTabList: () => [
        { id: 'tab-generic', title: 'G', url: GENERIC, active: true },
        { id: 'tab-xhs', title: 'XHS', url: 'https://www.xiaohongshu.com/explore', active: false },
      ],
      executeJS: async () => 'js-ran',
    } as unknown as BrowserController
    const out = await executeBrowserTool('browser_execute_js', { code: 'x', tab_id: 'tab-xhs' }, controller)
    assert.equal(parseError(out)?.errorCode, 'script_blocked', 'tab_id-targeted high-control page must not bypass the guard')
  })

  it('blocks browser_start_task whose payload wraps a script targeting a high-control platform (Codex R3)', async () => {
    let started = false
    const controller = {
      getActiveTab: () => ({ id: 'tab-1', title: 'G', url: GENERIC, active: true }),
      getTabList: () => [{ id: 'tab-1', title: 'G', url: GENERIC, active: true }],
      startTask: async () => { started = true; return { taskId: 't', kind: 'scroll_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } },
    } as unknown as BrowserController

    const out = await executeBrowserTool(
      'browser_start_task',
      { kind: 'scroll_collect', payload: { url: 'https://www.xiaohongshu.com/explore', customScript: 'return document.body.innerHTML' } },
      controller,
    )
    assert.equal(parseError(out)?.errorCode, 'script_blocked', 'start_task script wrapper must be blocked on high-control platforms')
    assert.equal(started, false, 'the task must NOT be queued')
  })

  it('blocks browser_start_task with payload.wait.customJs on a high-control platform', async () => {
    const controller = {
      getActiveTab: () => ({ id: 'tab-1', title: 'G', url: GENERIC, active: true }),
      getTabList: () => [{ id: 'tab-1', title: 'G', url: GENERIC, active: true }],
      startTask: async () => ({ taskId: 't', kind: 'scroll_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } }),
    } as unknown as BrowserController
    const out = await executeBrowserTool(
      'browser_start_task',
      { kind: 'scroll_collect', payload: { url: 'https://www.douyin.com/x', wait: { condition: 'custom_js', customJs: 'return true' } } },
      controller,
    )
    assert.equal(parseError(out)?.errorCode, 'script_blocked')
  })

  it('allows browser_start_task template scroll_collect (no script) on a high-control platform', async () => {
    let started = false
    const controller = {
      getActiveTab: () => ({ id: 'tab-1', title: 'G', url: GENERIC, active: true }),
      getTabList: () => [{ id: 'tab-1', title: 'G', url: GENERIC, active: true }],
      startTask: async () => { started = true; return { taskId: 't', kind: 'scroll_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } },
    } as unknown as BrowserController
    const out = await executeBrowserTool(
      'browser_start_task',
      { kind: 'scroll_collect', payload: { url: 'https://www.xiaohongshu.com/explore', template: 'card_list' } },
      controller,
    )
    assert.equal(parseError(out), null, 'template-path task must be allowed')
    assert.equal(started, true)
  })

  it('flags visible_collect as highControl when tab_id targets a high-control page (rate limits apply)', async () => {
    let payload: Record<string, unknown> | undefined
    const controller = {
      getActiveTab: () => ({ id: 'tab-generic', title: 'G', url: GENERIC, active: true }),
      getTabList: () => [
        { id: 'tab-generic', title: 'G', url: GENERIC, active: true },
        { id: 'tab-xhs', title: 'XHS', url: 'https://www.xiaohongshu.com/explore', active: false },
      ],
      startTask: async (req: { payload: Record<string, unknown> }) => {
        payload = req.payload
        return { taskId: 'task-1', kind: 'visible_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } }
      },
    } as unknown as BrowserController
    await executeBrowserTool('browser_visible_collect', { template: 'card_list', tab_id: 'tab-xhs' }, controller)
    assert.equal(payload?.highControl, true, 'tab_id-targeted high-control collect must get conservative limits')
  })
})
