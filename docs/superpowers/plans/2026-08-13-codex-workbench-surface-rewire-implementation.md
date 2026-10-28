---
title: Codex 工作面重接线实施计划
date: 2026-08-13
reviewed_at: 2026-08-14
status: implemented
enforce: true
depends_on:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-08-13-codex-capability-relight-index.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-08-11-ready-codex-matrix-wiring-closure-implementation.md
  - docs/architecture/current-runtime-contracts.md
note: >
  目标是让现行 Codex 主链真正推动文档、RSS、日程、Widget、Tag Forge 和地图，
  不复活 DomainAdapter / turn-engine。文件涌现保持独立产品调度。
---

> 2026-09-06 文档核对：本文保留当前仍使用的专项合同及原验收记录；后文的日期、阶段状态和现场缺口按原记录理解，不据此推导今天全部已验收或仍未实现。当前应用边界以 [运行时合同](../../architecture/current-runtime-contracts.md) 为准，近期状态见 [PROGRESS](../../../PROGRESS.md)。

# Codex 工作面重接线

## 目标

在不增加第二套模型循环的前提下，把 Ready 各工作面接到现行 Codex 主链：模型能看见当前表面，工具调用会真实改变或读取产品状态，权限由本轮冻结工具面、结构化资源和精确动作身份共同决定。

## 审核结论与已修正问题

本计划经生产调用链复核后可以实施，但原稿有以下错误或缺口，现已在后续工单中修正：

1. 产品动作不能按 `document.*` / `rss.*` 这类前缀授权；必须按“当前执行工具 → 唯一允许动作”固定映射，否则同域工具可越权调用兄弟写动作。
2. 不能只在分派前检查 run。Renderer 动作可能在超时或停止后迟到落地，必须有产品效果级身份、幂等回执和提交前复核；未知结果不得盲重试。
3. `rss_select_item` 会改变 UI 选择，不是只读工具；RSS 工作面无关键词地板只能自动加入 `rss_capture_session`。
4. RSS handler 当前依赖 RSS 页面挂载，跨工作面执行会强制切换可见模式；刷新摘要还可能读取刷新前的 Renderer 闭包。无导航意图的 RSS 动作必须后台执行，并从 Main 刷新结果或刷新后读回生成摘要。
5. `widget_target` 已存在于旧 RequestEnvelope 文本解析；真正缺口是 `SendScopedResourceSelection` 与 Codex 结构化 ingress 不接收它。不得再造第二种 Widget 资源合同。
6. Tag Forge 写回会调用 `tagForge.checkRevision` / `tagForge.applyContent`，原 W0 漏掉这两个产品动作；通用桥若只支持文档/RSS/日程，反而会让 Tag Forge 从“无桥可选降级”变成“有桥必失败”。
7. `resolveMapPlaceAmbiguityIfNeeded = () => false` 位于旧 SDK 支撑链，不是 Codex 生产执行点。地图歧义必须沿 Codex 正常下一轮调用 `ask_user_questions`，不得重接旧 helper。
8. 当前文档、external read slice、显式资源和技能策略不能再用互斥三元分支择一应用；它们必须在同一冻结快照上组合。Tag Forge 的五件套是组合后的唯一明确排他例外。
9. “Renderer 只传稳定 ID”只适用于有内容的资源。日历可见窗口的 start/end 是可信工作面结构事实，可以由 Renderer 传入，但 Main 必须校验格式、顺序和最大跨度；事件正文仍由 Main 按 ID/范围读取。
10. Widget 目标与实时信息不是二选一：目标决定写回哪张卡，用户明确要求最新天气、股价等外部事实时，网页查询工具与文档更新工具必须并存。

## 机器合同

