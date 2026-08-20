---
title: Ready 单一 Agent 与长期记忆运行时实施合同
date: 2026-08-20
status: ready
review_status: evidence_backed
enforce: true
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-08-11-ready-codex-matrix-wiring-closure-implementation.md
evidence_inputs:
  - path: /Applications/ChatGPT Matrix Runtime.app/Contents/Resources/codex
    codex_version: 0.148.0-alpha.15
    sha256: 7645c3caf5607e4528eb3a15b12496c284c2a918939aed34e863c760c1b421e7
    role: current_local_memory_design_evidence
    enforce: false
  - path: build/codex/aarch64-apple-darwin/codex
    codex_version: 0.146.1
    role: pinned_ready_runtime
    enforce: true
note: >
  本合同先完成旧 Agent、专项能力和伪接线记忆面的退役，再定义 Ready 后续长期记忆的唯一实现。
  Matrix 只作为同形宿主的设计证据；Ready 不直接共享其 CODEX_HOME、数据库、凭证或后台费用。
---

# Ready 单一 Agent 与长期记忆运行时实施合同

## 0. 裁决

Ready 只保留一个面向用户的助手身份：`Ready`。数据库中的 `butler` 只作为稳定的内部宿主标识，不再代表可选人格，也不再出现在选择器、设置、路由或能力判断中。

本轮先做退役闭环：

1. 删除聊天输入框和任务侧栏的 Agent 选择器、已选 Agent 标签。
2. 新会话由 Main 固定绑定 Ready，Renderer 不再提交 Agent id；所有历史会话与召回派生数据一次性清空，不做 Agent 身份兼容。
3. 专项蓝图、人格编辑、Agent 资料和旧记忆设置全部退出 Renderer、Preload 和 IPC 公开面；专项源码另行封包归档。
4. 旧 `memory_create/search/update/list_recent` 工具退出生产工具面；旧 memory lifecycle、crystallize 与 belief-decay 后台调度也不得启动。旧记忆没有真正接入当前 Codex 主链，不能继续在设置页宣称自动沉淀。
5. 新记忆运行时不在本轮偷偷启用后台模型调用。它必须按下文分阶段落地，并单独完成费用授权和真实包验收。

明确不做：

- 不保留专项会话兼容分支、Agent 别名迁移、旧选择器隐藏开关或人格回退。
- 不把技能包装成新的“专项 Agent”；领域方法继续归技能，长期事实归记忆。
- 不直接打开 Matrix 的 `memories` 开关冒充接线完成。
- 不让模型直接写长期记忆，也不把旧 `agent_memory_metadata` 当作新系统的真值。

## 1. Matrix 记忆设计事实

### 1.1 产生

官方说明与当前 Matrix Runtime 的本机协议、数据库和目录共同证明：记忆不是每轮同步追加，而是异步两阶段处理。

- 第一阶段从符合条件的旧会话提取候选记忆与会话摘要；当前会话、临时会话和不允许贡献的会话不参与。
- 第二阶段在空闲期把候选合并成全局记忆，负责去重、冲突处理、过期和遗忘；它有水位、租约、重试和冷却，而不是无状态定时提示词。
- 生成结果采用渐进披露：短摘要随上下文进入，较长手册按需搜索，原始会话摘要保留为证据。
- 原始会话是证据，不是指令；秘密和指令形文本必须拒绝或脱敏。

对应官方资料：

