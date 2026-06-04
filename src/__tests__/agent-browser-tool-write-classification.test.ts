import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  classifyBrowserToolCall,
  isClassifiedBrowserTool,
} from '../main/modules/browser-engine/browser-tool-write-classification'
import {
  BROWSER_INTERACTION_TOOL_NAMES,
  BROWSER_CONTENT_TASK_TOOL_NAMES,
} from '../main/modules/tools/browser-tool-catalog'

describe('browser tool write classification', () => {
  it('classifies every registered browser tool (no silent drift from the catalog)', () => {
    const all = [...BROWSER_INTERACTION_TOOL_NAMES, ...BROWSER_CONTENT_TASK_TOOL_NAMES]
    for (const name of all) {
      assert.equal(
        isClassifiedBrowserTool(name),
        true,
        `tool ${name} is missing from the write-classification table`,
      )
    }
  })

  it('treats obvious page mutations as writes', () => {
    for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_click_at', 'browser_scroll_at', 'browser_upload_scope_attachment', 'browser_go_back']) {
      assert.equal(classifyBrowserToolCall(name), 'write', `${name} should be write`)
    }
  })

  it('treats pure observation as reads (free of the lease)', () => {
    for (const name of ['browser_read_page', 'browser_get_tabs', 'browser_capture_viewport', 'browser_probe_workflow_state', 'browser_get_task', 'browser_aggregate_results']) {
      assert.equal(classifyBrowserToolCall(name), 'read', `${name} should be read`)
    }
  })

  it('classifies browser_extract_structured by THIS call: url present => write, absent => read', () => {
    assert.equal(classifyBrowserToolCall('browser_extract_structured', {}), 'read')
    assert.equal(classifyBrowserToolCall('browser_extract_structured', { template: 'card_list' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_extract_structured', { url: 'https://example.com' }), 'write')
  })

  it('treats browser_scroll_collect as always write (it scrolls the page)', () => {
    assert.equal(classifyBrowserToolCall('browser_scroll_collect', {}), 'write')
  })

  it('treats browser_execute_js as always write (read-only-ness is undecidable)', () => {
    assert.equal(classifyBrowserToolCall('browser_execute_js', { code: 'document.title' }), 'write')
  })

  it('classifies browser_wait_for_condition by call: custom_js runs page JS => write, else read', () => {
    assert.equal(classifyBrowserToolCall('browser_wait_for_condition', { condition: 'page_readable' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_wait_for_condition', { condition: 'selector', selector: '.x' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_wait_for_condition', { condition: 'custom_js', custom_js: 'return true' }), 'write')
    assert.equal(classifyBrowserToolCall('browser_wait_for_condition', { custom_js: 'document.title' }), 'write')
  })

  it('fails closed: an unknown tool defaults to write', () => {
    assert.equal(classifyBrowserToolCall('browser_some_new_mutator', {}), 'write')
    assert.equal(isClassifiedBrowserTool('browser_some_new_mutator'), false)
  })
})
