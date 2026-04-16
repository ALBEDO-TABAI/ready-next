# Document Read → Insight → Widget Pipeline Design

**Date:** 2026-04-16

**Status:** Draft for review

**Scope:** 文档阅读后生成信息卡 / widget 的阶段化执行链、超时治理、分段计时、可观测性与实施路径

---

## 1. Goal

为 Ready 里的这类请求建立稳定可观测的执行链：

- “先阅读当前文档，然后做一个信息卡”
- “根据这份文档整理一个卡片摘要”
- “先理解文档内容，再把结果写成 info card / stats card / comparison card”

本设计要解决的不是单点慢，而是 **当前单轮请求把『读文档 → 理解 → 提炼 → 生成卡片 → 写回文档』全部塞进一个总超时预算里，导致长任务不稳定、超时原因不可见、失败无法分段重试**。

目标是把它改造成：

1. **带问题的文档读取 / 分块提炼**
2. **产出结构化中间结果（insight）**
3. **基于 insight + widget 规则生成 card spec**
4. **由本地确定性写入把 widget 落到文档中**
5. **每阶段单独计时、可回显、可缓存、可重试**

---

## 2. Why This Matters

当前用户感知到的是“请求超时”，但真实问题可能来自不同层：

- 文档上下文没有真正送进去，导致模型在单轮里重复试探
- 文档读取链路含同步 I/O，主进程被阻塞
- agent 总超时过粗，没有阶段预算
- 长文档被截断为很小的上下文，任务语义与数据量不匹配
- widget 写入其实已经相对确定，但前面的理解与生成没有拆层

如果不改结构，只把超时时间从 5 分钟改到 10 分钟：

- 失败仍然会发生
- 用户仍然不知道卡在哪一段
- 系统仍然无法按阶段复用与重试
- 长文档任务的成本仍然失控

---

## 3. Current State Summary

### 3.1 当前 agent 请求发送链路

用户消息经 `useAgent.sendMessage()` 发送，随后组装成最终 prompt：

- `src/renderer/stores/useAgent.ts:877`
- `src/renderer/stores/useAgent.ts:938`
- `src/renderer/stores/useAgent.ts:945`

文档模式下会自动带上当前文档上下文，但这个上下文只是 **当前激活文档前 1200 字的截断片段**：

- `src/renderer/modules/agent/documentActions.ts:826`
- `src/renderer/modules/agent/documentActions.ts:836`
- `src/renderer/modules/agent/messageComposer.ts:294`
- `src/renderer/modules/agent/messageComposer.ts:297`

这意味着当前并不存在正式的“深度读文档后再生成卡片”的执行链。系统更像是在做：

> 用户消息 + 当前文档前 1200 字摘要 → 一次性送给 agent

这适合小改动，不适合“先读完整文档再做结构化产物”。

### 3.2 当前文档读取 / 写回能力分布

文档编辑侧已经具备较强的确定性操作能力：

- 载入文档：`src/renderer/modules/agent/documentActions.ts:768`
- 插入 widget：`src/renderer/modules/agent/documentActions.ts:931`
- 更新 widget：`src/renderer/modules/agent/documentActions.ts:966`
- 保存文档：`src/renderer/modules/agent/documentActions.ts:1048`
- tool → doc action 映射：`src/renderer/modules/agent/documentActions.ts:1068`

OpenUI / widget 规范也已经存在：

- `src/shared/document-widget-openui.ts:96`
- `src/shared/document-widget-openui.ts:212`

所以当前最弱的部分不是“怎么落盘”，而是：

- 怎么稳定地读文档
- 怎么针对问题提炼 insight
- 怎么把 insight 喂给第二轮卡片生成
- 怎么给每一步预算与反馈

### 3.3 当前超时与阻塞风险

agent 总超时现在是固定 5 分钟：

- `src/main/modules/claude-bridge/agent-manager.ts:153`

与此同时，provider 侧已经存在一层更细的单次请求超时策略：

- 普通请求：45 秒
- 通用文档工具请求：75 秒
- widget create / update 文档请求：90 秒

