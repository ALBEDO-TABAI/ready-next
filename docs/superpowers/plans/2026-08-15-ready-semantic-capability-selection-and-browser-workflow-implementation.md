---
title: Ready 语义能力选择与 Browser 任务闭环优化改造计划
date: 2026-08-15
status: implemented
review_status: passed
reviewed_at: 2026-08-15
implemented_at: 2026-08-15
completion_state: core_selection_layer
enforce: true
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-08-13-codex-workbench-surface-rewire-implementation.md
  - docs/superpowers/plans/2026-08-14-codex-browser-kernel-fit-implementation.md
  - docs/superpowers/plans/2026-08-14-codex-surface-hardening-and-split-implementation.md
  - docs/superpowers/audits/2026-07-24-chatgpt-app-agent-browser-runtime-study.md
  - docs/superpowers/audits/2026-07-24-ready-vs-chatgpt-agent-browser-gap-audit.md
evidence_inputs:
  - path: /Applications/ChatGPT Matrix Runtime.app/Contents/Resources/plugins/openai-bundled/plugins/browser/skills/control-in-app-browser/SKILL.md
    source_version: 26.810.50856
    sha256: bdec2bfc891a6bd3f0a62d9d872ece4c6c3678f75bef7a5a2916cb1a53cc6910
    role: current_local_comparison
    enforce: false
  - path: assets/codex-runtime/schemas/stable/codex_app_server_protocol.v2.schemas.json
    source_version: rust-v0.146.1
    sha256: e73b948f24079b1c531a64d5763f4820928b795613b72acf69d5764ba7f5c7e9
    role: pinned_protocol_contract
    enforce: true
note: >
  本计划替换的是动作执行器之前的能力选择层，不是 Browser/Calendar 执行器。
  首批只覆盖 public research、当前页读取、当前页操作和 Calendar 读写。
  不增加第二套模型循环，不复活 use_browser/use_skill、旧 Dynamic Delivery、
  Browser Owner 或通用 continuation，也不重做已有身份、claim、journal、
  readback 与 canonical closeout。
---

# Ready 语义能力选择与 Browser 任务闭环优化改造计划

## 0. 完成标准

本文是实现合同，不把计划完成写成功能完成。生产改造只有同时满足以下条件才算完成：

1. 打开 Browser、存在当前页或上一轮用过 Browser，都只表示可用环境，不再自动决定本轮使用 Browser。
2. 一个用户请求可以同时使用多种能力。例如“总结当前页，再和网上最新天气比较”必须同时获得当前页读取和公开网页查询，不再被 `primaryDomain` 或实时词裁成二选一。
3. 语义选择由主模型在原 turn 内完成；代码只根据结构事实生成候选能力，并继续负责权限、精确目标、动作身份、预算、确认和结果回读。
4. 昂贵的写/操作组通过固定 Codex app-server 的原生 deferred / namespace 按需加载。P0 若证明 pinned `0.146.1` 不支持，不得写第二套关键词选择器，也不得在本计划内升级 runtime；此时仍必须删除正则互斥，让便宜的只读组可以并存，但只能宣告“核心选择层完成”，不能宣告“工具面最小化完成”。
5. 当前页读取和当前页操作是两个能力。有 pageRef 只证明两组在结构上可执行，不代表用户要求使用。P0 通过时，操作组须由模型按需加载；P0 失败的降级切片允许它随 pageRef 出现在模型工具面。代码不得为了“天气轮不要点页面”再写意图拦截器；执行层只继续要求授权、exact pageRef、lease 和既有副作用确认。
6. Calendar 读取和写入按同一合同接入。工作面打开只产生只读地板；“记到日程”走现有确认和 event id 读回。
7. 工具不存在、本轮未授权、宿主未连接和外部服务失败继续互斥。可选能力失败不得显示成 `HOST_UNAVAILABLE`。
8. 第 8 节行为门通过。语义选择的自然语言理解由真实模型和安装版证明；脚本化假调用只能证明接线和授权。

本文区分两个完成状态：

- **核心选择层完成**：Browser↔research 的正则互斥已删除，多能力可并存，环境事实不再替用户决定任务，实际调用仍受本轮授权和执行层约束。
- **工具面最小化完成**：在上述基础上，P0 证明并接通 deferred / namespace，未被本轮模型选择的操作组不会展开。

P0 失败时只允许达到第一个状态。不得把“操作没有被调用”写成“操作工具没有暴露”。

## 1. 结论先行

Ready 现在最需要替换的不是 Browser 动作执行器，而是它前面的选择层。

当前做法是：代码先用关键词把整句归入一个领域，再按工作面决定一整组工具是否出现。这能覆盖少量固定短句，但无法稳定处理否定、指代、多目标和跨来源核对，也会把“当前页存在”当成“当前页是用户目标”。

目标链路：

```text
可信结构事实
  → 本轮可用能力目录
  → 主模型按子目标选择能力
  → 代码核对本轮授权和精确目标
  → 查询或操作
  → 结果回读与证据
  → 现有 canonical closeout / projection
```

只新增一份代码侧能力目录，以及它编译出的 root catalog / turn availability。现有执行层继续使用。

已有两个可直接仿照的组合先例，不要另起框架：

- 当前文档默认只有 `document_read_section`；明确写意图才加入固定写工具。
- Widget 目标与实时外部事实已经允许并存，不是二选一。

## 2. 已确认的应用事实

### 2.1 可借鉴的边界，不是可抄的实现

本机当前签名安装版是 `ChatGPT Matrix Runtime 26.810.50856`。本地 Browser skill 能证明的只有：

