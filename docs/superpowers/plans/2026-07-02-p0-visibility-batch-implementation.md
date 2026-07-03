---
title: P0 Visibility Batch Implementation (P0-1..P0-4)
date: 2026-07-02
status: implementation
enforce: true
source:
  - docs/superpowers/plans/2026-07-02-agent-core-experience-roadmap.md（P0 表，修正版）
  - docs/superpowers/plans/2026-07-02-p0-0-provider-true-sse-streaming-implementation.md（P0-0 已完成+live proof）
  - src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts
  - src/main/modules/agent-control/runtime-core/skill-clarification-guard.ts
  - src/renderer/components/agent/chat-panel/task/TaskCard.tsx（ToolTraceCard）
---

# P0 可见性批次（P0-1 技能轮放行 / P0-2 活动流呈现 / P0-3 心跳 / P0-4 质量看板）

## 前置事实（2026-07-02 预研钉死）

1. **hold 的真实保护对象**：`maybeHandleSkillClarificationGuard(finalText)`（orchestrator:1770）
   会把"写成正文的澄清问题"steer 掉（整段丢弃重试）或 checkpoint（保留正文+后缀，
   :1219-1220 全量 emit）。守卫只作用于 **run 最终响应的文本**；工具边界之前的旁白
   永不进入守卫。文本形工具调用泄漏由 `NATIVE_TEXT_TOOL_MARKERS` 切分独立覆盖。
2. **hold 现状还会丢内容**：跨响应的中间旁白只进 buffer、终局只补发 finalText
   （最后响应文本），中间旁白从不显示。
3. **工具执行的编排器可见点**：tool-executor 经 `runtimeContext.emitOutput(callTrace,
   'tool_use')`（agent-sdk-tool-executor.ts:517/619/695）回到编排器 emitOutput 闭包
   （orchestrator:531）——响应边界钩子零新增管道。
4. **renderer 去重**：runtimeDriver chunk 前缀去重（nextBuffer.startsWith(previousBuffer)
   → 只追加尾巴），checkpoint 的"正文+后缀"全量 emit 天然兼容。
5. **活动流组件**：ToolTraceCard（TaskCard.tsx:749-855）收起态只显最新一条 preview，
   展开受父级 expanded 控制；事件 {id, kind:'call'|'result', text, timestamp}；
   工具串行（maxFunctionToolConcurrency:1）。
6. **run 开始已有 phase 事件**：emitStatus('working')（orchestrator:674，极早）→
   phase 'planning' + type 'started'；phase 枚举含 planning/tool_running/responding…
   （electron.d.ts:867-877），不新增枚举值。
7. **`runtime.publishScopeRunEvent(payload)`（runtime.ts:3615-3617，公开方法）**：
   record + emit → ipc-handler:1625 直转 renderer——心跳零新 IPC/零类型改动。
8. **P0-4 数据单源**：`run_close`（terminalReason/taskType/at）、
   `adjudicator_enforce_divergence`、`provider_stream_first_delta`、
   `provider_stream_fallback` 全部落 ready-agent-metrics.log（JSONL，轮转）——
   看板聚合零 DB 改动。

## P0-1 技能轮 hold 放行（响应边界放行）

### 设计

hold 轮（`holdNativeTextUntilFinal===true`）不再"整轮全扣"，改为：

- onTextDelta 照旧只进 buffer（不放行进行中的响应文本）；
- **每当一个原生工具执行（emitOutput 收到 'tool_use'）→ 先 `flushNativeTextBuffer(true)`
  再发工具事件**——该响应既已产生工具调用，其旁白不可能成为守卫要转卡的 run 终局文本，
  且文本先于工具行出现，顺序自然；
- run 终局文本继续持留至守卫裁决：none → 既有 :1774 补发；steer → 静默丢弃（从未流出）；
  checkpoint → 既有全量 emit（该响应从未流出，无重复）；
- 实现为 emitOutput 内的边界冲刷 ref：进入 runAgent 前武装（仅 hold 轮）、
  runAgent 返回/抛错即解除——run 后处理阶段（泄漏工具恢复 :1722 也会发 tool_use）
  **永不**触发冲刷，守卫待决文本不可能提前泄出。

### 完成标准（行为测试，agent-sdk-runtime.test.ts 既有 harness）

