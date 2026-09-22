---
title: Ready Ask Map / 高德行程规划 Agent implementation
date: 2026-05-20
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Ask Map / 高德行程规划 Agent 实施计划

> 2026-08-20 现行修订：外部服务选择与未配置降级已由 `2026-08-20-map-service-selection-and-fallback-implementation.md` 取代本文件“未配置时仍暴露地图工具”的旧合同；其余地图执行合同继续有效。

## 背景

目标是让 Ready agent 通过一个受控高层工具完成路线规划、顺路地点推荐、多点顺序优化、耗时计算，并生成聊天解释、Markdown 文档草稿、地图静态图和 JSON/Markdown/PNG artifact 兜底。

第一版只接高德 Web 服务，不接高德 MCP；后续若接 MCP，也必须复用本次的 RoutePlanner 接口，不另起一套规划逻辑。当前聊天中出现过的高德 key 视为已泄露，正式使用前必须在高德控制台轮换，并只通过 Ready 设置页录入新 key。

## 架构边界

- 不新增 TaskType；地图请求仍按 short_task 或 multi_step_task 归类。
- 新增 ToolDomain=map、CapabilityGroupId=map_planning、AgentModuleKind=map、IntentDomain=map。
- DomainAdapter.shouldHandle 保持同步 boolean。
- 地图语义判断在 TurnEngine 早期异步完成，结果写入 ExecutionIntentContext.mapSemanticIntent，后续 adapter 只同步读取。
- buildExecutionToolState 只消费本轮意图结果，不调用 LLM、不读配置、不做语义判断。
- resolveRunCapabilities 之前，mapSemanticIntent 通过 intentGroupModes 打开 map_planning，以及文档、research、browser 等 secondary signals 对应能力组。

## 工具合同

模型只看到一个工具：map_plan_route。

v1 支持 driving、walking、bicycling；不支持公交、不支持 schedule。least_detour 必须与 alongRouteSearch 同时出现。waypoints 最多 16 个。place_ambiguous 只返回 candidates，不返回 clarificationOptions；主 agent 仍走 ask_user_questions。

未配置高德时不再暴露 map_plan_route；只开放明确标注为公开网页估算的紧凑兜底，并提示用户去设置页启用“高德地图”并填写 key。已配置但执行失败时不得静默改走网页。

## 核心模块

- AmapClient：统一请求高德 geocode、place text、place around、direction、distance、staticmap，所有 URL 日志脱敏。
- MapRateLimiter：同 key 并发 1，单 plan 默认 20 次请求预算，10021 限流退避重试。
- MapRequestCache：生命周期绑定 planId，cache key 不含 key，不跨 plan 复用。
- RoutePlanner：地址解析、基准路线、沿路采样搜索、候选去重、绕路计算、多点顺序优化。
- MapArtifactWriter：写入 outputsRoot/map-planner/<planId>/route-plan.json、route-plan.md、route-map.png。

静态地图 URL 只允许存在于 main 进程内存中。renderer、Markdown、JSON artifact 只看到本地 PNG 路径。源码、fixture、日志和 artifact 不得出现真实 key 或高德 key 查询参数。

## 测试重点

- map_plan_route schema、工具注册、未配置结构化失败。
- TaskType 不出现 map_planning。
- ExecutionIntentContext.mapSemanticIntent 默认 null，resolveExecutionIntentContext 保持同步。
- map 语义 LLM 失败时强关键词 fallback，普通非地图请求返回 null。
- MapDomainAdapter 只同步读取预计算结果，并只收窄已被 capability resolver 放行的工具。
- 4-5 点精确 TSP，6+ 近似并 warning。
- artifact JSON/Markdown 不包含高德 key 查询参数。
- calendar/research/browser/document 不被 map adapter 错抢。

## 手动验收

隔离 user data 启动 Ready，在设置页录入轮换后的高德 key，跑：

1. 从北京南站去故宫，路上帮我找一家顺路咖啡，最后写成文档并附地图。
2. 上海虹桥站到外滩，顺路晚餐。
3. 成都 4 个地点，给我安排最省时间的顺序。
4. 起点不清楚时 agent 反问。
5. 高德 key 关闭时提示去设置页配置。
6. 模拟 10021 时提示稍后重试或缩小搜索。
7. 明天安排一个会议行程，必须走 calendar。
8. 查小红书评价后再帮我选成都路线，必须以 map 为主任务并允许 research 辅助。
