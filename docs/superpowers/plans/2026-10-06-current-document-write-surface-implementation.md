# 当前文档写面：指向即可修改

## 已验证事实

- 旧合同：当前文档激活后默认只开放 `document_read_section`，固定写工具（Widget / replace exact / save）只在 `hasExplicitCurrentDocumentWriteIntent` 从用户措辞里认出写意图时开放。
- 2026-10-05~06 同一“信息卡”场景连续三轮因措辞漏判失败：“做一些信息卡”“换成 Ready 信息卡”都没被认成写意图。模型拿不到 Widget 工具，只能改写文件或用 Markdown 引用块冒充卡片（回合 `req-1791220302558-1tpuxe`、`req-1791224413251-f9ghvl`）。补词表只能覆盖已见过的说法。
- Codex 桌面端的做法：当前工作区文件的编辑工具始终可用，是否修改由模型判断，落盘的审批由用户选择的审批方式决定。
- Ready 的对应事实：编辑类文档工具只改已打开的 tab（可见、可撤销，tab 变为未保存）；只有 `document_save_tab` 写回磁盘，且只能写回该 tab 已有路径。对话已有 `ask / auto / full` 行动授权方式，行动确认 M3 规则可声明由 `auto`/`full` 代决。

## 合同

1. `resolveCurrentDocumentActivation` 激活当前文档时 `canWrite = !hasExplicitCurrentDocumentWriteProhibition(intentText)`：用户明确只读（“只阅读/仅查看…”“不要/别…修改/改动/保存”）才保持只读；删除正向写意图词表与问法排除。
2. 工具面组合在 `allowWrite` 时只并入冻结工具面里已有的固定写工具；旧线程缺写工具时本轮保持只读，不以 `tool_authorization_outside_surface` 拒绝准入。读地板 `document_read_section` 仍无条件。
3. 行动确认新增 M3 规则 `m3-save-current-document`（`document_save_tab`，`delegatedBy: 'auto'`）：`ask` 逐次确认，`auto`/`full` 代决；其他文档编辑工具不确认。
4. 不变：激活条件（指向措辞、Widget 目标、附件即当前文档）、修改前精确读取回执、写入绑定发送时冻结的 tab、保存只写回已有路径、当前文档轮最终回答须持有读取回执。

## 验证

- `codex-product-resource-envelope.test.ts`：明确只读的四种说法保持只读，“换成 Ready 信息卡”“做一些信息卡”“还能怎么改进？”“只需把第二段改短”不算只读；附件即当前文档且未说只读时可写，“只阅读这篇文档并总结”只读；组合出的工具面含读取、插入 Widget 与保存；冻结工具面只有读取工具时 `allowWrite` 也只得到 `document_read_section`。
- `action-confirmation-policy.test.ts`：`document_save_tab` 在 `ask` 下为 M3 确认、`auto`/`full` 放行；插入/更新 Widget 与 replace exact 不确认。
- `codex-retry-production-handoff.test.ts`（Electron，生产准入）：当前文档激活的显式 Retry 场景仍按原错误码拒绝，没有因写工具缺失变成 `tool_authorization_outside_surface`（该回归由本轮第 2 条修复）。
- `verify:native`、`verify:codex-workbench-surface`、`verify:widget-ready`、`verify:document-reading`、`verify:file-emergence`、类型检查、受影响文件 lint。
- 未在真实窗口用真实模型复跑（不使用用户 ChatGPT 凭据）。

## 组件目录送达（同日第二轮）

### 已验证事实

- 回合 `req-1791226293497-zv0eld`：写面已开放，模型连续 6 次 `document_insert_widget`（InfoCard、Card、空 spec、InfoGrid、info-card、SummaryCard）均被拒为“Unknown approved document widget component”，最后以未交付收尾。
- 组件目录与 props 结构只由 `buildDocumentSurfaceGuidance` 注入，它只接在已退役的 SDK 轮次装配上；Codex 轮里模型只看到 `componentSpec: record` 的通用描述。拒绝信息也不给出可用组件。
- Codex 线程冻结工具定义，改工具描述会让既有线程工具面不兼容；每轮上下文只能走 `additionalContext`，且网关把未识别的 developer 消息计入指令合同摘要。
- 真实 0.149 探针：`additionalContext` 值超过 1000 token（字节/4）会被从中间截断并插入“…N tokens truncated…”；首版目录 4305 字节被截断，截断后网关摘要必然不符。

### 合同

