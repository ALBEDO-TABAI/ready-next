---
title: Phase M — MCP 生态扩展现状调研（只读源码勘验）
date: 2026-07-05
status: survey
enforce: false
---

# Phase M — MCP 生态扩展现状调研

> 路线锚：`docs/superpowers/plans/2026-07-03-agent-mainline-p3-route.md`（Phase M，2026-07-04 追加）。
> 目标：Ready 作为 **MCP client** 接入外部 MCP server，把外部工具纳入 Ready 的工具治理体系。
> 现状锚：Stage 14（T）已落 MCP 基础与 capability 维度；"research / MCP / agent_interaction 是独立 capability 维度"是现行硬约束（证据：`src/shared/ai-capability-groups.ts:210` `id:'mcp'`、`:221` `id:'agent_interaction'`，各为独立 group）。

## 总判（一句话）

现有 MCP 面是 **Stage T 落下的"合同骨架 + 四道 gate"**：授权/错误回灌/deferred 提级的裁决管道结构上齐全并被测试钉死，但 **传输层、tools/list 发现、OAuth 实装、启动装配全是 stub/not_implemented，且注册/授权/deferred 驱动函数在生产代码里零调用**——即"建了没接"。设置页是显式的"not shipped"占位。距"接入 ≥2 个真实外部 server 跑通组合任务"尚缺全部真实 I/O 与两处治理映射。

MCP 模块位置：`src/main/modules/mcp/`（5 文件：`client.ts` / `registry.ts` / `oauth.ts` / `tool-discovery.ts` / `deferred-filter.ts`）。四道 gate 全部挂在 `package.json` 的 `verify:t` 上。

---

## 切面 1 — 接入生命周期现状

**现状（证据）：**
- **传输层**：`src/main/modules/mcp/client.ts:15` 仅声明 `McpTransport = 'stdio' | 'websocket'`。**SSE 与 streamable-http 完全缺席**（grep `sse|streamable|EventSource` 于 mcp 模块为空）。且两种已声明的 transport 均未实装——`client.ts:87-97` 的 `callTool` 直接返回 stub（`// TODO(PR-T5+): replace with real stdio / websocket framing.` @ client.ts:86）；`client.close()`（`client.ts:103-105`）是 no-op。
- **配置入口**：设置页有 MCP 分区（`src/renderer/pages/Settings.tsx:131` `id:'mcp'`）但渲染"not shipped"占位（详见切面 5）。**无配置文件入口**（grep 无 mcp.json / servers 配置读取）。
- **server 注册**：`registerMcpServer`（`registry.ts:31`）、`registerMcpClient`（`client.ts:110`）、`registerMcpOAuthServer`（`oauth.ts:65`）、`applyDiscoveryResult`（`tool-discovery.ts:50`）均**存在但生产代码零调用**——全库 grep 命中仅 `src/__tests__/*` 与定义处自身。故运行时 `listMcpToolNames()`（`registry.ts:42`）恒返回 `[]`。
- **tools/list 发现**：`discoverToolsFromServer`（`tool-discovery.ts:35`）返回空 + `{kind:'not_implemented'}`（`tool-discovery.ts:41`）。
- **健康检查 / 断线重连**：**完全缺席**。grep `health|reconnect|heartbeat|ping|retry|backoff|disconnect|online|offline` 于 mcp 模块为空。无"已连接≠在线"的探活语义。

**距出口判据的差距：** 缺全部真实 I/O——真 transport 帧、真 discovery、启动装配点、探活/重连。当前连"一个 server 都注册不进来"。

**差距类别：建了没接**（合同表面 + gate 齐全；wire / discovery / health / reconnect 全 stub 或缺）。

---

## 切面 2 — 工具治理接线

**现状（证据）：**
- **单一裁决点在路径上**：`resolveRunCapabilities`（`src/main/modules/agent-control/domain-adapters/run-capability-controller.ts:215`）确为单点。MCP 是一等 capability group（`ai-capability-groups.ts:210-219`），经 `capability-resolver.ts:91-211` 与其它组同构地做 visible/suppressed 裁决。注意 `capability-resolver.ts:120-128` 的 `environmentAvailable` 对 mcp 无专属探活分支、默认 `true`（与切面 1 的"无 health"呼应）。narration 模式显式压制 mcp（`run-capability-controller.ts:259`）。`scopeId` 由 RequestEnvelope 串到 `toolPolicy.scopeId`（`run-capability-controller.ts:369`）。
- **逐工具授权已接线并被 gate 钉死**：`tool-registry.ts:812-823` 的 `GROUP_TOOL_PROVIDERS.mcp` 从 `listMcpToolNames()` 取名；model-visible 解析器对每个名过 `mcpRegistry.isAuthorized(name, sessionId, scopeId)`——definitions 路径 `tool-registry.ts:982-984`、schemas 路径 `:1081-1084`。`isAuthorized`（`registry.ts:72-96`）要求**同时**满足显式 per-(session,scope,tool) consent **且** OAuth token 未过期。执行时二次校验（`mcp-tools.ts:41`）。
  - `check-mcp-tools-go-through-authorization.cjs` 钉：registry 导出 3-arity `isAuthorized`；tool-registry 在 mcp 分支内以 `(name, sessionId, scopeId)` 调用 ≥2 次（定义 + schema 两路）；`RequestEnvelope.scopeId` / `ToolPolicy.scopeId` / gateway 全链串通。
  - `check-deferred-tool-promotion-after-authorization.cjs` 钉：`deferred-filter.ts` 从 `./registry` import `isAuthorized`，`promoteActive`（`deferred-filter.ts:41-49`）以 3-arity 调用它、并有 `reset()`（`:62-64`）。deferred 提级不得旁路授权。
