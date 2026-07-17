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
    for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_scroll', 'browser_upload', 'browser_collect', 'browser_download']) {
      assert.equal(classifyBrowserToolCall(name), 'write', `${name} should be write`)
    }
  })

  it('treats pure observation as reads (free of the lease)', () => {
    for (const name of ['browser_read', 'browser_snapshot', 'browser_tabs', 'browser_screenshot', 'browser_status']) {
      assert.equal(classifyBrowserToolCall(name), 'read', `${name} should be read`)
    }
    assert.equal(classifyBrowserToolCall('browser_task', { action: 'get' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_task', { action: 'resume' }), 'write')
  })

  it('classifies browser_resources by THIS call: url present => write, absent => read', () => {
    assert.equal(classifyBrowserToolCall('browser_resources', {}), 'read')
    assert.equal(classifyBrowserToolCall('browser_resources', { tab_id: 'tab-1' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_resources', { url: 'https://example.com' }), 'write')
  })

  it('treats browser_collect as always write (it scrolls the page)', () => {
    assert.equal(classifyBrowserToolCall('browser_collect', {}), 'write')
  })

  it('treats browser_eval as always write (read-only-ness is undecidable)', () => {
    assert.equal(classifyBrowserToolCall('browser_eval', { code: 'document.title' }), 'write')
  })

  it('keeps browser_wait read-only and ignores removed custom script claims', () => {
    assert.equal(classifyBrowserToolCall('browser_wait', { condition: 'ready' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_wait', { condition: 'selector', selector: '.x' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_wait', { custom_js: 'document.title' }), 'read')
  })

  it('fails closed: an unknown tool defaults to write', () => {
    assert.equal(classifyBrowserToolCall('browser_some_new_mutator', {}), 'write')
    assert.equal(isClassifiedBrowserTool('browser_some_new_mutator'), false)
  })

  it('does not keep browser_visual_step as an unregistered ghost tool', () => {
    assert.equal(isClassifiedBrowserTool('browser_visual_step'), false)
    assert.equal(classifyBrowserToolCall('browser_visual_step'), 'write')
  })
})