1. Codex tool context 每次工具执行都提供 `requestModuleToolAction`，闭包绑定 exact `readyRunId + scope + messageVisibilityEpoch + native thread/turn/call + readyActionId + executingToolName`，不再以“是否有当前文档”决定桥是否存在。
2. 产品动作只接受固定“执行工具 → action”映射。action 未登记、与执行工具不匹配、工具不在冻结 allow-set、身份漂移或 run 已终态时，必须在产品效果发生前失败关闭。
3. Main 是产品动作准入与回执权威。每个可能改状态的动作在提交前重读 exact run/epoch/action claim；回执绑定工具、规范化参数摘要和动作身份。相同身份只回放既有结果，不重复执行；超时但无法证明未执行时标记 unknown，不自动重试。
4. 当前文档策略只限制 document 域：默认只开放 `document_read_section`；用户本轮明确要求修改后才加入固定文档写工具。该策略不得删除 RSS、日程、地图、研究或已授权技能能力。
5. 显式本地文件/目录只增加对应只读资源能力，并移除没有 typed authority 的 file 写/整理工具；不能剥掉已选技能的地板。Tag Forge 排他面按 W5 单独处理。
6. 新增 Codex 结构化资源 `rss_item`、`rss_source`、`calendar_window`，并把既有 `widget_target` 接入结构化 ingress。内容型资源由 Renderer 传稳定 ID、Main 读真值；窗口范围只传结构事实并由 Main 严格校验。
7. `workbenchMode=rss|calendar` 是可信表面事实。无关键词时，RSS 只加入 `rss_capture_session`；Calendar 加入 `calendar_capture_session` / `calendar_list_window`。写动作和 RSS 选择/分析不能仅因工作面打开而进入地板。
8. Tag Forge 最终工具面严格等于五件套，目录权限只来自本轮 typed folder；写回同步动作只允许由 `tag_forge_apply_batch` 调用。
9. Widget 目标只决定文档写回对象，不屏蔽明确的实时外部事实需求；工具面允许“网页读取 + 同一 Widget 更新”组合。
10. 文件涌现不注册模型工具。Agent 只能通过现有文件检索读取已经进入索引的文件事实，不能读取或改写涌现项目快照、反馈、代次和调度状态。
11. 远程入站继续只落消息/资源，不自动 `sendScoped`。只有用户后续发起真实输入才能创建 Codex run。
12. `DomainAdapter.shouldHandle/prepare/dispatch`、`DocumentTaskPipelineExecutor`、`AgentSdkRuntime`、`turn-engine` 和 `direct-chat` 均不得进入 Codex 生产 composition。

## 完成标准

- 在 RSS 工作面说“刷新订阅并总结未读”，只执行一次现有 Main `fetchAll`，复用 `RSSUpdateLock`；返回刷新后读回的条目数、源错误和未读事实，不返回“已排队”，也不从旧 Renderer 闭包猜数量。
- 从文档或日程等其他工作面刷新 RSS 时不强制切走当前页面；只有明确要求“选中/打开某条 RSS”才允许导航到 RSS。
- 在日程工作面说“列出这周安排并加一个明天下午的会”，读取真实窗口，创建动作经过既有确认，写入后按事件 ID 从数据库读回；旧 run 的确认或迟到回调不能创建事件。
- 当前文档可见时请求 RSS/日程/研究，`document_read_section` 与目标域工具同时存在；只有明确文档修改意图才出现文档写工具。
- `@[文件夹]` + 显式 Tag Forge，或 typed folder + 受控“文件夹打标”别名，最终工具面严格为五件套，不含通用文件写、shell、artifact 或反问工具；打开中的干净文档同步更新，dirty 文档失败关闭并回滚。
- 明确选择一张 Widget 后，结构化目标绑定发送时的 tab/version/incarnation；更新只能命中同一 widgetId。仅仅打开含 Widget 的文档不会自动创建目标。
- 指定 Widget 的样式调整不误触发网页查询；指定 Widget 且明确要求“最新天气/股价”等事实时，先取得网页证据再更新同一 Widget。
- 地图地点歧义在 Codex 同一任务的下一模型轮调用 `ask_user_questions`，用户选择后只重试一次绑定候选坐标的 `map_plan_route`；不调用旧 SDK helper。
- 文件涌现页面继续独立工作，Codex 注册表和 allow-set 都不存在 `file_emergence_*`。
- 飞书/远程图片或文件入站仍只形成资源，不自动创建 run。

