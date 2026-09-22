---
title: Ready Codex 产品回合、产物交付与失败历史闭环实施计划
date: 2026-08-18
status: ready
review_status: passed
reviewed_at: 2026-08-18
enforce: false
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-08-11-ready-codex-matrix-wiring-closure-implementation.md
  - docs/superpowers/plans/2026-08-13-codex-workbench-surface-rewire-implementation.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-08-14-codex-surface-hardening-and-split-implementation.md
evidence_inputs:
  - path: /Applications/ChatGPT Matrix Runtime.app
    source_version: 26.814.41407-build-6720
    codex_version: 0.148.0-alpha.15
    codex_sha256: 7645c3caf5607e4528eb3a15b12496c284c2a918939aed34e863c760c1b421e7
    app_asar_sha256: 8fba32f8baa6d984b0f0f4149d3da46221e3adb3b52836f85fe65e31e655a8c0
    role: current_local_comparison
    enforce: false
  - path: build/codex/aarch64-apple-darwin/codex
    source_version: 0.146.1
    sha256: 35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179
    role: pinned_ready_runtime
    enforce: true
  - path: assets/codex-runtime/schemas/stable/codex_app_server_protocol.v2.schemas.json
    source_version: rust-v0.146.1
    sha256: e73b948f24079b1c531a64d5763f4820928b795613b72acf69d5764ba7f5c7e9
    role: pinned_protocol_contract
    enforce: true
note: >
  本计划处理安装版在长文最终写出时终止、文件未落盘、失败后本轮历史消失的问题。
  Matrix Runtime 只作为同形宿主设计的本机证据；不复制其二进制、凭证、任意工作区权限，
  也不以升级 Ready 随包 Codex 代替 Ready 自身的接线修复。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Codex 产品回合、产物交付与失败历史闭环实施计划

## 0. 架构裁决

这不是一次“把 4096 调大”的修复，也不应在现有主链外再搭一套文件交付、失败历史和重试系统。

最小且完整的改法是把 Ready 已经拥有但尚未真正收口的产品回合扶正：

    Provider Responses SSE
      → Ready gateway（CodexProviderStreamPolicy）
      → bundled Codex / app-server
      → 现有 ReadyCodexLifecycleAdapter / CodexTurnCollector
      → CodexProductTurn（现有 codex_turn_bindings 与既有回执）
      → 产品发布封印与唯一 closeout
      → ProductTurnPresentation
      → Renderer 同一收据归并

文件交付不是旁路，而是产品回合中的一种有外部副作用的 ArtifactDeliveryItem：

    required → staged → exported → verified
                   ↘ failed / indeterminate

本计划只允许两个新的运行时边界：

1. CodexProviderStreamPolicy：只处理 gateway 内的 response.* Provider SSE，区分增量、结构事件、终态、字节和 idle。
2. ArtifactMaterializer：负责暂存和导出的串行、比较、原子替换与写后回读。

其余职责全部收回现有结构：

- ReadyCodexLifecycleAdapter 与 CodexTurnCollector 继续归并 app-server 的 thread/turn/item 通知；不新建第二个下游适配器。
- PreparedCodexProductRun 冻结本轮产品合同。
- codex_turn_bindings 是唯一产品回合聚合根。
- 现有 tool admission、binding、action receipt 和 response delivery receipt 继续作为工具副作用真值。
- 现有 publication receipt 扩展为整个产品回合的发布封印。
- 现有 canonical closeout 合并成功、失败、取消和中断。
- Renderer 只消费 Main 生成的产品回合投影，不再持有第二份历史或终态真值。

明确不新增：

- 第二张原生事件或“旁白”历史表。
- 独立 FailureCloseout、DeliveryFinalizer、HistoryRepository、FailureClassifier 服务。
- FolderGrant、WorkspaceBinding、OutputObligation、RetrySnapshot 等并列对象。
- 模型可见的复杂分片协议或缺少应用证据的 1 MiB 总文件上限。
- 自动 successor、旧 Dynamic Delivery、第二套模型循环或任意工作区写权限。

一句话目标是：一个回合账本、一次发布封印、一个可见终态。

## 1. 完成标准

### 1.1 文档完成

本计划只有同时满足以下条件才可标为 ready：

- 安装版故障由日志、数据库、包体和真实调用链互相印证。
- Matrix 对照绑定当前本机签名安装体，不沿用旧快照冒充当前事实。
- 每个根因都有对应的下一层风险、机器合同、施工位置和安装版验收。
- 方案复用现有账本和 closeout，不形成第二条产品主链。
- 独立复审未发现新的真值源、兼容旁路或无法验证的成功条件。

### 1.2 实施完成

后续实施只有达到第三档才算真正完成：

1. 源码通过：红测转绿，专项 gate、SQLite 原生验证、类型检查和构建通过。
2. 包体通过：同一提交产出的 App/DMG 通过运行时身份、结构、签名和哈希验证。
3. 安装版通过：从该包安装的 Ready 在隔离资料目录中跑通长参数、长时流、真实暂存、真实导出、故障注入、重启恢复和显式重试；界面、数据库与目标文件三方一致。

计划通过、候选代码通过焦点测试或生成了 DMG，都不等于安装版完成。

## 2. 本次事实基线

### 2.1 身份

| 对象 | 当前证据 | 作用 |
| --- | --- | --- |
| 诊断时源码 | codex/cod-ready，HEAD b40030bea6534f215ef1c5f23decef5d2bb95e1c | 取证基线；脏改不视为已验收 |
| 安装版 Ready | 0.7.9-a | 本次故障应用 |
| 安装版 app.asar | SHA-256 1afe435fa73cab864a226dbba40dafcbf227f6794bfa92a09875939120cf12e4 | 故障包身份 |
| Ready 固定 Codex | 0.146.1，SHA-256 35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179 | 本次强制协议 |
| Matrix Runtime | 26.814.41407，build 6720 | 当前本机对照体 |
| Matrix Codex | 0.148.0-alpha.15，SHA-256 7645c3caf5607e4528eb3a15b12496c284c2a918939aed34e863c760c1b421e7 | 只做设计对照 |
| Matrix app.asar | SHA-256 8fba32f8baa6d984b0f0f4149d3da46221e3adb3b52836f85fe65e31e655a8c0 | 静态宿主接线身份 |

08-11 计划中的 0.147 alpha 和 08-15 证据中的 26.810.50856 都是历史快照。实施时必须重新核对上述身份；Ready 的强制能力仍以随包 0.146.1 schema 为准。

### 2.2 安装版失败 run

失败 run：req-1786870521620-qhmizy。

| 证据 | 事实 | 排除或证明 |
| --- | --- | --- |
| ready-directchat.log | 08:55:21 开始，08:58:42 以 terminal_failure_after_persistence 返回 | 不是单纯 Renderer 看门狗超时 |
| engine terminal candidate | stream disconnected before completion: gateway_native_event_limit_exceeded | 第一断点在 Ready gateway |
| run_meta | status=error，terminal_reason=blocked_external | 错误又被误归类成外部阻塞 |
| 工具持久账本 | 10 个调用均有绑定、动作和结果交付回执 | 调研动作没有被数据库删除 |
| 工具构成 | 5 次 web_search、3 次 session_search、1 次 file_inventory、1 次完成条件声明 | 失败前调查真实存在 |
| 写出调用 | skill_write_artifact=0，skill_export_artifact=0 | 文件工具未执行，而不是执行后丢文件 |
| chat_messages | run 开始后 assistant 消息数为 0 | 失败 closeout 没写可见消息 |
| 旧会话消息 | 仍在数据库 | “全部消失”是终态投影缺口，不是删库 |
| SQLite | integrity_check=ok | 不是数据库损坏 |

直接因果链：