- 用户明确要求打开、查看或操作浏览器 UI 时，Browser 意图优先。
- 一个 URL、已打开的 tab 或应用提供的 Browser 上下文只是环境，不自动代表用户选择 Browser。
- 上一轮用过 Browser，不会让下一轮自动变成 Browser-first。

不能证明的，本计划不写进合同：服务端路由器、未知提示词、评分器、模型微调，以及 ChatGPT connector 查询层。Ready 没有 connector 注册表；等价物只是对本计划目录做原生 tool search，不新建第三套能力发现。

### 2.2 Ready 已经拥有的可靠底座

- 生产主链只有 `CodexHostOrchestrator → Codex ingress/product composition → ReadyCodexLifecycleAdapter → canonical closeout/projection`。
- `ReadyToolTurnSnapshot` 已把根工具面和本轮 allow-set 分开冻结；dispatch 再核 thread/turn/call/授权。
- `browserPageRef` 已绑定 tab、physical target 与 main-frame document。
- `BrowserActionExecutor`、claim、lease、journal、`mayHaveCommitted`、`needsObservation` 和 readback 已能区分没执行、已执行和结果未知。
- 当前页只读集合已经存在：`BROWSER_EXPLICIT_READ_TOOL_NAMES`。当前页整组读写是 `BROWSER_CURRENT_PAGE_TOOL_NAMES`，里面混了 observe 和 mutate。
- Calendar 已有 `calendar_list_window` / `calendar_capture_session` / `create|update|delete`，以及确认和写后读回。
- 公开查询已有 `web_search_domains` / `web_search` / `web_fetch`。
- `ready-system.md` 已写明：实时公开信息优先后台查询，只有登录态、当前页面或 UI 交互才用 Browser。不另写一份路由 prompt。

### 2.3 固定协议已经有、产品还没接上的部分

pinned `rust-v0.146.1` schema 已包含：

- function dynamic tool 的 `deferLoading`；
- `type: "namespace"` 及 namespace 内 function；
- `tool_search_call` / `tool_search_output` item；
- server tool call 的 `namespace + tool`。

Ready 当前实现是：

- `CodexDynamicToolSpec` 只接受平铺 function；
- `validateDynamicTool` 拒绝 namespace；
- `buildReadyToolSurface` 把全部工具平铺进 root，且不设 `deferLoading`；
- tool bridge 对非 null namespace 直接 `codex_builtin_tool_forbidden`。

08-14 kernel-fit 合同仍然有效：`0.146.1` 只允许在 `thread/start` 注册 dynamic tools，`turn/start` 不能追加。因此本计划若使用 deferred/namespace，只能是**在 thread/start 已经登记过的工具上做原生按需加载**，不是 Ready 在 turn 内扩权，更不是复活 `use_browser`。

P0 必须用真实 app-server 证明这件事在 pinned runtime 上成立。schema 有字段不等于 runtime 会发出 tool search。

### 2.4 当前选择层的直接问题

| 事实 | 当前行为 | 后果 |
| --- | --- | --- |
| `intent-classifier.ts` 用正则选一个 `primaryDomain` | 多目标先被压成一个主领域 | 当前页读取、公开查询、Calendar 无法自然并存 |
| `current-page-work-facts.ts` 用指代/否定正则决定 `admitCurrentPageRoot` | “当前页面放着不用管”仍会命中“当前页面” | 否定和组合语义被词面覆盖 |
| 当前页一旦准入就加入整份 `BROWSER_CURRENT_PAGE_TOOL_NAMES` | 读取和点击/输入一起出现 | “看看当前页”没有操作边界 |
| 生产 compose 只要存在 pageRef 就可能加回当前页工具 | 环境事实变成使用意图 | 坐在某页上查天气仍可能两套能力并存，或反过来丢掉公开查询 |
| 测试主要覆盖固定短句 | 正则自己生成的预期都能通过 | 测试绿不代表换一种自然说法仍可用 |

2026-08-15 只读探针：

| 输入 | 当前路由 |
| --- | --- |
| “先总结当前页，再查广州周末天气核对” | `pageWork.targeted=true`，公开查询被关掉 |
| “当前页面放着不用管，请查广州周末天气” | `pageWork.targeted=true`，排除没命中 |
| “比较这个页面的说法和网上最新天气预报” | 只有当前页，没有“两个能力都需要” |
| “查广州周末天气” | 只有不含当前页指代的短句能稳定排除当前页 |

相关单元测试 17 项全绿。这证明问题不是分支没测到，而是测试和实现共享了同一套过窄假设。

### 2.5 根因

1. **语义职责错位**：否定、指代、目标拆分由正则承担，模型只能在预裁剪后的工具面里行动。
2. **任务形态错位**：代码要求整轮一个主领域，真实任务常是多个操作、多种能力。
3. **能力粒度错位**：页面存在、读取页面、改变页面被绑成一件事。

固定运行时缺少 namespace 接线是放大器。即使把所有工具改成 deferred，如果仍由关键词决定授权，问题还在。

## 3. 第一性原理合同

### 3.1 用户请求是目标，不是路由标签

“总结当前页，再和网上最新天气比较”是两个证据操作加一次比较，不是必须先选 Browser 或 research。一个 turn 可以查询并调用多个能力组。

### 3.2 环境只决定“能不能”，不决定“要不要”