相关位置：

- `src/main/modules/claude-bridge/request-timeout-policy.ts`
- `src/main/modules/claude-bridge/openai-execution-client.ts`
- `src/main/modules/claude-bridge/anthropic-execution-client.ts`

这说明当前问题并不是“完全没有给文档任务更长超时”，而是：

- 单次请求仍然把“读文档 + 理解 + 生成卡片 + 写回”混在一起
- 会话级 system prompt 还可能被阶段性规则不断叠加，导致后续请求越来越重
- 总 run budget、单次 provider timeout、文档工具循环补提醒之间缺少统一的阶段化治理

这是整轮预算，不区分：

- 读文档
- 提炼 insight
- 生成 widget
- 写回文档

文档主进程 IPC 里存在同步 I/O：

- `readFileSync`：`src/main/modules/document-engine/ipc-handler.ts:146`
- `readdirSync / statSync`：`src/main/modules/document-engine/ipc-handler.ts:3-5`
- xlsx 整块读取：`src/main/modules/document-engine/ipc-handler.ts:181`

这会带来两个风险：

1. 大 docx / xlsx 会直接阻塞 Electron main thread
2. agent 流式反馈、IPC 响应、文档解析会互相影响，看起来像统一的“超时”

---

## 4. Problem Statement

当前“阅读文档后制作信息卡”的失败，不应被理解为一个单纯的 timeout 数值问题，而是一个 **任务建模错误**：

### 当前错误建模

把以下行为混成一个黑盒请求：

1. 打开并读取文档
2. 找到和用户问题相关的部分
3. 理解内容并提炼重点
4. 选择卡片形态
5. 生成 widget 内容
6. 写回文档
7. 保存文档

### 这会导致

- **数据面太大**：长文档无法稳定进入模型上下文
- **时间面太粗**：只有总超时，没有阶段预算
- **错误面太黑**：不知道卡在哪一步
- **状态面不可复用**：第二次调卡片样式还得重读文档
- **写入面不够克制**：模型容易被迫同时负责“理解 + 产出 + 写文档”

---

## 5. Design Goals

### 5.1 Primary Goals

1. **阶段化执行**：把单次大任务拆成明确阶段
2. **问题驱动阅读**：不是盲读文档，而是“带着问题读”
3. **中间结果显式化**：把 insight 产物落成结构化对象
4. **生成与写入分离**：模型负责理解和生成；本地工具负责落盘
5. **分段计时**：每阶段独立统计耗时与预算
6. **分段重试**：第二轮失败时，不必重读文档
7. **长文档友好**：支持 chunked read / focused aggregation
8. **可观测**：UI / trace / logs 都能看到阶段与耗时

### 5.2 Non-Goals

本设计不直接覆盖：

- 任意文档协作工作流的全面重写
- 大规模 provider 替换
- 文档编辑器核心模型更换
- widget runtime 的渲染机制重写
- 长期记忆系统的全面接入

---

## 6. Core Decision

## 决策：采用 `Document Read -> Insight -> Widget` 三段流水线

把“先阅读文档再制作信息卡”设计为一个显式 pipeline，而不是一个模糊的单轮 prompt。

### Phase A — Read / Focus

输入：

- 用户问题
- 文档路径 / 当前活动文档
- 可选章节范围 / 用户指定区域
- 预算（时间 / token / chunk 数）

输出：

- 与问题相关的文档切片集合
- 文档元数据
- 分块提炼结果

### Phase B — Insight

输入：

- Phase A 的相关切片
- 用户问题

输出：

- `DocumentInsight`
- summary
- key points
- evidence
- recommended widget family

### Phase C — Widget Materialization

输入：

- `DocumentInsight`
- widget catalog / OpenUI schema
- 风格 /组件偏好

输出：

- `componentSpec`（首选）
- 或规范化 `widgetCode`

### Phase D — Deterministic Writeback

输入：

- `componentSpec` / `widgetCode`
- 目标文档
- 插入位置 / 更新目标

输出：

- 本地写入结果
- 保存结果
- artifact refs / trace events

