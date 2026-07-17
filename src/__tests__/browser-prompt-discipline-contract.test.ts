import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_TOOLS } from '../main/modules/tools/browser-tool-catalog'

// 合同随实现同步（Phase C C4/C5，2026-07-05）：DirectChatEngine 退役，其内嵌
// TOOL_SYSTEM_PROMPT 的 observe-probe-act 句子随文件消亡。live 的 observe-probe-act
// 纪律锚点 = browser-tool-catalog.ts 的工具描述（read_page_map 优先 / probe 需
// fresh generation / act 带 target_id 且动作后复查 / 旧动作标 Fallback），交互
// 纪律资产 = assets/prompts/browser/discipline.md（最终 Browser 工具面已确定后注入本轮 instructions）。
test('browser tool catalog keeps snapshot-find-act discipline on the canonical surface', () => {
  const byName = new Map(BROWSER_TOOLS.map((tool) => [tool.name, tool.description]))
  assert.match(byName.get('browser_snapshot') || '', /紧凑可访问结构与稳定目标引用/)
  assert.match(byName.get('browser_find') || '', /页面快照.*查找目标/)
  assert.match(byName.get('browser_click') || '', /目标引用.*动作后返回可核验结果/)
  assert.match(byName.get('browser_type') || '', /快速填充或逐键输入/)
  assert.equal(byName.has('browser_visual_step' as never), false)
})
