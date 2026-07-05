---
title: Phase C — DirectChatEngine 退役（六职责解剖迁移 + 存在性合同）
date: 2026-07-05
status: contract-first
enforce: true
---

# Phase C — DirectChatEngine 退役实施合同

> 先合同后代码（红线 §0.5.1）。本文档由 2026-07-05 现场解剖产出，所有断言带 file:line 实锚；
> 实施前若行号漂移，以符号名重新定位，锚点意义不变。

## 0. 解剖结论（与路线文档"六职责"逐条对账）

DirectChatEngine（`src/main/modules/claude-bridge/direct-chat.ts`，1093 行）已无任何执行入口
（P6f 已证 SDK live / DirectChat dormant 执行边界）。唯一活消费者是
`runtime-core/orchestrator.ts`（`new DirectChatEngine()` @158）。其余四处引用
（message-capability-filter / headless-one-shot / openai-execution-client /
direct-chat-attachment-metrics）均为注释或类型语境，无运行时依赖。

| # | 路线文档职责 | 实态 | 判决 |
|---|---|---|---|
| 1 | 域适配器宿主 | **活**。构造块 @291-465：8 适配器 + Browser/Document 双域 orchestrator + 3 执行客户端（Anthropic/Kimi/OpenAI requestSimple 闭包，供 document 简单调用）+ BrowserTaskPlanner 闭包 + WidgetEditLeaseStore + 附件资源读取（chatRepository，@616-655，与 sessions map 无关） | 整厂迁移 |
| 2 | 技能上下文 | **活**。SkillContextOrchestrator 装配 @328-336，orchestrator 经 getSkillContextOrchestrator() @161 取用 | 随厂迁移 |
| 3 | 浏览器控制器 | **活**。set/has/getActiveBrowserUrl @502-521 + planner 闭包 getActiveTab/getTabContext @297-318 读 `this.browserController` | 随厂迁移 |
| 4 | sidecar | **暗线**。`sidecarManager` 仅 声明@283 + 赋值@524，零读取 | 删（连 orchestrator@499 的 setSidecarManager 调用一起） |
| 5 | runtime | **活但仅两闭包**。document pipeline 的 getConversationScope/publishScopeRunEvent @416-421；abort 注册 register/unregisterSessionAbortSource @541-565 为**暗线**（registerSessionAbortSource 零调用者；`session.abortController` 只被置 null @743，永不被赋活值） | 两闭包随厂迁移；abort 机器删 |
| 6 | 会话生命周期 | **基本暗**。sessions map 的 messages/systemPrompt/generation 无读者（执行路径已亡）；`newSession` 的活效应只有两行副作用：`documentTaskPipelineExecutor.clearSessionCache(name)` + `widgetEditLeaseStore.release(name)` @711-712；`stopGeneration` 活效应为零（abort 恒 null）；`setRunCleanupRegistry` 仅 声明@285 + 赋值@570，零读取 | newSession 副作用迁为 host.resetSession()；其余删 |

维护性公有面残余：`getAIConfigDetailed/getAIConfig` @573-580、`setSystemPrompt` @714-724 ——
实施第一步先做调用面清点（C1），零调用者即删，有调用者按同法归位。

## 1. 目标终态

- 新建 `src/main/modules/agent-control/domain-adapters/domain-adapter-host.ts`（DomainAdapterHost）：
  只承载上表判"活"的装配与接线，依赖全部显式注入（不允许引擎式 `this` 大杂烩闭包再生）。
- `orchestrator.ts` 以 `new DomainAdapterHost(...)` 替换 `new DirectChatEngine()`；
  六职责调用点 1:1 改指 host；暗线调用点（setSidecarManager/setRunCleanupRegistry/stopGeneration）删除。
- `direct-chat.ts` **文件删除**；`check-directchat-turnengine-dormant-boundary.cjs` 由
  "dormant 边界扫描"转型为**存在性合同**（复活即红），与 turn-engine 同法。
- 执行客户端（anthropic/kimi/openai-execution-client）与 direct-chat-attachment-metrics
  的归属随迁移决定：仅被 host 使用则移入 host 邻域或保持原位改 import；文件不动优先（手术式）。

## 2. 步骤与机器可验证合同