1. 长 skill_write_artifact 参数被拆成大量 function_call_arguments.delta。
2. Ready 把每条 delta 当作一个结构事件，达到 4096 后主动断流。
3. 工具参数尚未组成完整 JSON，写入工具从未被调用。
4. failure-only closeout 只写 run 和任务终态，没有插入 canonical assistant message。
5. Renderer 收到失败事件后先清 streamingRequestId；稍后的发送返回又要求该 ID 仍匹配，因此不再补失败正文。
6. 冷启动把 toolTrace 初始化为空，既有工具回执没有重新投影，形成“文件没写出、历史也被吞掉”的组合症状。

### 2.3 当前候选改动的边界

诊断时工作树已有大量未提交改动。与本故障相邻的候选包括 delta 排除集、文件夹能力地板、路径别名、预算加二和路径芯片。它们只能作为待审候选，不能视为修复完成：

- 四种 delta 黑名单不能覆盖未来新增的合法增量。
- 5000 条 output_text.delta 不能证明真实 function_call_arguments.delta 最终能调用工具。
- 120 秒仍是整条流的绝对期限。
- 8 MiB 网关、2 MiB sidecar 单行与 50 MiB writer 仍不是一份可达容量合同。
- reservedExportToolCalls 只是增大总额度，调研仍可把所谓保留额度吃掉。
- 模型仍可能靠名称、别名或绝对路径猜目标文件夹。
- append 不是原子比较更新，断线后可能重复追加。
- 失败 closeout、历史重建和 Renderer 竞态尚未闭合。
- verify:streaming 与 release structural 仍未真正覆盖这条 Codex 写出闭环。

实施必须逐项按本计划取舍，不能整批接收或整批提交现有脏改。

## 3. Matrix Runtime 对照

### 3.1 为什么可以参考

当前 Matrix 和 Ready 固定版本都具有本故障所需的同形协议：

- Thread、Turn、Item 的稳定身份。
- item started、增量、item completed 与 turn completed。
- 动态工具调用和结构化工具结果。
- thread read、turn/item 列表、resume、interrupt 与结构化错误。

0.148 新增的 queue、section、revert、plugin search 等不是这次修复的前提。升级 Codex 不能替代 Ready 宿主接线修复。

### 3.2 借鉴的设计

从当前本机 Matrix 宿主与 schema 中只提取五个原则。这里的 turn/item 指 app-server 通知层，不是 Ready gateway 上游的 response.* SSE：

1. 高频 delta 属于 item 内容，不是 turn 生命周期计数。
2. turn terminal 只改变终态，不能删除已经完成的 item。
3. 恢复时先读 canonical history，再按稳定 turn/item ID 合并缓冲通知。
4. dynamic tool-call execution path 有 host/thread/turn/call 的精确 owner 与唯一 claim。
5. 本机 macOS Matrix 的文件物化会绑定已存在的 regular file，按路径串行，在操作内重新校验权限和 realpath，使用预期状态或哈希、同目录临时文件、fsync、原子 rename 和最终哈希回读。

### 3.3 Ready 不能照抄的部分

Ready 有 Matrix 不替它负责的产品事实：

- Ready 的稳定身份是 scope、messageVisibilityEpoch 与 readyRunId；native generation 只是一次运行实例。
- 两版 schema 都说明 ThreadItems 的持久恢复是有损的，command execution 等交互不保证完整存在。
- 目标文件夹、冲突策略、交付义务和用户可见历史属于 Ready 产品层。
- Ready 必须保留自己的工具 admission、binding、action receipt 和 result delivery receipt。
- Ready 只能发布已接受的最终正文；失败时由 Ready 根据结构化事实生成说明，不能公开半截正文或推理内容。
- typed 文件夹仍是窄授权目的地，不是通用 workspace 或 shell 权限。
- Matrix 当前可证明的是“更新一个已经精确绑定的 regular file”；Ready 在空文件夹创建新文档、create-only 不覆盖和跨平台替换都是 Ready 自己必须补合同、实现和测试的扩展。
- “产品终态后拒绝迟到工具结果”是 Ready 基于 durable action ledger 的自定不变量，不能写成 Matrix 已替 Ready 保证。

因此目标不是“让 Ready 像 Matrix 一样拥有更多能力”，而是让 Ready 学会 Matrix 的 turn/item 归并方式，同时继续自持产品副作用证据。

## 4. 根因层级与下一层风险

| 层级 | 已证明的问题 | 只修表面会暴露什么 | 本计划裁决 |
| --- | --- | --- | --- |
| L0 Provider 流 | gateway 的 4096 把工具参数 delta 当结构事件 | 新 delta 类型再次误杀，或直接删上限后失去风暴保护 | gateway 内正向事件分类；结构数、字节和 idle 分开 |
| L1 传输容量 | 8 MiB stream、2 MiB sidecar 单行、50 MiB writer 不可同时到达 | 4096 修完后在更后面的单行或总字节处断 | 从最窄 transport 实测推导单次内联上限；大产物走带哈希的带外物化 |
| L2 超时 | 120 秒是绝对流期限 | 长任务持续有进展仍在写出前被杀 | transport 改 idle deadline；产品无进展期限由 turn owner 单独管理 |
| L3 准入 | 文件夹资源、写工具、暂存根、输出义务和预算多处猜测 | 无技能不出工具、同名目录误投、调研吃光写出额度 | 一个嵌套 outputContract 随现有 turn 合同冻结 |
| L4 暂存 | 当前 overwrite/append 缺少版本比较、串行和原子替换 | 重试重复追加、崩溃留下半文件、不同 run 串写 | 一个 ArtifactMaterializer，callId 幂等加 baseVersion 比较 |
| L5 导出 | 绝对路径和“工具成功”不能证明目标文件正确 | 同名目录、符号链接、跨卷、覆盖冲突、写后丢失 | resource ID、目录身份、目标预期状态、同目录原子替换、哈希回读 |
| L6 发布 | native completed 或模型说完成即可收尾 | 文件未 verified 仍显示成功 | 扩展现有 publication barrier，所有 required item verified 才能成功 |
| L7 closeout | 失败通道不写消息 | 数据库有回执但界面没有失败说明 | 所有终态走唯一 canonical closeout 事务 |
| L8 Renderer | scope event 和 send return 各自改状态 | 先到事件清锁，后到正文被 ID 门拦截 | 三个入口只应用同一种 ProductTurnReceipt |
| L9 恢复与重试 | 冷启动 toolTrace 为空，重试没有副作用对账 | 重复搜索、重复写、重复导出或再要一次文件夹 | 从产品回合账本重建；显式新 run 只存 predecessor 并先 reconcile |
| L10 发布门 | streaming gate 不跑 Codex gateway 写出链 | 源码焦点测试绿但同类回归仍进安装包 | 新完整 gate 接入 streaming、stability 和 release structural |

这十层是一条链，不是十个独立补丁。P1 必须先把“产品回合与可见终态”收成一个真值，P2 才把文件交付纳入这个回合。

## 5. 唯一权威与数据流

### 5.1 产品回合聚合根

现有 codex_turn_bindings 已经包含：

- ingress admission 与 turn contract digest。
- predecessor_run_id 与 attempt_kind。
- native thread/turn 身份。
- engine terminal candidate。
- publication receipt。
- product terminal 与 closeout 时间。

它应被正式定义为 CodexProductTurn 聚合根，而不是再建一张 run history 或 delivery turn 表。

run_meta、task_projections、canonical chat message、Renderer 时间线都是该聚合根的不同投影。任何投影不得单独决定产品终态。

### 5.2 既有副作用账本

以下表继续是唯一工具事实：

- codex_tool_call_admissions：调用是否被本轮授权。
- codex_tool_call_bindings：native call 与 Ready action 的精确归属。
- ready_tool_action_receipts：动作 pending、confirmed、proven_absent 或 indeterminate。
- codex_tool_response_delivery_attempts：已确认结果是否写回精确 native RPC。

不复制工具状态到新表。ProductTurnPresentation 只读取并归并这些事实；canonical message meta 可以保存有限、脱敏的展示摘要和摘要哈希，但不能成为工具状态真值。