| 结构事实 | 含义 | 不含义 |
| --- | --- | --- |
| Browser 工作面 + 完整 pageRef | 当前页读取组可以成为候选 | 用户要读或改这个页 |
| typed `browser_reference` | 用户提供了一个网页资源，产生只读地板 | 用户要点击或填写 |
| Calendar 工作面或 window/event 资源 | Calendar 目标可精确解析 | 用户要创建或删除日程 |
| 公开查询 provider 可用 | public research 可用 | 用户不要看当前页 |

是否使用由主模型根据本轮用户文本和显式资源选择。

### 3.3 模型和代码的分工

模型：理解否定/指代/比较，拆操作，选择能力，判断证据是否够。

代码：生成真实可用能力、冻结 root catalog 和本轮 allow-set、核对 pageRef/tab/文档代次/run/turn/call、判断 observe/mutate、确认、预算、unknown、回执和 closeout。

模型选了某项能力不等于获得授权；代码认为某项能力可用也不等于用户要求使用。

### 3.4 每个外部结论都有够用的证据

- 公开事实：搜索/fetch 来源回执。
- 当前页事实：绑定 exact pageRef 的读取回执。
- Calendar 写入：按 event id 读回。
- Browser 操作：沿用现有 action outcome 和 observe barrier。
- 结果未知：告诉模型未知，禁止自动重做可能已经发生的动作。

不另建 ExecutionPlan 或 semantic-decision 表。

### 3.5 防护强度跟风险匹配

- 搜索、读取、截图、查看日程：不新增确认。
- 创建/修改日程：现有确认；删除保持更高等级。
- 页面点击/输入：现有效果政策，不因“经过能力查询”重复确认。
- 用户明确指定 Browser 而 Browser 不可用：如实失败，不暗换公开搜索。
- 用户没指定 Browser，公开查询能完成时：优先公开查询，不 claim 当前页。
- 登记 deferred Browser 组、生成本轮 availability：不得创建 BrowserView、不得 claim 页面、不得新建 work tab。

### 3.6 本计划接受的残余风险

删除正则互斥后，模型仍可能在“只查天气”时去读当前页。P0 失败时，当前页操作组也可能随有效 pageRef 出现在模型工具面，模型甚至可能调用它。这比再建一套关键词开关更可接受，因为：

- 读取组可见不等于已经 claim 或初始化 BrowserView；
- P0 通过时操作组仍按需加载；
- 无论是否调用，执行层仍要求本轮授权、exact pageRef 和既有写确认；换页仍失败关闭。

不接受的是：

- 代码因“当前页面”四个字强制选择 Browser；
- 为了挡住天气轮的 click/type，再写一套“只读任务 / 实时词”拦截器；
- P0 失败后仍宣称天气轮的模型工具定义里一定没有 click/type/navigate，或宣称完整工具面最小化已经完成。

如果验收要求是“天气轮连 click/type 的定义都不能被模型看到”，那么 P0 不是可降级项，而是该验收要求的硬前置。这里必须区分“可见”“本轮获准调用”“实际调用”“产生效果”，不能用“拿到工具”混写四种状态。安装版若在 P0 失败路径上观察到天气轮调用了 act，记为已知残余，不把核心选择层判失败，也不为此补拦截器。

## 4. 目标架构

### 4.1 一份目录，两层冻结

根 thread 注册稳定能力目录；每轮再冻结 availability 和 allow-set。

```ts
type ReadyCapabilityGroupId =
  | 'public_research'
  | 'browser_current_read'
  | 'browser_current_act'
  | 'calendar_read'
  | 'calendar_write'

type ReadyCapabilityGroup = {
  id: ReadyCapabilityGroupId
  description: string
  tools: readonly string[]
  loading: 'always' | 'deferred'
}

type ReadyCapabilityTurnAvailability = {
  availableGroupIds: readonly ReadyCapabilityGroupId[]
  explicitFloorGroupIds: readonly ReadyCapabilityGroupId[]
  unavailableReasons: Readonly<Partial<Record<ReadyCapabilityGroupId, string>>>
}
```

约束：

- group id、description 和成员工具来自一份代码目录。成员必须是已有 ToolDefinition 名，不复制 effects。
- 只读组成员只能来自现有 `BROWSER_EXPLICIT_READ_TOOL_NAMES`。操作组是 `BROWSER_CURRENT_PAGE_TOOL_NAMES` 扣除只读组和 `browser_research` 后的保守余集；`browser_dialog`、`browser_collect` 这类混合或非纯 observe 工具统一归入操作组，不写只读 wrapper，也不把它们误称为“纯 mutate”。`browser_research` 需要既有 research child-task route，不属于当前页能力，随 `browser_work` 一起移出首批。
- 同名工具只能属于一个 group 或 always-visible root。
- `availableGroupIds` 只读结构事实，不分析用户自然语言。
- `explicitFloorGroupIds` 只来自本目录覆盖的 typed resource 或工作面只读地板。显式 Skill 继续走现有 `SkillToolAuthorization` 地板，不塞进这五个 group，也不因本计划改写。
- floor 只保证该组进入本轮 availability 和 allow-set；不改变稳定 root digest。
- availability 只留在 Main 的本轮冻结快照、授权和日志中，不进入 `additionalContext`、developer instructions 或伪造的用户文本。`additionalContext` 的现行合同只承载非语义、内容寻址的资源引用。即使某一轮的 `additionalContext` 只作用于该次 `turn/start`，把 availability 写进去也等于把代码裁决的能力清单交给模型，违反“环境不等于意图”。是否跨轮残留不是唯一理由，因此一律不写。
- 根目录摘要变化才创建新的 native generation；普通 turn availability 变化不重建 thread。
- 授权身份仍是工具名 allow-set，不是 namespace 名。目录不是第二套授权系统。
- P0 结果是实施前一次性确定的源代码路径，不是运行时配置、用户开关或双实现。通过就实现 deferred；失败就实现本文标明的单一降级面。