> 进度（2026-07-05 当日）：C1 ✅（§4 判决表）；C2 ✅（3a0fa67a，host + parity 合同 4✓）；
> C3 ✅（49fb76fc，orchestrator 切换 + MultimodalBlock 迁 contracts + 4 钉重锚，
> boundary/typecheck/stability/p6f 四绿）；C4 执行中（引擎已删、gate 已转存在性合同、
> turn-orchestrator 第 8 处 MultimodalBlock 导入已换址）；C5 钉点清扫进行中
> （19 处失败 14 文件，三分法裁决委派执行，主会话终验收口）。
> silent-catch 账：引擎 5 条 catch 随平移变 host 5 条（该 gate 为 HEAD 即红的
> 注册债，本阶段义务=净零新增，终封做集合对账）。

每步一提交（pathspec 协议），每步合同先写测试再动码：

- **C1 调用面终审**（无代码）：对 `getAIConfig*`、`setSystemPrompt`、`DirectChatSession` 类型导出、
  `TOOL_SYSTEM_PROMPT` 做全仓调用清点，产出"删/迁"判决表附在本文档 §4。
- **C2 host 落地 + 平移**：DomainAdapterHost 承接职责 1/2/3/5-活闭包 + `resetSession(name)`
  （= clearSessionCache + widget lease release）。合同测试
  `directchat-host-parity.test.ts`：host.getDomainAdapters() 的类名序列与引擎版逐一相等
  （含 Research 首位，护 `check-research-adapter-registered-in-host.cjs`）；
  browser controller 三访问器行为同构；planner 闭包在无 controller 时的空值语义不变。
- **C3 orchestrator 切换**：替换实例化与全部调用点；暗线调用点删除。合同：
  orchestrator 文件内 `DirectChatEngine` 出现次数为 0（AST 扫描并入 boundary gate）；
  行为测试跑 `verify:stability` 全链 + agent-lifecycle-group 的 newSession IPC 路径。
- **C4 引擎删除 + gate 转型**：删 `direct-chat.ts` 与仅服务于它的死类型；
  boundary gate 增加 `direct-chat.ts` 不存在断言（retired_file_resurrected 同款）；
  全仓 `new DirectChatEngine` 零命中断言。
- **C5 尸检清理**：上表暗线相关的类型/常量/测试逐一处置——测试按 Phase A 外科法
  （引擎专属断言删、live 合同留）；`check-*` 四 gate 扫描列表若含 direct-chat.ts 路径逐一摘除。
- **C6 收官验证**：`npm run typecheck`、`npm run verify:stability`、`verify:evolution-p6b/p6d/p6e/p6f`
  真实退出码全绿；全量套件对照战前基线零新增失败（B8 终封同法）。

## 3. 红线

- 迁移是**平移不是重写**：装配顺序、适配器构造参数、闭包语义逐字保持；发现的暗线只能删或迁，
  不允许"顺手修好"往里加新行为。
- 不做 legacy 兼容分支：不保留 DirectChatEngine 空壳、不留 re-export 假面。
- C29/C30 历史教训：每步合同先红后绿（先写断言证明现状，再动码让它以新形态继续绿）。
- renderer 零触碰；与 Settings/useAgent 拆分泳道无文件交集。

## 4. C1 判决表（2026-07-05 终审完毕）

| 残余面 | 全仓调用清点 | 判决 |
|---|---|---|
| `getAIConfigDetailed` / `getAIConfig` | `domainAdapterEngine.getAIConfig*` 零命中 | 删 |
| `setSystemPrompt`（引擎版） | `domainAdapterEngine.setSystemPrompt` 零命中（orchestrator@596 调的是 `sdkEngine.setSystemPrompt`，不同对象） | 删 |
| `DirectChatSession` 类型 | 仅 direct-chat.ts 自用（执行客户端参数为各自结构类型，构造闭包内 `as DirectChatSession` 断言随厂平移） | 随厂迁移（断言原样） |
| `TOOL_SYSTEM_PROMPT` | 引擎外零命中 | 随 sessions 机器删 |
| `WidgetEditLeaseStore` 实例 | 类定义 widget-edit-lease.ts + 引擎内 acquire/resolve/release 闭包，无第三方读取 | 实例随厂迁移 |
| `serializeMessages` / `fetchWithTimeout` | 仅执行客户端装配闭包使用 | 随厂迁移 |
| `sidecarManager` / `setRunCleanupRegistry` / abort 注册对 / sessions map | 上表 §0 已证暗线 | 删（含 orchestrator 侧调用点） |

结论：**无任何外部散点**。C2-C5 为纯机械迁移+删除，无语义悬案。
