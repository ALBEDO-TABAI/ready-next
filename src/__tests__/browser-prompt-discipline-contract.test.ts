import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '..')

// 合同随实现同步（Phase C C4/C5，2026-07-05）：DirectChatEngine 退役，其内嵌
// TOOL_SYSTEM_PROMPT 的 observe-probe-act 句子随文件消亡。live 的 observe-probe-act
// 纪律锚点 = browser-tool-catalog.ts 的工具描述（read_page_map 优先 / probe 需
// fresh generation / act 带 target_id 且动作后复查 / 旧动作标 Fallback），交互
// 纪律资产 = assets/prompts/browser/discipline.md（最终 Browser 工具面已确定后注入本轮 instructions）。
test('browser tool catalog keeps observe-probe-act discipline and demotes legacy actions', () => {
  const source = readFileSync(join(root, 'main/modules/tools/browser-tool-catalog.ts'), 'utf8')

  // observe：页面地图是浏览操作的第一入口。
  assert.match(source, /name: 'browser_read_page_map',\s+description: '读取当前页面的结构化页面地图[^']*浏览操作前优先调用/)
  // probe：只读探针必须携带 fresh generation。
  assert.match(source, /name: 'browser_probe_readonly',\s+description: '[^']*必须先读取 page map 并携带 fresh generation/)
  // act：动作必须带 target_id + fresh generation，动作后复查证据。
  assert.match(source, /name: 'browser_act_on_target',\s+description: '[^']*必须携带 target_id 和 fresh generation[^']*并在动作后复查/)
  // 旧选择器/文本动作降级为 Fallback，默认引导回 read_page_map + act_on_target。
  for (const legacy of [
    'browser_click',
    'browser_click_text',
    'browser_type',
    'browser_type_smart',
    'browser_compose_message',
  ]) {
    assert.match(
      source,
      new RegExp(`name: '${legacy}',\\s+description: 'Fallback：`),
      `${legacy} must stay demoted to Fallback in the live tool catalog`,
    )
  }
  // 已退役的 browser_visual_step 不得在工具目录复活。
  assert.doesNotMatch(source, /browser_visual_step/)
})