1. `codexDocumentWidgetGuidance(allowedToolNames)`：冻结授权含 `document_insert_widget` 时生成目录（用法、通用展示组件名与说明、核心 7 个组件的 props 结构），否则为 null；`additionalContext['ready-document-widget-guidance']` 的值为 `{contract, readyRunId, guidance}`，`readyRunId` 让 0.149 每轮都发送。
2. 准入 `additionalContextDigest`、实时开轮与启动恢复开轮使用同一函数；网关 `currentTurnReadyAdditionalContext` 识别当前 run 的单份目录并计入摘要，异 run、重复、非 developer 或带额外字段一律 `gateway_document_widget_guidance_invalid`；`instructionTranscriptDigest` 排除目录消息，历史中的旧目录不改变线程指令合同。
3. 目录值不超过 `CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES`（3800 字节），由测试锁定。
4. 组件名未知时错误附已批准组件名；props 校验失败时附该组件的 props 结构。

### 验证

- `codex-document-widget-guidance.e2e.ts`（真实 0.149，已接入 `verify:codex-input-continuity`）：两轮带目录、一轮不带；每轮目录完整送达且与准入摘要一致，三轮指令合同摘要相同，第三轮请求中只保留前两轮的历史目录；目录值字节数在预算内。
- `codex-turn-input-builder.test.ts`：只有授权写组件的轮次携带目录；网关拒绝异 run、重复、伪造角色与额外字段；历史目录不影响指令摘要。
- `verify:codex-input-continuity`、`verify:history-continuation`、`verify:widget-ready`、`verify:codex-workbench-surface`、`verify:native`、网关契约/对抗/记忆脱敏套件、sidecar e2e、类型检查、受影响文件 lint。
- 已知代价：每个可写组件的轮次在历史中多留约 900 token 的目录；本轮不扩展记忆脱敏去裁剪旧目录。

## 全链路复查（同日第三轮）

回合 `req-1791255417099-0d0cjd` 已按目录插入 3 张 `info_card` 并删除对应引用块，随后上游连续 6 次 `fetch failed`（HTTP 500，首部阶段，零字节）而失败；界面要求重述并重新附加资源。本轮先沿链路逐项核对，再从根部修复。

### 问题与证据

| 编号 | 问题 | 证据 | 处理 |
| --- | --- | --- | --- |
| A | 失败/停止续接从未生效 | 候选 `finalDeltaItemIds` 与 `commentaryItemIds` 都含开场叙述 `msg_06a4…`；收集器把所有 agentMessage 增量都算作“已显示回答”，历史判为 `diverged/partial_assistant`。模型几乎总会先流式输出叙述，三条续接 seam 在真实使用中从未命中 | 收集器只计非 commentary 的流式项（开始即 commentary 的被截断叙述也排除） |
| B | 声明“保存回原文件”必然被判未交付 | 模型按默认项目目录提示声明 `folder_output_intent: save` + 当前文档文件名；屏障只认暂存+导出回执，`document_save_tab` 不算，转换并保存后仍会以“计划保存的文件没有保存成功”收尾 | 声明时识别当前文档自身文件：剔除该项，只剩它时改为 `no_write` 并提示用 `document_save_tab` |
| Q | 首个声明被拒后永远待定 | 文件夹激活取第一条声明调用，即使它被校验拒绝；之后的合法声明被忽略，收尾报 `folder_output_intent_receipt_missing` | 由第一个被接受的声明冻结承诺；被拒绝的不算 |
| C | 本轮改过文档后无法再读 | 读取校验要求内容摘要等于发送时版本；第一次编辑后同轮所有 `document_read_section` 都返回 `resource_version_superseded` | Main 随写动作带上锚权限，Renderer 把“从已授权版本经本轮编辑得到”的版本加入可读集合；用户手动改动仍判失效 |
| D | 未保存的当前文档再附加时变成整段粘贴 | 失败轮留下未保存的卡片；文档标签附件在 dirty 时作为 `quoted_text`（最多 3 万字）发送，Main 也认不出它是当前文档 | 聚焦文档自己的标签始终按文件引用发送，由 Main 并入当前文档 |
| K | “继续”拿不到文档工具 | 续接提示让用户发“继续”，但措辞不指向文档，锚不激活 | 已由下一节“连续上下文”取代：聚焦文档对普通轮次默认可用 |

已核对无问题：E 工具预算（文档工具走不限次的普通通道，交付通道只计声明/暂存/导出）；F 保存确认（本轮 `full` 授权经请求信封到达确认门，M3 代决）与保存后的 Tag Forge（非新建文件且无可恢复回执时直接返回，不阻断）；G 本次 500 属于瞬时失败线；H 该文件没有待恢复的创建回执。

