---
title: ChatGPT Runtime 对照下的 MCP、宠物与 RSS 完全接线实施计划
date: 2026-08-20
status: proposed
enforce: false
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-08-11-ready-codex-matrix-wiring-closure-implementation.md
  - docs/superpowers/plans/2026-08-13-codex-workbench-surface-rewire-implementation.md
note: >
  本文只定义 MCP、宠物与 RSS 在现行 CodexHostOrchestrator / Matrix Runtime
  主链上的完整接线，不实施业务代码，不复活 AgentSdkRuntime、DomainAdapter 调度、
  第二套模型循环或通用后台 Agent。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# MCP、宠物与 RSS 完全接线

## 0. 结论

当前三项都不能称为“已完好接线”，但成熟度不同：

| 能力 | 当前事实 | 结论 |
| --- | --- | --- |
| MCP | 本地 stdio 的启动、发现、调用已有真实链路；远程、OAuth、资源、配置代次和运行态回执未闭合 | 部分可用，不能把草稿能力当成已开放能力 |
| 宠物 | 设置、独立窗口、动画和便利贴工具都存在；活动只看当前会话，窗口加载失败仍可能回报“已贴好” | UI 已接，产品事实与任务状态未接完整 |
| RSS | Main 后台刷新、数据库、自动调度和大部分 Codex 产品动作已经接通；异步分析启动会被包装成成功完成 | 基础能力完整，Agent 完成语义与少数 UI 回读未闭合 |

三项共有的根问题不是“少注册了一个工具”，而是现行终态允许一个动作型请求在没有任何动作工具回执时，仅凭助手文字进入完成态。继续给模型补提示词或重试提醒只会增加不确定性，不能证明产品动作真实发生。

本计划的核心是先建立一条共享的“动作结果义务”，再分别完成 MCP、宠物、RSS 的产品事实闭环。

## 1. 本计划的完成定义

只有同时满足以下条件，才能称为“完全接线”：

1. **可发现**：本轮真正可用的能力才进入冻结工具面；未配置、未连接、未授权或已变化的能力不能被模型看到。
2. **可执行**：调用绑定当前 Ready run、Matrix thread/turn/call、工具、参数和目标，不能跨会话、跨代次或跨目标复用。
3. **可验证**：工具返回成功不等于产品成功；必须从 Main 真值、Renderer 应用确认或后台作业终态读回结果。
4. **可恢复**：失败、超时和结果不明有明确状态；可能已经执行的动作不盲目重试。
5. **可呈现**：设置页、聊天状态、宠物和 RSS 页面展示的是同一份权威状态，不由 Renderer 根据局部页面自行猜测。
6. **可证明**：普通测试、Electron 原生测试和隔离安装版行为都通过；源码搜索、静态绿灯和“模型说完成”均不算验收。

“完全接线”指 Ready 明确声明的产品范围完整，不等于复制 ChatGPT 的所有功能。本期明确范围如下：

- MCP：本地 stdio server 的工具、资源、资源模板、server 元信息和受控确认。
- 宠物：唤醒/收起/外观设置、跨会话任务状态、可回读的便利贴动作。
- RSS：后台刷新、订阅源写入、条目选择、条目分析和长期调度状态。

本期不包含：

- 远程 Streamable HTTP MCP 与 OAuth。
- MCP prompts 对 Ready 指令层的注入。
- 通用 Scheduled Tasks 或后台 Agent 的重建。
- 模型控制宠物外观、位置或任务状态。
- RSS 作业完成后自动生成一条新的模型回复。

## 2. 对照依据

### 2.1 ChatGPT / OpenAI 官方设计

本计划只借鉴与 Ready 需求同形的部分，不按界面逐项照搬：

