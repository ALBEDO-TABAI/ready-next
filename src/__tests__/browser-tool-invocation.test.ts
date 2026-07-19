import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'
import { resolveBrowserToolInvocation } from '../main/modules/tools/browser-tool-invocation'
import { parseBrowserResearchPublicRequest } from '../main/modules/tools/browser-action-contracts'

test('every public semantic tool resolves to a private operation', () => {
  const fixtures: Partial<Record<(typeof BROWSER_PUBLIC_TOOL_NAMES)[number], Record<string, unknown>>> = {
    browser_navigate: { action: 'open', url: 'https://example.com/fixture' },
    browser_search: { query: 'fixture' },
    browser_type: { text: 'fixture' },
    browser_fill_form: { fields: [] },
    browser_press_key: { key: 'Enter' },
    browser_request_takeover: { reason: 'verification required' },
    browser_upload: { target_id: 'upload-target', attachment_id: 'attachment-1' },
    browser_research: { action: 'start', work_items: [{ requirement: 'fixture' }] },
    browser_download: { mode: 'page', url: 'https://example.com/fixture' },
    browser_archive: { format: 'pdf', path: '/tmp/fixture.pdf' },
    browser_task: { task_id: 'browser-task-fixture' },
    browser_eval: { code: 'document.title', purpose: 'read title' },
    browser_cdp: { method: 'Runtime.evaluate', purpose: 'read title' },
    browser_permission: { action: 'status', site_request_id: 'site-request-fixture' },
  }
  for (const name of BROWSER_PUBLIC_TOOL_NAMES) {
    const invocation = resolveBrowserToolInvocation(name, fixtures[name] || {}, 'model')
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
  assert.equal(resolveBrowserToolInvocation('browser_collect', { mode: 'structured' }).operation, 'collect_structured')
  assert.equal(resolveBrowserToolInvocation('browser_download', { mode: 'page', url: 'https://example.com' }).operation, 'download_advanced')
  assert.equal(resolveBrowserToolInvocation('browser_task', { action: 'result', task_id: 'task-1' }).operation, 'task_result')
})

test('long-task contracts reject calls that the handler cannot execute', () => {
  assert.equal(resolveBrowserToolInvocation('browser_research', { scope: 'current_site' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_collect', { mode: 'research' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_collect', { mode: 'start' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_download', { mode: 'urls', urls: [] }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_download', { mode: 'collected' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_download', { mode: 'page' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_download', { mode: 'media' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_download', { mode: 'resolve' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_task', { action: 'result' }, 'model').ok, false)
})

test('research accepts open work items and binds only explicit evidence receipts', () => {
  const started = parseBrowserResearchPublicRequest({
    action: 'start',
    work_items: [{ work_item_id: 'item-1', requirement: 'compare the observed options' }],
  })
  assert.equal(started.ok, true)
  assert.equal(started.ok && started.value.workItems[0]?.requirement, 'compare the observed options')
  assert.equal(parseBrowserResearchPublicRequest({ action: 'evidence' }).ok, false)
  const evidence = parseBrowserResearchPublicRequest({
    action: 'evidence',
    evidence_bindings: [{ work_item_id: 'item-1', observation_receipt_id: 'observation-1' }],
  })
  assert.equal(evidence.ok, true)
  assert.equal(evidence.ok && evidence.value.evidenceBindings[0]?.observationReceiptId, 'observation-1')
})

test('compound action contracts reject calls before their handlers run', () => {
  assert.equal(resolveBrowserToolInvocation('browser_navigate', {}, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_tabs', { action: 'switch' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_wait', { condition: 'selector' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_wait', { condition: 'text', text: 'ready' }, 'model').ok, true)
  assert.equal(resolveBrowserToolInvocation('browser_upload', { target_id: 'upload-target' }, 'model').ok, false)
  assert.equal(resolveBrowserToolInvocation('browser_upload', {
    target_id: 'upload-target', attachment_ids: ['attachment-1', 'attachment-2'],
  }, 'model').ok, true)
  assert.equal(
    resolveBrowserToolInvocation('browser_type', { target_id: 'search', text: 'query', submit: true }, 'model').ok,
    false,
    'text entry and submission must remain separate public actions',
  )
})

test('old public names are rejected and model-declared effects are stripped', () => {
  assert.equal(resolveBrowserToolInvocation('browser_read_page', {}).ok, false)
  const invocation = resolveBrowserToolInvocation('browser_eval', {
    code: 'document.title',
    purpose: 'read title',
    expected_effects: ['observe'],
  }, 'model')
  assert.equal(invocation.ok, true)
  if (!invocation.ok) return
  assert.equal('expected_effects' in invocation.args, false)
})

test('trusted internal calls keep control flags while model calls cannot inject them', () => {
  const trusted = resolveBrowserToolInvocation('browser_download', {
    mode: 'urls',
    urls: ['https://example.com/a'],
    unrelated_to_collection: true,
  })
  assert.equal(trusted.ok, true)
  if (trusted.ok) assert.equal(trusted.args.unrelated_to_collection, true)

  const model = resolveBrowserToolInvocation('browser_collect', {
    mode: 'scroll',
    custom_script: 'document.cookie',
    strategy: 'url_batch',
  }, 'model')
  assert.equal(model.ok, true)
  if (model.ok) assert.equal('custom_script' in model.args, false)
  if (model.ok) assert.equal('strategy' in model.args, false)
})