### 5.3 一条收尾事务

删除 commitCodexFailureCoreCloseout 的独立语义。统一为一个产品回合 closeout：

    commitCodexProductTurnCloseout(
      status,
      publicMessage,
      failureEvidence,
      publicationSeal
    )

它在现有 canonical closeout transaction participant 内一次提交并回读：

- codex_turn_bindings 的产品终态和 publication seal。
- run_meta 终态。
- task_projections 终态。
- 一条 Ready-owned canonical assistant message。
- ProductTurnReceipt 的 revision 与 digest。

成功、失败、取消和中断只是在同一事务中的不同状态，不再走不同持久化主链。

若事务未提交，不得先向 Renderer 发 terminal 事件或清空 live 内容。已有 product fence 留给当前进程或启动恢复继续对账；界面可以显示非终态的持久化异常提示，但不能伪装成已经完成的失败终态。

### 5.4 产品回合展示

新增只读查询，不新增历史仓库：

    readProductTurnPresentation(readyRunId)

它必须在一个 SQLite read transaction/snapshot 内，从聚合根、第一次 confirmed completion criteria、既有工具/交付/readback receipts 和 canonical message 生成有界、可分页的 ProductTurnReceipt，至少包含：

- readyRunId、scope、messageVisibilityEpoch 和终态。
- canonical message identity、正文和 digest。
- 已完成工具的脱敏摘要。
- 每个产物的 staged、exported、verified、failed 或 indeterminate 状态。
- failure kind、effect state 与可安全重试策略。

presentation digest 必须覆盖 turn identity/revision、publication seal、canonical message ID/digest，以及所有被引用 receipt 的 ID/revision/digest，不能只看 turn.revision。terminal ProductTurnReceipt 一经 closeout 即不可变；散读不得拼出一半新、一半旧的 torn receipt。

查询只解析展示所需的脱敏摘要和受限大小字段；单个历史 result_json 缺损、过大或无法解析时返回 degraded item 与证据引用，不能让整段会话加载失败。

不持久化原始 reasoning，不把半截模型正文变成历史。用户可恢复的历史边界是：用户输入、已完成工具活动、文件交付状态、Ready 生成的失败说明和已接受的最终答复。

### 5.5 既有失败历史修复

这次已经发生的 req-1786870521620-qhmizy 不能因未来路径修好而永久留白。启动迁移/reconciler 只处理可证明的旧 failure-only closeout 形状：

- post-admission ProductTurn 已有 terminal digest。
- run_meta 与 task_projection 已终态。
- 同一 visibility epoch 下不存在该 run 的 canonical assistant message。
- engine candidate、工具回执和消息归属均能完整核对。

满足时，以 readyRunId 派生确定性 message ID，在写路径的单一事务中补一条“历史失败已恢复”消息和 presentation digest；正文只陈述可证明的工具数量、文件阶段与失败原因，不伪造成当时的模型答复。重复启动幂等。证据不完整时不猜测，由 presentation 返回 degraded recovery item。

该修复只能在显式 startup migration/reconciler 中写入，readProductTurnPresentation 仍是纯读，继续满足 no-readpath-terminal-write。

## 6. 七条机器不变量

### I1 精确归属与有界流

每个 Provider SSE 事件必须归属唯一 response，item-scoped 事件还必须归属唯一 output item；app-server 通知必须归属唯一 thread/turn/item。Provider 增量不消耗结构事件计数，但必须消耗真实 wire bytes、单 item held bytes，并刷新有效进展的 idle deadline。固定 registry 明确列出的无语义扩展才可忽略；未知内容、工具或终态事件按协议错误关闭。

### I2 一个产品回合一个终态

每个 post-admission readyRunId 最终恰有一个 ProductTurnReceipt。native terminal、scope event、send return 或启动恢复都不能各自再创造第二个产品终态。

### I3 工具状态只认既有回执

任何工具已执行、未执行或结果未知的判断，只能来自既有 admission、binding、action 和 delivery receipt。native history 与 Renderer trace 只能补展示，不能覆盖这些事实。

### I4 文件成功必须有外部回读

存在 typed folder/outputContract 时，成功前必须先有 confirmed folderOutputIntentReceipt；no_write 不产生义务，正 intent 的 publication seal 必须覆盖所有 required ArtifactDeliveryItem，并记录精确 destination resource、目录身份、相对路径、字节数、SHA-256 与目标 readback receipt。staged 或 exported 都不等于 verified。

### I5 所有终态都有可见消息

每个 post-admission 成功、失败、取消或中断，都必须在同一 closeout 事务内提交 Ready-owned canonical message。失败消息来自 typed failure 与持久回执，不发布未接受的 native candidate。

### I6 Renderer 只归并同一种收据

scope terminal event、sendScoped 返回和冷启动 readback 都应用同一 ProductTurnReceipt。三者任意顺序到达结果相同；旧 run 或旧 revision 永远不能覆盖新 run。

### I7 重试先对账再行动

显式重试是一个真实用户输入触发的新 run，使用既有 predecessor_run_id 与 attempt_kind=explicit_retry。confirmed 副作用不重做，indeterminate 先 readback，资源和权限必须重新核验。

## 7. 轻量重构设计

### 7.1 CodexProviderStreamPolicy

4096、8 MiB 和 120 秒都属于 Ready gateway 消费 Provider Responses SSE 的上游边界，不属于下游 CodexTurnCollector。

CodexProviderStreamPolicy 从 codex-model-gateway.ts 抽出纯策略，复用当前 allowed-event registry，并给每种 response.* 事件明确分类：

- delta：output_text、refusal、reasoning_summary_text、function_call_arguments 等内容增量。
- structural：response created、output_item added/done 和已登记的生命周期变化。
- terminal：response completed、failed 或 incomplete。
- ignored-extension：固定 registry 明确登记、经证明不携带内容、工具或终态语义的扩展。

保护规则：

- 现有 4096 只约束 structural；第 4097 个真实结构事件仍失败。
- delta 数量本身不设上限，但总 wire bytes 和每 output item held bytes 仍有上限。
- 每次 delta 先校验 response/item owner、字段和累计字节，再拼接；不得先占内存后校验。
- terminal 对同一 response 只接受一次；terminal 后的内容事件拒绝。
- 未登记的内容、工具或终态事件按协议错误关闭，不能默认忽略或默认归入 delta。
- request body、Provider headers/first byte、相邻有效事件 idle、terminal drain 使用四个独立期限；headers/first byte 仍是绝对 deadline，不能机械地把同一个 streamDeadlineMs 全改成滑动计时。
- 只有通过身份/字段校验并推进 response/item 状态或增加合法 bytes 的事件才能刷新 idle。
- 产品层无进展期限继续由现有 turn owner 管理，不能伪装成 gateway 断流。
- 连续小事件仍受总 wire bytes、产品预算和 exact user cancel 约束；测试必须证明它不能绕过取消或无限制造结构状态。
- Provider 流容量/协议失败不得自动重启仍健康的 sidecar；只有进程或连接健康证据失败才进入 sidecar 恢复。

关键测试必须跨越真实层级：

    Provider 发出 5000 条 function_call_arguments.delta
      → gateway 完整转发
      → bundled Codex / app-server 形成一个 dynamic tool request/item
      → Ready action 执行一次
      → tool result delivery 一次

### 7.2 现有 Collector 的 turn/item 归并

Matrix 的恢复原则落在现有 ReadyCodexLifecycleAdapter 与 CodexTurnCollector，不新增第二个 adapter：

1. 恢复期间先缓冲 app-server 通知，不向产品投影提交。
2. 对精确 thread/turn 执行 canonical read。
3. 按 item ID 合并：completed item 丢弃旧 delta，未完成 item 只补未持久前缀。
4. 再按接收序归并缓冲通知。
5. 只有 owner、connection epoch 与 turn identity 均未变才放行。
6. ProductTurn 已终态时，Ready 依据 durable tool binding/action ledger 拒绝迟到工具结果。