## 禁止事项

- 复活 `turn-engine`、`direct-chat`、`AgentSdkRuntime` 主链或旧地图歧义 helper。
- 只按 action 前缀授权产品桥，或让 requester 在不知道 `executingToolName` 时自行猜调用者。
- 为 RSS/日历再写“系统执行器：本轮走 X 路径”假用户消息。
- 用文本正则单独授予文件、Tag Forge、文档或日程写权限。
- 把 Renderer 的当前正文、RSS 条目正文、日程事件正文或 widgetCode 当成权威上传给 Main。
- 把 timeout 当作“肯定没执行”后自动重试，或把 `ok:false` 包装成成功完成。
- 把文件涌现做成模型可写/可调度工具。
- inbound 远程消息自动启动 Codex run。
- 为了让工具能跑而放开 `environments`、本机 shell 或通用文件写。

## 模块接线矩阵（开工基线）

| 模块 | 产品自身 | Agent 现状 | 本计划处置 |
| --- | --- | --- | --- |
| 文档 | 可用 | 当前文档 live，但 composition 会整面替换 | 改为 document 域内最小收窄；保留其他域 |
| Widget | 渲染合同活 | Renderer 有附件，Codex structured ingress 拒绝 | 接入既有 `widget_target` 合同并绑定 exact anchor |
| RSS | 刷新/入库可用 | 组靠关键词；无桥会假排队；handler 依赖页面 | typed 当前源/条目 + 后台产品桥 + 刷新后读回 |
| 日程 | 可用 | `@event` 只读 live；写操作无通用桥 | 窗口地板 + 产品桥 + 既有确认 + DB readback |
| 文件涌现 | 可用 | 无 Agent 工具 | 保持独立产品调度，只加负例 |
| Tag Forge | 执行器活 | folder 收窄会剥工具；同步动作未纳入桥 | 五件套排他 + typed folder + 受控同步动作 |
| 文件管理 | 可用 | 无资源时写/整理面可能过宽 | 无 typed authority 时只保留已解析只读面 |
| 地图 | Main 规划可用 | present 无通用桥；歧义旧 helper 不属于 Codex | 正常 Codex 循环反问；present 走固定映射 |
| 远程 IM | 入站可用 | 故意不自动跑 Agent | 保持并复用现有负例 |
| Browser / 技能 | 已按域 11/9 收口 | live | 不回退 |

## 工单

### W0 · exact 产品动作桥与效果回执

缺口：`requestModuleToolAction` 只在有 `currentDocumentAnchor` 时挂载；当前 requester 只允许文档动作。RSS/日程会退回“已排队”，Tag Forge 打开文档同步和地图/文件呈现也拿不到稳定通道。现有 Codex tool bridge 只证明工具调用身份，不能单独证明 Renderer 迟到动作没有越过停止/新 run。

改动：

- `buildToolContext` 显式把 `executingToolName` 交给 `createCodexProductActionRequester`；requester 不从 action 前缀或参数推断调用者。
- 产品效果账优先扩展现有 `CodexToolActionJournal` / bridge receipt，不新建平行账本；`actionOrdinal` 由代码按一次工具调用内的稳定调用顺序签发，模型和 Renderer 都不能自报。
- 固定映射至少覆盖：

