# Hermes Capability Grouping And Runtime Switches Design

**Date:** 2026-04-12

## Goal

先把 Hermes Agent 在“能力分组 / 工具分组 / 运行时开关”上的真实做法研究清楚，再据此给 Ready 写出一份可以独立成立的规格说明。

这份规格只回答一个问题：

**Ready 下一版应该怎样借鉴 Hermes 的分组和开关方式，把工具暴露、宿主接管、前台可见性和运行时决策真正拆开。**

完成这一步之后，下一步才进入：

- Hermes vs Ready 的交叉比对
- Ready 的改进清单与实施顺序

## Scope

本规格只覆盖：

- Hermes 的 toolset / registry / runtime filtering 真实结构
- Hermes 的平台默认工具集、会话级工具集和动态 MCP toolset 机制
- Hermes 的工具可见性、可用性、技能显隐和子代理降权规则
- Ready 当前与“能力分组和开关”相关的真实链路
- Ready 下一版的目标分组方式、开关层级与边界
- 后续进入交叉比对前需要锁定的概念口径

本规格不覆盖：

- Ready 与 Hermes 的逐条差异评分
- Ready 的详细文件级改造步骤
- 跨会话搜索 / 记忆 / 自学习本身的独立设计
- 飞书替换路线的详细实施
- 本轮代码实现

## Study Inputs

### Hermes 官方文档