1. 【防泄漏钉子，改造前先写、改造后仍绿】技能授权轮（buildPreferredSkillToolNames 含
   skill_ask_user），模型零工具、finalText 为澄清问句 → 守卫 steer：澄清文本
   **零字节**出现在任何 'output' text 事件中；第二轮正常文本正常显示。
2. 【边界放行】技能授权轮，fake runAgent：先 onTextDelta 旁白 → invoke 一个工具 →
   再 onTextDelta 尾声并返回正常 finalText：旁白文本事件出现在 tool_use 事件**之前**；
   旁白与尾声各恰好出现一次（无重复无丢失）。
3. 【checkpoint 无重复】已 steer 过再次澄清 → checkpoint：保留正文+暂停后缀恰好
   出现一次；terminalReason=checkpoint_steered。
4. 非 hold 轮行为零变化（既有全量套件回归覆盖）。

## P0-2 ToolTraceCard 呈现调整

### 设计（组件内改动 + 纯函数，父级不动）

1. 纯函数 `deriveToolTraceRows(events)`（新文件 renderer/modules/agent/toolTraceRows.ts）：
   顺序配对 call→result（串行语义：result 配最近未配对 call），result 行带
   `durationMs`；输出行含显示文本与耗时标签（≥100ms 显示，`1.2s`/`860ms` 格式）。
2. ToolTraceCard：
   - `pending && !expanded` → 自动露出**最近 3 条**紧凑行（含耗时），header 保留
     "进行中的工具调用 + 最新 preview"；
   - `!pending`（run 结束）→ 回到现状收起态（自动收拢）；
   - 用户手动 expanded → 全量列表（现状），行内新增耗时标签；
   - 尺寸/密度遵循现有 t-meta 排版，不加新视觉框架。

### 完成标准

1. 纯函数单测：配对/耗时/乱序 result 容错（无未配对 call 时 result 行无耗时）、
   <100ms 不显示标签。
2. 组件行为测试（沿用 agent-phase4-settings-panels.test.tsx 的 tsx 测试形态）：
   pending+collapsed 渲染恰好 min(3, N) 条最近行；pending=false 时不渲染自动行；
   expanded 渲染全量。
3. 不新增 toolEvent 消费者、不改父级挂载 props（除向下传 pending 所需的既有 prop）。

## P0-3 首事件前心跳

### 设计

- orchestrator 新增 `emitHeartbeat(text)`：构造 `{type:'updated', scopeId, agent,
  runId, taskId?, phase:'planning', latestText:text, timestamp}` 经
  `this.host.publishScopeRunEvent(payload)` 发布（host 接口补一个可选方法签名，
  runtime 已有实现）；
- 发射点：emitStatus('working') 后（"正在理解需求…"）、prompt/工具面组装完成即将
  进入模型调用前（"正在调用模型…"）、compaction 重试时（"上下文过长，正在压缩重试…"）；
- 首个真实输出（text/tool_use）到达后 phase 自然被 responding/tool_running 覆盖，
  心跳无需清理逻辑；
- 心跳只在 run 期发射且带 runId；`isCurrentRun()` 守卫沿用（旧 run 晚到不得覆盖新 run
  ——稳定性合同）。

### 完成标准

1. 行为测试：一次 sendMessage 产生的 scopeRunEvent 序列中，在首个 text/tool 事件前
   存在 ≥2 个 phase='planning' 且 latestText 为心跳文案的 'updated' 事件，且
   runId 正确；run 被 supersede 后旧 run 心跳不再发射（isCurrentRun 守卫）。
2. 心跳不进 chat_messages 正文、不产生 transcript 'output' 事件（只走 scopeRunEvent）。
3. 不新增 phase 枚举值、不新增 IPC channel（enum drift gate 与 ipc-contract 零改动）。

## P0-4 运行质量看板

### 设计（metrics log 单源，最小闭环六件套）

1. 纯聚合 `agent-control/quality/run-quality-stats.ts`：
   `aggregateRunQualityStats(lines: string[], now)` → 最近 14 天
   `{days:[{date,total,proofGap,degraded,unconfirmed,done}], divergenceCount,
   firstDelta:{count,p50Ms,avgMs}, streamFallbacks:{reason:count}}`；
   malformed 行跳过不炸（账本消费纪律）。
