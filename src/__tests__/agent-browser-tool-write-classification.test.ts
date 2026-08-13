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

  it('derives page mutation ownership from the canonical operation', () => {
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['browser_navigate', { action: 'open', url: 'https://example.test' }],
      ['browser_click', { target_id: '1:0:1' }],
      ['browser_type', { target_id: '1:0:1', text: 'query' }],
      ['browser_scroll', { direction: 'down' }],
      ['browser_upload', { target_id: '1:0:1', paths: ['/tmp/example.txt'] }],
      ['browser_collect', { mode: 'visible' }],
      ['browser_download', { mode: 'urls', urls: ['https://example.test/file'] }],
    ]
    for (const [name, args] of mutations) {
      assert.equal(classifyBrowserToolCall(name, args), 'write', `${name} should be write`)
    }
  })

  it('treats pure observation as reads and rejects the retired takeover tool', () => {
    for (const name of ['browser_read', 'browser_snapshot', 'browser_tabs', 'browser_screenshot', 'browser_status']) {
      assert.equal(classifyBrowserToolCall(name), 'read', `${name} should be read`)
    }
    assert.equal(classifyBrowserToolCall('browser_task', { action: 'get' }), 'read')
    assert.throws(() => classifyBrowserToolCall('browser_request_takeover'), /browser_operation_not_registered/)
  })

  it('keeps browser_resources observational, including response-body forensics', () => {
    assert.equal(classifyBrowserToolCall('browser_resources', {}), 'read')
    assert.equal(classifyBrowserToolCall('browser_resources', { tab_id: 'tab-1' }), 'read')
    assert.equal(classifyBrowserToolCall('browser_resources', { include_response_bodies: true }), 'read')
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

  it('fails closed: an unknown tool has no inferred ownership mode', () => {
    assert.throws(
      () => classifyBrowserToolCall('browser_some_new_mutator', {}),
      /browser_operation_not_registered/,
    )
    assert.equal(isClassifiedBrowserTool('browser_some_new_mutator'), false)
  })

  it('does not keep browser_visual_step as an unregistered ghost tool', () => {
    assert.equal(isClassifiedBrowserTool('browser_visual_step'), false)
    assert.throws(
      () => classifyBrowserToolCall('browser_visual_step'),
      /browser_operation_not_registered/,
    )
  })
})