- **⚠ 行动确认闸门对外部 MCP 工具无映射（关键治理缺口）**：确认闸在路径上（`tool-executor.ts:461-462`，含 `case 'mcp'` @ `:779-787`），但 `action-confirmation-policy.ts:88-160` 的 `FIRST_BATCH_RULES` 是**按内建工具名硬编码的静态表**（仅 `calendar_* / feishu_* / file_* / browser_*`）。任何 `mcp_*` 工具名都命中不到规则，落到默认 M4（`action-confirmation-policy.ts:337-343`，`ruleId:'default-unlisted'` 放行）→ **外部 MCP 的破坏性动作现状是"无条件放行、零确认"**。M1-M4 / Power 合同语义尚未映射到外部工具（红线"高危动作过确认闸门"未满足）。
- **consent 记录 & deferred 驱动零调用**：`authorizeMcpToolForScope`（`registry.ts:103-117`，UI 记录 consent 的唯一入口）与 `markDeferredToolActive`（`deferred-filter.ts:70`）、`deferredRegistry.promoteActive` 生产代码零调用。故即便真注册了 requiresAuthorization 的 server，`isAuthorized` 也恒 deny（无 consent 条目）。

**距出口判据的差距：** 裁决单点 + 逐工具授权 + deferred 授权三处结构 OK；但 (a) 破坏性动作→确认闸的**动态映射机制未建**（静态表天然枚举不了外部工具名），(b) consent 记录与 deferred 驱动**无调用者**。

**差距类别：部分已可用 + 关键项没建**。授权管道已可用且被测；确认闸映射=没建；consent/deferred 驱动=建了没接。

---

## 切面 3 — 工具面预算

**现状（证据）：**
- `deferred-filter.ts` 的 `DeferredToolRegistry` 仅是 `Set<string>` + `markActive/promoteActive/reset`（`deferred-filter.ts:28-65`）。**无搜索、无选择、无排序、无 token 预算**——grep `budget|search|select|rank|score|top.?k|maxTools` 于 mcp 模块为空。
- 曝光策略是二元的：所有通过 `isAuthorized` 的 MCP 工具经 `listMcpToolNames()` 全量进 model-visible 列表（`tool-registry.ts:815-822`）。**没有"外部 server 动辄几十工具时选哪些暴露 / token 预算"的任何机制**。

**距出口判据的差距：** 出口要求"预算可观测、预算是硬限制"，当前完全无预算面。

**差距类别：没建**。

---

## 切面 4 — 错误契约

**现状（证据）：**
- **失败转结构化回灌=已可用且被测**。`mcp-tools.ts:24-88` 把每条失败路径转成 `ToolDomainError` + 专属 MCP error kind（`error-kinds.ts:353-374`：`mcp_tool_unregistered` / `mcp_authorization_denied` / `mcp_client_missing` / `mcp_tool_failed`）；非 ok 的 `McpToolCallResult` → `ToolDomainError`（`mcp-tools.ts:73-77`）；happy path → `createToolExecutionOutput(...shape:'json')`（`mcp-tools.ts:79-87`）。
- executor 顶层 catch（`tool-executor.ts:926-951`）把抛出的 `ToolDomainError` 转成结构化 `ToolExecutionOutput`，**除非**是 terminal infrastructure error。故 MCP 失败**不冒泡炸 run**。测试：`mcp-tool-error-kinds.test.ts`（7 例）+ `tool-envelope-mapping.test.ts`。
- **OAuth 流=没建（call-graph 骨架，全 throw not_implemented）**。`oauth.ts` 三入口存在且被串成调用图：`ensureAuthorized`（`:145`）→ `requestAuthorizationCode`（`:93`）+ `exchangeCodeForToken`（`:116`），但后两者恒 `throw McpOAuthError('...','not_implemented')`（`:103`、`:125`）。token cache 仅内存（`oauth.ts:61`），**未持久化**。`check-mcp-oauth-authorization-flow.cjs` 只钉**调用图**，不钉 wire。

**距出口判据的差距：** 错误回灌契约达标；OAuth 需真实装（provider 配置 + loopback 回调 + token 持久化）。