### 4.2 首批能力组

| 能力组 | 成员 | 进入条件 | 加载 |
| --- | --- | --- | --- |
| `public_research` | `web_search_domains` / `web_search` / `web_fetch` | provider 真实可用 | always。三件套便宜，defer 只会让每次天气查询先付一次 tool search |
| `browser_current_read` | 现有 `BROWSER_EXPLICIT_READ_TOOL_NAMES` | exact current page 或 typed browser reference | typed reference 时 floor；仅有 pageRef 时为候选。P0 通过则 deferred，否则可直接进入 allow-set |
| `browser_current_act` | `BROWSER_CURRENT_PAGE_TOOL_NAMES` 扣除显式只读集合和 `browser_research` 后的保守余集，含混合工具 `browser_dialog` / `browser_collect` | exact current page 且 Browser host 可执行 | 候选，不是地板。P0 通过则 deferred；P0 失败则允许它随 pageRef 出现在模型工具面，并记为降级接受项 |
| `calendar_read` | `calendar_list_window` / `calendar_capture_session` | Calendar host 可用 | Calendar 工作面或 Calendar resource 时 floor；否则 always。两个只读工具不必单独 defer |
| `calendar_write` | `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` | Calendar host 可用且产品映射已登记 | P0 通过时 deferred。P0 失败时只有两条诚实路：写组随 host 可用而可见，或把写组迁移推迟到 P0 通过。现行 Codex 主链没有“明确写意图才开放写工具”的可靠路径——`composeCodexTurnToolSnapshot` 在 Calendar 工作面只补 read 地板，整组 Calendar 工具今天是被 `classifyIntent` / `execution-intent-resolver` 一起打开的。不得虚构或复活该关键词开关 |

首批**不**加入 `browser_work`，也不把需要 research child-task route 的 `browser_research` 塞进 `browser_current_act`。后台 work tab、因果后继页签和 `browser_tabs` 继续走 08-14 kernel-fit 已有门；等当前页读/写和公开查询稳定后再单独立项。首批也不迁移 RSS、文档写、地图或技能目录。

### 4.3 原生 deferred / namespace

只在 P0 通过后接线：

1. `CodexDynamicToolSpec` 改为 function / namespace 严格联合类型，字段与 pinned schema 一致。
2. app-server client 按 pinned schema 校验，不再只接受平铺 function。
3. `buildReadyToolSurface` 从能力目录编译稳定 namespaces；always-visible 与 deferred 分开，但都在 `thread/start` 一次性登记。
4. tool bridge 接受已登记 Ready namespace，以 `namespace + tool` 查 surface entry，再核对本轮 allow-set。未知 namespace 仍按 built-in forbidden 关闭。

`tool_search_*` 是 Codex 内置协议事件，不是 Ready 函数工具。Ready 不得自己实现一个 `tool_search`。原生搜索能否只返回本轮 Ready allow-set 内的工具，当前没有证据；P0 必须记录真实搜索输出，不能把这一点写成既成事实。无论搜索或上一轮加载让模型看见什么，真正调用都必须在 Ready bridge 重新核对当前 turn 的工具名授权，不能越权执行。

这与 kernel-fit 不冲突：Ready 仍然不在 `turn/start` 追加 dynamic tools。

### 4.4 每轮选择

```text
用户输入 + typed resources + 工作面事实
  → 冻结 Turn Availability
  → 编译本轮 allow-set；模型只看到稳定 root catalog / namespace 描述
  → 主模型拆分操作并选择能力
  → 本轮授权 + 目标/参数校验
  → 执行 + readback
  → canonical closeout
```

| 用户说法 | 必须可用 | 不得自动发生 |
| --- | --- | --- |
| “查广州周末天气”，Browser 开着 | public research | 读取或 claim 当前页 |
| “当前页面放着不用管，查天气” | public research | 因“当前页面”进入 Browser |
| “总结当前页” | current-page read | click/type/navigate 进入本轮调用 |
| “总结当前页，再和网上最新天气比较” | read + public research | 二选一 |
| “在当前页填写并提交” | current-page act + 现有 claim/receipt | 只读工具假装完成 |

P0 失败时，表中“不得自动发生”约束的是**代码不得强制选择、不得 claim、不得初始化 BrowserView**。它不要求再写一个“天气/只读任务禁止 dispatch act”的拦截器。只有 P0 通过后，才能同时要求未选择的操作定义不被模型展开。

### 4.5 错误归属

只补一条原则：失败归具体能力或具体工具。

| 情况 | 处理 |
| --- | --- |
| 根 app-server 未连接 | 才能显示宿主不可用 |
| 查询到的工具没注册 | `tool_not_registered` |
| 工具存在但本轮结构事实不允许 | `authorization_denied` 或现有产品错误 |
| Browser host 不可用，用户未指定 Browser | 可用 public research 继续 |
| 用户明确指定 Browser，但 host 不可用 | 报告 Browser 不可用，不暗换来源 |
| 动作可能已经提交 | 保持 unknown/mayHaveCommitted，先观察 |

既有 `conversation_reset_required` / 旧合同换代不要改回 `host_unavailable`。本计划不重写全部错误分类，只禁止把 capability/auth/tool 失败再包装成宿主宕机。

### 4.6 现有路由器的处置

首批切换完成时：