- [ChatGPT / Codex memories](https://learn.chatgpt.com/docs/customization/memories)
- [Codex memory configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenAI state-based personalization cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization)
- [Codex memories implementation](https://github.com/openai/codex/tree/main/codex-rs/memories)

### 1.2 自定义

Matrix 把“使用既有记忆”和“让本会话贡献未来记忆”分开控制；全局还有生成开关、读取开关、外部上下文禁用、候选量、保留期、空闲期和模型选择。稳定偏好适合结构化档案，临时信息适合带时间、置信度和过期时间的笔记。当前用户输入和本轮明确要求始终高于记忆。

### 1.3 接线

Matrix 的短摘要由运行时注入，长记忆通过检索逐层展开；每条可见记忆引用可回到文件行和来源会话。生成任务使用独立作业表和记忆数据库，记忆目录自身有版本历史，重置是显式协议动作。

Ready 当前不能直接复用这条链：

- Ready 为随包 Codex 创建隔离的 `CODEX_HOME`，不会读取用户全局 Matrix 记忆目录。
- Ready 固定的 0.146.1 与当前 Matrix 0.148 alpha 协议不同；Ready 的消息归一器目前拒绝带 `memoryCitation` 的原生消息。
- Ready 模型网关只接受绑定产品回合、预算和凭证的请求；Matrix 后台 consolidation 没有这些 Ready 身份，直接打开开关会失败或形成未记账费用。
- Ready 当前输入合同除当前用户输入、明确资源和冻结工具合同外，只接受 Ready 产品层按本轮封印的 `ready-memory:v1` 快照；旧 PromptAssembly、人格、用户档案与旧记忆表都不在生产链。

因此最合适的方案是复用 Matrix 的原则，在 Ready 产品层实现记忆；等随包 runtime 升级并验证协议后，再评估是否把存储执行下沉给原生 Matrix。

## 2. Ready 新记忆唯一架构

```text
已成功结束的本地根会话
  -> 贡献资格与秘密过滤
  -> 第一阶段来源摘要（不可变、带 source digest / watermark）
  -> 空闲作业队列（有租约、重试、费用回执）
  -> 第二阶段全局整理（去重、冲突、TTL、遗忘）
  -> ReadyMemorySnapshot（短摘要 + 可检索条目 + 证据引用）
  -> 下一轮 Codex 准入时冻结
  -> turn additionalContext 中的 ready-memory:v1 + 只读 ready_memory_search
  -> 产品回合收据记录 snapshot digest 与实际读取条目
```

真值只允许四类：

1. `ready_memory_sources`：某次会话提取的不可变来源摘要、来源更新时间和摘要哈希。
2. `ready_memory_entries`：用户明确保存或第二阶段确认后的长期条目，包含类别、置信度、有效期、来源引用和状态。
3. `ready_memory_jobs`：提取与整理作业的水位、租约、尝试次数、费用回执和终态。
4. `ready_memory_policies`：全局“使用/生成”与每个会话“允许贡献”状态。

旧 `agent_memory_metadata`、`user_profiles`、`agent_personalities`、belief/persona 文件和会话回看索引都不是新记忆真值。会话回看仍是用户主动附加旧上下文的独立能力，不能与长期记忆混表。

## 3. 不可破合同

### 3.1 读取与注入

- `useMemories` 与 `generateMemories` 必须分开；关闭生成不能阻止读取已有记忆，关闭读取不能偷偷把记忆塞进 prompt。
- 每个本地会话有独立 `contributeToMemories`；远程、计划任务、临时/测试会话默认不贡献。
- 本轮只读上一轮已经封印的快照，绝不读取当前未结束会话生成的候选。
- 注入在 Codex 准入前解析并冻结；`PreparedCodexProductRun`、turn metadata 与最终产品收据都记录同一 snapshot digest。
- 当前用户输入 > 本会话明确设置 > 用户固定条目 > 自动整理条目。记忆只是建议，不能覆盖权限、工具合同、实时事实或本轮要求。
- 短摘要有固定字符预算；超出内容只通过只读检索展开。模型没有 create/update/delete 记忆工具。

### 3.2 生成与费用

- 自动生成默认关闭，直到用户明确开启并同意后台模型费用；开启状态必须可见、可撤销。
- 只处理成功终态、非当前、非临时的本地根会话；失败、取消、未知终态和带外部不可信上下文的会话默认跳过。
- 每个来源版本最多生成一次；来源 digest 未变化时不得重复收费。
- 所有模型调用进入专用 `memory` 预算通道，写入请求、用量、结果和失败回执。未知结果只允许查询恢复，禁止盲重试。
- 第一阶段不能直接修改全局条目；第二阶段只能消费已有来源摘要，不重新读取整段聊天。

### 3.3 安全、质量与遗忘

- 拒绝密钥、令牌、密码、身份凭证、一次性验证码和看起来像系统/开发者指令的内容。
- 候选必须可追溯到来源会话和消息范围；无证据、模型新编或只有一次性的临时事实不得入库。
- 冲突不做静默覆盖：新条目按时间与用户显式程度胜出，旧条目进入 superseded；无法判断时保持并列并等待用户处理。
- 自动条目有最后使用时间和 TTL；固定条目只由用户删除。删除、重置与关闭读取都要即时影响下一轮快照。
- 用户可查看“Ready 记住了什么、来自哪里、何时使用、为什么过期”，并可编辑、固定、忘记或全部重置。

## 4. 分阶段施工

### Phase 0：旧系统退役（本轮）

- 单一 Ready 身份；选择器和专项设置消失。
- 专项源码封包，生产 IPC 与工具面断线。
- 全部历史会话、会话召回派生数据和专项表数据由一次性迁移清理；仍有完整原生线程身份的绑定同时写入持久清理意图，新 Ready 会话从空白状态开始。该全量清理意图可穿过已经废弃的旧 Ready 栅栏、未终态回合与调用，但必须精确绑定已退役线程，保留后代线程阻断，并由归档 owner 再证明原生线程当前空闲或已卸载且没有运行中回合；普通归档资格不放宽。
- 已封印的任务、运行和模型回执保留原始归属作为审计证据，不伪造改写为 Ready。
- 旧 memory capability 标为 inactive，设置页不再展示伪接线能力。
- 旧记忆生命周期、crystallize 与 belief-decay 不在启动或定时任务中运行；本轮不产生任何旧记忆文件或后台整理写入。

### Phase 1：只读、用户自主管理

- 新建四张 Ready memory 表与 repository。
- 先支持用户手工新增、编辑、固定、删除和全量重置；不调用模型。
- `ReadyMemorySnapshot` 在产品准入前冻结并注入，带 digest、预算和读取回执。
- 先完成关闭读取、删除后下一轮立即消失、当前输入优先、跨会话有效四类原生验收。

### Phase 2：自动提取与整理（实现已接线，生产提交关闭）

- 新增 `memory` 预算通道、后台作业调度、来源水位和回执。
- 先上线第一阶段提取，再上线第二阶段整理；两阶段分别做故障注入、重启恢复和重复收费测试。
- 设置页包含全局使用/生成开关和当前会话贡献开关；生成默认关闭。当前生产 provider 无法按稳定本地请求身份找回丢失响应的同一次提交，因此生成开关必须禁用且不得发起请求；已知远端 id 只允许查询恢复。

### Phase 3：原生 Matrix 能力评估

- 升级随包 Codex 后重新生成 schema，并验证 `thread/memoryMode/set`、`memory/reset`、`memoryCitation` 与后台请求身份。
- 只有当原生后台请求可走 Ready 预算、凭证、关闭与恢复合同，且数据可迁移和读回，才允许替换 Ready 自管执行层。
- 原生接管不得改变 Ready 的产品表、设置语义、引用格式和用户删除权。

## 5. 机器验收

Phase 0 必须证明：

- ChatInput、TaskPanel 和 Settings 不再引用 AgentSelector、AgentTagRow、AgentSettingsHub、PersonalityEditor、MemorySettingsSection 或 UserProfileEditor。
- Preload 不公开 registry、systemStudio、specialistBlueprint、agentPersonality 的调用面；Main 不注册对应 IPC。
- `CreateSessionRequest` 不接受 Agent id，Main 固定创建 Ready 身份。
- 旧 `memory` capability 为 inactive/off/无默认 profile，旧写入工具面为空；新 `ready_memory_search` 只在本轮已有冻结快照时开放，而且始终只读。
- 生产宿主不启动 memory lifecycle、CrystallizeScheduler 或 belief-decay 回合。
- 迁移清空全部历史会话与召回派生行，退役它们的原生线程绑定，为可辨认的安全线程写入持久清理意图，并删除专项表行和非 Ready registry 行。

Phase 0/1 已接通后，设置页只显示新的“长期记忆”入口，并允许手工管理与关闭读取；不得恢复旧记忆页。自动提取与整理在可靠请求恢复和真实费用验收完成前必须明确显示为暂不可用，不能宣称 Ready 会自动整理，也不能产生后台模型请求。专项回归统一由 `npm run verify:single-ready-memory` 覆盖退役、升级、冻结、检索、历史脱敏、设置、IPC、恢复和归档全链。
