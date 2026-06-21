import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-script-m1-net declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-script-m1-net transitive sqlite load')
})

function controllerOn(url = 'https://example.com/page', overrides?: Partial<BrowserController>): BrowserController {
  const mock: Partial<BrowserController> = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Example', url, active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'Example', url, active: true }] as never,
    executeJS: async () => 'template-result',
    waitForCondition: async () => ({ matched: true, elapsedMs: 12, value: true }),
    extractStructured: async () => ({ template: 'article_list', items: [], sourceUrl: url }),
    extractStructuredFromUrl: async () => ({ template: 'article_list', items: [], sourceUrl: url }),
    scrollCollect: async () => ({ template: 'card_list', items: [], sourceUrl: url, scrolls: 1, reachedEnd: true }),
    startTask: async () => ({ taskId: 'task-1', kind: 'scroll_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } }) as never,
    ...(overrides || {}),
  }
  return mock as BrowserController
}

function outputData(out: string | ToolExecutionOutput): Record<string, unknown> | null {
  if (typeof out !== 'string') return (out.data || null) as Record<string, unknown> | null
  try {
    const parsed = JSON.parse(out)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

test('ordinary-site browser_execute_js rejects freeform code before controller execution', async () => {
  let executed = false
  const controller = controllerOn('https://example.com/article', {
    executeJS: async () => {
      executed = true
      return 'should-not-run'
    },
  })

  const out = await executeBrowserTool('browser_execute_js', {
    code: 'document.querySelector("button").click()',
  }, controller)

  assert.equal(outputData(out)?.errorKind, 'freeform_script_denied')
  assert.equal(executed, false)
})

test('ordinary-site browser_execute_js allows named read-only template', async () => {
  let script = ''
  const controller = controllerOn('https://example.com/article', {
    executeJS: async (_tabId, code) => {
      script = code
      return 'Heading'
    },
  })

  const out = await executeBrowserTool('browser_execute_js', {
    template: 'read_text',
    selector: 'h1',
  }, controller)

  assert.equal(out, 'Heading')
  assert.match(script, /__READY_READONLY_SCRIPT_TEMPLATE__/)
  assert.match(script, /read_text/)
  assert.doesNotMatch(script, /button"\)\.click/)
})

test('ordinary-site wait_for_condition rejects freeform custom_js', async () => {
  let waited = false
  const controller = controllerOn('https://example.com/article', {
    waitForCondition: async () => {
      waited = true
      return { matched: true, elapsedMs: 1 }
    },
  })

  const out = await executeBrowserTool('browser_wait_for_condition', {
    condition: 'custom_js',
    custom_js: 'fetch("/track"); true',
  }, controller)

  assert.equal(outputData(out)?.errorKind, 'freeform_script_denied')
  assert.equal(waited, false)
})

test('ordinary-site wait_for_condition allows named read-only predicate template', async () => {
  let customJs = ''
  const controller = controllerOn('https://example.com/article', {
    waitForCondition: async (_tabId, options) => {
      customJs = String(options.customJs || '')
      return { matched: true, elapsedMs: 3, value: 2 }
    },
  })

  const out = await executeBrowserTool('browser_wait_for_condition', {
    condition: 'custom_js',
    script_template: 'count_selector',
    selector: '.item',
  }, controller)

  assert.match(String(out), /"matched": true/)
  assert.match(customJs, /__READY_READONLY_SCRIPT_TEMPLATE__/)
  assert.match(customJs, /count_selector/)
})

test('ordinary-site extract_structured rejects custom_script but keeps template path working', async () => {
  let extracted = false
  const controller = controllerOn('https://example.com/article', {
    extractStructured: async () => {
      extracted = true
      return { template: 'article_list', items: [], sourceUrl: 'https://example.com/article' }
    },
  })

  const blocked = await executeBrowserTool('browser_extract_structured', {
    template: 'article_list',
    custom_script: 'localStorage.setItem("x", "1"); return []',
  }, controller)
  assert.equal(outputData(blocked)?.errorKind, 'freeform_script_denied')
  assert.equal(extracted, false)

  const allowed = await executeBrowserTool('browser_extract_structured', {
    template: 'article_list',
  }, controller)
  assert.equal(outputData(allowed)?.template, 'article_list')
  assert.equal(extracted, true)
})

test('ordinary-site scroll_collect rejects freeform custom_script', async () => {
  let collected = false
  const controller = controllerOn('https://example.com/list', {
    scrollCollect: async () => {
      collected = true
      return { template: 'card_list', items: [], sourceUrl: 'https://example.com/list', scrolls: 1, reachedEnd: true }
    },
  })

  const out = await executeBrowserTool('browser_scroll_collect', {
    template: 'card_list',
    custom_script: 'document.body.innerHTML = ""',
  }, controller)

  assert.equal(outputData(out)?.errorKind, 'freeform_script_denied')
  assert.equal(collected, false)
})

test('ordinary-site run_workflow rejects execute_js freeform step', async () => {
  let executed = false
  const controller = controllerOn('https://example.com/page', {
    executeJS: async () => {
      executed = true
      return 'should-not-run'
    },
  })

  const out = await executeBrowserTool('browser_run_workflow', {
    steps: [{ action: 'execute_js', code: 'window.open("https://example.com")' }],
  }, controller)

  assert.equal(outputData(out)?.errorKind, 'freeform_script_denied')
  assert.equal(executed, false)
})

test('ordinary-site start_task rejects wrapped freeform script payload', async () => {
  let started = false
  const controller = controllerOn('https://example.com/page', {
    startTask: async () => {
      started = true
      return { taskId: 'task-1', kind: 'scroll_collect', status: 'queued', progress: { total: 0, completed: 0, failed: 0, currentLabel: null } } as never
    },
  })

  const out = await executeBrowserTool('browser_start_task', {
    kind: 'scroll_collect',
    payload: {
      url: 'https://example.com/page',
      customScript: 'return document.body.innerHTML',
    },
  }, controller)

  assert.equal(outputData(out)?.errorKind, 'freeform_script_denied')
  assert.equal(started, false)
})