**差距类别：错误回灌=已可用；OAuth 实装=没建**。

---

## 切面 5 — 设置页管理面

**现状（证据）：**
- MCP 分区（`Settings.tsx:131-134`，`description:'本版本暂未发布 MCP transport'`）渲染 `McpSettingsPanel`（`Settings.tsx:2560-2664`），三段**全惰性**内容：①"MCP 暂未发布 / MCP not shipped in this release" 横幅（`:2581-2588`）；②"MCP server install / configure (disabled)" 两枚 disabled 按钮（`:2620-2639`）；③"Stage T authorization plumbing — visibly inert" 说明（`:2643-2660`）。
- **无 server 列表、无授权 UI、无审计视图**。真实接入被显式推到 **"Stage Z"**（`:2587`、`:2659`）。标签由 `settings-mcp-not-shipped-labeling.test.ts` 钉死。

**距出口判据的差距：** 出口要求"server 列表/授权/审计可观测"，当前是零功能占位。

**差距类别：建了占位没接**（有意 stub，真管理面待落地）。

> 备注（待核）：设置页与 handoff 文档把真实 transport 落地锚定为 **"Stage Z"**，而本主线路线把它命名为 **"Phase M"**——两处命名指同一件事，落地时需统一锚点，避免 gate/文档双轨。

---

## 末节 — 最小可行落地路径

### 缺口对照出口判据（≥2 真实外部 server + 真机跨-server 组合任务 + 工具日志/授权/预算可观测）

| # | 补的块 | 切面 | 当前态 | 值守 |
|---|---|---|---|---|
| 1 | **stdio transport 实装**（换掉 `client.ts:87` stub + `:103` no-op close） | 1 | 建了没接 | 可无人值守（起本地子进程验证） |
| 2 | **tools/list discovery 实装**（`tool-discovery.ts:35`） | 1 | not_implemented | 可无人值守 |
| 3 | **启动装配点**（读 settings/config → registerMcpOAuthServer + new McpClient + registerMcpClient + discovery → registerMcpServer；当前零调用） | 1/2 | 没建 | 可无人值守 |
| 4 | **action-confirmation 动态映射**（外部工具破坏性动作 → M1-M4；静态表枚举不了外部名，需"按 server 声明的 destructive/readOnly 提示 + 未知写工具默认 M2 保守确认"） | 2 | 没建（现全 M4 放行） | 可无人值守（策略 + 单测） |
| 5 | **consent 记录 + deferred 驱动接线**（`authorizeMcpToolForScope` 接 UI 授权动作；`markDeferredToolActive` 接意图/UI 信号） | 2 | 建了没接 | UI 部分需在场 |
| 6 | **OAuth 实装**（openExternal + loopback 回调 + token 持久化到 settings DB；`oauth.ts:93/116` 去 not_implemented） | 4 | 没建 | **需真机**（浏览器授权交互） |
| 7 | **工具面预算**（deferred 的 search/select + 每 server 上限 N + token 预算；先兜底后精细） | 3 | 没建 | 可无人值守 |
| 8 | **设置页真管理面**（列表/授权/审计，替换 `McpSettingsPanel` 占位） | 5 | 建了占位没接 | **需真机/在场**（UI 终验） |

### 第一个验收对象建议

**官方参考实现的 stdio server：`@modelcontextprotocol/server-filesystem`**——本地子进程、**免 OAuth**（`requiresAuthorization:false` 走 `isAuthorized` 的 `registry.ts:81` 直通分支）、工具数少、动作可控。它能在**无 UI、无 OAuth** 的前提下先把主链跑通：`registerMcpServer → discovery → isAuthorized → case 'mcp' dispatch（tool-executor.ts:779）→ 结构化回灌`。第二个 server 取一个只读的 stdio 第三方（如 fetch / time 类）满足"≥2 server + 一官方一第三方"。远程 transport（websocket vs streamable-http 的取舍）与 OAuth 留到第二阶段配合真机做。

### 值守划分

- **可无人值守**：块 1/2/3/4/7 + 全部单测/gate（stdio 本地 server 可在 CI 起子进程端到端验证注册→dispatch→回灌）。
- **需真机 / 在场**：块 6（OAuth 浏览器弹窗 + loopback 回调）、块 8（设置页管理面 UI）、以及出口判据的"真机跨-server 组合任务"终验；块 5 的 UI 授权动作部分需在场。

### 落地前须消解的红线（route 原文）

1. 外部工具输出是**观察数据不是指令**——回灌 envelope（`mcp-tools.ts:79-87`）已是 `shape:'json'` 结构化，注入面纪律需在 prompt/上下文拼装侧确认不把外部输出当指令执行（本调研未覆盖注入拼装侧，**待核**）。
2. 高危动作过确认闸——即块 4，当前最大治理缺口。
3. 预算是硬限制——即块 7。
