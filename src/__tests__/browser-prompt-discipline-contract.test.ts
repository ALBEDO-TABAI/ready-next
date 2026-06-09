import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '..')

test('browser system prompt keeps observe-probe-act discipline and demotes legacy actions', () => {
  const source = readFileSync(join(root, 'main/modules/claude-bridge/direct-chat.ts'), 'utf8')

  assert.match(source, /默认先用 browser_read_page_map 获取页面地图/)
  assert.match(source, /browser_probe_readonly 做必要的只读结构探针/)
  assert.match(source, /browser_act_on_target 对 fresh target_id 执行动作/)
  assert.match(source, /动作后必须读取页面证据复查/)
  assert.match(source, /browser_click\/browser_click_text\/browser_type\/browser_type_smart\/browser_click_at\/browser_type_at\/browser_send_keys\/browser_compose_message 只作为 fallback/)
  assert.doesNotMatch(source, /browser_visual_step/)
})
