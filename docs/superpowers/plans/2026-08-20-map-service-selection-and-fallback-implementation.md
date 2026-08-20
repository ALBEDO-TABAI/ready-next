---
title: Ready 地图外部服务选择与未配置降级 implementation
date: 2026-08-20
enforce: true
supersedes:
  - docs/superpowers/plans/2026-05-20-map-route-planning-agent-implementation.md#工具合同
---

# Ready 地图外部服务选择与未配置降级实施合同

## 事实与根因

安装版中“查一下从广州海珠区晓港雅筑出发去韶关罗坑大草原要多久”实际调用了网页搜索和 Browser 工具，没有调用已经配置好的 `map_plan_route`。高德配置本身有效；缺口有两层：Codex 生产路径使用的同步地图意图判断没有覆盖“从 A 出发去 B 要多久”，且后续通用能力合并会把已经收窄掉的网页和 Browser 工具重新加入。

ChatGPT / Matrix 的可借鉴边界是：外部服务的连接与启用状态先决定本轮哪些工具可用，再让模型只在这份冻结工具集合内选择。Ready 不复制某个地图插件的具体实现，只采用“先判可用性、再冻结授权”的合同。

## 现行合同

1. 路线规划使用 Codex 生产链现有的同步语义判定，不增加第二次模型请求；“从 A 出发去 B 要多久”等自然表达必须识别为路线，公交、地铁、高铁、航班等当前不支持的公共交通不得误送到驾车规划。
2. 高德在外部服务设置中处于启用状态且存在 Key，才视为本轮地图服务可用；只向工具授权层传递冻结布尔值，不暴露 Key。
3. 地图服务可用时，普通路线任务以 `map_plan_route` 为唯一主查询工具，同时保留 `ask_user_questions` 及用户显式资源产生的必要地板；不得因为当前工作面是 Browser 或通用能力目录可用而重新加入公开网页或 Browser 工具。
4. 地图服务未配置时，不向模型暴露 `map_plan_route`；只开放 `web_search`、`web_fetch` 与 `ask_user_questions` 的紧凑兜底面。回复必须说明这是公开网页估算，不得声称是地图导航结果，并提示可在“设置 > 外部服务”配置高德地图。
5. 地图服务在本轮开始时可用、但实际调用失败时，以地图工具的结构化错误结束；不得静默切换成网页答案。设置在轮次中变化也不得改写已经冻结的本轮授权。
6. 路线规划与实时路况是不同意图：实时路况继续走公开网页实时查询；路线距离、行车时间和多点规划按本合同处理。

## 验收

- 精确复现用语在 Browser 工作面且高德已配置时，最终授权包含 `map_plan_route`，不包含 `web_search` 和任何 `browser_*` 工具。
- 同一用语在高德未配置时，最终授权包含 `web_search` / `web_fetch`，不包含地图、Browser 和垂直领域查询工具，且工具说明明确网页估算与配置入口。
- 公交、地铁、高铁等不被判成当前只支持 driving / walking / bicycling 的地图路线。
- 上述行为纳入 `npm run verify:codex-workbench-surface`，并通过 typecheck、Codex runtime、streaming 与 native 回归。