- `resolveCurrentPageCapabilityRouting` / `current-page-work-facts.ts` 已从工作区删除，不再保留第二套关键词判断。
- `detectLiveInfoIntent` 不再决定 Browser 与 public research 的互斥工具面。
- `classifyIntent.primaryDomain` 与 `execution-intent-resolver` 可暂时服务旧 UI 提示、预算或未迁移域，但不得再决定 Browser/research 互斥，也不得再决定 Calendar 写工具是否进入本轮 allow-set。
- 旧 SDK route 不得成为 fallback。生产切换与旧授权调用点删除必须在同一实施阶段完成。
- 历史测试和支撑链的正则代码不在第一阶段顺手清理。

P5 必须改写权威合同里与本计划冲突的句子，至少包括：

- “可信浏览器工作面且已绑定当前页时，资料分析仍走当前页 Browser 工具，不得因 research 意图改走普通网页搜索”；
- “当前页目标与排除由请求资源层给出……当前页指示或否定表达兜底”。

改成：环境只产生候选；公开查询与当前页读取可以并存；否定和多目标由模型选择；代码不再用指代/平台/实时词裁剪互斥工具面。

同时保持现有 `additionalContext` 合同：它只承载非语义、内容寻址的资源引用，不承载每轮可变的 capability availability。

## 5. 分阶段实施

P0 未通过不得接线 namespace/deferred。P0 失败不阻断删除正则互斥。P1 的目录与 P2 的 additive availability、P3 的删除 live 正则必须同一交付切片落地，避免“目录接上了但正则仍是权威”。

### P0 — 固定运行时小实验

目标：证明 pinned `0.146.1` 真实 app-server 能 search → load → call，并分别观察“搜索/加载后模型可见性”和“Ready 当前 turn 是否允许执行”。

实验方式：曾用一次性 opt-in e2e 注册一个 deferred function 和一个含两个函数的 namespace，记录 namespace、tool、thread、turn、call、surface digest 和 authorization digest。结论归档后删除探针源码，不把失败实验保留成产品入口或常驻测试。

通过：真实 runtime 走完全链；非 null namespace 到达 Ready bridge；未授权工具在 dispatch 前被拒。测试必须记录两轮搜索输出，并覆盖“上一轮已加载、本轮授权收回”的调用拒绝；若原生搜索仍返回本轮未授权工具，这不等于越权，但必须作为 P0 能力边界写进验收记录。

失败即停止 namespace 产品路径。单独再提 runtime 升级，不在本计划内升级，也不回退成“把全部 Browser 和全部目录工具一次摊开”；只允许 §4.2 明列的首批降级面。

### P1 — 能力目录

目标：最小目录只接研究、当前页读/写、Calendar。

改动面：新增 `codex-capability-catalog.ts`；若 P0 通过，再改 `codex-native-runtime.ts`、`codex-app-server-client.ts`、`codex-tool-surface.ts`、`codex-tool-bridge.ts`。

机器合同：

- 目录编译稳定、排序稳定、digest 稳定；
- 同名工具只属于一个 group；
- 只读组不包含 mutate 或混合工具，操作组精确等于当前页全集扣除只读集合和 `browser_research` 后的余集；`browser_research` 不得在没有 research child-task route 的首批表面出现；
- P0 通过后，bridge 按 namespace + tool + turn auth 解析；伪造 namespace、跨 turn/call 全部拒绝。

### P2 — 结构化 Turn Availability

目标：代码只描述真实可用能力，不再解释用户语义。

改动面：`codex-runtime-production-composition.ts`、`codex-tool-surface-composition.ts`、`codex-browser-admission.ts`，新增 `codex-capability-turn-availability.ts`。Calendar 与公开研究只复用现有 host/provider 能力事实和产品映射；不得复用 `execution-intent-resolver` 的自然语言分类结果来生成 availability，也不新写意图分类。

机器合同：

- 无 exact pageRef 时，两个当前页 group 都不可用；
- typed browser reference 只产生 read floor，不产生 act floor；
- 仅有 Browser host / pageRef 时，read/act 只是候选，不自动 claim 页面，不初始化 BrowserView；
- public research 是否可用只看 provider，不看天气/新闻词；
- Calendar 工作面只产生 read floor；
- 同一 turn 的 allow-set 可以同时包含 public research 和 current-page read；
- availability 与 turn authorization 一起冻结，dispatch 时精确重读；
- availability 不序列化进 `additionalContext`、developer instructions 或用户消息，两轮 pageRef/host 变化不得由旧上下文污染新轮授权。

### P3 — 移除 Codex live 的正则语义裁决

改动：

- 删除 production composition 对 `resolveCurrentPageCapabilityRouting` 的调用。
- 删除 Codex live 对 `primaryDomain` / `detectLiveInfoIntent` 的 Browser↔research 互斥。
- 保留 typed resource floor、exclusive Tag Forge 和 provider 能力减法。
- 若 P0 通过，让 `tool_search_call/output` 进入既有 turn item/活动投影。
- 只在 namespace/group description 写清用途和先决条件，不追加路由 prompt。

机器合同：

- 选择一个能力不删除另一个仍可用能力；
- 登记或暴露 Browser 组本身不得创建 BrowserView / claim / work tab；
- 不得新增“天气/只读任务禁止调用 act”的 dispatch 拦截器；
- 上一轮加载 Browser 不影响下一轮选择，但下一轮授权仍独立生效。

### P4 — Calendar 写路径与错误归属

不重写 Calendar scheduler 或 EventModal。只把 `calendar_read` / `calendar_write` 接到同一目录，复用 `codex-product-action-map`、确认和 event id 读回。create/update/delete 成功只认现有数据库 readback。ingress / tool / provider / capability 错误保持互斥。

