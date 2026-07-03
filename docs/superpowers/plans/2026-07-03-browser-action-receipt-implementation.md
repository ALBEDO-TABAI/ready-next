---
title: Browser Action Receipt Implementation (P1 addendum)
date: 2026-07-03
status: implementation
enforce: true
source:
  - docs/superpowers/plans/2026-07-02-agent-core-experience-roadmap.md（P1 §新增一项 E5 动作回执）
  - docs/superpowers/plans/2026-07-01-browser-resource-transaction-reliability-implementation.md（A1 结构化输出同源）
  - src/main/modules/browser-engine/page-state-service.ts（getPageIdentity 现成探针）
  - src/main/modules/tools/browser-tools.ts（browser_click / browser_click_text / browser_type）
---

# 浏览器动作回执（P1 E5，动作后结构化变化摘要）

## Goal

写类浏览器动作（click / click_text / type）执行后，返回一段**确定性的结构化变化回执**，
让模型不必每步都 `browser_read_page` 才知道刚才发生了什么。回执回答第一性问题
"这一步之后页面变了吗、怎么变的"：URL 是否变化、标题、当前焦点元素、是否出现可见
toast/alert/aria-live 提示。这是诊断 §6.2 指出的两大浏览器缺口之一（另一个是成功证据
铸造，已由既有 `detectBrowserPageTransactionConfirmation` 覆盖）。

## Assumptions

1. 回执是**只读**的：一次 read-only 探针，绝不改页面、不触发 P3c 自由脚本面。
2. 复用既有 `getPageIdentity` 式的廉价探针；不引入重量级 DOM dump。
3. 不改既有写动作的成功/失败语义、followedTab 跟随、transaction confirmation 铸造。
4. 回执失败（探针异常/超时）绝不能让写动作本身失败——回执缺失时降级为
   `{ captured: false }`，写动作结果照常返回。
5. 纯整形 `buildBrowserActionReceipt` 与探针 IO 分离，整形逻辑单测覆盖。

## Completion Criteria

**纯整形（单测）：**
1. before/after URL 不同 → `urlChanged: true`，回执带 before/after url。
2. before/after URL 相同 → `urlChanged: false`。
3. after 探针含可见 toast/alert 文本 → `visibleSignal` 携带该文本（截断上限）。
4. 焦点元素变化 → `activeElement` 反映 after 值。
5. after 为空/探针失败 → `{ captured: false }`，不抛。
6. 回执文本有长度上限（不灌大段 DOM）。

**集成（写动作输出）：**
7. `browser_click` / `browser_click_text` / `browser_type` 成功输出的 JSON 带
   `changeReceipt` 字段，含 `captured` + （captured 时）url/urlChanged/activeElement/visibleSignal。
8. 探针抛错时写动作仍返回成功结果，`changeReceipt.captured === false`。
9. 不改 followedTab / confirmation / nextSuggestedAction 既有字段。

**回归：** `npm run verify:browser-reliability`、`npm run typecheck` 不回退。

## 设计

新增 `src/main/modules/browser-engine/browser-action-receipt.ts`：
- `BrowserActionReceiptProbe`（after 探针原始形状：url/title/activeElement/visibleSignal）。
- `BROWSER_ACTION_RECEIPT_PROBE_JS`：只读探针，读 location/title/activeElement +
  扫描 `[role=alert],[aria-live],.toast,.message,.notification` 的可见文本（首条、截断）。
- `buildBrowserActionReceipt({ beforeUrl, after })`（纯）→
  `{ captured, url?, urlChanged?, title?, activeElement?, visibleSignal? }`。
- `captureBrowserActionReceipt(controller, tabId, beforeUrl)`（薄 IO）：跑探针 → 整形；
  任何异常 → `{ captured: false }`。

写动作接线：在 `settleAfterAction` 后、构造输出前，捕获回执并放进输出 JSON 的
`changeReceipt`。beforeUrl 取动作前的 `activeBrowserToolUrl(controller, tabId)`。

## 非目标

- 不做整页 diff / 节点级 diff（只给高价值信号）。
- 不改 Power 工具（它们已有结构化输出 + A1 失败回执）。
- 不替代 `browser_read_page`——回执是"少读一次"的增量，不是完整页面地图。

## Closeout（2026-07-03，工作区未提交）

已交付 `browser-engine/browser-action-receipt.ts`（只读探针 `BROWSER_ACTION_RECEIPT_PROBE_JS`
+ 纯整形 `buildBrowserActionReceipt` + 薄 IO `captureBrowserActionReceipt`），接线
`browser_click` / `browser_click_text` / `browser_type`（`attachBrowserActionSessionOutput`
新增 `changeReceipt` 参数，patch 缺失时也能单独附回执）。7 测试全绿（含探针抛错降级 +
browser_type 集成回执）。已登记 `c4Exempt`（fake controller，永不真开 sqlite）。
`npm run typecheck` 通过；已并入 `verify:browser-reliability`。

后续（非本单）：`browser_type_smart` / 坐标点击 / 上传工作流可按同一 helper 增补回执。