### 7.3 outputContract

不给 PreparedCodexProductRun 增加五个平级对象，只增加一个可选嵌套字段 outputContract，并随现有 ingress_json 与 turnContractDigest 一次冻结。

它只保存 immutable policy：

- destination logicalResourceId。
- 发送时文件夹 realpath、平台可用的目录身份（macOS 的 device/inode，Windows 的 volume/file identity）和资源版本摘要。
- artifact namespace=readyRunId；绝对 staging root 仍只由 Materializer 的宿主配置派生。
- 本阶段只允许 create_only 或 same_hash_idempotent，不实现覆盖不同内容。
- required output policy：正 intent 激活后的最少数量、最多数量、允许类型和是否必须导出。

本阶段只接受一个 current-turn typed destination。存在多个文件夹时先用结构化反问让用户选择，宿主和模型都不能按名称、顺序或历史静默挑选。

当前 turn 恰有一个 typed 文件夹、且代码侧行动授权允许该精确 resource 时，admission 冻结一个“待语义激活”的 outputContract：

- declare_completion_criteria 是该 turn 的无条件 floor。
- write/export 是 frozen surface 内的 dormant conditional entries；激活谓词随 outputContract 与 turnContractDigest 冻结。
- activation=pending 时，provider-facing effective subset 排除 write/export，dispatch 和 tool-group admission 也不得为它们留下 admitted 记录。
- 代码侧 action authorization/用户确认继续独立生效；正 intent receipt 不能替代安全确认。

不新增 preflight 模型调用。现有模型可见 declare_completion_criteria 扩展一个结构化 folderOutputIntent=create|save|export|no_write；destinationResourceId 由宿主从 frozen outputContract 盖章，不让模型自由填写。第一次 confirmed action receipt 绑定当前 user message ID/digest、宿主目标和 expected_outputs：

- 模型只做 create/save/export/no_write 的语义判断。
- 代码只认这份 receipt，并负责资源、权限、预算、路径和状态转移。
- 有 typed folder 的 turn 在成功 closeout 前必须取得一次声明；no_write 不激活写权，也不产生输出义务。
- create/save/export 只有在 receipt 与 frozen destination 完全匹配、且该 tool result 已成功交付 app-server 后才激活 conditional write/export。
- 激活只对下一次 Provider iteration 生效；declare 与 write/export 同 group、同 iteration 时，副作用调用确定拒绝、零 admission、零 action。
- no_write 永久保持 dormant，下一步只进入 final lane。
- 语义不确定时模型必须声明 no_write 或结构化询问用户，不能猜。

现有 hasExplicitFolderExportIntent 关键词正则必须退役，不能继续靠补同义词授权。无技能但 receipt 为正时，宿主仍能使用同一条件工具；选了技能也不能扩大到别的目录。显式 retry 可引用 predecessor 的正 intent receipt，但仍要绑定新的真实用户输入并重新核验目录身份。

模型不接触绝对目标路径。file_inventory 与提示可展示人类可读标签，但 skill_export_artifact 只接受冻结的 logicalResourceId 与相对目标路径。重名文件夹靠 ID 和目录身份区分，不靠名称猜测。

正 intent receipt 把 expected_outputs 冻结成具体 ArtifactDeliveryItem：

- 不能把最少数量减为零。
- 不能超过合同最大数量。
- itemId 固定为 turnContractDigest、destinationResourceId 与规范化 relativePath 的摘要。
- 后续 completion criteria 不能改变已冻结路径或数量。
- 没有这份 confirmed receipt，write/export admission 必须拒绝。

ArtifactDeliveryItem 不是新表或 mutable JSON 状态机。required 集合来自这份 confirmed action receipt；staged/exported/verified 只由既有 confirmed write/export action receipt、response delivery 与目标 readback receipt 纯折叠得到。task_projection 只展示该 fold，不能写回或改判状态；publication seal 冻结本次 fold 使用的全部 receipt refs 与 digest。

### 7.4 ArtifactMaterializer

ArtifactMaterializer 统一暂存与导出的文件语义，现有 skill_write_artifact 和 skill_export_artifact 只做授权、参数转换和回执接线。

暂存规则：

- staging root 由宿主 base 与 readyRunId namespace 决定，不从 skillId、session fallback、当前 workspace、合同绝对路径或模型路径推导。
- 同一 run 内每个相对路径串行；不同 run 永不共享可写路径。
- 现有 native call/action ID 是幂等操作 ID，不再增加 chunkId。
- 每次写入携带 expectedVersion；成功返回新 version、segment bytes/hash、累计逻辑 bytes 与 manifestDigest，不在每次 append 后重新扫描整份文件。
- replace 创建新的逻辑版本；append 在 expectedVersion 上增加一个 host-owned immutable segment。segment 由 call ID、bytes/hash 和 action receipt 标识，模型不传 chunkId。
- 逻辑 manifest 只引用 immutable segment，并以 content-addressed immutable 文件保存；当前版本仍只由按序 confirmed write action receipts 的 baseVersion/newVersion/manifestDigest 链决定，manifest 文件不能成为第二真值。
- 导出时按该 receipt chain 流式合并到一个目标临时文件，避免每次 append 复制全文件造成平方级写放大。
- 整份逻辑文件 SHA-256 在导出/发布前的单次流式合并中计算，写入 finalized staged receipt；重试复用该 receipt，不重复全量哈希。
- implementation 必须冻结最大 append 次数与累计 bytes，并对最大产品文件做时间、峰值内存和磁盘放大基准。
- 同一个 call ID 重放只返回原回执，不重复落盘。
- 崩溃点无法证明写入是否生效时记为 indeterminate，恢复先按路径、版本、大小和哈希 readback。

统一读取规则：

- ArtifactMaterializer 同时提供唯一 readVersion/streamVersion(readyRunId,itemId,version)；不能只改 write/export。
- Codex folder-output 路径下的 skill_read_artifact、export、retry copy-on-write、artifact inventory/handoff 读取都使用 logical artifact ref + version，通过这两个入口消费 receipt chain。
- 模型和 Renderer 不再收到一个实际不存在的 staging absolutePath；返回 logicalArtifactRef、version、bytes、manifestDigest，以及 finalized 后的 logical SHA-256。
- shared 非 Codex skill 继续使用原有 physical artifact path，不因本计划被强制迁移。
- 同轮读取、应用重启读取、重试读取和最终导出必须得到相同 bytes/hash。

容量规则：

- 不新增无依据的 1 MiB 总文件上限。
- 单次模型内联 content 上限必须用 2 MiB sidecar 单行、8 MiB Provider stream 和最坏 JSON 转义实测反推，由测试锁定，并写入 Codex 可见 schema/提示。
- 累计文件上限沿用真实产品上限，除非新的资源和磁盘证据支持调整。
- 普通 UTF-8 长文通过两次以上 expectedVersion 写入组成；中断重放仍只接受一次 segment。
- 二进制或专用生产工具不把大块内容搬进 JSON，而是直接写 run staging，并返回 source ref、版本、字节和哈希回执。
- shared primitive 若仍服务非 Codex 调用，不因本计划全局删除 base64；Codex surface 单独收窄。

导出规则：

- 输入是 destination logicalResourceId、相对目标路径、expected staged version/hash 和 expected target state。
- 操作开始前重新核对文件夹 realpath、设备/目录身份、授权代次和目标父目录。
- 拒绝符号链接跳转、资源身份漂移和越界路径。
- 先把逻辑 staged 内容复制到目标目录的完整临时文件，使最终提交始终同卷。
- create_only 必须使用平台实测的原子 no-replace 原语；目标在最后一刻出现时返回 EEXIST/conflict，禁止 check-then-rename。
- 目标已存在时，只在读取精确文件身份、哈希相同且路径身份复核仍一致后作为 same_hash_idempotent 成功。
- 目标已存在且哈希不同一律 conflict；本阶段不实现 replace_exact，也不偷偷改名、短暂覆盖或覆盖后补救。
- macOS 路径执行临时文件 fsync、no-replace commit、目录 fsync 与最终 readback；Windows 使用对应的 no-replace/flush 语义和本机测试，不能照搬 macOS rename 假设。
- commit 后、回执前崩溃属于 indeterminate；恢复以精确目标身份、bytes 与 hash readback 决定 confirmed 或 proven_absent。