| 执行工具 | 唯一允许 action |
| --- | --- |
| `document_read_section` | `document.readSection` |
| `document_list_widgets` | `document.listWidgets` |
| `document_insert_widget` | `document.insertWidget` |
| `document_update_widget` | `document.updateWidget` |
| `document_remove_widget` | `document.removeWidget` |
| `document_replace_exact` | `document.replaceExact` |
| `document_save_tab` | `document.saveTab` |
| `rss_add_source` | `rss.addSource` |
| `rss_fetch_updates` | `rss.fetchUpdates` |
| `rss_select_item` | `rss.selectItem` |
| `rss_analyze_item` | `rss.analyzeItem` |
| `rss_capture_session` | `rss.captureSession` |
| `calendar_list_window` | `calendar.listWindow` |
| `calendar_create_event` | `calendar.createEvent` |
| `calendar_update_event` | `calendar.updateEvent` |
| `calendar_delete_event` | `calendar.deleteEvent` |
| `calendar_capture_session` | `calendar.captureSession` |
| `tag_forge_apply_batch` | `tagForge.checkRevision`、`tagForge.applyContent`（含同一批次回滚） |
| `map_plan_route`、`present_file`、`web_clip_url` | `renderer:present-file` |

- 文档 exact read receipt、tab 绑定、写前同 run 精确读取保持现有实现，不另建第二套。
- Main 在效果提交点校验 action claim；Renderer 只执行 Main 已签发且仍有效的 claim。calendar/RSS 的 Main 数据写不能只靠 Renderer 收到消息时的旧 run 状态。
- 产品效果回执至少绑定 `readyRunId/scope/epoch/thread/turn/call/readyAction/tool/action/actionOrdinal/argsDigest`，状态能区分 `claimed/completed/rejected/unknown`。同一工具需要呈现多个产物或同步多个文件时由稳定 ordinal 区分；重复 exact identity 回放完成结果，不同 identity 永不复用。
- 停止、超时、Renderer 重载与新 run 竞态：能在提交前取消则不落效果；已开始且结果不明时返回 unknown 并要求 readback，禁止自动重复写。
- RSS 手动刷新继续复用 Main 单实例 `fetchAll + RSSUpdateLock`；日程写继续走统一行动确认；不复制业务状态机到 requester。
- Codex 生产 context 缺 requester 时直接返回结构化失败，不得退回 `emitToolAction` 或“已排队”；handler 的 `ok:false/errorKind` 必须保留为失败结果，不能生成成功效果回执。

测试：

- 无当前文档执行 `rss_fetch_updates`：产品动作 1 次，返回刷新后结构结果，不出现“已排队”。
- action 与 executing tool 不匹配、工具不在 allow-set、旧 epoch/旧 run：产品 handler 执行 0 次。
- 同 action identity 重投只回放；timeout 后结果 unknown 时不会自动创建第二份日程或重复添加订阅。
- 停止发生在 handler 提交前：产品状态不变；提交后才收到停止：回执仍准确归属旧 run，不能覆盖新 run。
- `tag_forge_apply_batch` 可调用两种 Tag Forge 同步 action，其他 file 工具不能调用。

验证：`npx tsx --test src/__tests__/codex-product-action-bridge.test.ts && npm run typecheck`

### W1 · 同一冻结快照上的组合与最小收窄

缺口：`buildCurrentDocumentReadToolSnapshot` 把 allow-set 换成文档列表；`buildExplicitResourceReadToolSnapshot` 会过滤所有未列入资源名单的 file 域工具；current document 与 external read slice 目前还通过互斥分支择一应用。

改动：

- 组合顺序固定为：共享解析结果 → capability floors → current document 域内收窄 → external/explicit resource 约束与只读地板 → 产品工作面只读地板 → 最终排他策略。
- 同步修改 capability floor 定义：`current_document_context` 的无条件地板只有 `document_read_section`；明确写意图产生独立的条件地板。不得先恢复全部文档写工具、再靠后续过滤移除地板来制造合同自相矛盾。
- 当前文档存在时，从已有 allow-set 仅移除未授权的 document 写工具；始终并入 `document_read_section`。明确写意图才并入固定 Widget/replace/save 工具。
  - 2026-10-06 起写工具不再看措辞：激活即开放（用户明确只读除外），保存走 M3 确认，见 [当前文档写面](2026-10-06-current-document-write-surface-implementation.md)。