### 验证

- `codex-turn-collector.test.ts`：已完成与被截断的叙述都不进 `finalDeltaItemIds`，被截断的回答仍计入；撤掉修复时失败。
- `codex-folder-output-activation.test.ts`：被拒声明后待定；拒绝→接受→后续 `no_write` 时承诺按接受的那条冻结；声明当前文档自身文件得到 `no_write`；旧实现下前者失败。
- `declare-completion-criteria.test.ts`：只剩当前文档时改为 `no_write`，混合时保留其他文件，无可写当前文档时照常。
- `codex-product-resource-envelope.test.ts`：真实 Main 请求器 + Renderer 文档动作，本轮编辑后可再读、用户手改后失效（旧读取实现下失败）；写参数携带锚权限；“继续”在沿用文档时激活、其他情况不激活。
- `codex-renderer-ingress-input.test.ts`、`codex-current-document-continuation.test.ts`。
- `verify:codex-workbench-surface`（已接入新测试）、`verify:widget-ready`、`verify:document-reading`、`verify:skill-envelope-write`、`verify:history-continuation`、`verify:codex-input-continuity`、`verify:file-emergence`、`verify:tag-forge`、`verify:native`、`verify:codex-turn-delivery`（仅两条既有 app-server 失败）、类型检查、受影响文件 lint。
- 未在真实窗口用真实模型复跑（不使用用户 ChatGPT 凭据）。

## 连续上下文（同日第四轮）

### 问题

成功一轮之后的追问（“把第二节也换成信息卡”）、失败后的“继续”都不提“文档”，代码按措辞决定是否激活当前文档，于是模型虽然从对话里明白指的是哪篇文档，却拿不到文档工具。上一轮只为“未完成后的继续”打了补丁（`readUnfinishedTurnDocument`），仍把连续对话交给关键词。

之所以不能简单地“每轮激活”，是因为激活同时带来“回答前必须读取当前文档”的收尾义务：无关提问也会被迫先读文档，否则判为未交付。可用性与义务原本绑在一起。

### 合同

1. 可用性与义务分离：文档工作面聚焦的文档对每个普通轮次可用（读、写工具按冻结工具面开放；用户明确只读时不开写；显式 Retry 与明确排除本地/当前文档时不激活）。模型按对话上下文决定是否使用，和 Codex 桌面端对工作区文件的处理一致。
2. 读取义务只在用户指向当前文档时产生（措辞指向、Widget 目标、附上这篇文档）。仅因聚焦可用的轮次冻结 `currentDocumentAmbient: true`（准备阶段写入 prepared，严格 schema 已扩展），收尾不再要求读取回执；已发生的读取照常核对回执。旧数据不含该字段，按原义务处理。
3. 组件目录只在指向轮发送，避免文档模式下每轮都在历史中追加约 900 token；此前的目录留在 thread 历史中，组件名错误时拒绝信息给出可用组件与字段。
4. 移除 `readUnfinishedTurnDocument`：其覆盖的“继续”已由第 1 条包含。

### 验证

- `codex-product-resource-envelope.test.ts`：“把第二节也换成信息卡”“继续”“今天天气怎么样”在聚焦文档下都激活、可写、无读取义务；附件与措辞指向产生义务；显式 Retry 与明确排除不激活。
- `codex-binding-repository-native.test.ts`：同一完成轮，仅可用（`currentDocumentAmbient`）时收尾接受，指向时仍报 `current_document_read_required`；撤掉修改后前者失败。
- `codex-document-widget-guidance.e2e.ts`：仅可用的轮次不生成目录。
- 生产 Retry 交接（Electron）：显式 Retry 在聚焦文档下仍不激活当前文档。
- 修复上一轮引入、此前未被覆盖的回归：启动恢复读取冻结授权生成目录时，`codex-product-boot-recovery.test.ts` 的过期夹具缺少顶层 `allowedToolNames`，已补夹具（生产数据由严格 schema 保证该字段）。
- `verify:codex-workbench-surface`、`verify:widget-ready`、`verify:document-reading`、`verify:skill-envelope-write`、`verify:history-continuation`、`verify:codex-input-continuity`、`verify:file-emergence`、`verify:tag-forge`、`verify:native`、`verify:codex-turn-delivery`（仅两条既有 app-server 失败）、e4/e6 后续步骤、类型检查、受影响文件 lint。

本合同取代 `2026-08-13-codex-workbench-surface-rewire-implementation.md` 中“明确写意图才并入固定写工具”的条目。