---

## 7. Proposed Runtime Architecture

## 7.1 新增 pipeline owner

建议新增一个面向文档结构化任务的专门编排层，例如：

- `src/main/modules/agent-control/document-task-pipeline.ts`

它不替代现有通用 agent loop，而是作为 **特定任务类型的阶段化执行器**。

### 责任

- 识别这是不是 `document_read_then_widget_create` 类型
- 维护阶段状态机
- 分配阶段预算
- 决定是轻量上下文还是深读模式
- 驱动 insight 生成与 widget 生成
- 最终调用确定性文档写回

### 不该承担的责任

- 不直接做 widget renderer 运行时逻辑
- 不直接持有文档 UI 状态
- 不直接耦合 ChatPanel 呈现细节
- 不成为通用 provider 封装替代品

---

## 7.2 引入显式任务类型

建议在当前 intent / task classification 层新增显式类型：

```ts
export type StructuredDocumentIntent =
  | 'document_read_then_widget_create'
  | 'document_read_then_summary'
  | 'document_read_then_rewrite_section'
```

其中本次重点是：

```ts
'document_read_then_widget_create'
```

### 触发条件

用户请求同时包含以下两类意图：

1. 阅读 / 理解文档
   - “先阅读”
   - “根据这份文档”
   - “看完文档后”
   - “从当前文档整理”

2. 结构化卡片产出
   - “制作信息卡”
   - “生成一个卡片”
   - “做成 info card”
   - “整理成可视化卡片”

### 为什么要显式分类

因为只有识别为该类型，系统才知道不能只靠：

- 1200 字自动上下文
- 单轮 prompt
- 单次总超时

### 不应该命中的场景

以下场景应继续走现有路径，而不是误进新 pipeline：

- “更新这个 widget / 改这个卡片样式” → 继续走 `document_update_widget`
- “看看现在有哪些 widget” → 继续走 `document_list_widgets`
- “删除这个 widget” → 继续走 `document_remove_widget`
- “只做格式优化” → 继续走现有 deterministic format flow
- “只改某一章节内容” → 继续走现有 deterministic rewrite flow

换句话说，新 pipeline 只应覆盖：

> 需要先读文档，再产出一个新的结构化卡片 / widget 草稿

---

## 7.3 阶段状态机

建议给这类任务建立正式状态机：