P0 失败时没有可依赖的现行“明确写意图才开放写工具”主链：旧 `CalendarDomainAdapter` 的触发正则不是当前 Codex live 权威；`composeCodexTurnToolSnapshot` 在 Calendar 工作面只补 `calendar_capture_session` / `calendar_list_window`；整组写工具今天是被 `classifyIntent` / `execution-intent-resolver` 一起打开的。因此 P4 只有两条诚实路：

1. 等 P0 通过后再迁写组，读组先按地板/always 接入；
2. 接受“Calendar host 可用则三项写工具可见”，安全边界只剩既有逐次确认、精确 event id 和写后读回。

不能复活旧 adapter，不能新增写意图开关，也不能一边删正则一边继续靠 `primaryDomain === 'calendar'` 打开写工具。若走路径 2，Calendar 工作面上看天气时写工具也会可见，这必须写进降级接受项，不能假装没有。

### P5 — 合同、专项门和安装版

- 更新 `docs/architecture/current-runtime-contracts.md` 的工具面与 Browser 章节中与本计划冲突的句子，并保留 `additionalContext` 只承载非语义资源引用的现行约束。
- 新增轻量 `verify:codex-capability-selection`，只串本计划直接行为测试。
- 受影响净增代码按现有大文件台账处理。
- 发布前用真实 DMG 和隔离用户数据目录跑第 7 节。源码测试通过只表示实现切片完成，不等于安装版验收完成。

## 6. 文件与责任边界

| 文件/模块 | 允许 | 禁止 |
| --- | --- | --- |
| `codex-native-runtime.ts` | 仅在 P0 通过后补 namespace/deferred 协议类型；本次保持 function-only | 改 turn/thread 生命周期 |
| `codex-app-server-client.ts` | 仅在 P0 通过后接收 namespace；本次保持现状 | 宽松接收未知字段 |
| `codex-tool-surface.ts` | 从能力目录编译 root surface | 把 per-turn 授权混进 root digest |
| `codex-tool-bridge.ts` | P0 未通过时继续拒绝 namespace | namespace 自动扩权或名称 fallback |
| `codex-runtime-production-composition.ts` | 构造 availability、移除正则 live 裁决 | 复活旧 SDK/DomainAdapter 主链 |
| `codex-browser-admission.ts` | 只生成结构化 Browser availability 和 exact refs | 解析用户句子决定读写 |
| `browser-capability-registry.ts` | 继续作为 operation/effect 唯一真值 | 再复制一份模式表 |
| Calendar product action | 复用已有映射、确认、readback | 新建第二套 Calendar executor |
| Renderer | 展示真实选用能力与结构化错误 | 猜完成、自动重试、新的能力选择 UI |

## 7. 必须通过的用户场景

### 7.1 语义选择

| 场景 | 必须发生 | 禁止发生 |
| --- | --- | --- |
| Browser 打开着，“查广州周末天气” | public research | 读取或 claim 当前页 |
| “当前页面放着不用管，查广州周末天气” | public research | 因“当前页面”四个字进入 Browser |
| “总结当前页” | exact current-page read | click/type/navigate 被本轮调用 |
| “总结当前页，再和网上最新天气比较” | current-page read + public research | 二选一 |
| “看看我现在打开的小红书笔记并概括” | current-page read，绑定原 tab/document | 按“小红书”写站点 adapter |
| “在当前页填写标题并提交” | current-page act + 既有 claim/receipt/readback | 只读工具假装完成 |
| 上一轮用了 Browser，下一轮问普通知识 | 直接回答或非 Browser 能力 | 沿用上一轮 Browser-first |

P0 降级验收：代码不得因工作面/pageRef/实时词强制进入 Browser，也不得为此新增拦截器。安装版记录模型是否调用了 act；若调用了，记为已知残余，不把核心选择层判失败。P0 通过后再增加“未选择的操作组不展开”的可见性断言。

### 7.2 Calendar

| 场景 | 必须发生 | 禁止发生 |
| --- | --- | --- |
| “我下周三要和学生 acall，帮我记一下日程” | calendar write、现有确认、event id readback | `HOST_UNAVAILABLE` 掩盖工具或授权问题 |
| “我下周三有什么安排” | calendar read | create/update/delete 被调用或触发；P0 通过后还要求写组不展开 |
| Calendar 工作面打开，用户只问天气 | public research | 因工作面自动读或改日历 |
| 创建回执未知 | 查 exact event/readback 后再定性 | 自动再创建一条 |

### 7.3 失败和恢复

| 场景 | 必须发生 |
| --- | --- |
| current page 在调用前已换页 | exact identity 拒绝，不读新页 |
| click/type 可能已送达后断线 | unknown/mayHaveCommitted + observation，不盲重试 |
| Browser host 不可用且用户没指定 Browser | 继续公开查询 |
| 用户明确指定 Browser 而 host 不可用 | 说明 Browser 不可用，不暗换来源 |
| P0 未来通过后，上轮加载的 namespace 工具本轮未授权 | bridge 拒绝，且错误不是 `tool_not_registered` |

## 8. 测试与验收门

### 8.1 新增行为测试

不要为每个阶段各建一套平行文件。持续保留的行为门如下；P0 的一次性探针已在结论归档后删除：