1. [Plugins architecture](https://developers.openai.com/plugins/concepts/plugins)：插件由技能、可选 MCP server、结构化工具结果和可选 UI 组成；UI 不是工具成立的前提。
2. [MCP server concepts](https://developers.openai.com/plugins/concepts/mcp-server)：完整过程是发现能力、模型按 schema 选工具、server 校验并执行、返回结构结果、模型继续处理。
3. [Tool design](https://developers.openai.com/plugins/plan/tools)：读写工具分离，权限和副作用明确，输入输出 schema 稳定，错误行为可预期。
4. [ChatGPT MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)：桌面端支持 server 状态、认证状态、工具/资源发现和每 server / tool 的确认策略；远程认证是完整 OAuth 流程，不是一个布尔开关。
5. [ChatGPT Pets](https://learn.chatgpt.com/docs/pets)：宠物是可选的任务状态投影，外观不改变任务执行；状态优先级为“需要输入 > 受阻 > 已完成未读 > 运行中”，点击可回到对应会话。
6. [Scheduled tasks](https://learn.chatgpt.com/docs/automations)：后台任务有独立的 active / paused / completed 与运行记录，不把“已开始”冒充“已完成”。
7. [Plugin UI](https://developers.openai.com/plugins/build/chatgpt-ui)：UI 是工具结果的可选呈现；需要确认的动作在组件拿到输入前完成确认。

### 2.2 本机 ChatGPT Matrix Runtime 协议证据

2026-08-20 对本机 `/Applications/ChatGPT Matrix Runtime.app` 做了只读检查：

- 应用版本：`26.814.41407`，build `6720`。
- 内置 `codex-cli`：`0.148.0-alpha.15`。
- 可用以下命令重新生成当前协议 schema：

```bash
/Applications/ChatGPT\ Matrix\ Runtime.app/Contents/Resources/codex \
  app-server generate-json-schema --experimental --out <临时目录>
```

当前协议明确提供：

- `ThreadStartParams.dynamicTools`；`TurnStartParams` 没有动态工具字段。工具定义属于 thread 代次，不是每一轮随意变化。
- MCP server 状态、工具、资源、资源模板、serverInfo、认证状态和启动状态。
- `mcpServer/tool/call`、`mcpServer/resource/read`、OAuth login、启动状态通知、工具进度通知和表单询问。
- `mcpToolCall` 线程 item，状态为 `inProgress | completed | failed`，带结构化结果或错误。
- turn 状态为 `inProgress | completed | interrupted | failed`，可由宿主投影成真实 UI 状态。

这些字段证明 ChatGPT Runtime 把 MCP 与任务状态当成一等协议对象，而不是靠提示词模拟。

### 2.3 为什么 Ready 不直接打开 Matrix 的全局 MCP

Matrix 原生 MCP 功能更完整，但当前 Ready 不能直接把它全局打开，原因是：

1. Ready 的工具权限按本轮 scope、资源、技能和产品意图冻结；Matrix MCP 配置属于共享 app-server 配置，没有现成的 per-turn Ready allow-set。
2. 当前 Ready 的产品效果账、动作确认和工具回执都围绕 dynamic tool call 建立。原生 `mcpToolCall` 目前被明确列入 opt-out 通知，直接启用会绕开既有准入与回执合同。
3. 同一个 Matrix sidecar 服务多个 Ready 会话；运行中动态改全局 MCP 配置会让旧 thread 的权限边界失真。
4. Ready 的隔离配置明确要求 ordinary turn 只使用冻结 dynamic tools。直接开放原生 MCP 会破坏这个隔离假设。

因此本期最合适的方案是：**保留 Ready 自管的 MCP 连接，把通过准入的 MCP 工具转成 Matrix dynamic tools；借鉴 Matrix 的状态、资源和结果模型，但不让 Matrix 绕过 Ready 直接执行 MCP。**

同时增加负向门禁：隔离 Matrix thread 中出现原生 `mcpToolCall` 时按配置漂移失败关闭，不能静默接受第二条 MCP 通道。

## 3. Ready 当前事实

### 3.1 共用主链

现行生产链是：

```text
用户输入
  -> CodexHostOrchestrator
  -> ingress / product preparation
  -> 冻结 Ready tool surface + turn authorization
  -> Matrix thread/start 或 turn/start
  -> dynamic tool call
  -> Ready tool bridge / product action journal
  -> Main 或 Renderer 产品效果
  -> canonical closeout / projection
```

已存在的 `readToolPublicationBarrier()` 会核对当前 run/thread/turn/call 的工具准入、工具绑定、动作回执、结果摘要和向 Matrix 的交付，但候选中没有工具调用时也能通过。与此同时，普通产品请求常被归类为 `direct_answer/system`，最终只需要 `response_digest`。这就留下了“文字上说做完，产品里没发生”的通用缺口。

### 3.2 MCP

当前真实链路：

```text
mcp_servers_json
  -> parseMcpServersConfig
  -> spawn stdio child
  -> initialize / notifications/initialized
  -> tools/list
  -> Ready registry
  -> dynamic tool schema
  -> tools/call
  -> structured result
```

已有优点：

- 配置错误逐条回显，不会全部静默丢弃。
- server 逐个启动，一个失败不拖垮全部。
- 工具名、schema 和 annotations 已进入目录。
- stdio fixture 已能证明 initialize、list、call 和 close。
- 设置页明确写着 stdio，没有宣称远程已经可用。

未闭合问题：

1. `McpClient` 仍声明 `websocket`，`oauth.ts`、`deferred-filter.ts` 和相关授权接口仍保留草稿，但生产没有可用的 OAuth 登录面或 per-scope 授权闭环。
2. `requiresAuthorization=true` 对本地 stdio 会进入未实现 OAuth，用户没有办法完成授权，工具永久不可用。
3. `ai-capability-groups.ts` 仍把 MCP 描述为“远程 + OAuth + deferred”，与实际产品相反。
4. child 的 stderr 没有持续消费；高日志 server 可能填满管道后卡死。
5. child 继承完整 `process.env`，配置的第三方 server 可能看到与自己无关的应用凭据。
6. 只实现 `tools/list` / `tools/call`，没有资源、资源模板、serverInfo、instructions、进度和 server 状态代次。
7. 设置页是原始 JSON 编辑器，能用但无法安全展示命令、环境变量、风险和单工具确认策略。
8. “保存并重连”会改变 registry，但 Matrix dynamic tools 在 thread/start 冻结；旧 thread 不能原地获得或失去工具。
9. 当前安装数据中没有 `mcp_servers_json`，因此只能证明空配置行为和测试 fixture，不能宣称真实用户 server 已验收。

### 3.3 宠物

已有链路：

- Main 管理独立透明窗口、位置、大小、外观和 always-on-top。
- Preload / Renderer / 设置页均有真实入口。
- Pet window 可显示活动、事件和便利贴。
- Codex 工具注册了显示、移除、清空便利贴。

未闭合问题：

1. `usePetActivityBridge()` 只读取 Renderer 当前选中 scope 的局部状态。切到空闲会话后，其他会话正在运行、等待确认或失败都可能从宠物上消失。
2. 活动状态由 Renderer 推断，不是 Main canonical lifecycle / projection 的权威聚合。
3. 没有跨会话“已完成但未读”的真值，无法实现 ChatGPT Pet 的 Ready 状态。
4. `updateSettings({ enabled: true })` 内部 `void this.show()`；窗口加载失败也不阻止后续创建便利贴和返回“已贴到宠物便利贴”。
5. `sendSnapshot()` 只是发送事件，没有 Renderer 确认某个 snapshot revision 已经应用。
6. 便利贴只存在 Main 内存，重启即消失；成功回执无法证明用户之后还能看到它。
7. dismiss 不存在的 note 也包装为 `success:true`；clear 没有返回清理数量和读回结果。
8. `pet-tool-loop-policy.ts` 与 `pet-stickynote-retry-reminder.ts` 试图靠再次提醒模型补工具调用，但没有形成产品效果证明，也没有生产闭环。

当前安装设置中宠物默认关闭，选择的是 `white-chinchilla-cat`；这只能证明设置可读，不能证明真实便利贴动作已经通过安装版验收。

### 3.4 RSS

已有链路：

- `RSSAutoRefreshScheduler` 在 Main 运行，不依赖 RSS 页面打开。
- 手动与自动刷新复用 `fetchAllRSSFeeds()` 和 `RSSUpdateLock`。
- 刷新结果、条目、未读、订阅源和分析作业都有数据库真值。
- Codex `rss.fetchUpdates` 会等待刷新并读取刷新后的 DB 统计；刷新仍进行时会明确失败，不再假装完成。
- `rss.addSource` 写入后按 source ID 回读。
- `rss.analyzeItem` 已经由 Main 创建 durable job。

安装数据只读快照显示 5 个启用源、3208 条条目、3 小时刷新间隔，并有 2026-08-20 的真实后台完成记录。这说明 RSS 产品本身在运行，不等于 Agent 全链已经闭合。

未闭合问题：

1. `startItemAnalysis()` 创建 `queued` job 后立即返回；Codex handler 把 queued/running 包装为 `ok:true` 和“分析已启动”。用户说“分析并给我结果”时，这不能满足完成条件。
2. `rss_select_item` 仍通过 Renderer 动作桥；缺少 exact item + UI surface generation 的 applied ack。
3. Renderer `useRSSAgentAdapter` 仍在 RSS 页面挂载时注册旧 handler，和 Main 产品桥形成两条语义不同的路径。
4. typed `rss_item` 虽可进入结构化资源，但当前工作面地板主要保证 `rss_capture_session`；“这个条目”没有统一转成分析/选择动作义务。
5. 分析作业的 queued/running/completed/failed 已存在，但聊天终态没有区分“已受理”和“结果已交付”。
6. 部分源刷新失败时需要“完成但有警告”，不能把有结果的刷新全部判失败，也不能把警告吞掉。

## 4. 目标架构

### 4.1 一条产品结果主线

```text
现有意图与结构化资源解析
  -> 冻结本轮动作结果义务
  -> 冻结 thread 工具面 / turn allow-set
  -> Matrix dynamic tool call
  -> Ready exact action claim
  -> 产品效果
  -> Main readback / Renderer applied ack / job terminal artifact
  -> 工具结果交付 Matrix
  -> publication barrier 校验动作义务
  -> canonical done | blocked | failed | unknown
```

模型负责语义选择和组织回复；代码负责路由、授权、执行、结果状态和是否允许完成。不得增加第二个模型来判断“刚才是否真的做了”。

### 4.2 `ReadyActionObligationSetV1`

在 `PreparedCodexProductRun` 中新增一份冻结对象，并由现有 sealed ingress JSON 持久化，不新建平行账本：

```ts
type ReadyActionObligationSetV1 = {
  contract: 'ready_action_obligation_set_v1'
  requirements: Array<{
    requirementId: string
    domain: 'mcp' | 'pet' | 'rss'
    outcome: 'start' | 'effect' | 'renderer_applied' | 'job_terminal_artifact'
    allowedToolNames: string[]
    allowedProductActions: string[]
    target: { kind: string; id: string } | null
    evidence: string[]
    source: 'explicit_action' | 'explicit_resource' | 'explicit_mcp_selection'
  }>
  digest: string
}
```

约束：

1. requirements 是无顺序依赖的 `all_of` 集合，最多 8 项；每个显式产品动作一项。需要先后依赖或目标仍不唯一时，继续使用已有计划/工具循环或先反问，不在此处发明工作流 DAG。
2. 义务由现有 intent resolution、结构化资源，以及用户在本轮输入中写出的完整 canonical MCP 工具名共同生成，不从助手回答反推，也不再写第二套关键词分类器。当前产品只有结构化 MCP 资源选择，没有工具或 server picker，不得把不存在的 UI 选择当成已接线来源。
3. `allowedToolNames` 必须是本轮 allow-set 子集；`allowedProductActions` 必须来自固定 tool -> action 表。MCP 没有 Ready 产品动作时该数组为空，由 exact MCP tool receipt 满足。
4. target 已知时必须冻结稳定 ID；模型参数与 target 冲突时执行 0 次。
5. digest 对不含 digest 字段的 canonical requirements 计算，随 Prepared run 一起校验；任何字段变化都要求新 run。
6. 所有 requirement 都满足才可完成；没有显式动作的普通问答不生成 requirements，保持 direct answer。

### 4.3 终态裁决

扩展现有 `readToolPublicationBarrier()`，在它完成所有现有身份与结果校验后检查动作义务：

| 证据 | 终态 |
| --- | --- |
| 精确工具 + 精确动作 + `confirmed` + action-specific readback | 可完成 |
| 没有工具调用 | `action_obligation_missing`，不能完成 |
| 调了错误工具或错误目标 | fabricated / mismatch，失败关闭 |
| action `proven_absent` 或工具 `ok:false` | failed |
| action `pending` / `indeterminate` / 可能已提交 | unknown 或 blocked，不重试 |
| 只存在助手 response digest | 不能代替产品动作证据 |
| “已启动”但义务要求 terminal artifact | 保持 running/blocked，不能完成 |

候选文本若声称成功但义务没有满足，不发布为成功结果；按现有失败关闭规则收口，下一条用户消息使用新的 thread generation，避免错误成功文本污染后续上下文。

## 5. MCP 完全接线方案

### 5.1 产品边界

本期 MCP 对外只声明：**本地 stdio server**。

- 删除 `websocket` transport 类型、未实现 OAuth/deferred 生产接口、错误能力描述和只服务这些草稿的 gate。
- 设置页不再写“后续版本开放”来暗示现有代码已经半接好；远程 MCP 必须以后按单独计划重新设计。
- `requiresAuthorization` 不再代表 OAuth。替换为 `approvalMode: 'always' | 'writes' | 'never'`，执行确认仍走 Ready 现有行动确认。
- `never` 只允许用户显式设置；未知 annotations 默认按写/外部动作处理，不能自动放行。

### 5.2 配置与子进程安全

把原始 JSON 文本区替换为结构化 server 列表，同时保留“高级查看规范化配置”，避免失去可审计性。

每个 server 的最小配置：

- id、display name、enabled。
- command 与逐项 args；禁止 shell 字符串。
- 可选、掩码显示的 env。
- approval mode。
- 连接/断开与删除。

执行约束：

1. `spawn(..., { shell: false })` 保持不变。
2. 不再继承完整 `process.env`。只传最小系统环境与该 server 明确配置的变量；Ready provider token、gateway token、远程 IM token 等不得泄露。
3. 给每个 server 固定私有 cwd 和数据目录；文件访问范围由 server args / 用户选择表达，不继承 Ready 仓库 cwd。
4. 持续消费并限长保存 stderr；设置页显示最近错误，日志不得输出 env value。
5. 进程 exit、spawn error、协议超时、abort、reload 和 app quit 都进入明确生命周期并清理在途请求。
6. Save 只保存；Connect 才启动命令。首次 Connect 显示 command、args、cwd 和权限摘要并要求确认。

### 5.3 协议能力

在现有 client 上补齐 Ready 声明范围：

- initialize 结果：protocol version、serverInfo、capabilities、instructions。
- tools/list 与 tools/call。
- resources/list、resources/templates/list、resources/read。
- tools/list_changed / resources/list_changed 通知触发 catalog refresh。
- tool call progress 进入当前工具卡，不伪造完成。
- server-initiated elicitation 本期返回结构化 unsupported；不能挂死请求。

server instructions 按不可信外部内容处理：

- 设置页可查看。
- 当本轮已结构化选中该 server 的资源时，其 instructions 可作为 bounded untrusted context 提供给模型。
- 不写入 Ready system/developer instructions，不覆盖技能或产品规则。

MCP prompts 本期不接入。Ready 已有技能承担方法论，直接引入 server prompt 会形成第二套指令优先级。

### 5.4 工具与资源准入

1. 只有 enabled、ready、catalog digest 有效的 server 工具能进入候选目录。
2. 每个工具保留 serverId、remote name、input/output schema、annotations、catalog generation 和 schema digest。
3. 进入 Matrix 的仍是 Ready dynamic tool；调用仍经过 exact turn authorization、Ready action receipt 和结果交付。
4. MCP 资源不自动塞进上下文。用户在设置页、资源选择器或 composer 明确选中后，Main 按 URI 读取，冻结 `serverId + uri + catalogGeneration + contentDigest`，再作为结构化只读资源进入 ingress。
5. resource template 先由用户或代码提供完整参数，再生成 URI；模型不能凭模板字符串扩大任意资源访问范围。
6. 当前工具的显式绑定只来自用户写出且本轮 allow-set 已包含的完整 canonical 工具名；一旦绑定，必须用 exact tool receipt 满足。当前没有 structured MCP tool/server picker，因此未连接或已消失的文本名称不伪装成结构化 pre-model 绑定；普通任务可继续用其他已授权能力。

### 5.5 catalog 代次与 Matrix thread

每次成功连接或 catalog change 生成 `mcpCatalogGeneration + mcpCatalogDigest`。

- Prepared run 记录本轮涉及的 MCP catalog digest。
- active native thread 的 frozen tool surface 只记录真正模型可见的工具面 digest；catalog digest 保留在本轮合同。
- 保存、重连、启停、tools changed 后不修改正在运行的 turn。
- 下一条用户输入重算真正模型可见的 dynamic tool 工具面。只有工具名、说明、schema 或执行合同变化时才退休旧 thread；资源、资源模板、server 元信息或 catalog generation 单独变化只更新本轮 catalog 合同，不切断历史。
- 删除 server 后，旧 thread 不能继续调用其工具；需要立即撤销时直接退休受影响的 active thread，不能等待模型自行不再使用。

### 5.6 MCP 验收

- 空配置：设置显示“未配置”，Matrix 工具面没有任何 `mcp_*`。
- 有效 fixture：initialize、serverInfo、tools、resources、resource templates 均可读；结构化工具结果完整返回。
- noisy stderr：持续输出超过管道容量仍不阻塞 tools/call，设置页能看到限长错误摘要。
- env 隔离：fixture 读不到 Ready provider/gateway/IM secret，只能读到允许的系统变量和显式 env。
- readOnly tool 按策略执行；write/open-world/unknown tool 触发确认，拒绝后 server call 为 0。
- call 超时或连接断开：状态明确，不自动再发第二次调用。
- 保存并重连改变工具 schema：当前 turn 不变；下一输入创建新 thread generation，新旧工具不混用。
- 显式 resource 读取绑定 exact URI/digest；换 URI、换 server 或过期 generation 均拒绝。
- 隔离 Matrix rollout 中出现原生 `mcpToolCall` 时测试失败，证明不存在绕过 Ready 的第二通道。

## 6. 宠物完全接线方案

### 6.1 产品定位

采用 ChatGPT Pet 的正确边界：

- 宠物是任务状态和注意力入口，不是任务执行器。
- 外观、大小、位置、唤醒和收起由用户显式控制；不会改变 Agent 能力或完成结果。
- 点击活动气泡回到准确会话；不能只跳到当前聊天页。
- Ready 特有的便利贴保留为明确产品动作，但与状态投影分开。

### 6.2 Main 侧活动聚合

新增 Main-owned `PetActivityProjectionService`，消费 canonical scope/run/interaction projection，而不是订阅 Renderer 当前 scope store。

跨会话状态优先级：

1. `needs_input`：等待确认、结构化问题或用户决策。
2. `blocked`：cutover 后的未读失败，或仍未解决的系统错误、暂停与外部条件。
3. `ready`：cutover 后已完成且对应 assistant message 尚未被用户看过。
4. `running`：当前仍在执行。
5. `idle`：以上都没有。

同优先级按最近更新时间选择；snapshot 带 `taskId + scopeId + messageId/runId + updatedAt + revision`。点击宠物时 Main 导航到该 scope，并由 Renderer 回传 exact identity 已打开。首次接线创建一次性 durable cutover，不能把功能启用前的历史失败、暂停或阻塞当成新提醒。

Ready 当前没有 Main 侧的会话注意力未读真值。本计划在现有 `chat_conversations` 上增加最小 read marker：最后可见 assistant message ID 与任务投影 seen-at。terminal completed/failed 都受这个 high-water 约束；用户直接加载 scope 也会推进该 scope。Renderer 只能发送“用户已打开这一 exact activity/scope”，Main 校验归属后更新并重新聚合；不能只在本地把气泡藏起来。open blocked/paused 不是一次性通知，查看后仍持续到投影改变。

### 6.3 便利贴产品动作

把 `pet_show_sticky_note`、dismiss、clear 接入现有 `codex-product-action-map` 和产品动作 journal，不再从工具直接操作全局 manager。

显示便利贴的完成证据顺序：

1. 确认当前 exact action authority。
2. 若宠物关闭，等待 `show()` 真正完成；loadURL/loadFile 失败立即失败。
3. 将 note 写入 AppSettings 中有版本的 bounded `pet_sticky_notes_v1` 快照，最多 6 条；记录 noteId 与 content digest。
4. Main 发出带 snapshot revision 的窗口快照。
5. Pet Renderer 应用后回传 `pet:snapshotApplied(noteId, revision, contentDigest)`。
6. Main 验证窗口未销毁、revision 和 digest 一致，再确认 action receipt。

只有第 6 步完成才能回复“已贴好”。如果写入已经发生但窗口确认不明，返回 unknown，并通过 readback 查询同一 note；不得再建第二张便签。

dismiss / clear：

- dismiss 不存在的 ID 返回 `ok:false, reason:not_found`。
- clear 返回真实删除数量和剩余数量。
- 三个动作均持久化后读回，并向 Pet Renderer 等待 exact revision ack。

### 6.4 退役旧路径

共享动作义务落地后删除：

- `tool-policy/pet-tool-loop-policy.ts`
- `system-reminders/pet-stickynote-retry-reminder.ts`
- 只验证提示词重试的旧 gate/tests

`usePetActivityBridge.ts` 不再向 Main 上报任务真值；Renderer 只负责 Pet window 的 snapshot applied ack 和会话导航 read ack。

### 6.5 宠物验收

- 另一个会话在运行时切到空闲会话：宠物仍显示运行中的准确会话。
- 同时存在等待确认、失败、完成未读、运行：严格按上述优先级显示。
- 点击气泡：打开准确 scope；打开后 terminal ready/failed 未读状态清除并显示下一条活动，其他 scope 不受影响；open blocked 仍保持。
- 宠物关闭时调用 show note，窗口加载失败：没有“已贴好”，持久化结果按事务边界可证明 absent 或 unknown。
- 正常 show note：持久化 note、窗口 applied ack、action receipt 三者 ID/digest 一致。
- 重启应用：便利贴仍存在，直到用户明确 dismiss / clear。
- dismiss 不存在 note、clear 空列表均诚实返回，不包装成发生了变化。
- 模型只写“我已经贴好了”但没有 tool receipt：本轮失败，不能出现完成态。
- 改宠物外观不会改变 tool surface、task status 或 Agent 行为。

## 7. RSS 完全接线方案

### 7.1 保留现有 Main 真值

以下能力不重写：

- `RSSAutoRefreshScheduler`
- `fetchAllRSSFeeds()`
- `RSSUpdateLock`
- RSS source/item/analysis job 数据库
- 已有抓取器、诊断、OPML 和分析执行器

ChatGPT Automations 的启发只用于状态模型，不把 RSS 调度器改造成通用 scheduled Agent。RSS 是固定领域后台服务，Main scheduler 比模型定时任务更轻、更可靠。

### 7.2 动作完成合同

| 用户目标 | 动作义务 | 可接受结果 |
| --- | --- | --- |
| 刷新订阅 | effect | fetchAll 已 settle + DB stats readback；部分源错误为 warnings |
| 添加订阅源 | effect | exact source ID 行存在且规范化 URL 一致 |
| 打开/选中条目 | renderer_applied | exact item ID + RSS surface generation applied ack |
| “开始分析” | start | durable job ID，状态 queued/running，明确说“已开始” |
| “分析这个 / 给我报告” | job_terminal_artifact | job completed + report path/digest/readback |

“分析这个”默认解释为要结果；只有用户明确说“开始、排队、后台跑”时才生成 start 义务。

### 7.3 RSS 分析状态

不增加第二个模型循环。处理方式：

1. `rss_analyze_item` 创建或复用 exact item + analysis type 的 durable job。
2. start 义务可在 job queued/running 后结束，回复只说“已开始”，任务卡保持 background running。
3. result 义务在工具调用内等待 bounded terminal window；完成则读回 report file、digest、job ID 和 terminal receipt。
4. 超过等待窗口仍运行时，本轮进入 `background_running` / blocked presentation，不能标 done；RSS 页面继续从 Main job projection 更新进度。
5. 作业完成后只更新产品状态和产物入口，不自动发起新的模型 turn。
6. 用户后续询问结果时，新增只读 `rss_get_analysis_result`，按 job ID 或 exact item + type 读取 terminal job 和报告摘要；没有 terminal artifact 就诚实返回仍在运行/失败。

如果现行公开产品不允许“后台仍运行”的聊天终态，则实现时选择更简单的严格模式：result 义务一直等待到工具 deadline，超时即 blocked；不得退回“已完成”。

### 7.4 typed resource 与 UI 选择

- `rss_item` 明确带 itemId 时，分析/选择缺省使用该 ID；模型传入不同 ID 立即拒绝。
- typed item + 明确“分析/打开”动作生成相应义务；仅引用条目进行问答仍可只读，不自动写/导航。
- `rss_select_item` 改为专用 Main -> Renderer UI command，带 action identity、itemId、expected RSS surface generation。
- Renderer 选中并确认当前列表确实包含该 item 后回传 applied ack；导航失败、条目不可见或页面代次变化都不能回成功。
- 替换完成后删除 Renderer `useRSSAgentAdapter` / `rss-agent-handler` 的 Agent 执行职责；RSS 页面只消费 Main 状态和执行受签名 UI command。

### 7.5 刷新与调度呈现

设置页和 RSS 页面统一显示：

- enabled/paused。
- interval 与 next run。
- 当前 run 的 queued/running/completed/failed。
- 上次完成时间、抓取数量、错误源数量和错误摘要。
- 手动 refresh 与 scheduler 是否合并进同一 in-flight run。

刷新全局完成但部分源失败时返回 `completed_with_warnings`；成功条目和失败列表同时保留。只有整个 fetch 无法启动或没有可信 readback 才判失败。

### 7.6 RSS 验收

- RSS 页面关闭、应用保持运行：scheduler 到点后 DB 条目和 completion receipt 更新。
- 手动刷新与自动刷新撞车：只有一次 fetchAll，两个调用都读到同一最终状态。
- 5 个源中 1 个失败：其余结果入库，状态 completed_with_warnings，错误源可见。
- typed item “分析这个并给我报告”：queued 不能满足；只有 terminal report digest 才完成。
- 明确“后台开始分析”：返回 job ID 和 running，不出现“报告已完成”。
- 分析运行中重启：现有 recovery 将中断状态标明；不会生成伪报告或重复收费/重复执行未知外部动作。
- 选择 item 时 Renderer 未挂载、列表代次变化或 item 不存在：没有成功 action receipt。
- 文档/聊天工作面刷新 RSS 不强制导航；只有 select/open 才切换 RSS。
- 模型只用文字说“已刷新/已分析”但没有相应回执：不能完成。

## 8. 分阶段实施

### P0 · 基线合同与失败复现

目标：先让现有假成功稳定失败，避免后续靠人工观察判断。

改动范围：

- 新增动作义务 schema、digest 与 Prepared run validator。
- 为三域建立固定 intent/typed-resource -> obligation 表。
- 先写 zero-tool、wrong-tool、wrong-target、unknown 的原生回归。

验证：

- 宠物“把这段贴到便利贴”、RSS“刷新订阅”在 zero tool candidate 下均失败。
- 普通问答仍能 direct answer。
- Prepared ingress 篡改 obligation 任一字段均拒绝。

### P1 · 共享终态闸门

目标：让已存在的 tool/action receipts 真正决定是否完成。

改动范围：

- 扩展 `readToolPublicationBarrier()`。
- closeout 映射 missing/failed/unknown，不让 response digest 覆盖动作失败。
- 删除宠物提示词重试路径。

验证：行为矩阵覆盖 0 次、1 次成功、错误工具、错误目标、pending、proven_absent、indeterminate、重复 exact identity。

### P2 · 宠物重接线

目标：Main 全会话聚合 + exact note applied ack。

改动范围：

- `PetActivityProjectionService`。
- 会话 seen marker。
- 持久便利贴 snapshot。
- Pet product action requester / journal。
- Pet Renderer snapshot applied 与导航 ack。

验证：普通行为测试 + SQLite native + 真实 Electron 可视回归。

### P3 · RSS 完成语义

目标：区分 start 与 terminal result，移除页面挂载执行依赖。

改动范围：

- RSS obligation resolver。
- `rss_get_analysis_result`。
- 分析 job terminal readback。
- `rss_select_item` signed UI command / ack。
- 旧 Renderer Agent handler 退役。

验证：后台刷新、部分失败、分析排队/完成/失败/重启、页面未挂载选择失败。

### P4 · MCP 本地 stdio 完整化

目标：一条受控 MCP 通道，工具与资源可用，草稿路径归零。

改动范围：

- 收窄 config 类型与设置页。
- 安全 child env/cwd/stderr/lifecycle。
- initialize metadata、resources、templates、notifications。
- catalog generation 与 native thread regeneration。
- 删除 websocket/OAuth/deferred 草稿与误导文案。

验证：本地 fixture、权限确认、资源 digest、catalog change、env 泄露负例、Matrix 原生 MCP 负例。

### P5 · 总线、设置与安装版验收

目标：公开入口、状态与真实安装行为一致。

改动范围：

- Main IPC、Preload、Renderer 类型、设置页状态统一。
- 权威 runtime 文档与 gate 同步。
- 清理旧测试中“空工具面”“后续开放 OAuth”等过期断言。

隔离安装验收：

1. 使用临时 userData，不碰用户真实数据。
2. 启动本地无费用 MCP fixture，验证工具、资源、重连和 thread generation。
3. 启用宠物，执行便利贴并截图；重启后验证 note 仍在。
4. 用本地 RSS fixture 验证 scheduler、手动刷新、部分失败和分析 job 状态。
5. 从产品公开 readback 读取 action receipt / job / catalog / applied revision，不能只看 UI 文案。

## 9. 文件落点

### 共享终态

- `src/main/modules/agent-control/codex-runtime/codex-product-run-preparer.ts`
- `src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts`
- `src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-task-facts.ts`
- 新增 `src/main/modules/agent-control/codex-runtime/codex-action-obligation.ts`

### MCP

- `src/main/modules/mcp/bootstrap.ts`
- `src/main/modules/mcp/client.ts`
- `src/main/modules/mcp/registry.ts`
- `src/main/modules/mcp/tool-discovery.ts`
- `src/renderer/pages/settings/McpSettingsPanel.tsx`
- `src/main/modules/claude-bridge/ipc/mcp-group.ts`
- `src/main/modules/tools/builtins/install-mcp-server.ts`
- 删除 `src/main/modules/mcp/oauth.ts`
- 删除 `src/main/modules/mcp/deferred-filter.ts`

### 宠物

- `src/main/modules/pet/pet-window-manager.ts`
- `src/main/modules/pet/ipc-handler.ts`
- `src/main/modules/tools/pet-tools.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-action-map.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-action-handlers.ts`
- `src/renderer/pages/PetWindow.tsx`
- `src/shared/pet.ts`
- 退役 `src/renderer/modules/pet/usePetActivityBridge.ts` 的状态上报职责

### RSS

- `src/main/modules/rss-engine/auto-refresh-scheduler.ts`
- `src/main/modules/rss-engine/item-analysis-manager.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-action-handlers.ts`
- `src/main/modules/agent-control/codex-runtime/codex-product-turn-authorization.ts`
- `src/main/modules/tools/rss-tools.ts`
- `src/renderer/modules/rss/useRSSAgentAdapter.ts`
- `src/renderer/modules/rss/rss-agent-handler.ts`
- `src/renderer/pages/modes/RSSMode.tsx`

只有在行为替代已经通过后才删除旧文件；不得先删入口再补新链。

## 10. Gate 与交付要求

新增或扩展一个单一专项入口：`verify:product-capability-wiring`，至少包含：

- 动作义务与 canonical closeout 行为测试。
- MCP stdio、resource、catalog generation、环境隔离原生测试。
- Pet SQLite 持久化、跨会话聚合和 Electron applied ack 测试。
- RSS scheduler、analysis terminal、Renderer selection ack 原生测试。
- Matrix 原生 `mcpToolCall` 不得进入 Ready product turn 的负例。

最终必须同时通过：

```bash
npm run typecheck
npm run verify:product-capability-wiring
npm run verify:codex-runtime-source
npm run verify:stability
npm run verify:native
npm run build
git diff --check
```

专项 gate 必须从真实入口观察结果，不能只搜索源码字符串。Electron ABI skip 不算覆盖，SQLite、设置和持久化行为必须由 Electron native suite 证明。

## 11. 禁止事项

- 不把 Matrix 原生 MCP 和 Ready dynamic MCP 同时开放。
- 不用 prompt、reminder 或第二次模型调用替代动作回执。
- 不把 queued/running 包装为 completed。
- 不把 Renderer 当前页面状态当作跨会话任务真值。
- 不让 MCP child 继承完整 Ready 环境变量。
- 不在运行中的 Matrix thread 原地增删 dynamic tools。
- 不为远程 MCP 保留无法使用的 OAuth/websocket “半成品兼容层”。
- 不复活 DomainAdapter、AgentSdkRuntime、turn-engine、direct-chat 或通用后台 Agent。
- 不因 MCP、宠物或 RSS 改动扩大 shell、文件写或浏览器权限。

## 12. 最终验收清单

- [ ] 动作型请求没有产品回执时一定不能完成。
- [ ] 三域成功都能从公开产品 readback 证明，不依赖助手自述。
- [ ] unknown 结果不自动重试。
- [ ] MCP 只有一条受控执行通道，未配置时工具面为空。
- [ ] MCP 模型可见工具面变化才创建新 Matrix thread generation；非工具 catalog 变化保留对话历史。
- [ ] MCP server 看不到无关 Ready secret。
- [ ] Pet 状态来自 Main 全会话聚合，优先级与导航准确。
- [ ] Pet 便利贴持久化并经过 Renderer applied ack。
- [ ] RSS 刷新、分析启动和分析完成三种状态不混淆。
- [ ] RSS 页面未挂载时后台刷新和分析仍正常，选择动作诚实失败或确认应用。
- [ ] 设置页显示与运行真值一致，无“远程/OAuth 已接”类误导。
- [ ] 隔离安装版行为、截图、数据库/readback 和日志全部通过。

全部勾选前，本计划状态保持 `proposed`；实现完成并通过隔离安装验收后，才可改为 `implemented`。
