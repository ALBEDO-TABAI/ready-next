/**
 * Browser-interaction derivation equality test (Phase 2.5 PR 9).
 *
 * Locks zodObjectToParamList output against the legacy hand-rolled
 * SkillParamDefinition[] for all 25 browser_interaction tools byte-for-byte.
 *
 * Design note: PR 9 deliberately omits a full 25-tool golden snapshot
 * (inlining the 660+ line LLM-facing payload would be more noise than
 * signal). Instead the combination of this derivation test + the downstream
 * `toSchemaParam`/`normalizeAnthropicToolSchema` pipeline (unchanged since
 * PR 1) + the full-suite regression check covers the byte-equivalence
 * contract.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_INTERACTION_SCHEMAS } from '../main/modules/tools/schemas/browser-interaction-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

const TAB_ID: SkillParamDefinition = {
  name: 'tab_id',
  type: 'string',
  description: '标签页 ID，留空则使用当前活跃标签页',
  required: false,
}

test('browser_navigate', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_navigate), [
    { name: 'url', type: 'string', description: '要导航到的完整 URL (http/https)', required: true },
    { name: 'tab_id', type: 'string', description: '可选：在指定标签页导航（留空使用当前活跃页）', required: false },
  ])
})

test('browser_search', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_search), [
    { name: 'query', type: 'string', description: '搜索关键词', required: true },
    {
      name: 'engine',
      type: 'string',
      description: '搜索引擎：auto/google/duckduckgo/bing/baidu，默认 auto',
      required: false,
      enum: ['auto', 'google', 'duckduckgo', 'bing', 'baidu'],
    },
    { name: 'tab_id', type: 'string', description: '可选：在指定标签页搜索（留空使用当前活跃页）', required: false },
  ])
})

test('browser_get_tabs', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_get_tabs), [])
})

test('browser_read_page', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_read_page), [TAB_ID])
})

test('browser_read_page_map', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_read_page_map), [
    TAB_ID,
    { name: 'max_bytes', type: 'number', description: '页面地图文本最大字节数，默认 32768', required: false },
  ])
})

test('browser_probe_readonly', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_probe_readonly), [
    { name: 'generation', type: 'number', description: 'browser_read_page_map 返回的当前 generation', required: true },
    { name: 'query', type: 'string', description: '只读观察目标的文字描述，不作为脚本执行', required: false },
    {
      name: 'scope',
      type: 'string',
      description: '固定只读观察范围，默认 document',
      required: false,
      enum: ['document', 'visible', 'forms', 'links', 'media', 'frames', 'shadow-dom'],
    },
    { name: 'max_nodes', type: 'number', description: '最多返回节点数，默认 24，最大 80', required: false },
    { name: 'include_hidden', type: 'boolean', description: '是否包含隐藏但已加载的节点摘要，默认 false', required: false },
    TAB_ID,
  ])
})

test('browser_click', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_click), [
    { name: 'selector', type: 'string', description: 'CSS 选择器，例如 "button.submit" 或 "#search-btn"', required: true },
    TAB_ID,
  ])
})

test('browser_click_text', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_click_text), [
    { name: 'text', type: 'string', description: '要点击的可见文本（支持部分匹配）', required: true },
    { name: 'exact', type: 'boolean', description: '是否精确匹配文本，默认 false', required: false },
    TAB_ID,
  ])
})

test('browser_type', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_type), [
    { name: 'selector', type: 'string', description: 'CSS 选择器，定位输入框元素', required: true },
    { name: 'text', type: 'string', description: '要输入的文字', required: true },
    { name: 'clear_first', type: 'boolean', description: '是否先清空输入框（默认 true）', required: false },
    TAB_ID,
  ])
})

test('browser_type_smart', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_type_smart), [
    { name: 'target', type: 'string', description: '输入框目标，如 "搜索框" / "邮箱"', required: true },
    { name: 'text', type: 'string', description: '输入文本', required: true },
    { name: 'submit', type: 'boolean', description: '输入后是否回车提交，默认 false', required: false },
    { name: 'clear_first', type: 'boolean', description: '是否先清空，默认 true', required: false },
    TAB_ID,
  ])
})

test('browser_compose_message', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_compose_message), [
    { name: 'text', type: 'string', description: '要输入的内容', required: true },
    { name: 'target', type: 'string', description: '可选目标描述，如“搜索框”“消息输入框”', required: false },
    { name: 'submit', type: 'boolean', description: '输入后是否自动发送，默认 true', required: false },
    { name: 'clear_first', type: 'boolean', description: '是否先清空输入框，默认 true', required: false },
    TAB_ID,
  ])
})

test('browser_capture_viewport', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_capture_viewport), [
    TAB_ID,
    {
      name: 'mode',
      type: 'string',
      description: '截图模式：viewport/clip/full_page，默认 viewport',
      required: false,
      enum: ['viewport', 'clip', 'full_page'],
    },
    {
      name: 'clip',
      type: 'object',
      description: '可选裁剪区域：{x,y,width,height}（像素）',
      required: false,
    },
  ])
})

test('browser_probe_workflow_state', () => {
  assert.deepEqual(
    zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_probe_workflow_state),
    [
      { name: 'prompt', type: 'string', description: '可选：用于校验 prompt 是否已经写入输入区', required: false },
      { name: 'attachment_name', type: 'string', description: '可选：用于校验页面是否已显示该附件', required: false },
      { name: 'include_candidates', type: 'boolean', description: '是否返回 upload/input/send 候选，默认 true', required: false },
      {
        name: 'vision_action',
        type: 'string',
        description: '可选：当指定动作为 upload/input/send 且 DOM 候选不足时，顺带返回视觉候选',
        required: false,
        enum: ['upload', 'input', 'send'],
      },
      TAB_ID,
    ],
  )
})

test('browser_locate_action_targets', () => {
  assert.deepEqual(
    zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_locate_action_targets),
    [
      {
        name: 'action',
        type: 'string',
        description: '动作类型：upload/send/close/back',
        required: true,
        enum: ['upload', 'send', 'close', 'back'],
      },
      TAB_ID,
    ],
  )
})

test('browser_locate_input_targets', () => {
  assert.deepEqual(
    zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_locate_input_targets),
    [
      { name: 'target', type: 'string', description: '可选目标描述，如“提示词输入框”“消息输入框”', required: false },
      TAB_ID,
    ],
  )
})

test('browser_analyze_viewport', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_analyze_viewport), [
    {
      name: 'action',
      type: 'string',
      description: '动作类型：upload/send/close/back/input',
      required: true,
      enum: ['upload', 'send', 'close', 'back', 'input'],
    },
    TAB_ID,
    {
      name: 'include_dom_candidates',
      type: 'boolean',
      description: '是否附带 DOM 候选作为视觉分析参考，默认 true',
      required: false,
    },
  ])
})

test('browser_list_upload_targets', () => {
  assert.deepEqual(
    zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_list_upload_targets),
    [TAB_ID],
  )
})

test('browser_upload_scope_attachment', () => {
  assert.deepEqual(
    zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_upload_scope_attachment),
    [
      { name: 'attachment_id', type: 'string', description: '当前会话中的附件 ID', required: false },
      { name: 'attachment_name', type: 'string', description: '当前会话中的附件文件名或其片段', required: false },
      { name: 'latest', type: 'boolean', description: '是否优先使用当前会话最新附件，默认 true', required: false },
      { name: 'selector', type: 'string', description: '可选：直接定位 file input 的 CSS 选择器', required: false },
      { name: 'target', type: 'string', description: '可选：上传入口目标描述，如“上传图片”', required: false },
      { name: 'x', type: 'number', description: '可选：归一化横坐标 0-999', required: false },
      { name: 'y', type: 'number', description: '可选：归一化纵坐标 0-999', required: false },
      TAB_ID,
    ],
  )
})

test('browser_click_at', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_click_at), [
    { name: 'x', type: 'number', description: '归一化横坐标 0-999', required: true },
    { name: 'y', type: 'number', description: '归一化纵坐标 0-999', required: true },
    TAB_ID,
  ])
})

test('browser_type_at', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_type_at), [
    { name: 'x', type: 'number', description: '归一化横坐标 0-999', required: true },
    { name: 'y', type: 'number', description: '归一化纵坐标 0-999', required: true },
    { name: 'text', type: 'string', description: '要输入的文本', required: true },
    { name: 'press_enter', type: 'boolean', description: '输入后按 Enter，默认 true', required: false },
    {
      name: 'use_shift_enter_for_newline',
      type: 'boolean',
      description: '多行文本是否使用 Shift+Enter 断行',
      required: false,
    },
    { name: 'clear_before_typing', type: 'boolean', description: '输入前是否清空内容（全选+删除）', required: false },
    TAB_ID,
  ])
})

test('browser_scroll_at', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_scroll_at), [
    { name: 'x', type: 'number', description: '归一化横坐标 0-999，默认 500', required: false },
    { name: 'y', type: 'number', description: '归一化纵坐标 0-999，默认 500', required: false },
    {
      name: 'direction',
      type: 'string',
      description: '滚动方向 up/down/left/right',
      required: true,
      enum: ['up', 'down', 'left', 'right'],
    },
    { name: 'magnitude', type: 'number', description: '滚动幅度，默认 800', required: false },
    TAB_ID,
  ])
})

test('browser_send_keys', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_send_keys), [
    { name: 'key', type: 'string', description: '键名，如 Enter/Escape/Tab/a', required: true },
    {
      name: 'modifiers',
      type: 'array',
      description: '可选组合键数组：ctrl/shift/alt/meta',
      required: false,
      items: { type: 'string' },
    },
    TAB_ID,
  ])
})

test('browser_ask_user_takeover', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_ask_user_takeover), [
    { name: 'call_to_action', type: 'string', description: '给用户的动作提示', required: true },
    { name: 'details', type: 'string', description: '补充说明', required: false },
    { name: 'timeout_sec', type: 'number', description: '等待超时秒数，默认 300', required: false },
  ])
})

test('browser_query_gemini', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_query_gemini), [
    { name: 'text', type: 'string', description: '提问内容', required: true },
    { name: 'tab_id', type: 'string', description: '可选标签页 ID', required: false },
    { name: 'wait_response_ms', type: 'number', description: '等待响应时间，默认 35000ms', required: false },
  ])
})

test('browser_wait', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_wait), [
    { name: 'timeout_ms', type: 'number', description: '超时时间，默认 8000ms', required: false },
    { name: 'selector', type: 'string', description: '可选：等待该 selector 出现', required: false },
    TAB_ID,
  ])
})

test('browser_wait_for_condition', () => {
  assert.deepEqual(
    zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_wait_for_condition),
    [
      {
        name: 'condition',
        type: 'string',
        description: '等待条件：page_readable/selector/network_idle/content_stable/custom_js',
        required: true,
        enum: ['page_readable', 'selector', 'network_idle', 'content_stable', 'custom_js'],
      },
      { name: 'selector', type: 'string', description: 'condition=selector 时使用', required: false },
      { name: 'custom_js', type: 'string', description: 'condition=custom_js 时返回 truthy 视为满足', required: false },
      { name: 'timeout_ms', type: 'number', description: '超时时间，默认 8000ms', required: false },
      { name: 'check_interval_ms', type: 'number', description: '轮询间隔，默认 250ms', required: false },
      { name: 'stable_iterations', type: 'number', description: 'network_idle/content_stable 需要连续稳定次数', required: false },
      TAB_ID,
    ],
  )
})

test('browser_go_back', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_INTERACTION_SCHEMAS.browser_go_back), [TAB_ID])
})