- `src/__tests__/codex-capability-catalog.test.ts`：目录编译、digest、无重复归属、只读组无 mutate。
- `src/__tests__/codex-capability-turn-availability.test.ts`：结构事实只决定 availability/floor；read+research 可并存；pageRef 不产生 act floor；可变 availability 不进入任何模型输入，两轮结构事实变化不串轮。
- `src/__tests__/codex-cross-capability-turn.test.ts`：同 turn 研究 + 当前页读取的接线与授权，可用脚本化模型。Calendar 读写/确认/readback 接到现有 calendar surface 测试，不单独立一套选择框架。

脚本化模型只能证明接线和授权。第 7 节语义选择必须由真实生产模型和安装版证明。

### 8.2 分阶段命令

P0 已完成并归档在 `docs/superpowers/audits/2026-08-15-codex-deferred-capability-p0.md` 与同名 JSON。它不是持续回归门。

P1-P4：

```bash
npm run typecheck
npm run verify:codex-runtime-source
npm run verify:codex-workbench-surface
npm run verify:browser-surface
npm run verify:codex-capability-selection
```

不要把 `verify:codex-runtime-experiment` 整条 E0–E9 链绑进本计划每个切片。P0 通过并实际改到 bridge / native binding 时，P1-P4 必须追加 `verify:codex-tool-bridge` 和 `verify:codex-runtime-e4`；P0 失败且没有这些改动时不跑。Calendar 若改 SQLite 或产品 persistence，再追加 `npm run verify:native`。

最终发布前：

```bash
npm run build
```

然后用真实 DMG 和隔离用户数据目录完成第 7 节。dev server 或旧安装版不能替代。

### 8.3 通过证据

每个安装版场景至少保存：app/runtime 版本、用户输入原文、被查询和实际调用的 capability group、是否出现 current-page claim、工具终态与 readback、最终回答是否覆盖全部目标、失败时的精确层级。不记录页面正文或认证信息。不新建巨大报告协议。

## 9. 明确不做

1. 不增加前置 intent LLM、router Agent 或第二次模型判断。
2. 不为每个句子建立持久 ExecutionPlan、semantic decision 表或新状态机。
3. 不扩充天气、新闻、平台名、否定词和“当前页”正则词典。
4. 不一次迁移全部工作面。首批没有 `browser_work` / `browser_research`、RSS、文档写、地图。
5. 不因为某个 group availability 变化就新建 thread。
6. 不在本计划内升级 Codex runtime。P0 失败只停 namespace 路径；允许明确标记的单一路径降级可见面，但不维护 eager/deferred 两套产品实现。
7. 不重新实现 claim、action receipt、unknown、observation barrier、closeout 或 Calendar readback。
8. 不给搜索、读取、截图、查看日程增加确认。
9. 不自动重试可能已经提交的写操作。
10. 不重开 08-14 已删除的 BrowserView 巨报告门。
11. 不用来源平台 allowlist 决定 Browser。
12. 不把 Matrix 未公开的服务端实现写成已知事实，不新建 connector 注册表。
13. 不发明“本轮 action mode”或其它自然语言开关来决定 act 组。
14. 不把登记 deferred 组或生成 availability 当成 Browser 初始化。
15. 不为天气、只读或“当前页放着不用管”新增 dispatch 拦截器。

## 10. 实施顺序与交付检查单

顺序：`P0 →（P1+P2+P3 同一交付）→ P4 → P5`。

- [x] 固定 runtime 的 deferred/namespace 小实验有明确通过或失败记录。失败则 namespace 产品路径停止，正则互斥仍须删除。
- [x] P0 失败时只宣告核心选择层完成；P0 通过并证明未选择操作组不展开后，才宣告工具面最小化完成。
- [x] root catalog 与 turn availability 的 digest、归属、授权有行为测试。
- [x] 可变 availability 没有进入 `additionalContext`、developer instructions 或用户文本，两轮结构变化不串轮。
- [x] Codex live 不再用当前页/实时词正则决定 Browser 与 research 互斥。
- [x] 同一 turn 可以同时拥有 public research 和 current-page read。
- [x] 当前页 read 与 act 边界清楚；混合工具没有整名进入只读组。
- [x] `browser_research` 没有借当前页操作组绕回首批；后台研究仍等后继页签合同单独立项。
- [x] Calendar write 继续确认并按 event id 读回。
- [x] capability/auth/tool 失败不再包装成 host 不可用。
- [x] 现有 Browser 身份、unknown、观察和 closeout 回归通过。
- [x] 权威合同里与本计划冲突的句子已改写。
- [ ] 安装版第 7 节在发布前通过并有可复核回执。

任何一项未证明，都只能报告对应阶段完成。

## 11. 对抗审查记录

### 11.1 首轮审查（相对原稿）

原稿方向正确：根因是选择层而不是执行器，模型做语义、代码做授权，环境不等于意图。以下是按应用事实删改的点，不是风格偏好。

| 原稿问题 | 应用事实 | 调整 |
| --- | --- | --- |
| P0 失败则整计划停止 | 正则互斥与 namespace 是两件事；XOR 修复不依赖 tool search | P0 只门禁 deferred 路径 |
| 六个 group，含 `browser_work` | work tab 仍被 kernel-fit 的后继页签合同挡住；首批没有独立故障 | 移出首批 |
| 未定义的“本轮 action mode” | 会变成下一套关键词/意图开关 | 删除；act 只由 pageRef+host 成为候选 |
| `public_research` 默认 deferred | 三件套便宜；每次天气查询先 tool search 是额外失败面 | always-visible |
| P4 再派生 read/act，P5 再接 Calendar | 只读集合已经是 `BROWSER_EXPLICIT_READ_TOOL_NAMES`；Calendar 映射已存在 | 目录阶段一次划清；Calendar 收成短 P4 |
| 每阶段跑 `verify:codex-runtime-experiment` | 那是整条 E0–E9 链，远超本切片 | 改回 workbench/browser/source + 新专项门 |
| 八个新测试文件 | 选择层测试会被文件数稀释 | 收成五个 |
| 未点名要改的旧合同句 | 现行合同仍写“绑定当前页则资料分析不得走普通搜索”和“指代兜底” | P5 必须改写这些句子 |
| 把 Matrix connector 查询写成可借鉴流程 | Ready 没有 connector 层 | 只借鉴环境≠意图，不新建发现系统 |

