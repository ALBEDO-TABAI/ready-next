import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_PUBLIC_TOOL_NAMES,
  BROWSER_TOOL_SURFACE_MANIFEST,
  browserBaseIntentForInstruction,
  browserOnDemandToolNames,
  browserToolNamesForIntent,
} from '../shared/browser-tool-surface'
import {
  BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_NAMES,
  BROWSER_COLLECTION_SUBSET_TOOL_NAMES,
  BROWSER_OBSERVATION_SUBSET_TOOL_NAMES,
} from '../shared/browser-collection-intent'
import { BROWSER_TOOLS } from '../main/modules/tools/browser-tool-catalog'
import { classifyBrowserToolCall } from '../main/modules/browser-engine/browser-tool-write-classification'

const EXPECTED_PUBLIC_NAMES = [
  'browser_tabs',
  'browser_navigate',
  'browser_search',
  'browser_snapshot',
  'browser_find',
  'browser_read',
  'browser_screenshot',
  'browser_wait',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select',
  'browser_hover',
  'browser_scroll',
  'browser_press_key',
  'browser_drag',
  'browser_upload',
  'browser_dialog',
  'browser_request_takeover',
  'browser_collect',
  'browser_download',
  'browser_archive',
  'browser_task',
  'browser_status',
  'browser_console',
  'browser_network',
  'browser_resources',
  'browser_eval',
  'browser_cdp',
  'browser_session',
  'browser_permission',
] as const

const LEGACY_PUBLIC_NAMES = [
  'browser_get_tabs',
  'browser_read_page',
  'browser_read_page_map',
  'browser_probe_readonly',
  'browser_click_text',
  'browser_act_on_target',
  'browser_type_smart',
  'browser_compose_message',
  'browser_capture_viewport',
  'browser_probe_workflow_state',
  'browser_locate_action_targets',
  'browser_locate_input_targets',
  'browser_analyze_viewport',
  'browser_list_upload_targets',
  'browser_upload_scope_attachment',
  'browser_click_at',
  'browser_type_at',
  'browser_scroll_at',
  'browser_send_keys',
  'browser_ask_user_takeover',
  'browser_query_gemini',
  'browser_wait_for_condition',
  'browser_go_back',
  'browser_collect_images',
  'browser_download_urls',
  'browser_download_collected_media',
  'browser_inspect_resources',
  'browser_resolve_video',
  'browser_extract_structured',
  'browser_scroll_collect',
  'browser_start_task',
  'browser_get_task',
  'browser_resume_task',
  'browser_cancel_task',
  'browser_aggregate_results',
  'browser_download_gallery',
  'browser_research_topic',
  'browser_run_workflow',
  'browser_execute_js',
  'browser_power_eval',
  'browser_power_cdp',
  'browser_power_network_trace',
  'browser_power_resource_forensics',
  'browser_power_script_run',
  'browser_media_download_advanced',
  'browser_stage_site_strategy',
  'browser_visible_collect',
  'browser_collect_notes',
  'browser_confirm_collection_consent',
] as const

test('browser catalog has one canonical 31-tool semantic surface', () => {
  assert.deepEqual(BROWSER_PUBLIC_TOOL_NAMES, EXPECTED_PUBLIC_NAMES)
  assert.deepEqual(BROWSER_TOOLS.map((tool) => tool.name), EXPECTED_PUBLIC_NAMES)
  assert.equal(BROWSER_TOOL_SURFACE_MANIFEST.length, EXPECTED_PUBLIC_NAMES.length)
  assert.equal(new Set(BROWSER_PUBLIC_TOOL_NAMES).size, EXPECTED_PUBLIC_NAMES.length)
  for (const name of LEGACY_PUBLIC_NAMES) {
    assert.equal(BROWSER_PUBLIC_TOOL_NAMES.includes(name as never), false, `${name} must not be public`)
  }
})

test('common turn surfaces are derived from manifest metadata and stay narrow', () => {
  assert.deepEqual(BROWSER_OBSERVATION_SUBSET_TOOL_NAMES, browserToolNamesForIntent('observation'))
  assert.deepEqual(BROWSER_COLLECTION_SUBSET_TOOL_NAMES, browserToolNamesForIntent('collection'))
  assert.deepEqual(BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_NAMES, browserToolNamesForIntent('batch_collection'))
  assert.ok(browserToolNamesForIntent('reading').length <= 10)
  assert.ok(browserToolNamesForIntent('interaction').length <= 15)
  assert.ok(browserToolNamesForIntent('advanced').length <= 8)
  assert.deepEqual(browserOnDemandToolNames('在下拉选项选中新加坡'), ['browser_select'])
  assert.deepEqual(browserOnDemandToolNames('悬停查看菜单后把卡片拖动排序'), ['browser_hover', 'browser_drag'])
  assert.deepEqual(browserOnDemandToolNames('处理网页弹窗'), ['browser_dialog'])
  assert.equal(browserBaseIntentForInstruction('打开网页读一下内容'), 'reading')
  assert.equal(browserBaseIntentForInstruction('点击登录并填写表单'), 'interaction')
})

test('every public browser tool has an explicit lease classification', () => {
  for (const tool of BROWSER_TOOL_SURFACE_MANIFEST) {
    assert.equal(classifyBrowserToolCall(tool.name, {}), tool.defaultAccess)
  }
  assert.equal(classifyBrowserToolCall('browser_tabs', { action: 'list' }), 'read')
  assert.equal(classifyBrowserToolCall('browser_tabs', { action: 'open' }), 'write')
  assert.equal(classifyBrowserToolCall('browser_task', { action: 'get' }), 'read')
  assert.equal(classifyBrowserToolCall('browser_task', { action: 'resume' }), 'write')
  assert.equal(classifyBrowserToolCall('browser_dialog', { action: 'get' }), 'read')
  assert.equal(classifyBrowserToolCall('browser_dialog', { action: 'accept' }), 'write')
})