2. IO 壳：读 `<tmpdir>/ready-agent-metrics.log`（+ 存在则 .1 轮转文件）尾部 ≤5MB。
3. IPC：新 group `claude-bridge/ipc/run-quality-group.ts` 注册
   `agent:getRunQualityStats`（只读）；preload `agent.getRunQualityStats()`；
   renderer 类型同步。
4. Settings 新面板 `RunQualityPanel`（挂在诊断/知识区旁）：14 天 proof_gap 日占比
   迷你表、divergence 计数、首 token 延迟 p50/均值、降级原因计数——数字优先、
   零装饰（workbench 极简基准）。

### 完成标准

1. 纯函数单测：占比/分位数/malformed 跳过/空日志。
2. IPC 行为测试：handler 注册且返回结构化数据（fake 文件内容）。
3. 面板渲染测试：给定 stats 渲染出关键数字。
4. `npm run verify:ipc-contract` 相关 gate 不回退（新增 channel 按合同登记）。

## 批次收尾验收

1. `npm run typecheck` 通过；
2. `npm run verify:streaming` 通过（157/161 基线之上零新增失败）；
3. `npm run verify:stability` 通过（P0 验收红线"不回退"）；
4. 新增焦点测试全绿；
5. 用户测试指南（操作步骤+预期结果）随批次完成交付。

## 非目标

- 不动 IPC 通道结构、不新增 phase/terminalReason 枚举；
- 不做卡片视觉重设计（只调信息密度与默认态）；
- 不改守卫（clarification/announcement）判定逻辑本身；
- 不做 P1+ 内容（浏览器合同、A1 补全等）。

## Closeout（2026-07-03 回填，工作区未提交）

**P0-1 完成**：orchestrator emitOutput 'tool_use' 钩子 + 每模型调用武装/解除的
`nativeTextToolBoundaryFlush` ref（agent-sdk-turn-orchestrator.ts）。三行为测试：
钉子（steer 防泄漏/checkpoint 无重复，改造前后均绿）+ 边界放行（改造前红→改造后绿，
旁白先于 tool_use、恰好一次）。夹具备注：裸 listToolDefinitions 覆盖会丢 skills
capability 组导致 skill_ask_user 不入 allowlist——沿用"浏览器消息 + 显式技能 +
setBrowserController"的既证形态。

**P0-2 完成**：`renderer/modules/agent/toolTraceRows.ts` 纯配对/耗时 +
ToolTraceCard pending 态自动露出最近 3 条（收起态 preview 在完成态回归）+
展开全量带耗时。6 测试（3 纯 + 3 JSDOM 组件）。

**P0-3 完成**：`emitHeartbeat`（phase='planning' 复用 + `publishScopeRunEvent?.()`
双重可选调用——初版只判 runtime 空、未判方法空，被 fake-runtime 测试当场抓出）；
发射点：working 后"正在理解需求…"、每次模型调用前"正在调用模型…/压缩重试文案"；
RunDurationMeter planning 态用心跳文本替换静态标签（状态回显与超长文本回落）。
4 测试（1 runtime 行为 + 3 纯 label）。既有 tool-trace-truth 测试按新通道语义更新
（心跳事件零 toolEvent + 工具序列不受扰动，双断言保留原意图）。

**P0-4 完成**：`quality/run-quality-stats.ts`（纯聚合 + 5MB 有界尾读，metrics log
单源）→ `ipc/run-quality-group.ts`（agent:runQuality:stats）→ preload/d.ts →
`RunQualityPanel`（Settings 信念卡面板旁；样本/proof_gap 占比/降级占比/裁决分歧/
首 token p50/流式降级 + 近 7 天日行）。4 测试（2 纯 + 1 IPC group + 1 JSDOM）。

**批次验收**：
- `npm run typecheck` 通过；
- `npm run verify:streaming`：165 测试 162 过、3 失败=改造前既有基线
  （upload 工具曝光 / document 附件隐藏 / new document 修复，与本批次无关）；
- `npm run verify:stability`：**整链 EXIT=0，全段 fail 0**；
- 新增焦点测试合跑 13/13 绿；
- `check-ipc-contract`：本批次新 channel 零违规；gate 整体 FAIL 来自
  browser-engine/ipc-handler.ts 的分支 WIP 既有 2 处违规（非本批次文件，留档不认领）。

**P0-0 live proof 补记**：用户 2026-07-02 晚真机实测流式逐段输出通过。
P0-1..P0-4 的真机验收见批次交付的用户测试指南（roadmap P0 验收项）。