```ts
export type DocumentWidgetPipelinePhase =
  | 'queued'
  | 'loading_document'
  | 'chunking_document'
  | 'extracting_relevant_chunks'
  | 'building_insight'
  | 'generating_widget_spec'
  | 'writing_widget'
  | 'saving_document'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

每个 phase 都应有：

- `startedAt`
- `endedAt`
- `durationMs`
- `budgetMs`
- `status`
- `error?`
- `summary?`

---

## 7.4 活动文档全文快照入口

第一阶段实现里必须补一个 **仅供系统内部使用** 的活动文档快照入口，否则主进程拿不到：

- 未保存草稿的全文
- 当前标签页的真实内容
- 当前标签页标题 / 路径 / dirty 状态

现在主进程能稳定拿到的通常只有：

- prompt 里的 1200 字文档摘要
- 或从路径重新读文件

这对“当前正在编辑但尚未保存”的文档不够。

### 建议新增

在 renderer 文档代理侧增加一个 host-only action，例如：

- `document.inspectActive`

返回：

```ts
interface ActiveDocumentSnapshot {
  title: string
  path: string | null
  content: string
  isDirty: boolean
  charCount: number
}
```

### 约束

- 这不是给模型直接暴露的新工具
- 只供 runtime / pipeline 内部读取当前活动文档
- 若存在路径，后续写回仍优先复用现有确定性文档工具

---

## 8. Data Contracts

## 8.1 `DocumentReadPlan`

```ts
interface DocumentReadPlan {
  taskType: 'document_read_then_widget_create'
  question: string
  documentPath: string
  deepRead: boolean
  targetSections?: string[]
  preferredWidget?: string
  maxChunks: number
  maxCharsPerChunk: number
  maxInsightChars: number
}
```

作用：

- 把“本次要怎么读”说清楚
- 明确不是所有任务都要全文深读
- 为预算控制和 trace 提供依据

## 8.2 `DocumentChunk`

```ts
interface DocumentChunk {
  id: string
  index: number
  sectionTitle?: string
  content: string
  charCount: number
  startLine?: number
  endLine?: number
}
```

## 8.3 `FocusedChunkInsight`

```ts
interface FocusedChunkInsight {
  chunkId: string
  relevanceScore: number
  summary: string
  keyPoints: string[]
  evidence: string[]
}
```

## 8.4 `DocumentInsight`

```ts
interface DocumentInsight {
  question: string
  documentPath: string
  documentTitle: string
  summary: string
  keyPoints: string[]
  evidence: Array<{
    sectionTitle?: string
    quote: string
  }>
  recommendedWidget:
    | 'info_card'
    | 'stats_card'
    | 'comparison_grid'
    | 'callout_block'
    | 'data_table'
  warnings?: string[]
}
```

这是整个设计的关键中间产物。

### 它的价值

- 可缓存
- 可展示给用户确认
- 可二次生成不同 widget
- 可在失败后恢复
- 可被 trace / logs / future memory capture 利用

## 8.5 `DocumentWidgetDraft`

```ts
interface DocumentWidgetDraft {
  componentSpec?: {
    component: string
    props?: Record<string, unknown>
    dataSource?: {
      type: 'manual' | 'calendar' | 'schedule'
      preset?: string
      date?: string
    }
  }
  widgetCode?: string
  title: string
  insertionMode: 'append_end' | 'after_section' | 'update_existing'
  targetSectionTitle?: string
  targetWidgetTitle?: string
}
```

### 决策

**优先产出 `componentSpec`，而不是直接让模型自由生成 `widgetCode`。**

原因：

- 当前已有 widget schema 与 compiler
- 更利于校验
- 更利于测试
- 更利于以后统一 UI 风格

相关基础：

- `src/shared/document-widget-openui.ts:96`
- `src/shared/document-widget-openui.ts:212`

---

## 9. Read Strategy

## 9.1 两种读取模式

### A. Light Context Mode

适用于：

- 小文档
- 跟随当前段落的简单修改
- 用户没有明确要求“先完整读文档”

沿用现有：

- 当前文档前 1200 字上下文
- `src/renderer/modules/agent/documentActions.ts:836`

### B. Deep Read Mode

适用于：

- 用户明确要求“先阅读文档”
- 需要总结 / 提炼 / 生成结构化卡片
- 当前文档明显超过轻量上下文范围
- docx / 长 markdown / 长 txt

### 决策规则

当满足以下任一条件时，进入 `deepRead: true`：

- 显式命中 `document_read_then_widget_create`
- 文档字符数 > 4,000
- 用户指令包含“先阅读”“看完”“通读”“根据全文”

---

## 9.2 Chunking 策略

### 原则

不是机械按固定字符切，而是：

1. 尽量按章节切
2. 章节过长再按段落切
3. 段落过长再按字符窗口切

优先复用已有章节识别能力，现有文档模块已经有章节锚点解析逻辑：

- `src/renderer/modules/agent/documentActions.ts:149`
- `src/renderer/modules/agent/documentActions.ts:199`
- `src/renderer/modules/agent/documentActions.ts:210`

建议把这些章节识别逻辑提炼成 shared helper，避免 pipeline 自己再写一套。

### 默认参数建议

- `maxChunks = 8`
- `maxCharsPerChunk = 2200`
- `maxSelectedChunksForInsight = 4`

### 目标

让模型面对的是：

- 若干个和问题相关的片段
- 而不是整篇长文
- 也不是只有开头 1200 字

---

## 9.3 Focused Read 而不是 Blind Summary

本阶段不应该做“全文摘要”，而应该做：

> 带着用户问题，从文档中筛出和本次卡片制作最相关的内容。

例如用户说：

> 先阅读当前项目文档，然后做一张项目定位信息卡

那么 pipeline 读文档时的提示不该是：

- “请总结这篇文档”

而应是：

- “围绕项目定位、核心能力、工作台模式，提炼制作 info card 所需的最关键内容”

---

## 10. Insight Stage Design

## 10.1 为什么必须显式 insight

当前系统的问题之一是：

- “理解文档”只是模型内部隐式过程
- 系统拿不到一个稳定的可重用结果

这会导致：

- 第二轮改卡片样式需要重新读文档
- trace 看不到“理解结果是什么”
- UI 无法展示“我先读了什么，提炼了什么”

所以必须显式产出 `DocumentInsight`。

## 10.2 Insight 生成策略

### 小文档

可以直接从全文 / 主要章节生成一个 insight。

### 长文档

先做：

1. chunk-level relevance extraction
2. aggregate chunk insights
3. merge into final `DocumentInsight`

### 结果要求

- `summary`：一段浓缩结论
- `keyPoints`：3-6 条
- `evidence`：最好附带引文或章节来源
- `recommendedWidget`：推荐卡片类型
- `warnings`：例如信息不足、章节冲突、文档过长已采样

---

## 11. Widget Generation Stage

## 11.1 以 `componentSpec` 为第一输出

建议 Widget 阶段优先要求模型输出符合 OpenUI 的 `componentSpec`。

例如：

```json
{
  "component": "info_card",
  "props": {
    "heading": "Ready 项目定位",
    "body": "Ready 是一个集成式创作工作台，统一承载浏览、文稿、RSS、日程、AI Agent、技能中心与远程协作。",
    "points": [
      "统一工作台",
      "多模式切换",
      "Agent 深度协同"
    ],
    "tone": "info"
  }
}
```

然后交给本地编译成 widget code。

### 好处

- 减少模型直接写 HTML/SVG/JS 的自由度
- 更利于 schema 校验
- 更利于回归测试
- 更利于以后统一视觉风格

## 11.2 当何时允许直接输出 `widgetCode`

仅在以下情况下允许：

- 现有 catalog 中没有合适组件
- 用户明确指定自定义 widget 代码
- componentSpec 编译失败且存在安全兜底策略

默认路径仍应是：

> insight -> componentSpec -> compile -> widgetCode

---

## 12. Writeback Stage

## 12.1 模型不直接整篇重写文档

写回文档必须优先走现有确定性操作：

- `insert_widget`
- `update_widget`
- `save_tab`

相关入口：

- `src/renderer/modules/agent/documentActions.ts:931`
- `src/renderer/modules/agent/documentActions.ts:966`
- `src/renderer/modules/agent/documentActions.ts:1048`

### 原则

- 模型负责理解与生成
- 本地工具负责结构化写入
- 除非用户明确要求整段改写，否则不要让模型整体重写全文

## 12.2 写回位置策略

支持三种模式：

1. `append_end`
2. `after_section`
3. `update_existing`

默认建议：

- 如果用户指定“在某章节后插入” → `after_section`
- 如果用户指定“更新已有卡片” → `update_existing`
- 否则默认 `append_end`

---

## 13. Timeout And Budget Design

## 13.1 总预算与阶段预算并存

保留总超时，但不再只靠总超时。

建议：

```ts
interface PipelineBudget {
  totalMs: number
  loadDocumentMs: number
  focusedReadMs: number
  buildInsightMs: number
  buildWidgetMs: number
  writebackMs: number
}
```

### 默认建议预算

- `totalMs = 300000`（先兼容现有 5 分钟）
- `loadDocumentMs = 20000`
- `focusedReadMs = 60000`
- `buildInsightMs = 60000`
- `buildWidgetMs = 60000`
- `writebackMs = 20000`

### 为什么不是平均分

因为：

- 文档读取应该尽快失败或尽快完成
- insight / widget 是主要模型阶段
- 写回必须短且确定

## 13.2 预算耗尽策略

### 某阶段超时

- 该阶段立即失败
- 输出明确 phase 名称
- 保留前序阶段产物
- UI 告知“已完成到哪一步”

### 总预算接近耗尽

- 如果 insight 已拿到但 widget 未生成，可以给出“先返回 insight”的降级结果
- 如果 widget 已生成但写回失败，可以返回 widget 草稿供用户手动确认

---

## 14. Observability And UX

## 14.1 每阶段可见

当前 run state / tool trace 已经有基础能力：

- `src/renderer/stores/useAgent.ts:918`
- `src/renderer/modules/agent/runtimeDriver.ts:23`
- `src/renderer/modules/agent/runtimeDriver.ts:54`

建议新增面向 pipeline 的前台阶段展示：

- 正在读取文档
- 正在提炼关键信息
- 正在生成信息卡
- 正在写入文档
- 正在保存

## 14.2 每阶段都记录 metrics

建议记录：

```ts
interface PipelinePhaseMetric {
  phase: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  budgetMs: number
  inputChars?: number
  outputChars?: number
  chunkCount?: number
  selectedChunkCount?: number
  cacheHit?: boolean
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
}
```

## 14.3 分段日志

建议写入 ready 现有日志体系时，按 phase 分段：

- `document_pipeline phase=loading_document ...`
- `document_pipeline phase=building_insight ...`
- `document_pipeline phase=generating_widget_spec ...`

这样就能真正回答：

- 慢在读文档？
- 慢在相关片段提炼？
- 慢在第二轮 widget 生成？
- 还是写回 / 保存阶段？

---

## 15. Caching Strategy

## 15.1 为什么值得缓存

这类任务常见 follow-up 是：

- “再简洁一点”
- “换成 stats card”
- “不要这个色调，换成 warning”
- “保留结论，把 points 改三条”

这些都不该重新全文阅读。

## 15.2 缓存粒度

优先缓存 `DocumentInsight`，而不是最终 widget。

### cache key 建议

- `documentPath`
- `documentModifiedAt` 或内容 hash
- `questionHash`
- `selectedSectionsHash`

### cache value

- `DocumentInsight`
- `selectedChunks`
- `phase metrics`

### 生命周期

- 会话内短期缓存先行
- 之后再考虑跨会话缓存

---

## 16. Main Process I/O Refactor

## 16.1 当前问题

文档主进程 IPC 里存在同步读写 / 同步文件系统遍历，容易造成 main thread 阻塞：

- `src/main/modules/document-engine/ipc-handler.ts:146`
- `src/main/modules/document-engine/ipc-handler.ts:181`

## 16.2 决策

逐步把文档读取热点改为异步，优先覆盖：

1. docx 读取
2. 大文本读取
3. xlsx 读取

## 16.3 最小目标

不是一上来把 document engine 全改掉，而是先做到：

- 深读 pipeline 使用的读取路径尽量异步
- 允许 future progress / abort
- 避免大文件阻塞主线程太久

---

## 17. Proposed File-Level Changes

以下是建议改造点，按“最小可行版本”与“后续增强”划分。

## 17.1 第一阶段：最小可行版本（MVP）

### A. 新增 pipeline 规格与状态结构

建议新增：

- `src/main/modules/agent-control/document-task-pipeline.ts`
- `src/main/modules/agent-control/document-task-types.ts`

职责：

- task type 判定
- phase 状态机
- budget 分配
- pipeline 执行入口

### B. 在 orchestrator / runtime 里挂接结构化文档任务

候选接入点：

- `src/main/modules/agent-control/orchestrator.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/agent-control/runtime.ts`

目标：

- 当 intent 命中 `document_read_then_widget_create` 时，走 pipeline
- 非命中场景仍走现有通用聊天链

### B.1 第一版接入点建议

尽管长期更理想的归宿可能是更靠近 runtime / orchestrator 的统一层，但 **第一版建议直接落在 `direct-chat.ts` 旁路接入**：

- 写入范围更小
- 容易复用现有 provider simple call
- 容易复用现有文档工具与 structured task patch 输出
- 不必在第一版同时重构 runtime 总线

等 MVP 稳定后，再评估是否上提到更通用的 orchestrator 层。

### C. 提炼 shared document chunking helper

从当前 `documentActions.ts` 中抽离章节识别相关能力，避免 renderer 私有逻辑被 pipeline 重写一遍。

候选新增：

- `src/shared/document-sectioning.ts`

来源参考：

- `src/renderer/modules/agent/documentActions.ts:149`
- `src/renderer/modules/agent/documentActions.ts:199`
- `src/renderer/modules/agent/documentActions.ts:210`

### D. 复用现有 widget compiler

保持 OpenUI 编译链为第一输出路径：

- `src/renderer/modules/agent/documentWidgetOpenUI.ts`
- `src/shared/document-widget-openui.ts`

### E. 增加 pipeline trace 映射到现有 run state

建议把 phase 信息映射到当前 `scopeRunState` / `toolTrace`，先不做全新 UI 组件。

### F. 增加 host-only 文档快照读取

建议同时补一条内部只读路径：

- renderer：返回当前活动文档快照
- main pipeline：优先使用快照；若无快照再回退到按路径读取

否则 MVP 只能覆盖“已有路径且已落盘”的文档，无法稳定覆盖当前编辑中的草稿。

---

## 17.2 第二阶段：增强版

### A. 异步文档读取

重构：

- `src/main/modules/document-engine/ipc-handler.ts`

优先避免同步热路径。

### B. chunk-level insight cache

建议新增 session-level cache 容器。

### C. 失败降级返回

支持：

- insight 成功但 widget 失败时先回 insight
- widget 成功但写回失败时回 widget draft

### D. 更细颗粒的 UI 提示

在 ChatPanel 或 task card 中展示：

- 当前阶段
- 已完成阶段
- 耗时
- 是否使用缓存

---

## 18. Detailed Implementation Path

## Phase 0 — Instrument First

在真正改执行链前，先补观测。

### 目标

- 先知道当前真实超时分布
- 先知道卡在哪个阶段

### 动作

1. 为当前文档加载加时间统计
2. 为现有 agent 总请求记录文档大小 / 类型 / 是否 docx
3. 在 run state 里增加最小 phase 标签

### 交付

- 不改变现有功能路径
- 只增加观测与日志

---

## Phase 1 — Structured Pipeline MVP

### 目标

让“读文档后做信息卡”不再走单轮大 prompt。

### 动作

1. 引入 `document_read_then_widget_create` intent
2. 新增 `DocumentReadPlan` 和 `DocumentInsight`
3. 新增阶段状态机
4. 补一个 host-only `document.inspectActive` 入口，保证当前活动文档全文可读
4. 先用同步读路径也可以，但执行链必须拆成两轮：
   - 第一轮：文档 -> insight
   - 第二轮：insight -> componentSpec
5. 使用现有 `insert_widget` / `update_widget` 落盘

### 额外要求

- 第一轮和第二轮的 system prompt 必须是 **per-run 临时拼接**，不要污染会话级 `systemPrompt`
- 第二轮默认优先走 `document_insert_widget + componentSpec`
- 若当前请求明显是“更新已有 widget”，应直接退出 pipeline，回到现有 widget update 路径

### 成功标准

- 用户能看到明确阶段推进
- 第二轮失败时不需要重读文档
- 长文档不再只依赖前 1200 字上下文

---

## Phase 2 — Deep Read + Chunking

### 目标

让长文档场景稳定。

### 动作

1. 按章节 / 段落分块
2. 增加 relevance extraction
3. 只把相关 chunks 聚合成 insight
4. 增加采样 warning 与 chunk metrics

### 成功标准

- 10k+ 字文档也能可控处理
- 超时率明显下降
- insight 质量高于现有单轮截断路径

---

## Phase 3 — Async I/O + Cache + Degrade

### 目标

把链路打磨到可长期维护。

### 动作

1. 主进程文档读取异步化
2. 增加 insight cache
3. 增加部分成功结果降级返回
4. 增加更完整 task card / progress UI

### 成功标准

- 大文件不容易卡主线程
- 重试成本明显下降
- 用户能清楚看到部分完成结果

---

## 19. Testing Strategy

## 19.1 单元测试

建议新增测试覆盖：

1. intent classifier
   - 命中 `document_read_then_widget_create`
2. read plan builder
   - 小文档走 light mode
   - 长文档走 deep mode
3. chunker
   - 章节切分
   - 长章节二次切分
4. insight merger
   - 多 chunk 聚合结果稳定
5. widget draft builder
   - 产出合法 `componentSpec`
6. budget manager
   - 阶段超时与总超时逻辑正确

## 19.2 集成测试

建议覆盖：

1. markdown 文档 → info card
2. 长 markdown 文档 → info card
3. docx 文档 → info card
4. insight 成功 / widget 失败 → 返回 insight
5. widget 成功 / writeback 失败 → 返回 widget draft
6. 更新已有 widget 而不是重复插入

## 19.3 回归重点

确保不破坏：

- `/doc` 直接命令路径
- 现有 widget 插入 / 更新 / 保存逻辑
- 普通聊天请求
- 非文档模式下的 agent 聊天

---

## 20. Risks And Mitigations

## Risk 1: Pipeline 过早做太重

### 风险

一开始就上完整 chunking + cache + async I/O，容易把改造范围拉爆。

### 缓解

先做 **两阶段 MVP**：

- insight
- widget

先把结构立起来，再细化读取与缓存。

## Risk 2: 文档章节切分规则不稳定

### 风险

不同格式文档标题风格不一致。

### 缓解

- 先复用已有章节识别逻辑
- 允许 fallback 到固定窗口切分

## Risk 3: 第二轮 widget 生成与 schema 不一致

### 风险

模型输出 componentSpec 不合法。

### 缓解

- 严格走 schema validate
- 失败时给出可诊断错误
- 必要时降级为可控 widgetCode 模式

## Risk 4: 主进程同步 I/O 仍拖慢整体

### 风险

即便 pipeline 拆段，底层读文件仍可能卡。

### 缓解

- 先打点确认热点
- 再逐步异步化热点读取路径

---

## 21. Recommended Rollout Order

### 建议顺序

1. **先加观测，不先改 timeout**
2. **先做 intent + 两阶段 pipeline MVP**
3. **再做 chunked deep read**
4. **再做 async document I/O**
5. **最后做 cache / degrade / richer UI**

### 不推荐顺序

- 先把 5 分钟改成 10 分钟
- 先让模型更自由地直接写文档
- 先补一堆 provider 特判来掩盖链路问题

---

## 22. Codex Cross-Check Checklist

下面这些点建议与 Codex 对照时重点看：

### 架构层

- 是否认同把该类任务从通用单轮聊天里拆成 pipeline
- pipeline owner 应该落在 runtime、orchestrator 还是 direct-chat 旁路层
- renderer / main 的职责边界是否清楚

### 数据层

- `DocumentInsight` 字段是否足够
- `componentSpec` 是否应成为唯一主输出
- cache key 是否合理

### 运行时层

- 阶段预算是否合理
- 失败降级策略是否足够实用
- chunking 粒度是否合适

### 工程层

- 第一阶段最小改造文件集合是否可控
- 是否需要先抽 shared sectioning helper
- 是否应该优先改 document-engine IPC 的同步 I/O

---

## 23. Final Recommendation

如果只做一个最值得做的改动，我的建议不是“把 timeout 调大”，而是：

## **把『先读文档再做卡片』正式建模成两阶段以上的 pipeline，并让 insight 成为显式中间产物。**

因为这一步一旦建立，后面的优化——包括：

- chunking
- cache
- degrade
- phase timing
- richer UI
- async I/O

都会有稳定挂点。

如果这一步不做，后续所有优化都只是围绕一个黑盒请求打补丁。

---

## 24. Suggested Next Step

下一步建议直接产出一份实施计划，精确到：

1. 第一阶段要改哪些文件
2. 每个文件新增什么结构
3. 哪些逻辑抽 shared helper
4. 哪些测试先补
5. 哪些文档要同步更新

这样就能进入真正的可执行改造，而不是继续停留在概念层。
