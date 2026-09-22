---
title: Agent 改文档后的反馈裂环 — 成功被误判失败 / 终态显示已暂停 / 文件树不刷新 / 标签页不可读
date: 2026-06-17
status: 已实施（Codex 补合同 + EP-A/B/C/D 落地）
authors: 白（Claude 定位 + 用户三方裁决 + Codex 二轮复核）
scope:
  - src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts（document target guard / autosave / done 收口）
  - src/main/modules/agent-control/runtime-core/run-finalizer.ts（强制降级收口）
  - src/main/modules/agent-control/quality/task-adjudicator.ts、criteria-templates.ts、proof-collector.ts（判据/证据匹配）
  - src/main/modules/agent-control/task-projection/task-projection-sync.ts（终态投影/interaction_state 收敛）
  - src/main/modules/agent-control/contracts/run-contracts.ts（TaskInteractionState 合同）
  - src/renderer/modules/agent/documentActions.ts（文档工具：内存改 vs 落盘）
  - src/main/modules/document-engine/ipc/file-io-group.ts、directory-change-broadcast.ts（写入后目录广播）
  - src/renderer/components/document/MarkdownEditor.tsx（loadError 黏住/不自愈）
enforce: false
related:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-16-resume-continuation-fact-source-implementation.md
  - src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts
  - src/main/modules/agent-control/runtime-core/run-finalizer.ts
  - src/main/modules/agent-control/quality/criteria-templates.ts
  - src/main/modules/agent-control/quality/task-adjudicator.ts
  - src/main/modules/agent-control/quality/proof-collector.ts
  - src/main/modules/agent-control/task-projection/task-projection-sync.ts
  - src/main/modules/agent-control/contracts/run-contracts.ts
  - src/renderer/modules/agent/documentActions.ts
  - src/main/modules/document-engine/ipc/file-io-group.ts
  - src/renderer/components/document/MarkdownEditor.tsx
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Agent 改文档后的反馈裂环 — 根因分析与修复计划

> 一句话：一次「继续」续作里 agent 把既有文档改了但**没保存就收口**，现有"目标文档保存闸"因为本轮指令只是"继续"而没接上（结构性绕过），结果裁决判 degraded、`923dddfe` 的强制降级把它翻成 failed；同时"agent 改文档"缺统一 fan-out，文件树/编辑器标签也各自没收到通知。

## 二轮复核变更摘要（2026-06-17，Codex）

本稿已按 Codex 复核修订，主要变更：

- **EP-A 重定向**：放弃"在 main file-io 层另接 artifact proof 通道"（**重复造轮子**——`proof-collector.ts:129 collectToolOutputProofs` 已从成功工具输出里抽路径生成 artifact proof，见测试 `proof-collection-five-sources.test.ts:56`）。真因是**这轮根本没保存**；保存闸（`documentTargetGuard`/autosave，`agent-sdk-runtime.ts:4995-5048`）被结构性绕过。EP-A 改为"修保存闸的目标解析"，让保存发生后 proof 自然生成。
- **EP-B 落地路线明确**：`TaskInteractionState`（`run-contracts.ts:150-157`）没有 `none/done/closed`，DB 列 NOT NULL（`migrations.ts:1197`）。改为二选一：扩合同+迁移 / 或仅在任务卡渲染层对终态不显示 interaction badge（推荐后者，最小）。
- **EP-D 去险**：删除"`setTabPath` 同步清 `isDirty`"（危险——`setTabPath` 在 `writeFile` 之前，`documentActions.ts:1919-1951`，会把写失败误标已保存）；自愈只走"回退渲染 store 内容 + 文档变化信号重试"，落盘语义仍只由保存成功后的 `markTabSaved` 承担。
- **A2 判据收紧**：degraded-不硬失败的"实质成果"定义必须硬——文档编辑任务的完成 proof 至少是保存成功/文件路径/明确"未保存待续"，**普通编辑工具成功（tool_result）≠ 完成**（这轮就有 14 个 tool_result 仍没落盘）。
- **保留**：无 save_tab 修正、EP-C 文件树广播方向、症状三"已证实黏住 / 未证实 race"分写。

