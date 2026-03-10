# Agent Refactor Baseline 2026-03-07

## 当前已落地的底座
1. Run routing 已按 `runId + scopeId` 固化。
- renderer 不再依赖当前 UI 选中的 scope 才能正确接流。
- 这条前提已经是后续多模块 agent 执行的既有事实。

2. `useAgent` 已完成第一轮拆层。
- `useAgent` 不再是旧式单文件 controller。
- runtime routing、message composition、command execution、scope-run patching 已拆入独立模块。
- store 仍存在，但已经不是整条执行链的唯一承载点。

3. Browser main-process 已服务化。
- 壳层命令、tab lifecycle、preview、automation/CDP、data access、diagnostics、downloads、popup/window-open、session policy、host layout 已拆出独立 services。
- renderer 侧 browser shell/layout/diagnostics entry 也已从页面容器中拆出。

4. Repository 分层基线已建立。
- browser/chat/rss/calendar/settings/agent 访问路径已具备独立 repository。
- 旧的 `database.ts` 直接穿透式访问和静态/动态导入告警已不再是当前主路径。

5. 模块 handler 已基本独立。
- design、video、RSS、calendar 的 agent handler 已从页面组件中抽离。
- 这些模块已经可以在统一 run model 上继续深化，而不必先回头拆页面内逻辑。

6. TaskPanel 和结构化 run state 已可用。
- TaskPanel 能显示结构化 run state、module label、tool trace、artifact state。
- 这部分已经从“消息猜状态”转向“typed payload 驱动”。

## 当前可用的闭环基线
- Browser：既有 workflow 路径可用，shell/layout/diagnostics 已分离。
- Document：确定性文档动作闭环可用，并接入共享 workbench chrome。
- Design：open/save/export/session capture 可用，已有 diagnostics panel。
- Video：import/inspect/export/session capture 可用，已有 schema helper 与 diagnostics panel。
- RSS：add source / fetch / select / analyze / diagnostics / benchmark / session capture 可用。
- Calendar：list/create/update/delete/capture 闭环可用，已有 agent handler 与 diagnostics panel。

## 当前仍未完成的底座项
- `useAgent` 仍然偏大，还没有被收敛成最小纯状态 surface。
- Browser orchestration 还剩最后一层协调逻辑可继续下沉。
- Diagnostics 目前是 panel，不是完整的跨模块 lab。
- Video 仍未完全达到 `Remotion schema-first` 终态。
- Design inspector 仍缺高频属性控制和 shape 一致性。
- RSS / Calendar 的最终 adapter + lab 终态还没完全收口。
- `PromptAssemblyService + L0/L1/L2 memory` 还没开始。
- Feishu capability replacement 还没开始。

## 下一阶段建议顺序
1. 先完成 RSS 三条源在应用内浏览器路径上的最终签收。
2. 再完成 workbench 顶部三行、tabs、toolbar 的视觉基线。
3. 然后继续收 browser orchestration，并把 diagnostics panel 升级为真正 lab 入口。
4. 最后回到尚未启动的主线：layered memory 与 Feishu replacement。