- explicit resource 只移除没有 typed authority 的 file 写/整理工具，并入该资源对应的只读工具；不得删除其他域和选中技能地板。
- current document、external read slice 和 explicit resources 同时存在时全部组合，不再使用互斥三元分支让后者失效。
- 无 typed file/folder authority 时，`file_rename/file_move/file_copy/file_organize_*` 与 `tag_forge_*` 不出现；已解析的 `file_search/file_locate/file_read_excerpt` 只按原意图保留，不因普通闲聊常开。
- Tag Forge 五件套在 W5 作为最后的 `exclusive` 策略替换结果；这是唯一不是并集的明确例外。

测试：

- 文档可见 + “看看订阅源”：含 `document_read_section` 与目标 RSS 工具，无文档写工具。
- 文档可见 + external read slice：两边地板都存在，且没有额外写权限。
- explicit local file/folder + 非 Tag Forge 技能：资源只读工具与技能地板都在。
- 无资源普通闲聊：无文件写/整理/Tag Forge。
- 结构测试只锁组合顺序；主要断言必须从真实 `resolveReadyToolTurnSnapshot + Codex production composition` 观察最终工具定义和 dispatch allow-set 一致。

验证：`npx tsx --test src/__tests__/codex-tool-surface-union.test.ts src/__tests__/codex-product-resource-envelope.test.ts && npm run typecheck`

### W2 · RSS typed surface 与后台执行

缺口：`SendScopedResourceSelection` 没有 RSS kind；`workbenchMode=rss` 只有环境标签；RSS action handler 懒挂载，跨工作面会切页面；刷新摘要可能读取刷新前的 `deps.items`。

改动：

- 增加 `rss_item { itemId }` / `rss_source { sourceId }` 到 shared type、Zod IPC schema、Codex explicit resource resolver 和 RequestEnvelope kind/source。
- RSS 工作面发送消息时自动附带当前选中 source/item 的稳定 ID；RSS item 拖入 Agent composer 使用同一 typed resource。禁止按标题或附件正文重建身份。
- Main 按 ID 读取 `rss_items/rss_sources` 真值，向本轮输入提供受预算限制的标题、来源、链接和摘要；版本摘要进入 resource refs，Renderer 快照不作为正文真值。
- `workbenchMode=rss` 无关键词只并入 `rss_capture_session`。`rss_fetch_updates`、`rss_select_item`、`rss_analyze_item`、`rss_add_source` 都要求本轮对应明确意图。
- 明确 item target 时，select/analyze 省略 itemId 可注入唯一 target；模型给出不同 itemId 必须拒绝，不能回退到当前 UI 选择。
- 非导航 RSS 动作的 handler 注册与可见 RSS 页面解耦，不切换工作面。只有 `rss_select_item` 的明确导航动作可以激活 RSS。
- `rss.fetchUpdates` 从 Main `fetchAll` 返回值或刷新后数据库 readback 生成摘要，保留部分源错误；不得使用刷新前 Renderer 数组长度。
- `rss_add_source` 加入统一 M2 已知写操作确认表；无明确添加意图时不开放。`rss_analyze_item` 沿用既有任务/成本边界，不因工作面地板自动触发。

测试：

- RSS 工作面无关键词：只有 RSS capture 地板，不含 select/add/analyze。
- 文档工作面执行 RSS refresh：可见 mode 不变，Main 刷新一次，结果为刷新后 readback。
- `@item`/拖入 item 后分析：始终绑定同一 itemId；冲突参数失败关闭。
- 普通 Browser 闲聊不打开 RSS 组。
- `rss_add_source` 未确认执行 0 次；确认后写入并按 source ID 读回。

验证：`npx tsx --test src/__tests__/codex-rss-surface.test.ts src/__tests__/action-confirmation-policy.test.ts && npm run typecheck`

### W3 · 日程窗口、事件目标与写回

缺口：`calendar_event` 已能按 ID 读事件，但当前日历窗口、写动作桥和目标绑定未闭环。

改动：