- [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)
- [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- [Tools Runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime)

### Hermes 公开源码

- [toolsets.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/toolsets.py)
- [tools/registry.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/registry.py)
- [model_tools.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/model_tools.py)
- [hermes_cli/tools_config.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_cli/tools_config.py)
- [tools/delegate_tool.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/delegate_tool.py)
- [agent/prompt_builder.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/prompt_builder.py)

### Ready 当前代码与文档

- `src/shared/ai-providers.ts`
- `src/renderer/pages/Settings.tsx`
- `src/renderer/components/settings/RemoteIMSettingsPanel.tsx`
- `src/main/modules/agent-control/tool-gateway.ts`
- `src/main/modules/agent-control/execution-tool-policy.ts`
- `src/main/modules/agent-control/execution-tool-config.ts`
- `src/main/modules/agent-control/execution-intent-resolver.ts`
- `src/main/modules/agent-control/tool-runtime-context-builder.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/tools/index.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/main/modules/tools/document-tools.ts`
- `src/main/modules/tools/rss-tools.ts`
- `src/main/modules/tools/calendar-tools.ts`
- `src/main/modules/tools/skills-tools.ts`
- `src/main/modules/tools/feishu-tools.ts`
- `src/main/modules/tools/memory-tools.ts`
- `src/main/modules/tools/session-recall-tools.ts`
- `src/main/modules/tools/system-tools.ts`
- `docs/superpowers/plans/2026-04-08-hermes-agent-inspired-agent-browser-roadmap.md`
- `docs/superpowers/specs/2026-04-09-agent-core-loop-runtime-host-design.md`

## Core Finding

Hermes 真正值得借的，不是“它有哪些工具”，而是它把“模型到底能看见什么能力”做成了一条明确的解析链：

1. **每个工具先归属到唯一 toolset**
2. **平台先选默认 toolset**
3. **会话 / 任务再做启用或禁用**
4. **运行前再按 check_fn / MCP 过滤 / 子代理约束做最后收口**
5. **技能显隐、MCP 动态工具、子代理权限都复用同一套 toolset 口径**

而 Ready 当前已经有不少“开关”，但这些开关分散在不同抽象层：

- provider 能力判断
- Settings 的少量三态配置
- `direct-chat.ts` 里的任务启发式
- 文档 / 浏览器 / skill 的专项过滤
- `allowedToolNames` 的最终兜底

这导致 Ready 现在的问题不是“缺开关”，而是：

**没有一套单一真相来定义：某个能力属于哪一组、默认谁开、什么时候给模型看、什么时候只允许宿主内部接管。**

## 1. Hermes 的真实做法

## 1.1 Toolset 是 Hermes 的正式能力单位

Hermes 在 `toolsets.py` 里把 toolset 作为正式的一等对象，而不是文档上的别名。

它至少有四类 toolset：

- **core toolset**
  例如 `browser`、`file`、`terminal`、`memory`、`skills`
- **composite toolset**
  例如 `debugging`、`safe`
- **platform toolset**
  例如 `hermes-cli`、`hermes-acp`、`hermes-api-server`、`hermes-feishu`
- **dynamic toolset**
  例如 `mcp-<server>` 和插件在运行时注册出的 toolset

Hermes 的关键点不是“名字很多”，而是：

**每个工具从一开始就必须属于某个 toolset。**

工具注册在 `tools/registry.py` 中带着 `toolset` 字段进入 registry；后续 schema 生成、平台配置、技能显隐和子代理权限，都围绕这个字段复用。

## 1.2 Hermes 的开关不是一个布尔值，而是一条解析链

Hermes 真正的能力开关分五层：

### Layer A: 静态归组

每个工具注册时就声明自己属于哪个 toolset。

这一步回答的是：

- 这个能力是什么家族
- 它和哪些能力一起被启用或关闭
- 它以后会被哪个平台 / 子代理 / 技能规则引用

### Layer B: 平台默认集

CLI、ACP、API server、Telegram、Feishu 等运行形态，都有默认 toolset。

这一步回答的是：

- 某个平台天然应该拥有哪些能力
- 哪些平台默认不能要 `clarify`、`send_message`、`cronjob` 这类工具

Hermes 并不是所有地方都从 “all tools” 开始，而是先按平台拿一份默认包。

### Layer C: 会话级启用 / 禁用

`model_tools.get_tool_definitions()` 支持：

- `enabled_toolsets`
- `disabled_toolsets`

如果显式传 `enabled_toolsets`，就是白名单；
如果只传 `disabled_toolsets`，就是先拿全集再减法；
如果都不传，则按当前上下文默认值装满。

这一步回答的是：

- 这次会话到底要不要浏览器
- 这次任务是不是只允许 web / file
- RL / batch / API / subagent 是否需要一份更窄的能力面

### Layer D: 可用性过滤

registry 在真正吐出 schema 前，还会跑 `check_fn`。

这一步会处理：

- API key 缺失
- 依赖没装
- 外部服务未连通
- 某个 MCP server 当前不可用

也就是说，Hermes 区分了：

- **逻辑上属于某个 toolset**
- **这轮实际上能不能拿给模型**

### Layer E: 任务级约束

Hermes 在 toolset 之上还有几层“临场收口”：

- MCP server 可以 `include / exclude` 某些具体工具
- MCP 的 `resources / prompts` wrapper 可以单独关闭
- 子代理只能拿父代理已有 toolset 的子集
- 某些 toolset 永远不允许子代理继承
- skills prompt 会根据 `requires_toolsets` / `fallback_for_toolsets` 决定显示什么 skill

这意味着 Hermes 的能力系统不是“分完组就结束”，而是：

**先有稳定分组，再允许不同运行场景在这个基础上做可解释的减法。**

## 1.3 Hermes 把“模型可见性”和“底层实现方式”分开

Hermes 的工具注册和 toolset 设计，重点是 agent-facing surface。

例如：

- Browser provider 怎么换，不影响 `browser` toolset 的口径
- MCP server 是本地还是 HTTP，不影响它作为 `mcp-<server>` toolset 被启用
- 子代理是否能用 memory，不靠 prompt 临时警告，而是靠 toolset 层硬约束

Hermes 在这里最值得借的是：

**先把模型看见的能力面定清，再让不同实现细节挂在后面。**

## 2. Ready 当前的真实现状

## 2.1 Ready 现在已经有多层“开关”，但没有统一命名体系

Ready 当前至少存在五种不同性质的“能力控制”：

### 1. provider capability 开关

`src/shared/ai-providers.ts` 里有：

- `toolUseMode`
- `visionMode`
- `nativeVideoMode`

它们是 provider 兼容层的三态开关，用来判断：

- 工具调用是否可用
- 网页视觉是否可用
- 原生视频输入是否可用

这层很有价值，但它控制的是 **协议能力**，不是 **业务能力分组**。

### 2. 运行时可见性计划

`execution-tool-policy.ts` / `execution-intent-resolver.ts` 会在单轮运行前决定：

- 这轮是否还有 tools
- 浏览器工具是否允许暴露
- 是否只保留一小组 skill 工具

这层已经接近真正的 run-time switch，但它还是围绕少数专项逻辑临时拼出来的。

### 3. 工具级专项过滤

`execution-tool-config.ts` 会对：

- document 工具
- browser 工具
- preferred skill tools
- design tool fallback names

做进一步过滤。

这一步已经在做“分组和开关”的事情，但它不是从正式的 group registry 推导出来的，而是从工具名前缀和专项 heuristics 反推出来的。

### 4. 最终 allowlist

`direct-chat.ts` 会把过滤后的工具名集合压成 `allowedToolNamesForPolicy`，最后交给 `tool-executor.ts` 执行时再兜底判断。

这说明 Ready 其实已经有最终执行闸门。

但当前问题是：

- allowlist 的来源不统一
- allowlist 只是结果，不是正式能力模型

### 5. 宿主侧独立开关

例如：

- `RemoteIMSettingsPanel.tsx` 里有远程频道和 sidecar 的连接 / 启停
- BrowserView 是否可见由浏览器宿主规则控制
- 某些 deterministic flow 实际由宿主直接接管

这些是 Ready 产品必须有的控制面，但它们和模型可见工具面并没有被显式拆开。

## 2.2 Ready 的“实际能力分组”已经存在，但没有正式收口

从 `src/main/modules/tools/index.ts` 和各工具文件看，Ready 现在的真实工具家族至少有：

- `browser_*`
- `document_*`
- `rss_*`
- `calendar_*`
- `skill_*`
- `feishu_*`
- `memory_*`
- `session_*`
- `system_*`

其中浏览器内部其实还分成两类：

1. **交互控制类**
   - 导航、点击、输入、截图、等待、执行 JS
2. **内容任务类**
   - 结构化提取、滚动采集、下载、研究任务、任务续跑、结果聚合

这说明 Ready 真实需要的分组，比当前 `ToolGateway` 里的静态 group 更细。

## 2.3 ToolGateway 现在只是“说明书”，还不是正式真相

`src/main/modules/agent-control/tool-gateway.ts` 目前只维护一份元数据列表。

它有几个明显问题：

1. **分组不完整**
   - 没覆盖 `skill`、`memory`、`session recall`、`system`
2. **命名和真实工具前缀不完全一致**
   - 例如 gateway 里写 `filesystem`，真实执行层是 `system_*`
3. **它不拥有真实 schema**
4. **它不拥有真实启用 / 禁用决策**
5. **它不拥有最终 allowlist**

所以它现在更像一个“健康检查和概念目录”，不是正式 registry。

## 2.4 Settings 里现在只有“协议能力开关”，没有“能力组开关”

`src/renderer/pages/Settings.tsx` 当前能控制的是：

- 工具调用
- 网页视觉
- OpenAI API 形式
- 思考强度

这对于 provider 兼容层是合理的，但它还没有回答这些问题：

- 浏览器这组工具默认给不给模型
- memory / recall 要不要进默认工具面
- 远程频道连上了以后，是否自动给模型暴露 `feishu_*`
- `system_*` 这种宿主高风险能力是否允许用户显式控制

所以当前 Settings 里的“工具调用 = 开”并不等于“所有能力组都该看见”。

## 2.5 Ready 已经出现了分组漂移的迹象

当前代码里已经能看到几类漂移：

### 1. 设计工具残影仍在策略层

`execution-tool-config.ts` 和 `design-tool-loop-orchestrator.ts` 仍然引用一组 `design_*` 工具名，但当前 `src/main/modules/tools/` 已经没有对应的正式注册源。

这说明当前系统里已经存在：

- 策略层知道某些能力名
- registry / schema 层却没有统一真相

### 2. 浏览器同组内混了不同执行语义

现在 `browser_*` 里既有：

- 实时 UI 驱动动作
- 证据探测
- 结构化提取
- 批量下载
- 长任务句柄

这些能力虽然都属于浏览器域，但它们需要的默认开关、可见性和 UI 投影并不相同。

### 3. Feishu 同时有“连接开关”和“模型可见工具”两套概念

远程 IM 设置面板控制的是 sidecar / adapter / channel 是否连上；
`feishu_*` 工具控制的是模型是否可以读写飞书消息、文档和日历。

当前这两层还没有被正式桥接成：

**连接状态 -> 能力可用性 -> 是否对模型暴露**

## 3. 方案选项

## 3.1 方案 A：继续沿用现有启发式，补更多局部开关

做法：

- 保留现有 `direct-chat` + policy filter 结构
- 在 Settings 再补几个浏览器 / 技能 / memory 开关
- 继续靠工具名前缀和专项 heuristics 收口

优点：

- 改动最小
- 短期风险最低

问题：

- 分组漂移会继续扩大
- 新能力每次都要重新接一条专线
- ToolGateway 仍然不是正式真相
- 很难稳定支持后续的交叉比对、分平台、分频道、分 run profile

结论：

**不推荐。**

## 3.2 方案 B：直接把 Hermes 的 toolset 体系完整搬进 Ready

做法：

- 每个工具必须归属正式 capability group
- 所有平台 / 会话 / 子流程都只用 group set 说话
- `getAnthropicTools / getOpenAITools` 改成从 registry resolve

优点：

- 结构最干净
- 与 Hermes 对齐度最高

问题：

- Ready 不是通用 CLI agent，而是产品内宿主
- BrowserView、deterministic runner、前台任务卡、sidecar channel 都需要宿主内控
- 直接照搬 Hermes，容易把“宿主接管”和“模型可见能力”混成同一种 group

结论：

**方向正确，但不能原样照搬。**

## 3.3 方案 C：采用 Hermes 式能力解析链，但保留 Ready 的宿主分层

做法：

- 引入正式的 capability group registry
- 让 tool schema、group、默认暴露策略、执行语义都从 registry 派生
- 把 provider capability、group policy、run policy、host-only capability 分层
- 继续保留 Ready 的 deterministic browser / document / host workflow

优点：

- 能吸收 Hermes 最值钱的部分
- 不会破坏 Ready 的产品内优势
- 后续更容易做交叉比对和改进计划

问题：

- 需要先重写能力模型，再做实现
- 初期需要处理旧策略层与新 registry 的过渡

结论：

**推荐采用。**

## 4. 推荐规格

## 4.1 定义四层正式能力模型

Ready 下一版把“能力”和“开关”拆成四层正式对象：

### Layer 1: Provider Capability

继续保留当前 provider 兼容层三态：

- `toolUseMode`
- `visionMode`
- `nativeVideoMode`

这层只回答协议问题：

- provider 是否支持工具
- 是否支持视觉
- 是否支持视频

它不再直接承担业务分组的职责。

### Layer 2: Capability Group

新增正式能力分组，作为 Ready 的一等对象。

每个模型可见工具必须归属一个 group，每个 group 至少声明：

- `id`
- `label`
- `domain`
- `exposure`
- `executionKinds`
- `defaultMode`
- `requires`
- `toolNames`

其中 `exposure` 必须明确区分：

- `model_visible`
- `host_only`
- `ui_visible_only`

这是整个规格里最关键的边界。

### Layer 3: Capability Profile

新增 profile，用于定义不同运行上下文的默认组集合。

第一版至少需要：

- `local_chat`
- `remote_channel`
- `scheduled_run`
- `embedded_workflow`

profile 决定的是“默认应该打开哪些组”，而不是最终每轮都原样暴露。

### Layer 4: Run Capability Resolution

单轮运行前，把以下信息收口成正式结果：

- provider capability
- profile 默认值
- 用户显式 group override
- 当前环境可用性
- 当前任务意图
- 当前附件 / 视频 / blocker 状态

最终产出：

- `visibleToolNames`
- `hostOnlyCapabilities`
- `suppressedGroups`
- `uiProjectionGroups`

Ready 当前零散的 `visibilityPlan`、`toolPolicy`、`allowedToolNames`，都应该被合并成这一份正式产物。

## 4.2 Ready 的目标能力分组

第一版建议把 Ready 的能力分成下面这些正式 group：

### 1. `browser_interaction`

覆盖：

- 导航
- 点击
- 输入
- 截图
- 等待
- 键盘 / 坐标动作

特点：

- `model_visible`
- 高交互性
- 强依赖 BrowserView 实时宿主

### 2. `browser_content_tasks`

覆盖：

- 结构化提取
- 滚动采集
- 下载
- 研究任务
- 任务恢复
- 结果聚合

特点：

- `model_visible`
- 更偏任务型 / 管线型
- 和 `browser_interaction` 同域，但默认开关策略可以不同

### 3. `document`

覆盖：

- 打开文档
- 写入
- 替换
- widget 增删改
- 保存

特点：

- `model_visible`
- 宿主可插入 deterministic flow

### 4. `rss`

覆盖：

- RSS 源管理
- 获取更新
- 条目分析
- 会话采集

### 5. `calendar`

覆盖：

- 查询日程
- 创建 / 更新 / 删除事件

### 6. `skills`

覆盖：

- 启动 skill action
- execution blocker 继续
- 提交输入 / 确认 / 结果
- 重跑 / 取消

特点：

- `model_visible`
- 但需要支持 run-time 缩成“只暴露当前活跃 skill 相关工具”

### 7. `memory`

覆盖：

- 记忆新增
- 搜索
- 更新
- 最近列表

### 8. `session_recall`

覆盖：

- 历史会话搜索与回看注入

之所以单列，是因为它和 memory 的意义不同：

- memory 是长期事实沉淀
- session recall 是旧会话检索

### 9. `channel_feishu`

覆盖：

- 飞书消息
- 文档
- 日历
- 文件

特点：

- `model_visible`
- 但前提必须依赖 sidecar / channel adapter 可用

后续如果远程渠道继续扩展，应该进入统一 `channel_*` 家族，而不是继续散在宿主连接逻辑里。

### 10. `system_host`

覆盖：

- `system_run_embedded_python`
- `system_run_openclaw`

特点：

- 默认应为 `host_only`
- 不进入普通模型默认工具面
- 仅在宿主判定为显式安全流程时短路调用

### 11. `design_reserved`

当前状态：

- 策略层仍然留有 `design_*` 残影
- 正式 registry 暂无实际工具定义

要求：

- 第一版只把它登记为 `reserved / inactive`
- 不允许继续出现“策略层知道 design 组，registry 却没有正式条目”的漂移

## 4.3 开关语义统一成三态

Ready 当前 provider capability 已经使用 `auto / on / off`。

建议 group 开关也统一采用同样语义：

- `auto`
  - 按 profile、环境和意图自动决定
- `on`
  - 只要环境可用，就强制进入可见候选
- `off`
  - 彻底不暴露给模型

这样有三个好处：

1. 前台认知一致
2. 能自然兼容当前 Settings 的三态方式
3. 比 Hermes 的纯启用 / 禁用更适合 Ready 这种产品内宿主

## 4.4 把“模型可见性”和“宿主接管”彻底分开

下一版必须明确：

### 模型可见 group

模型可以直接看见 schema 并主动调用。

例如：

- `browser_interaction`
- `browser_content_tasks`
- `document`
- `skills`

### 宿主内控 capability

宿主可以使用，但默认不把 schema 暴露给模型。

例如：

- `system_host`
- BrowserView hide/show / bounds 同步
- sidecar adapter 管理
- 某些 deterministic workflow trigger

### UI 可见但不等于模型可见

例如：

- 连接状态
- task card
- capability badge
- blocker 提示

这些东西应该进前台投影，但不应该被误当成模型工具开关。

## 4.5 ToolGateway 要升级成正式 registry

下一版 `ToolGateway` 不再只是元数据目录，而要成为正式能力真相。

它至少要负责：

- 注册每个工具的正式 group
- 产出各协议下的 schema
- 支持按 group / exposure / profile / override resolve
- 产出最终 `visibleToolNames`
- 给前台返回 group 列表和状态

`src/main/modules/tools/index.ts` 不应再手工把所有工具简单拼接后交给策略层二次裁剪。

正确方向应该是：

**registry 先 resolve group，再派生 OpenAI / Anthropic tools，再进入 run-time policy。**

## 4.6 技能与回退逻辑也要改成 group-aware

Hermes 有一个很重要的优点：

- skills prompt 会根据 toolsets 决定显示哪些 skill

Ready 下一版也应该复用 group 口径，而不是只靠工具名前缀和主动请求技能时的特殊判断。

第一版至少要支持：

- 某个 skill 需要哪些 group
- 某个 skill 是否只在某组关闭时出现 fallback
- 当前 run 是否只暴露活跃 skill 所需的一小组工具

## 4.7 远程渠道能力要走“连接状态 -> group availability -> tool visibility”链路

以 Feishu 为例，下一版规则应为：

1. `RemoteIMSettingsPanel` 负责连接和配置
2. sidecar / adapter 心跳决定 `channel_feishu` 是否 `available`
3. profile 和 group mode 决定 `channel_feishu` 是否 `enabled`
4. run resolver 决定这轮是否 `visible`

这样才能避免：

- 渠道没连上但模型仍看到工具
- 渠道已连上但能力始终无法解释为什么没暴露

## 5. 当前结构 vs 目标结构

| 维度 | 当前 Ready | 目标 Ready |
|---|---|---|
| 正式能力单位 | provider capability + 工具名前缀 + 局部 heuristics | provider capability + capability group + run resolution |
| registry 真相 | `ToolGateway` 仅元数据 | `ToolGateway` 成为正式 registry |
| Settings 开关 | 仅 provider 级三态 | provider 三态 + group 三态 |
| 工具暴露规则 | `direct-chat` / policy / allowlist 多层拼装 | 单轮先 resolve capability plan，再统一下发 |
| 浏览器分组 | 所有 `browser_*` 混在一起 | 交互组与内容任务组拆开 |
| 远程渠道 | 连接状态与模型暴露脱节 | 连接状态驱动 group availability |
| 宿主内控 | 和模型工具面混在同一运行链里 | `model_visible` / `host_only` / `ui_visible_only` 明确分层 |
| 技能显隐 | 主要靠显式请求和局部过滤 | 改为 group-aware |

## 6. 第一版验收口径

下一阶段真正进入实现时，这部分应该作为签收标准：

### 1. 有单一 registry 真相

必须能从一个地方回答：

- 某个工具属于哪组
- 某组默认在哪些 profile 打开
- 某组当前为什么可用 / 不可用
- 某轮最终为什么给模型看见 / 看不见

### 2. 有正式 group 三态开关

前台必须能区分：

- `auto`
- `on`
- `off`

并能看到每组的解析结果，而不是只看到“工具调用开 / 关”。

### 3. 运行前有正式 capability resolution 产物

单轮执行前必须产出统一结果对象，而不是继续让：

- `visibilityPlan`
- `toolPolicy`
- `allowedToolNames`
- 专项 deterministic 判断

分散在不同函数里各自收口。

### 4. 宿主内控和模型可见能力不再混用

至少要做到：

- `system_host` 默认不进普通模型工具面
- 远程渠道连接逻辑不等于模型工具暴露
- BrowserView 宿主规则不再被当成“浏览器工具本身的一部分”

### 5. 旧漂移要被封口

至少包括：

- `ToolGateway` 分组缺漏
- `filesystem` vs `system_*` 口径不一致
- `design_*` 残影没有正式状态定义

## 7. 明确不做的事

为了避免这一步规格过度膨胀，先明确本轮不做：

- 不在这份规格里决定 memory / recall 的具体产品交互
- 不在这份规格里定义 Feishu 替换细节
- 不在这份规格里设计所有 profile 的 UI 细节
- 不在这份规格里决定跨会话搜索与自学习如何接入 group resolver
- 不把 Hermes 的平台爆炸式 toolset 名称直接原样搬进 Ready

## Final Recommendation

Ready 在“能力分组和开关”这块，正确方向不是继续往 `direct-chat.ts` 里堆策略，也不是把 Hermes 的 toolset 原样抄进来。

正确方向是：

**借 Hermes 的“正式分组 + 多层解析 + 运行前收口”方法，把 Ready 现有的 provider capability、工具集合、宿主内控和单轮 allowlist 收敛成一套 capability registry。**

用一句话概括：

**Hermes 负责告诉我们怎样把能力面做成正式系统；Ready 负责把这套系统改写成适配 BrowserView、前台任务卡、远程渠道和宿主接管的产品内版本。**