### 7.5 产品发布封印

将 readToolPublicationBarrier 扩展为 readProductPublicationBarrier，不新增 Finalizer：

- 继续核对 native candidate 中每个 tool call 的 admission、action receipt 和 response delivery。
- 若无 outputContract，沿用现有工具发布条件。
- 若有 outputContract，从第一次 confirmed completion criteria 及既有 action/delivery/readback receipts 纯折叠 ArtifactDeliveryItem，再核对数量、稳定 ID、当前 staged version、export receipt 与目标 readback。
- success seal 前对精确目标再做一次 fresh path identity、bytes 与 hash readback，不能只信较早的 export 返回。
- publication_receipt_refs_json 同时引用工具结果和文件交付回执。
- publication receipt digest 成为 success closeout 的唯一 seal。

以下状态不得发布成功：

- 必需 item 未创建。
- 只有 staged、没有目标 export。
- export 调用返回但目标 readback 不匹配。
- 任一副作用 indeterminate。
- 目标文件夹身份或授权代次已漂移。
- 模型正文声称完成但 seal 不完整。

### 7.6 交付额度

删除“总工具额度加二就是保留”的算法。现有 productBudgetSeed 在同一冻结对象内明确 ordinary、delivery、final 三类额度：

- ordinary 仍按当前任务类型限制 research、普通工具调用和对应 iteration。
- delivery 在 activation=pending 时只允许 declare_completion_criteria，以及已经存在 pending question 时的结构化反问；正 intent 已 durable 且结果已交付后，才允许推进未完成 item 的 write、export 与核验。
- final 独立保留最后一次无工具回答 iteration，不能被 ordinary 或 delivery 消费。
- delivery lane 上限由 required item 最大数量和允许的状态转换推导，在 admission 时冻结并写入现有 budget snapshot。
- frozen tool surface 与 digest 始终不变；ordinary 耗尽时，activation=pending 仍必须保留声明工具，positive 才按 receipt fold 保留 item delivery 子集，no_write 才进入 final。gateway authority 只能从冻结 surface 确定性收窄，不能另造授权快照或提前 forceToolFreeFinalization。
- tool-group admission 按代码拥有的 tool name、item state 与 receipt fold 给对应 lane 记账，不能读 task_projection 或 Renderer。
- 具体数值必须在 P2 用一文件、多文件、超单次 content cap、冲突和失败重试场景测得；不能再写死“无论几份文件都加二”。
- 未消耗的 delivery lane 不能转回 research，也不能让模型增加输出数量。

这保证“调研做满后仍能交付”，同时不会给普通任务无限续命。

### 7.7 统一失败与错误归类

错误只保留会改变恢复策略的少数类别，并在 CodexProviderStreamPolicy、现有 Collector、工具边界或 closeout support 中直接产生，不另建分类服务：

- transport：连接断开且副作用状态可判定。
- protocol：事件、身份或摘要违反固定合同。
- provider：上游明确拒绝或失败。
- tool_effect_unknown：动作是否生效未知。
- artifact_delivery：暂存、导出、冲突或 readback 失败。
- cancelled：用户或受信 owner 取消。
- persistence：产品 closeout 尚未成功提交。

每个 TurnFailure 同时带 effectState、retryPolicy 和 evidenceRefs。用户文案由 Ready 模板生成，至少说明：

- 已完成的调查和工具活动仍被保留。
- 文件目前是未暂存、已暂存未导出、目标未知或已验证中的哪一种。
- 是否可以安全重试，重试前会先做什么核对。

publication_diverged 可以退役 native generation，但不得推进 messageVisibilityEpoch、清空 Ready 历史或阻止下一条真实用户输入。

### 7.8 Renderer 与冷启动

Renderer 只保留一个幂等归并动作 applyProductTurnReceipt：

- scope terminal event、sendScoped 返回与冷启动 readback 都提供同一 receipt 形状。
- key 是 scope、messageVisibilityEpoch、readyRunId、revision 与 canonical message ID。
- 同 revision 重放无副作用；高 revision 覆盖低 revision。
- 迟到的旧 run receipt 仍按 readyRunId upsert 到它自己的历史位置，不能直接丢弃；但只有当前 foreground owner 的 receipt 可以改变 composer lock、active run 和 streaming 状态。
- streamingRequestId 只控制 live stream、停止和输入框锁，不再决定终态消息能否显示。
- terminal receipt 落屏后再解锁；额外 readback 暂时失败时保留当前消息并后台重读，不清空画面。
- createEmptyScopeRunState 中的空 toolTrace 只能表示“尚未加载”，不能覆盖已持久的 ProductTurnPresentation。

启动恢复顺序：

1. 先注册事件监听。
2. 读取当前 scope、visibility epoch 和未收口 ProductTurn。
3. 对账 native history 与 Ready 既有回执。
4. 读取 ProductTurnPresentation 并应用 receipt。
5. 再放行缓冲事件与新发送。

用户最终看到的是 Ready 的 durable 产品历史，而不是某一次 Renderer 进程的内存痕迹。

### 7.9 显式重试

不新增 RetryContextSnapshot，但也不能只写一个 predecessor_run_id。P3 必须给 PreparedCodexProductRun 增加真实用户输入触发的 explicit_retry admission variant，并按现有 schema 持久：

- ingress 仍是 user_ingress，taskOrigin=user_root、runOrigin=initial；只把 attemptKind 扩为 explicit_retry，因此它是新用户回合，不是公开 continuation/resume。
- predecessor_run_id 与 attempt_kind=explicit_retry。
- history_parity_evidence_digest。
- current_thread_read_evidence_digest。
- continuation_contract_digest。
- 新 run 自己的普通 ingress、资源、授权、预算和 turnContractDigest。

重试上下文从 predecessor ProductTurn、既有 receipts 和当前重新核验资源即时派生；上述摘要证明派生依据，不复制一份可漂移的大快照。

对账规则：

- confirmed 只读工具：只有其新鲜度合同仍有效时才可复用，否则重新查询。
- confirmed 写入/导出：绝不重做，先验证 staged/target hash 后推进下一状态。
- indeterminate：先 readback，不能盲重试。
- proven_absent：允许按新 call/action ID 执行。
- 文件夹资源：同 logicalResourceId 仍必须重新核对 realpath、设备/目录身份和授权代次。
- 同一 native thread：只有 thread read、history parity、connection owner 和 continuation digest 均安全时复用；否则创建新 generation，但保持同一 Ready scope 与 visibility epoch。

新 run 不写 predecessor staging root。它只能持有前一回合 finalized staged receipt 的只读 source ref：

- 只需导出时，直接按 source hash 读取 predecessor 内容。
- 需要继续编辑时，先 copy-on-write 到新 readyRunId namespace，再产生新 version。
- verified success 的 staging 在 publication seal 和目标 readback 后可清理。
- failed、indeterminate 或 retryable staging 保留到成功 successor 已 seal、用户删除/重置该对话或显式清理产物；活动 predecessor/successor 引用存在时 GC 不得删除。
- GC 只按 ProductTurn 与 predecessor receipt refs 判定，不能按目录 mtime 猜。
- 所有 segment 计入宿主 artifact storage budget；空间不足时只清 verified/unreferenced 内容，不能静默删除 retryable 引用。没有安全清理对象时，新写入以 storage_budget_exhausted 明确失败。