## 三轮复核变更摘要（2026-06-17，Codex）

按 Codex 第二轮复核再修订（方向不变，硬化实施合同）：

- **EP-A 补前置合同 A0**：A1 要"运行时观测 mutation → 绑 target → autosave"，但 renderer 回给 main 的文档工具结果只有 `summary + classifyDocActionMutationOutcome`（`mutated/mutationReason/documentSaved`，**无结构化 tabId/path/title**，`moduleExecutor.ts:300-312`、`documentActions.ts:284-329`，且全靠 summary 正则）。main 只知道"有文档被改"，不可靠知道"改的是哪个文件"。新增 **A0（前置合同）**：mutation 工具成功时结构化回传真实 `tabId/path/title`，否则 autosave 是猜测。A1 依赖 A0。
- **EP-B 断言与实现对齐**：B1（只在渲染层隐藏终态 badge）做不到"DB 里 suspended 仅出现在可续终态"——B1 下 DB 仍是 `failed+suspended`，只是不显示。断言拆开：B1 只验"UI 终态不显示 interaction badge"；要改 DB 真值得选 B2（扩合同+迁移）。
- **保存闸解释精确化**：guard 输入是 L1 包装文本 + request envelope，不是纯用户一句话；`requestEnvelope.primaryInstruction` 可给出裸「继续」，而 fallback `primaryInstructionText`（`agent-sdk-runtime.ts:779-788`）在 L1 包装文本里会截到无目标的前导块（如 `## L1 会话上下文`），两种情况下都拿不到上一轮引用目标。真正目标只存在于**回忆上下文 / 上一轮 `#引用`**里，保存闸（入口 `889`）没有从这些地方恢复目标。
- **A2 拆两类证据**：把"完成证据"（保存成功 proof / 文件路径 artifact → 可支持 `completed`）与"待续证据"（明确未保存待续 → 只支持 `checkpoint/blocked`，**不**支持 completed）分开，防止实现把"未保存待续"当成完成。
- **就绪度**：EP-C / EP-D 基本可做；EP-A 必须先落 A0 回传合同；EP-B 先定 B1(仅 UI) 还是 B2(改投影状态)。

## 0. 摘要（TL;DR）

- **现象（截图那轮）**：世界杯文档续作（`req-1781663965934-qkm5ug`，conv-acabc2a8）跑完，编辑器里能看到补充的内容，但任务卡同时显示「失败」+「已暂停」+ 标题卡在「正在理解需求」。
- **确证的真因（症状一）**：本轮真实序列是 `openTab → replaceExact → replaceExact → 结束，无 save_tab`；本轮 run 的请求指令就是字面 **「继续」**。`resolveDocumentTargetGuard`（`agent-sdk-runtime.ts:889-928`）只认**当前请求里**的目标引用 + 编辑触发词，"继续"两者都不命中 → 返回 `null` → 整套"未写入不许声明完成 + 新文档 autosave + 保存失败拦截"（`4995-5048`）被**结构性绕过** → 未落盘的编辑滑过 done → 裁决 degraded → 强制降级 → failed。
- **三表现面、≥2 共享根因（用户裁决口径）**：
  - **任务卡（症状一）** = 保存闸在续作里没接上 + 质量收口把"改了没保存的半成品"渲染成硬失败 + 终态没收敛 `interaction_state`。
  - **文件树（症状二）/ 编辑器标签（症状三）** = 文档变化**没有统一广播/通知**。
  - 共同主题：**「agent 改文档」缺统一 fan-out + 持久化与改动信号脱节**。
- **关键修正（推翻"内容一定已落盘"）**：`document.replaceExact` 等只改内存脏标签（`docStore.setTabContent` + 内存 `pendingToolDocumentWrites` Map），**只有 `save_tab` 才落盘**（`writeFile`）。所以这轮编辑只在标签里可见、没进磁盘——"disk content 总是对的"是错的；症状一里"c1 产出报告文件 未满足"**部分如实**（没保存就没物证）。
- **放大器**：中断+续作让本轮以全新 `research` 起跑（判据要新报告+来源 ref，与"编辑既有文档"错配），且"继续"指令天然丢失目标绑定——这正是保存闸被绕过的入口。
- **与 2026-06-16 续作修复的关系**：本问题**部分是那次 EP-2（shadow 裁决具备强制力 + degraded→failed 投影映射）的副作用**。那次在"续作秒死/起新 run"线是对的；本计划处理它溢出到"半成品被判失败"的新面 + 一直存在的刷新面。
- **ABI/native 降级**：`native:check` OK（Electron 42 / ABI 146），只排除一类底层问题，对本定位贡献不大。