- 增加 `calendar_window { start, end, calendarId? }`。start/end 来自当前可见工作面，Main 校验合法 ISO、`start < end`、跨度不超过 366 天和可选 calendarId；不上传全部事件正文。
- Calendar 工作面发送消息时附带当前窗口；已有选中事件继续用 `calendar_event { eventId }`，Main 按 ID 读事件真值。
- `workbenchMode=calendar` 地板含 `calendar_capture_session` / `calendar_list_window`，不自动加入 create/update/delete。
- list 用 typed window 提供默认范围，但用户明确查询其他日期时允许使用新范围；所有返回都来自现有日历 API/数据库。
- update/delete 绑定一个明确 event target 时，缺失 id 可注入该 ID；不同 id 拒绝。无 typed target 时，只能使用同一 run 的 `calendar_list_window` / `calendar_capture_session` 精确读取回执中唯一匹配的 eventId；0 个或多个匹配都必须反问，不能只按标题猜测，也不能拿 UI 最近选择兜底。
- create/update/delete 走 W0 和现有确认表；创建/更新后按返回 ID 读回，删除后确认查无。不得把 Ready 本地日历写默认转成 lark-cli。

测试：

- 日历工作面无关键词能读取当前窗口，非法/过大窗口在 Main 拒绝。
- 创建事件经确认后恰好写一次，字段完整并可按 ID 读回；拒绝确认时写入 0 次。
- 显式事件目标与模型参数冲突时 update/delete 执行 0 次。
- 旧 run 的确认卡、迟到回调和重复 exact action 均不能产生第二次写入。

验证：`npx tsx --test src/__tests__/codex-calendar-surface.test.ts && npm run typecheck`

### W4 · Widget 结构目标与实时证据组合

缺口：Renderer 已有 `document-widget-target` 附件和旧文本格式，RequestEnvelope 也认识 `widget_target`；但 Codex ingress 将该附件报为 `codex_structured_resource_not_ready`，且发送时先组资源、后冻结 current document anchor，无法证明目标属于同一文档版本。

改动：

- 不新增第二种 RequestEnvelope Widget 合同；只增加 `SendScopedResourceSelection.widget_target { logicalResourceId, tabId, widgetId, currentVersion, currentDigest, policyEpoch, incarnationKey }` 并接到既有 `widget_target` kind/source。
- 发送顺序改为先冻结 `currentDocumentAnchor`，再构造 Widget typed resource。resource 的 logical resource、tab、version、digest、policy epoch 和 incarnation 必须与 anchor 完全相同；不匹配或 widgetId 为空时发送前失败。
- Codex 输入不再携带 widgetCode/HTML 作为权威正文。Main 只接受结构身份；模型必须先通过同 run 的 `document_read_section` 取得写前精确读取回执，必要时再用 `document_list_widgets` 定位结构目标。
- 有 typed widget target 时，`document_update_widget` / `document_remove_widget` 省略 target 可注入唯一 widgetId，不同 target 拒绝。无 typed target 时，只有用户明确给出名称/ID、且同 run 的精确读取与 widget 列表唯一命中时才能修改；“这张卡”等模糊指代必须拒绝或反问，不能取当前/首个 Widget。插入只在明确创建意图时开放，不能因已有 target 自动开放。
- 仅有 Widget target + 样式/布局/已有数据调整时保持文档任务，不因附件正文里的“温度/最新”等字样误开 live-info。
- 用户自己的指令明确要求最新天气、新闻、股价等外部事实时，research/browser 只读面与 document update 面并存；网页证据成功后更新同一目标。仅打开含 Widget 的文档、但没有 target attachment 时，普通实时问题只走网页查询，不得任意修改卡片。

测试：

- 结构目标与 anchor 一致时命中同一 widget；版本、incarnation、tab 或目标参数任一不一致均执行 0 次。
- Widget HTML 不进入 Codex ingress/additionalContext，精确读取仍能返回现状。
- “把这张卡里已有温度字号调大”不打开 live-info；“把这张卡更新为今天最新天气”同时有网页读取与 Widget 更新能力。
- 无 widget_target 且只有“这张卡”等模糊指代时不能调用 update/remove；用户明确命名且同轮读取唯一命中时仍可正常修改。