普通失败不得自动创建 successor。只有用户点击失败消息的 Retry 动作，或回复该失败消息并携带宿主签发的 predecessorRunId，才创建 explicit_retry run；按钮可以显示/发送“再试一次”，但未绑定 predecessor metadata 的普通短句不得静默继承写权限。若资源身份漂移且无法无歧义恢复，才要求用户重新选择目标。

## 8. 分阶段施工

每一阶段先写真实入口红测，再改实现。P0 至 P4 必须顺序完成，不能只落 delta 修复就打包。

### P0 证据冻结与红测

目标：把本次故障变成可重复、可审计的失败合同。

新增或扩展测试：

- gateway 单测：5000 条 function_call_arguments.delta 完整通过 Provider SSE policy。
- pinned app-server 跨层测试：上述流最终只形成一次 dynamic tool request、一次 Ready action 和一次 result delivery。
- 当前安装版形状在第 4096 条前后断流的对照 fixture。
- failure-only closeout 后 chat_messages 没有 assistant message 的红测。
- scope event 先于 send return 时失败正文消失的 Renderer 红测。
- 冷启动 toolTrace 被空数组覆盖既有回执的红测。
- closeout 事务提交前进程退出，以及已提交但 terminal IPC 未发送的红测。
- 当前失败 run 终态完整但无 canonical message 的 legacy repair 红测。
- malformed/oversized receipt 不应拖垮整段历史的红测。
- folder output intent 接线测试只喂 confirmed positive/no_write receipt：代码不再根据用户文本改判；无 receipt、declare+write 同组和多 destination 都拒绝。
- 超过单次 content cap 的 UTF-8 文档分两次以上 expectedVersion 写入，中间断线一次的红测。
- append 重放、no-replace 最后一刻出现目标、commit 后崩溃、目标 hash 冲突和文件夹身份漂移红测。

证据 fixture 必须脱敏，保留 readyRunId、事件类型计数、工具调用摘要、DB 行摘要和包体身份；不保存凭证、用户正文或原始 reasoning。

通过条件：这些测试在旧实现上稳定失败，原因分别对应 L0 至 L10 的真实入口，而不是靠 source grep。自动 gate 只证明代码只认 receipt；真实模型对同义、否定、讨论式、多语言与 retry 短句的语义表现放入安装版矩阵，不能用 fixture 冒充。

### P1 产品回合外壳切换

目标：一次性解决事件误计数、失败无消息、终态竞态和冷启动历史。

工作：

- 抽出 gateway 内的 CodexProviderStreamPolicy，建立正向事件分类、字节/结构/idle 三种保护。
- 拆开 request body、headers/first byte、event idle 与 terminal drain 四类期限。
- 保留 CodexTurnCollector 为 app-server notification 的唯一 reducer，并补 canonical read + buffered notification 归并。
- 把 commitCodexFailureCoreCloseout 合并到唯一 canonical product closeout。
- 让 closeout 返回带 revision/digest 的 ProductTurnReceipt。
- 增加 readProductTurnPresentation，在单一 SQLite snapshot 内只读组合现有账本，并对坏 receipt 降级。
- 在 startup migration/reconciler 中幂等修复可证明的旧 failure-only closeout，包括本次故障形状。
- Renderer 的 event、send return、cold start 收口到 applyProductTurnReceipt。
- 删除失败正文的 Renderer 本地拼接和 streamingRequestId 终态门。

主要落点：

- src/main/modules/agent-control/codex-runtime/codex-model-gateway.ts
- src/main/modules/agent-control/codex-runtime/codex-turn-collector.ts
- 新的小文件 codex-provider-stream-policy.ts
- src/main/modules/repositories/agent-session-checkpoint-closeout.ts
- src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts
- src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts
- src/shared/ipc-contracts/agent-runtime.ts
- src/renderer/modules/agent/runtime-driver-scope-events.ts
- src/renderer/stores/agent-send-orchestration.ts
- src/renderer/modules/agent/scopeRunState.ts

通过条件：

- 5000 Provider 工具参数 delta 通过 gateway，pinned app-server 最终完成一个 tool item；4097 个真实 Provider structural 事件仍失败。
- 连续有效进展超过 120 秒不失败，静默超时仍准确关闭。
- success/error/cancel/interrupted 都写 canonical message。
- closeout 提交前崩溃没有半终态，boot recovery 最终只提交一次；提交后未发 IPC 可由 receipt 恢复。
- event 与 send return 顺序互换，最终 messages、run state 和 input lock 完全相同。
- 重启后工具活动与失败说明可恢复；本次旧失败 run 被明确标注为“历史失败已恢复”。
- 迟到旧 run receipt 补入旧历史，但不改当前 composer；坏 receipt 只降级单项。

删除条件：新路径转绿后必须删除 commitCodexFailureCoreCloseout 的生产调用和旧 Renderer failure patch；不得保留双写兼容期。

### P2 文件交付纳入产品回合

目标：从“工具曾返回成功”提升为“目标文件已验证”。

工作：

- 给 PreparedCodexProductRun 增加可选 outputContract，纳入现有 schema 与 turn digest。
- exactly one current-turn destination；多目标先结构化反问。
- 用 declare_completion_criteria 的单一结构化 folderOutputIntentReceipt 替代 hasExplicitFolderExportIntent 正则。
- 在 frozen surface 内实现 dormant conditional write/export；只有前一 Provider iteration 的 positive receipt 已 confirmed 且结果已交付才激活。
- 用 logicalResourceId 和目录身份替代模型传绝对目标路径。
- 从第一次 confirmed completion criteria action receipt 冻结 item 集；状态只从现有 receipt fold。
- 新增 ArtifactMaterializer，接管 write/export 的原子物化和回读。
- 将 Codex folder-output 的 read、inventory/handoff、retry COW 也接到 Materializer 的 logical version 读取。
- 将现有 publication barrier 扩展为 product publication barrier。
- 把 ordinary、delivery、final 额度分开，并同时修改 gateway authority 与 tool-group admission。
- 由真实 transport envelope 测出单次内联 content 安全上限。
- 大/二进制产物接专用 staging receipt，不经过模型 JSON 搬运。

主要落点：

- src/main/modules/agent-control/codex-runtime/codex-product-run-preparer.ts
- src/main/modules/agent-control/codex-runtime/codex-product-turn-authorization.ts
- src/main/modules/agent-control/codex-runtime/codex-model-gateway-authority.ts
- src/main/modules/agent-control/codex-runtime/codex-tool-binding-repository.ts
- src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts
- src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts
- src/main/modules/agent-control/runtime-core/agent-sdk-execution-utils.ts
- src/main/modules/tools/agent-interaction-tool-defs.ts
- src/main/modules/tools/builtins/declare-completion-criteria.ts
- 新的小文件 src/main/modules/tools/artifact-materializer.ts
- src/main/modules/tools/skill-primitives/write-artifact.ts
- src/main/modules/tools/skill-primitives/read-artifact.ts
- src/main/modules/tools/skill-primitives/export-artifact.ts
- src/main/modules/tools/skills-tools.ts 中 Codex folder-output 的物理路径消费者
- 对应 primitive schema、授权与输入验证

通过条件：

- typed 文件夹加结构化 output intent 在有技能/无技能两种场景都形成同一 outputContract；同义、否定、讨论式和多语言输入不靠关键词补丁。
- declare+write 同 group/同 iteration 时 write 确定拒绝，admission/action 数均为零；下一 Provider iteration 才能看到激活的 write/export。
- 只读文件夹请求不开放写工具。
- ordinary 恰好耗尽且 activation=pending 时仍能 declare→write→export→final；no_write 后 write 永远不可见、不可 admission。
- 同名文件夹、旧附件和模型绝对路径不能改变目标。
- ordinary iteration 与 tool call 都恰好耗尽后，仍能完成 write→export→final；frozen surface digest 不变。
- staging、export、target readback 缺任一步都不能发布成功。
- 超过单次安全 content cap 的一个 UTF-8 文档通过两次以上 expectedVersion 写入，中途断线后最终只导出一次且 hash 正确。
- 两个以上 segment 在同轮 read、应用重启 read、retry COW 与 export 中得到相同 bytes/hash；不存在伪 absolutePath。
- 同 call 重放只执行一次；immutable segment/manifest 崩溃恢复不重复、不留不可解释状态。
- 跨卷导出、目标同 hash、目标异 hash、最后一刻外部创建目标、符号链接和权限漂移都有确定结果。
- create_only 使用本机 no-replace 原语；目标不同内容一律 conflict，没有 replace_exact 旁路。