## 1. 触发场景与现象（前因后果）

### 1.1 主时间线（conv-acabc2a8「世界杯视觉设计研究.md」续作）

| Run | 北京时间(≈) | task_type | 本轮请求（实测） | run_meta 终态 | 投影 status |
|---|---|---|---|---|---|
| `req-…2yepe5` | 10:21 | short_task | 「这个部分写多一点，再加入相关背景」 | done / done | completed |
| `req-…vs6lq6` | 10:36→10:37 | multi_step_task | 「@[世界杯视觉设计研究.md #引用]这…」 | error / blocked_external | **interrupted**（main_process_restarted）|
| `req-…qkm5ug` | 10:39→10:42 | **research** | **「继续」** | **error / adjudication_degraded** | **failed** |

- 第二条是用户说的「中断了一次」：续作中途主进程重启，没存下 continuation handle → 标 `interrupted/suspended`。文档以 `#引用`（引用/citation）出现在这条，**不是**编辑目标附件。
- 第三条是截图那张卡：指令仅「继续」，以全新 `research` run 接着跑，做了 `openTab + replaceExact×2` 后 **done 被强制降级为 failed**，**全程无 save_tab**。

### 1.2 截图三处自相矛盾

1. **「失败」**（status badge）：`adjudication_degraded → 'failed'`。
2. **「已暂停」**（interaction 标签）：终态投影把 `interaction_state` 收敛成了 `suspended`。
3. **标题「正在理解需求」+ 无步骤**：`steps_json=[]`、`recent_artifacts_json=[]`，投影停在初始相。

### 1.3 用户报告的另外两面

- **文件树不刷新**：在会落盘的场景（如新建文档 `setContent + saveTab`）写了文档，文件树不出现新文件，要切模式/重启才出来。
- **标签页「文档不可读」**：关掉该标签、重新打开后内容完整——不是数据没了，是打开着的标签卡在不自愈的错误态。

## 2. 问题定位过程（可追溯证据链）

方法：`ready-debug` 日志优先级 → 账本巡检 → 结构化 metric → 代码定位。运行态库：`~/Library/Application Support/ready/ready.db`（mtime 10:37；`Electron/ready.db` 是陈旧库，勿用）。日志在 `$TMPDIR/ready-*.log`。

### 2.1 排除 ABI（降级证据）

`native:check` → `OK Electron 42.3.0 Node 24.15.0 ABI 146`；`ready-database.log` 无 `NODE_MODULE_VERSION`。排除"原生依赖伪装成数据丢失"，对本问题无进一步指向。

### 2.2 账本（实测值）

`task_projections`（run `req-…qkm5ug`）：

```
status=failed  interaction_state=suspended  waiting_for=none
task_title=正在理解需求  steps_json=[]  recent_artifacts_json=[]  continuation_ref_json=∅
resumable_actions_json=["retry"]
checkins_json=[{kind:shadow, verdict:degraded, terminalStatus:done, terminalReason:done,
               satisfiedCount:2, totalCount:4, proofCount:15,
               blockers:["criteria_unsatisfied:c1","criteria_unsatisfied:c2"]}]
proof kinds = tool_result×14 + assistant_response×1   （零 artifact-kind proof）
```

`run_meta`：`status=error  terminal_reason=adjudication_degraded`；本轮 `first_message_text` 标题段 = **「继续」**。非终态行扫描（无声死亡）：**空**——不是卡死，是被判失败。

### 2.3 结构化 metric（`ready-agent-metrics.log`）

```
adjudicator_shadow_divergence  runId=req-…qkm5ug  taskType=research
  verdict=degraded  actualStatus=done  terminalReason=done  proofCount=15
  blockers=[criteria_unsatisfied:c1, criteria_unsatisfied:c2]
run_close  runId=req-…qkm5ug  terminalReason=adjudication_degraded  initiator=done
  toolCallsUsed=14  durationMs=177208  taskType=research
```

→ 运行时本来收口 `done`，shadow 裁决 `degraded`，该 verdict 被提升成实际 terminalReason。证明跑的就是 `923dddfe` 的新强制逻辑。

### 2.4 工具日志 + 保存闸解析（关键）

```
10:41:39  document.openTab
10:41:56  document.replaceExact   （已精准替换第 1 处）
10:42:15  document.replaceExact
10:42:23  run 结束（adjudication_degraded）   ← 无 document.saveTab
```

`resolveDocumentTargetGuard`（入口 `agent-sdk-runtime.ts:889-928`）的输入是 `envelopeRefs.primaryInstruction || primaryInstructionText(message)`。若 request envelope 提供 primaryInstruction，本轮 canonical 指令是裸「继续」；若走 fallback，`primaryInstructionText`（`779-788`）在 L1 包装文本里会截到无目标的前导块（如 `## L1 会话上下文`）。于是：① 三个 target 正则（写入/保存到/改成/编辑 @[...]）都不命中；② 单一可编辑附件的隐式编辑 fallback 也不命中（本轮目标只活在**回忆上下文/上一轮 `#引用`**里，已被截掉，`#引用` 本身是引用资源非编辑附件）→ 返回 `null` → `documentTargetGuard=null`、`newDocumentNeedsSave` 未触发 → `4995-5048` 的 done-block + autosave 全跳过 → 未落盘编辑被允许收口 done。**精确表述**：不是"继续"这个词本身有毒，而是 canonical 指令/前导块都没有目标，保存闸不从回忆/上一轮引用恢复目标。

### 2.5 代码定位（把账本/日志钉到行）

- **保存闸来源（EP-A 真支点）**：`agent-sdk-runtime.ts:3969`（`documentTargetGuard = resolveDocumentTargetGuard(content, requestEnvelope)`，**请求消息派生**）；`889-928`（解析逻辑）；`4995-5048`（未写入不许 done / `newDocumentNeedsSave` autosave / 保存失败 `persistence_failed` 拦截）。
- **proof 已能从保存输出生成 artifact**：`proof-collector.ts:129-143 collectToolOutputProofs`（从 data/projectionPatch/text 抽路径 → `collectArtifactProof`），测试 `proof-collection-five-sources.test.ts:56`。→ 缺的是"保存没发生"，不是"proof 通道缺失"。
- **强制降级**：`run-finalizer.ts` `writeTerminalOutcome`（约 192–221）：`done && verdict!=='accept'`，有可续证明转 `checkpoint`，否则转 `error/adjudication_degraded`。
- **degraded→failed 投影映射**：`task-projection-sync.ts` `resolveTerminalStatus`（约 347–356，`923dddfe` 新增）、`resolveTerminalBlockedReason`（约 454）。
- **判据/证据**：`criteria-templates.ts:69–72`（`research: c1=artifact, c2=report_sources`）；`task-adjudicator.ts:36–47`（`artifact/report_sources` 只认 `artifact`-kind）、`74–90`（done 且 satisfied<applicable → degraded）。
- **文档工具内存 vs 落盘**：`documentActions.ts:1858–1877`（`replace_exact` 仅内存）、`1914–1955`（`save_tab` → `writeFile`，`setTabPath`@1920 在写盘@1946 之前、`markTabSaved`@1951 仅在成功后）、`62–89`（内存 Map，仅被后续 `save_tab` 消费）。
- **终态 interaction_state bug**：`task-projection-sync.ts:317–326`（终态 `failed/completed/killed` 且原 `running/resuming` → 强制 `suspended`）。`TaskInteractionState` 枚举：`run-contracts.ts:150–157`（无 `none/done/closed`）。
- **文件树广播缺口**：`file-io-group.ts:219–377`（落盘 handler 不广播目录变化）；`directory-change-broadcast.ts:35`（仅 `browser-tools.ts:1442` 下载、`board-engine/ipc-handler.ts:74` 看板导出在用）；`FilesPanel.tsx:231–280`、`watch-group.ts:146`。
- **编辑器 loadError 不自愈**：`MarkdownEditor.tsx:253–339`（唯一写 loadError、依赖 `[tab.path]`）、`766–773`（不可读 UI）。

## 3. 根因分层 + 关联判断

### 3.1 症状一：续作改文档未保存 → 被判失败 + 显示已暂停（最高优先）

四段叠加（第 1 段是新确证的真支点）：

1. **保存闸在续作里结构性失效（真支点）**：保存闸 `resolveDocumentTargetGuard` 从 canonical 指令 + envelope 派生 target，需要当前指令里有目标引用 + 编辑触发词。本轮 canonical 指令是裸「继续」，真正目标只活在被截掉的回忆上下文/上一轮 `#引用` 里，保存闸不从那里恢复 → 闸 null → autosave/done-block 全跳过 → 编辑未落盘就收口 done。这把"agent 改了不保存"从偶发模型行为，变成**续作路径上的系统性漏洞**。
2. **判据与任务形态错配 + 编辑不产 artifact**：续作归 `research`，要 `artifact`（新报告文件）+ `report_sources`；编辑既有文档只产 `tool_result`，满足 document overlay 却满足不了 research 基线 → degraded。叠加第 1 段没落盘，c1 未满足**部分如实**。
3. **强制降级**（`923dddfe`）：`done + verdict≠accept + 无可续证明` → `error/adjudication_degraded` → 投影 `failed`。原意针对"degraded 且无成果"，但没区分"内容在标签但未落盘"。
4. **显示 bug**：`resolveRecordInteractionState` 把终态强收成 `suspended` → 「已暂停」；steps/artifacts 空 → 冻结「正在理解需求」。与 status 各算各的，凑成别扭三连。

### 3.2 症状二：文件树不刷新（写入侧无广播）

`document:write/createFile/saveAs` 不调 `broadcastDirectoryChanged`；文件树只靠"已展开+面板可见目录的 `fs.watch`"或别模块手动广播。写进未展开/未监听目录、或面板不可见时无事件 → 不刷新；切模式/重启重挂 `FilesPanel` 重扫，于是"手动救一下就好"。**与生命周期无关**。注意：截图那轮没落盘，那轮文件树不变是**正确**的；本症状真正咬人的是会 `save_tab`/`createFile` 的场景（用户提到的"新建文档 setContent+saveTab 成功"那次）。

### 3.3 症状三：标签页不可读、重开恢复（确证 + 假设分开）

- **确证（源码可证）**：不可读 UI 唯一来自 `MarkdownEditor` 的 `loadError`；只在 `tab.path` 变化时重算，一旦置错就**黏住、不重试、无自愈**；没有"文档已变/已加载"信号去清它。重开好是因为新标签已有干净非空内容（命中短路）或文件已就绪。
- **降级为假设（待复现）**：具体触发是不是"读文件撞上还没落盘的写"（`FILE_NOT_FOUND` race / 路径 `null→real` 仍 `isDirty` 重触发 read）——合理但本次日志未直接证明，需复现或抓日志。内存 `pendingToolDocumentWrites` reload 即丢，可能加剧"标签里有内容、重开不一致"的困惑。

### 3.4 关联判断（结论）

- **不是一个 bug**，但也**不是三个完全独立缺陷**。三表现面：任务卡（保存闸+收口+显示）；文件树/编辑器标签（文档变化无统一通知）。
- **更深共同根因**：文档改动与"持久化 + 改动信号"脱节——编辑落内存脏标签，是否/何时落盘取决于保存闸是否接上 / 模型是否记得 `save_tab`；即便落盘也没有统一"doc changed" fan-out 去刷 proof 账本、文件树、其它标签。
- **放大器**：中断+续作让续作以全新 `research` 起跑（判据错配）+ "继续"丢目标绑定（保存闸入口）；放大症状一、三，不影响症状二。

## 4. 修复方案（按用户优先级分工单）

> 顺序：先修"成功/有成果被误判失败"，再修"终态不显示已暂停"，再补"写入后刷新广播"，最后"编辑器自愈"。每个 EP 独立可验收。先合同后代码、修根因不修症状、手术式改动。

### EP-A（最高）：续作改文档不再"未保存→误判失败"

**支点 = 修保存闸的目标解析，让保存真的发生；保存发生后 artifact proof 由现有 `collectToolOutputProofs` 自然生成，不另接 proof 通道。**

- **A0（前置合同，必做，A1 的硬依赖）**：文档 mutation/save 工具**成功时结构化回传真实身份**——`tabId` + `title` 必填；`path` 对既有/已保存文档必填，对新建未保存标签可为 `null`；同时回传 `dirty/requiresSave/saveState` 这类保存状态。现状：renderer 回 main 的 payload 只有 `summary + classifyDocActionMutationOutcome`（`mutated/mutationReason/documentSaved`，靠 summary 正则；`moduleExecutor.ts:300-312`、`documentActions.ts:284-329`），**没有可靠文件身份/保存状态**。
  - 改动面：`documentActions.ts`（`performDocAction`/`classifyDocActionMutationOutcome` 增结构化身份字段）+ `moduleExecutor.ts`（透传）+ main 侧消费处类型。
  - 没有 A0，A1 的"绑 target → autosave"只能靠猜，禁止动手。
- **A-投0（前置调查，必做）**：核对续作/research 路由是否还在别处跳过 document domain 守卫（`document-tool-loop-orchestrator.ts:148` 的"改了必须 save_tab"本轮是否根本没进），产出"保存闸为何没接上"的完整清单。
- **A1（根因修复，依赖 A0）**：把"目标文档"从**仅 canonical 指令/envelope 派生**扩成**也认运行时实际改动**——若本 run 经 A0 回传确认对某个既有文档（tabId/path 明确）做了成功 mutation，即使指令是"继续"，也绑定该文档为 target，套用现有 `4995-5048` 的 done-block + autosave。硬边界：只有本 run 内**唯一明确被修改的 tab/path**，或所有成功 mutation 都指向同一个 tab/path，才允许 autosave；多目标、缺 path、或无法确认目标时只能 checkpoint/blocked，不能猜着保存。
  - 改动面：`agent-sdk-runtime.ts`（guard 解析新增"运行时观测目标"第二来源 + 消费 A0 身份）；复用既有 `documentTargetGuard`/`newDocumentNeedsSave`/autosave 分支，**不新建保存流程**。
- **A2（收口分级，判据拆两类）**：`done + degraded` 时按证据分流，**两类证据严格区分**：
  - **完成证据**（支持 `completed`）：保存成功 proof / 落盘文件路径 artifact。有则落"完成（带降级说明）"而非 failed。
  - **待续证据**（只支持 `checkpoint/blocked`，**不**支持 completed）：明确"未保存待续"状态。
  - **普通编辑工具 tool_result 成功不算任一类完成证据**（本轮 14 个 tool_result 仍没落盘即反例）。与 2026-06-16 §6.2 三分类红线对齐，防止把"未保存待续"误当完成。
- **A3（分类加分项）**：「继续/扩充既有文档」尽量归 `document`/`multi_step`（判据 d1/d2，`tool_result` 可满足），不归 `research`。降低错配，但不替代 A1。
- **明确放弃**：原 A1"在 main file-io 层另登记 artifact proof"——重复（`proof-collector.ts:129` 已覆盖），不做。

**回归断言**：① mutation/save 成功 → main 拿到结构化 tabId/title/path/保存状态（A0；新建未保存 path 可为 null）；② 续作"继续"里 agent 改了唯一既有文档 → 触发 autosave 或落"未保存待续"，**不**静默滑过 done；③ 多目标或无法确认目标 → checkpoint/blocked，不猜保存；④ 真落盘的 done → completed、有 artifact proof、不误判 failed；⑤ 真零成果 degraded → 仍非 completed；⑥ 纯 tool_result 成功但未落盘 → 不判 completed（按"待续证据"走 checkpoint/blocked，不进 completed）。

### EP-B：终态不显示「已暂停」（interaction_state 收敛）

`TaskInteractionState`（`run-contracts.ts:150-157`）无 `none/done/closed`，DB 列 NOT NULL（`migrations.ts:1197`）。二选一：

- **B1（推荐，最小）**：渲染层处理——任务卡对终态 status（completed/failed/killed）**不显示** interaction badge（「已暂停」等），不动合同/迁移。改动面：任务卡视图（`TaskCard`/`taskCardViewModel`）。
- **B2（更彻底）**：扩 `TaskInteractionState` + 迁移加终态中性值，`resolveRecordInteractionState`（`task-projection-sync.ts:317-326`）终态收敛到该值。改动面更大（合同+迁移+回填策略）。

**回归断言（按所选方案分开，不混用）**：
- **若选 B1（仅 UI）**：任意终态 status（completed/failed/killed）→ 任务卡 UI **不显示** interaction badge（「已暂停」等）。**注意 DB 真值仍可能是 `failed+suspended`**——B1 不改投影状态，只验 UI 不显示，不得断言"DB suspended 仅出现在可续终态"。
- **若选 B2（改合同+迁移）**：投影真值层 `suspended` 仅出现在真可续终态（checkpoint/paused）；终态 failed/completed/killed 落终态中性值。

### EP-C：文档写入/保存后广播目录变化（文件树刷新，方向已确认可直接做）

把 `broadcastDirectoryChanged([dirname(path)])` 接进 `file-io-group.ts` 的 `document:write/createFile/saveAs` 成功分支（镜像 `browser-tools.ts:1442`、`board-engine/ipc-handler.ts:74`）。改动面：三个落盘 handler + 复用 `directory-change-broadcast.ts`，不动 renderer watcher。
**回归断言**：agent `createFile`/`save_tab` 到任意目录（含未展开/不可见）→ 文件树最终刷新，无需切模式/重启。

### EP-D：编辑器 loadError 自愈（已去险）

让 `loadError` 可自愈，**但不把保存语义塞进 `setTabPath`**：① store 已有该 tab 非空内容时回退渲染内容而非黏错误态；② 收到 `document:directoryChanged`（或新增"文档已变"信号）时对该 tab 重试一次 read；③ 落盘成功仍只由 `save_tab` 路径的 `markTabSaved`（`documentActions.ts:1951`）承担，**不**在 generic `setTabPath` 清 `isDirty`（避免写失败被误标已保存）。
改动面：`MarkdownEditor.tsx`（错误回退/重试）；不动 `setTabPath` 的 dirty 语义。
**回归断言**：保存新文档/重开既有文档不再"打开着不可读、关掉重开才好"；文件就绪或 store 有内容时错误态自动恢复；写失败的 tab 不被标已保存。
**备注**：症状三精确触发器仍是假设，落地前最好补一次复现（人为 read 撞 write 或加触发态日志）再决定是否需要主进程读重试/锁。

## 5. 待确认问题（交给 Codex / 用户裁决）

1. **A1 目标解析的边界**：已收敛为硬合同——只允许唯一明确被修改的既有 tab/path 自动保存；多目标、缺 path、无法确认目标一律 checkpoint/blocked，不猜保存。
2. **autosave 的许可边界**：续作里自动保存既有文档，算不算需要用户确认的写动作（对照行动确认闸门 M 系列 / "确认≠提权"）？还是 autosave 仅写回用户已引用/已打开的目标即视为授权内？
3. **EP-B 选 B1 还是 B2**：只是显示别扭就 B1；若别处也依赖"终态 interaction 中性值"则 B2。
4. **症状三触发器**：需复现确认是否 `FILE_NOT_FOUND` race / 路径切换重触发 read；否则 EP-D 只做"黏住→自愈"，不动主进程读路径。
5. **历史数据**：沿用 2026-06-16 方案 A（仅修未来、零回填）。

## 6. 回归与验收（断言矩阵）

| 场景 | 期望 |
|---|---|
| mutation/save 工具成功 | main 拿到结构化 tabId/title/path/保存状态；新建未保存 path 可为 null（EP-A/A0 前置合同）|
| 续作「继续」里 agent 改了唯一既有文档 | 触发 autosave 或明确"未保存待续"；不静默滑过 done（EP-A/A1，依赖 A0）|
| 续作里改了多个文档或目标无法确认 | checkpoint/blocked；不猜保存（EP-A/A1 边界）|
| 文档真落盘的 done（有 save/writeFile） | completed；有 artifact proof（现有 `collectToolOutputProofs`）；不误判 failed |
| 纯 tool_result 成功但未落盘 | 不判 completed；按"待续证据"走 checkpoint/blocked（A2 拆两类）|
| 真零成果 degraded | 仍非 completed（不放水，沿用 2026-06-16 红线）|
| 任意终态 completed/failed/killed（选 B1）| 任务卡 UI 不显示「已暂停」badge；DB 真值可能仍 failed+suspended |
| 任意终态 completed/failed/killed（选 B2）| 投影真值终态中性；suspended 仅在可续终态 |
| 终态任务卡标题/步骤 | 不冻结「正在理解需求」，反映真实最后相或显式已结束 |
| agent createFile/save_tab 到未展开/不可见目录 | 文件树最终刷新出该文件（EP-C）|
| 保存新文档 / 重开既有文档 | 不再"打开着不可读、关掉重开才好"；错误态可自愈（EP-D）|
| 写盘失败的 tab | 不被标已保存（EP-D 去险）|
| 跨 EP 不回归 | `verify:stability` / `verify:evolution-p4` 绿；2026-06-16 续作修复不被破坏 |

## 7. 证据附录（可追溯）

- 账本：`task_projections(run=req-…qkm5ug)` status=failed / interaction_state=suspended / title=正在理解需求 / steps=[] / recent_artifacts=[] / checkin satisfiedCount 2/4 blockers c1,c2；`run_meta` error/adjudication_degraded、first_message 标题=「继续」。
- metric：`adjudicator_shadow_divergence`（verdict=degraded, actualStatus=done, proofCount=15）、`run_close`（terminalReason=adjudication_degraded, initiator=done, toolCallsUsed=14, durationMs=177208）。
- 工具日志：10:41:39 openTab → 10:41:56 replaceExact → 10:42:15 replaceExact → 10:42:23 结束，无 saveTab。
- 保存闸：`agent-sdk-runtime.ts:889-928`（resolveDocumentTargetGuard）、`3969`（请求派生）、`4995-5048`（done-block/autosave/persistence_failed）。
- proof 自动生成 artifact：`proof-collector.ts:129-143`、测试 `proof-collection-five-sources.test.ts:56`。
- 强制降级：`run-finalizer.ts` writeTerminalOutcome（约 192–221）。
- 投影映射/收敛：`task-projection-sync.ts` resolveTerminalStatus（约 347–356）、resolveTerminalBlockedReason（约 454）、resolveRecordInteractionState（317–326）。
- 判据/证据：`criteria-templates.ts:69–72`、`task-adjudicator.ts:36–47 / 74–90`。
- interaction 合同/迁移：`run-contracts.ts:150–157`、`migrations.ts:1197`（NOT NULL）。
- 文档工具内存/落盘/保存顺序：`documentActions.ts:62–89 / 1858–1877 / 1914–1955`（setTabPath@1920 先于 writeFile@1946，markTabSaved@1951 仅成功后）；`document-tool-loop-orchestrator.ts:148`（改了必须 save_tab 守卫）。
- 文件树广播：`file-io-group.ts:219–377`、`directory-change-broadcast.ts:35`、`browser-tools.ts:1442`、`board-engine/ipc-handler.ts:74`、`FilesPanel.tsx:231–280`、`watch-group.ts:146`。
- 编辑器：`MarkdownEditor.tsx:253–339 / 766–773`、`useDocTabs.ts:343–349 / 351–357`。
- ABI：`native:check` OK（Electron 42.3.0 / ABI 146）。运行态库：`~/Library/Application Support/ready/ready.db`。

---

**状态**：已按 EP-A…EP-D 实施。保留本文作为诊断、边界与回归断言追溯；具体落地以对应代码与测试为准。