验证：`npx tsx --test src/__tests__/codex-widget-target.test.ts && npm run verify:widget-ready && npm run typecheck`

### W5 · Tag Forge 排他面与打开文档同步

缺口：selected skill 地板会被 explicit folder 收窄剥掉；自然语言“给这个文件夹打标”没有安全的 Codex 选技闭环；通用 requester 若不允许 Tag Forge 同步动作，会让 apply 在 dirty/open tab 场景失去原子性。

改动：

- 显式 `@[tag-forge]` 沿现有技能授权。自然语言路径只增加一个代码拥有的窄别名：同时满足“本轮 typed local_directory + 明确文件夹打标动作”时，将授权解析为稳定 skill id `tag-forge`；无 folder、仅出现“标签”等泛词或第三方内容都不能选技。
- 选技结论必须先成为 `SkillToolAuthorization(mode=selected, skillId=tag-forge)`，composition 不得用第二次文本正则直接授予工具。
- 最终 exclusive allow-set 严格为 `file_locate` / `file_read_excerpt` / `tag_forge_prepare_batch` / `tag_forge_apply_batch` / `declare_completion_criteria`，并同时驱动模型定义和 dispatch authorization。
- `tag_forge_review_batch` 保持 host-only；目录授权只来自本轮结构化附件。
- W0 允许 `tag_forge_apply_batch` 调用 `tagForge.checkRevision/applyContent`。dirty open tab 必须在磁盘写前拒绝；干净 open tab 写后同步；索引/readback 或 Renderer 同步失败沿既有事务回滚，回滚同步使用同一 action claim。

测试：

- 显式技能 + folder 与自然语言窄别名 + folder 都得到同一五件套。
- 无 folder、“研究标签体系”、附件正文提到“打标”均不选 Tag Forge。
- 五件套不含 `file_inventory/file_move/skill_run_shell/skill_write_artifact/ask_user_questions`。
- 真实 production composition 不再剥 prepare/apply；dirty tab 无磁盘变化，干净 tab/磁盘/索引最终一致。

验证：`npm run verify:tag-forge && npx tsx --test src/__tests__/codex-tag-forge-union.test.ts && npm run typecheck`

### W6 · 地图歧义、产物呈现与文件涌现负例

地图：

- `map_plan_route` 保持 Main 规划；不修改或调用旧 `AgentSdkRuntime.resolveMapPlaceAmbiguityIfNeeded`。
- 地图工具面同时包含 `ask_user_questions`。`place_ambiguous` 作为结构化工具结果进入 Codex 下一模型轮，模型用候选构造一张反问卡；答案返回后将选中候选的坐标写入 retry args，再调用一次 `map_plan_route`。
- 取消/超时不重试；候选与原调用字段不匹配时失败关闭；最多按一次用户选择重试，不能循环猜地点。
- 地图 Markdown/静态图通过 W0 的 `map_plan_route -> renderer:present-file` 固定映射呈现。`present_file` / `web_clip_url` 的相同 action 也各自绑定自身工具，不能互相借权。

文件涌现：

- 加负例证明注册表与每轮 allow-set 都没有 `file_emergence_*`。
- Agent 通过 `file_search/file_locate` 只能看到搜索索引已公开的文件事实；不得声称读取了涌现项目分组、推荐原因、反馈或生成代次。
- 本计划不新增文件涌现 IPC、工具、调度入口或 prompt 控制语句。

测试：

- Codex 序列 `map_plan_route(place_ambiguous) -> ask_user_questions -> selected candidate -> map_plan_route`，且旧 SDK helper 调用 0 次。
- 地图产物 action 身份错误时不呈现，正确时恰好呈现一次。
- 所有 public/internal tool definitions 与最终 allow-set 都不含 `file_emergence_*`。

