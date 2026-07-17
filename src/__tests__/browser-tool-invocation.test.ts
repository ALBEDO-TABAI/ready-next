import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'
import { resolveBrowserToolInvocation } from '../main/modules/tools/browser-tool-invocation'

test('every public semantic tool resolves to a private operation', () => {
  for (const name of BROWSER_PUBLIC_TOOL_NAMES) {
    const invocation = resolveBrowserToolInvocation(name, {})
    assert.equal(invocation.ok, true, `${name} should resolve`)
    if (!invocation.ok) continue
    assert.doesNotMatch(invocation.operation, /^browser_/)
  }
})

test('locator and compound tools choose one deterministic private operation', () => {
  assert.deepEqual(resolveBrowserToolInvocation('browser_navigate', { action: 'back' }), {
    ok: true,
    group: 'act',
    operation: 'navigate_back',
    args: { action: 'back' },
  })
  assert.equal(resolveBrowserToolInvocation('browser_click', { target_id: 'ref-1' }).operation, 'click_target')
  assert.equal(resolveBrowserToolInvocation('browser_click', { selector: '#save' }).operation, 'click_selector')
  assert.equal(resolveBrowserToolInvocation('browser_click', { text: '保存' }).operation, 'click_text')
  assert.equal(resolveBrowserToolInvocation('browser_click', { x: 10, y: 20 }).operation, 'click_coordinate')
  assert.equal(resolveBrowserToolInvocation('browser_type', { x: 10, y: 20, text: 'A' }).operation, 'type_coordinate')
  assert.equal(resolveBrowserToolInvocation('browser_collect', { mode: 'notes' }).operation, 'collect_notes')
  assert.equal(resolveBrowserToolInvocation('browser_download', { mode: 'collected' }).operation, 'download_collected')
  assert.equal(resolveBrowserToolInvocation('browser_task', { action: 'cancel' }).operation, 'task_cancel')
})

test('old public names are rejected and model-declared effects are stripped', () => {
  assert.equal(resolveBrowserToolInvocation('browser_read_page', {}).ok, false)
  const invocation = resolveBrowserToolInvocation('browser_eval', {
    code: 'document.title',
    purpose: 'read title',
    expected_effects: ['observe'],
  })
  assert.equal(invocation.ok, true)
  if (!invocation.ok) return
  assert.equal('expected_effects' in invocation.args, false)
})