### P3 显式重试与恢复对账

目标：用户说“再试一次”时继续已有成果，而不是重做一切或再次索要同一文件夹。

工作：

- 为 PreparedCodexProductRun 增加真实用户输入触发的 explicit_retry variant。
- 持久 predecessor、history parity、current thread read 与 continuation contract 四类现有证据。
- 从 predecessor ProductTurn、现有回执和当前资源派生新合同。
- 对 confirmed、indeterminate、proven_absent 分别处理。
- 重新核对 destination identity 与 create-only policy。
- predecessor staged source 只读引用；继续编辑时 copy-on-write 到新 run root。
- GC 按 ProductTurn/predecessor refs 与明确生命周期清理，不按 mtime。
- 安全时复用同 native thread；不安全时换 generation 但不换 visibility epoch。
- 失败说明展示“已保留什么、将从哪一步继续”。

主要落点：

- src/main/modules/agent-control/codex-runtime/codex-product-run-preparer.ts
- src/main/modules/agent-control/codex-runtime/codex-binding-schema.ts
- src/main/modules/agent-control/codex-runtime/codex-binding-repository.ts
- src/main/modules/agent-control/codex-runtime/codex-product-boot-recovery.ts
- src/main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter.ts
- ArtifactMaterializer 与对应 retry/GC 行为测试

通过条件：

- 已确认检索按新鲜度策略复用或刷新，不无条件重复。
- 已确认 staged/exported 文件不重复写；未知导出先目标 readback。
- 新 run 不写旧 staging root；copy-on-write 后版本和 receipt 归属新 run。
- 目标目录未漂移时无需用户再次附加文件夹。
- 目标目录漂移或冲突时明确停在授权边界，不猜路径。
- retry run 的回执不能覆盖前一 run，前一历史也不能被新 run 清掉。
- 应用重启并运行 GC 扫描后，仍可从被 predecessor refs 保护的 staged source 安全继续。
- storage pressure 只能清理 verified/unreferenced segment；全部仍被引用时新写入明确失败而不是吞掉重试源。

### P4 门禁、包体与安装版闭环

目标：让这类回归无法绕过发布链。

工作：

- 新增 verify:codex-turn-delivery，覆盖 P1 至 P3 的完整行为。
- 将快速 Provider stream policy 切片接入 verify:streaming。
- 将 closeout、presentation、Renderer 顺序和 retry 切片接入 verify:stability。
- 将完整 verify:codex-turn-delivery 明确加入 release structural command list。
- 为 release structural 脚本增加命令存在和顺序测试。
- 构建同一提交的 App/DMG，核对包内 app.asar、Codex binary、schema、签名和 receipt。
- 在隔离 HOME/资料目录安装并执行第 10 节矩阵。

通过条件：专项 gate、结构包和安装版证据绑定同一 source manifest 与 package hash；任何一项缺失都不得标完成。

## 9. Gate 设计

### 9.1 当前漏门

当前 package.json 的 verify:streaming 只覆盖自管 provider 流，不运行 Codex gateway 对抗测试。run-release-structural-verify.cjs 虽运行 verify:streaming、verify:stability、verify:native 和 E2，却没有运行 E3 / verify:codex-model-gateway，也没有一条完整的产品回合文件交付 gate。

这正是“局部测试看起来绿色，同类回归仍进入安装包”的结构原因。

### 9.2 新入口

新增：

    npm run verify:codex-turn-delivery

它至少包含：

- CodexProviderStreamPolicy：Provider 事件分类、5000 参数 delta、结构风暴、四类期限、字节和 idle。
- pinned app-server 跨层：一个 dynamic tool item、一次 action、一次 result delivery。
- ProductTurn closeout：成功/失败/取消/中断同事务、两个 closeout 崩溃点和 legacy repair。
- ProductTurnPresentation：单一 SQLite snapshot、既有回执、坏项降级、失败消息与重启恢复。
- ArtifactMaterializer：expectedVersion、immutable segments、readVersion/streamVersion、幂等、原子 no-replace、跨卷导出、哈希回读和崩溃点。
- outputContract：结构化 folder intent、跨 iteration 条件激活、多目标拒绝、文件夹身份、receipt-folded output item、三类预算与 publication seal。
- Renderer：三个终态入口的交换律、旧 run 历史 upsert 和当前 owner 隔离。
- retry：predecessor 证据、只读 staged source、copy-on-write、GC 和副作用不重复。

归属：

- 快速 gateway 测试加入 verify:streaming。
- closeout/presentation/retry 加入 verify:stability。
- 完整新 gate 加入 verify:release-structural。
- SQLite、消息、回执和迁移测试必须在 Electron ABI 下进入 verify:native。

不修改历史 E0-E9 的语义来伪装覆盖；新 gate 直接表达新的产品闭环。

### 9.3 实施完成时必跑

    npm run verify:codex-turn-delivery
    npm run verify:streaming
    npm run verify:stability
    npm run verify:codex-model-gateway
    npm run verify:codex-workbench-surface
    npm run verify:skill-envelope-write
    npm run verify:native
    npm run typecheck
    npm run build
    npm run verify:release-structural
    npm run verify:release-candidate

若实际 package.json 名称变化，实施文档必须同步为真实入口，不能保留不存在的命令。

## 10. 安装版验收矩阵

所有场景使用同一新包、隔离资料目录和可回读的真实目标文件夹。每个场景同时保存 UI 截图/录屏、ready-directchat.log、ready-tools.log、SQLite 摘要、目标文件 bytes/hash 与动作次数。

| 场景 | 操作 | 必须看到 |
| --- | --- | --- |
| A 长工具参数 | 5000 以上 Provider function_call_arguments.delta 生成长文并导出 | gateway 完整通过，app-server 只形成一个 tool item，write/export 各一次，目标 hash 匹配 |
| B 真结构风暴 | 注入 4097 个合法 structural 事件 | 以 protocol/capacity 准确失败，历史和失败消息仍在 |
| C 长时有进展 | 持续有效事件超过 120 秒 | 不被 absolute deadline 杀死 |
| D 真静默 | 中途停止全部有效事件 | idle timeout 生效，sidecar 健康时不被无故重启 |
| E 有技能/无技能 | 同一 typed 文件夹用不同同义表达输出文档 | 两种场景都有结构化 intent receipt、同一窄 outputContract 和目标回读 |
| F 只读文件夹 | 用否定、讨论“怎么输出”和多语言 no-write 表达询问/盘点 | intent receipt=no_write，不开放 write/export |
| G 多文件 | 声明并交付多份 required output | 逐项 verified，普通额度耗尽也能完成 |
| H 失败前未暂存 | 在 writer 前断流 | 失败消息说明未写入，调查历史可恢复 |
| I 已暂存未导出 | 暂存后断开 | 重试复用 staged hash，不重写 |
| J 提交后未知 | no-replace commit 后、receipt 前崩溃 | 重启 readback，确认后不重复导出 |
| K 目标冲突 | 目标已有不同 hash | 不覆盖、不偷改名，返回明确冲突 |
| L 相同目标 | 目标已有相同 hash | 幂等确认，不重复写 |
| M 同名文件夹 | 当前/历史各有同名目录 | 只写冻结 resource ID 对应目录 |
| N 身份漂移 | 发送后替换目录或符号链接 | 导出拒绝并保留 staged 产物 |
| O Renderer 顺序 | terminal event 与 send return 两种顺序 | 消息、工具史、输入锁结果一致 |
| P 应用重启 | 失败或成功 closeout 后重启 | 用户消息、工具活动、文件状态和终态正文仍在 |
| Q 显式重试 | 用失败消息的 Retry 动作发送“再试一次”，覆盖 confirmed、indeterminate、proven_absent | 请求带宿主 predecessor metadata，复用目标 intent，只执行必要动作，副作用次数精确为一 |
| R 旧 run 迟到 | 新 run 开始后投递旧 receipt/delta | 旧 receipt 补入旧历史，但不能改变当前回合或输入锁 |
| S 包体身份 | 从 release receipt 指向的 DMG 安装 | UI、DB、文件证据绑定同一包和源码 |
| T 超单次容量 | 一个 UTF-8 文档超过实测单次 content cap | 两次以上 expectedVersion 写入，中断一次，最终只导出一次且 hash 正确 |
| U 最后一刻抢占 | no-replace 提交前由外部进程创建目标 | EEXIST/conflict，外部文件字节不变 |
| V closeout 崩溃点 | 分别在事务提交前退出、提交后 IPC 前退出 | 前者 boot 继续且无半终态；后者从 receipt 恢复且只显示一次 |
| W 既有失败修复 | 用本次 failure-only DB 形状升级启动 | 出现明确“历史失败已恢复”消息，10 个工具记录在，文件状态为未写入 |
| X 坏历史回执 | 注入 malformed/oversized result_json | 仅该 item degraded，会话其余历史正常显示 |
| Y 多目标 | 同一当前消息附两个 typed 文件夹并要求输出 | 先结构化询问，未选择前没有 output activation 或写入 |