验证：`npx tsx --test src/__tests__/codex-map-ambiguity.test.ts src/__tests__/codex-file-emergence-no-tool.test.ts && npm run verify:file-emergence && npm run typecheck`

### W7 · 远程入站保持资源态

本计划不改远程入站生产逻辑，只把现有“不自动运行”合同纳入总门：

- 文本、图片、文件和 attachment-only 入站均只持久化消息/资源。
- 普通入站不得调用 provider、创建 Codex run、发送 typing/progress；已有 ask card 的合法回答只结算该卡，不创建 successor。

验证：`npx tsx --test src/__tests__/remote-channel-context-reset.test.ts src/__tests__/remote-im-attachment-contract.test.ts`

## 施工顺序

```text
W0 exact 产品动作桥与效果回执
  → W1 同一冻结快照组合
    → W2 RSS / W3 日程
      → W4 Widget
        → W5 Tag Forge 排他面
          → W6 地图与涌现负例
            → W7 远程入站总门
```

W0/W1 是其余模块的共同根因，未通过前不得先补 UI mention 或宣称某个工作面已恢复。W2–W5 完成后必须回跑 W0/W1，防止新资源或排他面重新破坏 exact action 与工具并集。

## 验证门

```bash
npx tsx --test \
  src/__tests__/codex-product-action-bridge.test.ts \
  src/__tests__/codex-tool-surface-union.test.ts \
  src/__tests__/codex-product-resource-envelope.test.ts \
  src/__tests__/codex-rss-surface.test.ts \
  src/__tests__/codex-calendar-surface.test.ts \
  src/__tests__/codex-widget-target.test.ts \
  src/__tests__/codex-tag-forge-union.test.ts \
  src/__tests__/codex-map-ambiguity.test.ts \
  src/__tests__/codex-file-emergence-no-tool.test.ts \
  src/__tests__/remote-channel-context-reset.test.ts \
  src/__tests__/remote-im-attachment-contract.test.ts
npm run verify:tag-forge
npm run verify:file-emergence
npm run verify:widget-ready
npm run verify:codex-runtime-source
npm run verify:native
npm run verify:codex-workbench-surface
npm run typecheck
```

不能只靠纯函数或 source-grep 宣告完成。`verify:codex-workbench-surface` 现在证明生产 handler + 隔离 SQLite（Electron-as-node）的刷新锁、日程写回和回执行为。完整隔离 userData 的生产 `sendScoped` UI 实机门仍待补，不能用本脚本代替：

1. RSS 刷新不得把 in-flight lock 写成完成；分析不得切走当前页面。
2. 日程创建经确认后按 ID 读回；拒绝、停止和重复 action 不产生额外事件。
3. Widget 目标必须匹配冻结 anchor；错误 version/incarnation 无修改。
4. Tag Forge 别名必须先成为 `SkillToolAuthorization`，最终五件套排他。
5. 任何 skipped、unknown、无 readback 或依赖历史产物都算未通过。

## 文档同步

落地后只更新受影响的权威入口：

- `docs/architecture/current-runtime-contracts.md` §2：把当前文档地板统一为“默认 read；明确写意图才加入固定写工具”，并写明多个 surface policy 在同一快照组合、Tag Forge 为最终排他例外。
- §6：补 RSS 后台产品动作、刷新后 readback、日程窗口和 exact effect receipt。
- §7：补结构化 `widget_target`、anchor 绑定，以及实时证据与 Widget 写回可组合。
- §9：补 Tag Forge 五件套在 Codex composition 生效，及 `tagForge.*` 同步动作边界。
- `../../archive/2026-09-06/docs/superpowers/plans/2026-08-13-codex-capability-relight-index.md` 与 `../../archive/2026-09-06/docs/superpowers/plans/2026-08-11-ready-codex-matrix-wiring-closure-implementation.md` 只在真实 gate 通过后更新状态，不提前写成已完成。

实施完成前，本计划只描述目标合同；当前实现仍按代码与 `current-runtime-contracts.md` 的已验证事实为准。