保留的原稿约束：不升级 runtime、不写 eager-all 双路径、不另建 Agent/状态机、不重做执行可靠性、安装版才能证明自然语言理解。

### 11.2 复审（针对本文修订稿）

复查问题与结论：

1. **和 kernel-fit“turn 内不能扩权”是否冲突？** 不冲突。deferred 只展开 `thread/start` 已登记工具；Ready 仍不在 `turn/start` 追加。P0 失败则根本不走这条路。
2. **P0 失败后 act 组可见，会不会让“查天气”获得点击？** 会获得可见定义，模型也仍可能调用。这是降级残余，不是再写拦截器的理由。若产品要求定义本身不可见，P0 就是硬前置。
3. **always-visible 的 public_research 算不算 eager-all？** 不算。eager-all 指一次摊开整组 Browser mutate。三件公开查询工具保持常驻，与现行天气路径一致。
4. **availability 能否进 additionalContext / application context？** 不能。现行合同里它只承载非语义资源引用；写进去等于把本轮代码裁决交给模型。是否跨轮残留无需先证明，一律不写。
5. **是否还在用关键词做权限？** live authorization 不再用。`classifyIntent` 只允许旧 UI/预算，且不能删能力或发写授权。若实施时发现它仍能改 allow-set，按回归处理，不得当成兼容层保留。
6. **Calendar 询问安排是否会露出写工具？** P0 通过时 write deferred；P0 失败时会露出。现行 Codex 主链没有可复用的“明确写意图才进入 allow-set”，旧 adapter 正则不能复活。降级安全边界是现有确认、精确目标和写后读回；若不接受可见，只能等待 P0。
7. **是否过度防御？** 已删除 browser_work、action mode、connector 层、整条 experiment 链和只读 wrapper。剩下的 P0 实验、exact pageRef 和写确认都是现有风险边界，不是新防护。
8. **原生 tool search 会不会自动尊重 Ready 本轮 allow-set？** 尚无证据。P0 必须记录 search/load 输出；真正的安全边界仍是 bridge 的当前 turn 授权，不能把搜索结果过滤写成协议保证。
9. **`browser_research` 能否留在 current act？** 不能。它是 research workflow metadata，执行时要求 browserTaskId / parentTaskId；没有 child-task route 会直接失败，也会让退出首批的后台研究边界失真。首批操作组只保留真正绑定当前文档的工具。
10. **阶段编号是否自洽？** 原稿 P6 在修订稿中已并入 P5。正文残留的“P6 必须改写合同”已改成 P5。`calendar_read` 在非工作面时不再写“deferred 或直接可见”，与 public research 一样 always。

复审结论：六项删改方向都成立；随后 Codex 补的四点都是应用事实，应保留。需要再收的只有落地合同：不得把“天气轮不要点页面”写成代码拦截，否则会逼出第二套意图判断。

### 11.3 针对 Codex 四点补丁的复核

| 补丁 | 应用事实 | 结论 |
| --- | --- | --- |
| 每轮能力状态不进会遗留的上下文 | `additionalContext` 现行只承载资源引用；`developer_instructions` 在 `turn/start` 必须为 null | 成立。补强为：即使只作用于当轮，也不许把 availability 当路由卡写入 |
| P0 失败时没有“明确写日程才开放写工具” | Calendar 工作面只补两个只读工具；写工具今天靠 intent 整组打开 | 成立。再写清两条诚实路：推迟 P4 写组，或接受 host 可用即可见 |
| 原生 tool search 未必按本轮 allow-set 过滤 | schema 未保证；Ready 也还没接 | 成立。P0 记录输出，执行仍以 bridge 复核为准 |
| `browser_research` 移出当前页操作 | 它不钉当前页引用，surface 走 agent-view-foreground，且要 research route | 成立，保持移出首批 |

另外改掉的过度合同：P0 降级不得再要求代码保证天气轮零 act 调用。那会重新引入关键词拦截，和本计划根因相反。

修订后的计划可以实施。没有扩大首批范围，也没有新增第二套意图判断。本轮只修计划。

### 11.4 实施后复核（2026-08-15）

1. **P0**：真实 Electron 实验已记录失败（`start_delivery_unknown`）。产品面保持平铺 function，`READY_CAPABILITY_DEFERRED_LOADING_SUPPORTED = false`；一次性探针与仅供探针使用的 namespace 客户端接收面已移除。不得宣称工具面最小化完成。
2. **核心选择层**：production compose 以结构 availability 为第一批权威；`resolveCurrentPageCapabilityRouting` / `admitCurrentPageRoot` 已退出 Codex live。
3. **Calendar 写组**：走路径 2。Calendar host 可用则三项写工具可见；确认和 event id 读回未改。
4. **已知残余**：pageRef 存在时 act 组可见；天气轮模型仍可能调用 click/type。未新增拦截器。
5. **安装版第 7 节**仍未做。源码门通过不等于发布验收完成。