安装版关闭条件：

- UI 显示成功时，每个 required output 在目标目录存在且 hash 与 publication seal 一致。
- UI 显示失败时，本轮已完成工具和文件状态仍可见，重启后仍成立。
- 每个写入/导出 action 的 confirmed 次数为一；未知状态有 readback 证据。
- SQLite integrity_check=ok，且没有 post-admission run 缺 canonical message。
- 同一 visibility epoch 内旧历史没有因为 generation、publication divergence 或重试而消失。

## 11. 迁移与删除清单

### 11.1 必须删除的旧路径

在对应新合同转绿后删除，不保留“暂时兼容”：

- commitCodexFailureCoreCloseout 及生产调用。
- Renderer 依赖 streamingRequestId 才落失败正文的分支。
- terminal scope event 先清历史真值的分支。
- 冷启动以 toolTrace=[] 覆盖 durable presentation 的路径。
- 所有 SSE 事件共享一个 4096 计数的逻辑。
- delta 类型黑名单式免计数。
- reservedExportToolCalls 直接增加总工具额度的算法。
- 模型指定绝对导出路径和同名文件夹别名回退。
- 裸 appendFileSync 的产物写入。

### 11.2 不做第二套迁移

- 不新增 codex_run_narration_events。
- 不复制 tool receipt 状态到 chat message 或新 history 表。
- 不把 Renderer 临时 trace 反写为真值。
- 不把 native ThreadItems 当 Ready 工具账本。
- 不保留旧 failure closeout 双写观察期。

默认不新增表，也不新增 ArtifactDeliveryItem mutable state。若现有 ingress_json、action/delivery receipt 和 publication refs 无法承载 immutable outputContract/receipt identity，才允许给现有 ProductTurn 或 receipt 增加最少不可变字段；必须先证明无法复用、提供原生 migration test、旧库 readback 和 downgrade/停线说明。

## 12. 文件规模与施工纪律

当前相邻大文件包括：

- codex-binding-repository.ts：约 7465 行。
- codex-runtime-production-composition.ts：约 3322 行。
- codex-model-gateway.ts：约 2551 行。
- agent-session-checkpoint-closeout.ts：约 1046 行。

实施不能继续把新状态机内联进这些文件。允许的策略是：

- CodexProviderStreamPolicy 从 gateway 抽走 Provider SSE 事件归一和流预算规则。
- ArtifactMaterializer 从 primitive handler 抽走文件物化。
- repository 与 production composition 只保留薄接线和事务调用。
- ProductTurnPresentation 是纯读模型，不拥有写权限。

任何净增后的千行文件都按项目规则更新 large-file-health-log。若某阶段需要第三个新服务、第二张历史表或双 closeout 才能继续，立即停线复审，而不是继续堆补丁。

## 13. 停线条件与非目标

### 13.1 停线条件

出现以下任一情况不得进入打包：

- 无法证明目标文件 hash 来自用户冻结的 destination resource。
- success closeout 可以绕过 publication seal。
- failure closeout 仍可能没有 canonical message。
- Renderer 仍有第二个终态判断源。
- confirmed/indeterminate 副作用无法区分。
- 新容量数值不是从真实 transport envelope 测出。
- focused tests 通过但完整 release structural 未运行新 gate。
- 工作树中用户既有改动无法与本计划切片区分。

### 13.2 非目标

- 不升级 Ready bundled Codex 到 0.148。
- 不复制 Matrix 私有模块、二进制或账号状态。
- 不开放通用 shell、终端或任意 workspace 写权限。
- 不恢复 Dynamic Delivery、worker/owner、skill_executions 或公开续跑入口。
- 不持久化原始 reasoning 或未接受的半截模型正文。
- 不用自动重试替代用户明确重试。
- 不在本阶段覆盖目标目录中不同 hash 的现有文件；可恢复备份与 replace_exact 另立合同。
- 不顺手重构 Browser、Document、RSS、Calendar 或旧 SDK 支撑链。

## 14. 与既有合同的关系

- 08-11 Matrix wiring 计划继续定义 native runtime 身份和基础协议；本计划绑定当前 26.814.41407 对照体并补产品回合交付闭环。
- 08-13 workbench surface 计划继续定义工具面来源；本计划只规定 typed 文件夹输出如何形成 outputContract。
- 08-14 surface hardening 计划继续定义工具授权与收窄；本计划不扩大工具类别。
- current-runtime-contracts 已写明 delta 不计结构事件，但当前 release gate 尚未证明真实工具参数写出链。本计划把该文档约束变成行为 gate，并同时补齐 closeout、文件 readback 和恢复。

若既有文档与真实实现或 gate 冲突，先定性为实现回归或文档漂移，再只更新单一权威入口。

## 15. 独立复审记录

当前状态：passed。Blocker 0，Major 0。

第一轮独立复审发现并推动关闭了这些问题：

1. Provider Responses SSE 与 app-server turn/item 通知曾被混成一层；现已拆回真实两层接线。
2. 文件 create-only 曾存在 check-then-rename 竞争；现只接受平台实测的原子 no-replace。
3. output item、预算、失败历史和 retry 曾有形成第二真值的风险；现全部折叠到现有 ProductTurn、既有回执和唯一 closeout。
4. conditional write/export 曾可能在声明同轮抢跑；现要求前一轮 durable positive receipt、result delivery 和下一 Provider iteration 才激活。
5. immutable segments 曾未覆盖 read、重启、handoff 和 retry；现统一经 Materializer logical version 读取。
6. 长参数、长时流、超单次文件、closeout 崩溃点、重启恢复和 release structural 漏门均已进入行为 gate 与安装版矩阵。

最终复审确认：没有第二个产品终态或历史真值；没有成功路径可以绕过目标文件 fresh readback；Matrix 事实、Ready 自定扩展和 pinned 0.146.1 合同边界清晰；计划可以按 P0-P4 施工。

非阻断实施提醒：P2 必须一并删除 skills-tools.ts 中 reference/advisory 基于文本猜测的 auto-export/overwrite 旁路；现有 P2 落点与删除清单已经覆盖，不再扩充新概念。

`ready` 只表示计划已通过施工前复审，不表示源码、包体或安装版已经完成。
