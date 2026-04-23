# "已有信息卡修改" 链路专项追踪

> 审核日期: 2026-04-17
> 触发线索: 用户反馈 "修改这个信息卡" / "把上面这张卡改成 XX" 这类请求不能真正更新已有 widget, 经常退化成在文档末尾追加一张新卡.
> 关联审核: `2026-04-17-ready-agent-runtime-realignment-audit.md` §4

## 1. 问题现象

用户典型输入:

- "把这个信息卡改成极简风格"
- "统一一下当前卡片的配色"
- "修改上面那张 widget, 把数据换成新的"

预期: 定位到已有 widget → 就地更新内容.
实际: 要么直接在文末追加新卡, 要么 LLM 在 free tool loop 里尝试 `document_list_widgets → document_update_widget` 但序列经常中断 / 参数错 / 退化成 replace text.

## 2. 链路拆解

自上而下共 5 层:

```
用户文本
  │
  ▼
[1] shouldForceDocumentToolCall / inferDocumentWidgetTaskKind        (tool-policy-heuristics.ts)
  │   → 识别出这是 widget 更新任务, forceDocumentTool = true
  │
  ▼
[2] classifyStructuredDocumentIntent                                 (document-task-types.ts)
  │   → 命中 EXISTING_WIDGET_UPDATE_PATTERNS, 返回 null
  │   → 明确拒绝进入 document_read_then_widget_create pipeline
  │
  ▼
[3] maybeRunDocumentWidgetPipelineShortcut                           (direct-chat.ts:1199)
  │   → 上一步返 null, 所以这里 `return null`, shortcut 不执行
  │
  ▼
[4] TurnEngine 进入 free tool loop (LLM 自由调用 document_* 工具)
  │   → 成功率依赖 LLM 推理质量
  │
  ▼
[5] 若 LLM 走进 pipeline fallback 路径, consumer 仍然错
  │   (这条分支在"创建卡但命名成 update_existing"时触发)
```

每一层的具体代码证据与失败点:

### 2.1 Layer 1 — 启发式已经认出 "这是 update" (没问题)

`src/main/modules/claude-bridge/tool-policy-heuristics.ts:105-111`:

```typescript
if (replaceVerb.test(primaryInstruction)) return 'replace_existing'
if ((additiveHint.test(...) || placementHint.test(...)) && createVerb.test(...)) {
  return 'additive_create'
}
if (existingWidgetReference.test(primaryInstruction) && updateVerb.test(primaryInstruction)) {
  return 'update_existing'
}
```

`inferDocumentWidgetTaskKind` (同文件 :175-189) 再把它折叠成:

```typescript
if (referenceIntent === 'replace_existing' || referenceIntent === 'update_existing') {
  return 'update'
}
```

结果: `toolPolicy.documentWidgetTaskKind = 'update'`, `forceDocumentTool = true`.

**这一层没错**, 信号清晰传下来了.

### 2.2 Layer 2 — Classifier 显式拒绝 (核心断点 A)

`src/main/modules/agent-control/document-task-types.ts:1-46`:

```typescript
export type StructuredDocumentIntent =
  | 'document_read_then_widget_create'
  | null

const EXISTING_WIDGET_UPDATE_PATTERNS = [
  /(更新|修改|调整|优化|重做|替换|改成|改为).*(这个|当前|已有|现有|上面).*(widget|卡片|信息卡)/i,
  /(把|将).*(这个|当前|已有|现有).*(信息卡|卡片|widget).*(改成|改为|换成)/i,
  /(查看|列出|看看).*(widget|卡片)/i,
  /(删除|删掉|移除).*(widget|卡片)/i,
] as const

export function classifyStructuredDocumentIntent(userText: string): StructuredDocumentIntent {
  const text = String(userText || '').trim()
  if (!text) return null

  if (EXISTING_WIDGET_UPDATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return null  // ← 显式 opt-out
  }

  const wantsReadDocument = READ_DOCUMENT_PATTERNS.some(...)
  const wantsWidgetCreate = CREATE_WIDGET_PATTERNS.some(...)
  const mentionsDocumentSource = DOCUMENT_SOURCE_PATTERNS.some(...)

  return wantsWidgetCreate && (wantsReadDocument || mentionsDocumentSource)
    ? 'document_read_then_widget_create'
    : null
}
```

**类型设计本身就有瑕疵**: `StructuredDocumentIntent` 联合里只有 `'document_read_then_widget_create'` 和 `null` —— 更新 / 列出 / 删除 在类型层面就没位置. 所以 classifier 只能把它们打成 `null`, 这是类型导致的必然.

### 2.3 Layer 3 — Pipeline shortcut 自然跳过

`src/main/modules/claude-bridge/direct-chat.ts:1199-1213` (摘要):

```typescript
private async maybeRunDocumentWidgetPipelineShortcut(params: {...}): Promise<TurnShortcutResult | null> {
  const intent = classifyStructuredDocumentIntent(userText)
  if (intent !== 'document_read_then_widget_create') return null
  // ... 下面才是 pipeline.run
}
```

Layer 2 返 null → 这里直接 `return null` → pipeline 不跑.

### 2.4 Layer 4 — Free tool loop 兜底失败率高

此时 `TurnEngine` 进入普通 tool loop, 只要 `toolPolicy.documentWidgetTaskKind === 'update'`, 会有如下引导:

- `document-tool-loop-orchestrator.ts` 会在 `handleNoToolCall` 时提示 "请调用 document 工具"
- 但**没有任何地方告诉 LLM "先列出 widgets 再 update"**, 也没有告诉它 "把哪个 widget 名字映射到 `target` 参数"

LLM 在这里实际观察到的是: 一大堆 document 工具 (`insertWidget / updateWidget / listWidgets / removeWidget / replaceText / ...`) + "请用文档工具更新" 提示. 它的常见错误分支有:

- 直接 `document_insert_widget` → 追加新卡 (这正是用户看到的现象)
- `document_replace_text` 尝试改 widget 内部 HTML → 经常改到错位置 / 破结构
- 漏掉 `document_list_widgets` 步骤, 凭想象构造 `target: '第 3 个'` → `document_update_widget` 返回 "未找到"

### 2.5 Layer 5 — Consumer 也没处理 update_existing (核心断点 B)

即便 Layer 2 打开闸门放行, pipeline 跑到生成 widget draft 阶段 **且** LLM 设置了 `draft.insertionMode = 'update_existing'`, 最终的 consumer 仍然会退化:

`src/main/modules/claude-bridge/direct-chat.ts:1366-1376`:

```typescript
insertWidget: async ({ draft, signal }) => {
  void signal
  const payload = await params.requestModuleToolAction!('document.insertWidget', {
    title: draft.title,
    componentSpec: draft.componentSpec,
    widgetCode: draft.widgetCode,
    position: draft.insertionMode === 'after_section' ? 'after_section' : 'append_end',
    sectionTitle: draft.targetSectionTitle,
  })
  return typeof payload.summary === 'string' ? payload.summary : '已写入信息卡'
},
```

三重错位:

1. 无论 `draft.insertionMode` 是什么, 都**调用 `document.insertWidget`** (永远不会调 `document.updateWidget`).
2. `position` 参数里**只有 `'after_section'` 和 `'append_end'` 两个分支**, `'update_existing'` 被 `? :` 吞掉落到 `'append_end'`.
3. `draft.targetWidgetTitle` 在 `normalizePipelineWidgetDraft` (direct-chat.ts:1871-1872) 解析进来了, 但**这里没有往 payload 放**, 后续链路里也没有任何地方消费它.

### 2.6 Pipeline 阶段机根本没有 update 流程

`src/main/modules/agent-control/document-task-pipeline.ts:4-11`:

```typescript
export type DocumentWidgetPipelinePhase =
  | 'loading_document'
  | 'building_insight'
  | 'generating_widget_spec'
  | 'writing_widget'
  | 'saving_document'
  | 'completed'
  | 'failed'
```

没有 `locating_target_widget` / `updating_widget` / `removing_widget`. `writing_widget` 里的实现 (document-task-pipeline.ts:~230) 也只会把 draft 交给 `deps.insertWidget`, 不会按 draft 做分流.

`DocumentReadPlan.taskType`:

```typescript
export interface DocumentReadPlan {
  taskType: 'document_read_then_widget_create'
  ...
}
```

类型级别就**只有创建一种任务类型**.

## 3. 三层同步失效的后果

- 类型系统: "`update_existing / targetWidgetTitle`" 是**死字段** (能声明能解析, 没人消费).
- 控制流: 已经识别出是更新任务, 却被 classifier 打成 null, 放弃结构化路径.
- 兜底路径: 回到 LLM 自由 tool 决策, 没有结构化提示, 成功率低.
- 运营层: 用户看到的最终症状 = 新卡被追加到文末, 老卡原样不动.

## 4. 相似形状的缺口 (由这条线索牵出)

### 4.1 删除 widget 同样断

Classifier 的 `EXISTING_WIDGET_UPDATE_PATTERNS` 第 4 条 `(删除|删掉|移除).*(widget|卡片)` 也走 `return null` 分支. 同样掉进 free tool loop. `document.removeWidget` 工具在, 但从来不会被 structured pipeline 驱动.

### 4.2 查看 / 列出 widget 同样断

`(查看|列出|看看).*(widget|卡片)` 也是 opt-out. 用户问 "当前有几张卡片?" → LLM 自己决定是否调 `document_list_widgets`, 缺少结构化提示.

### 4.3 `DocumentReadPlan.taskType` 是单元素联合

```typescript
taskType: 'document_read_then_widget_create'
```

类型是字面量联合但只有一项. 语义暗示这里本应能扩展成 `'document_read_then_widget_update' / 'document_widget_inspect' / 'document_widget_remove'`, 但没建.

### 4.4 `tool-policy-heuristics.ts` 和 `document-task-types.ts` 对"任务种类"的判定不一致

- tool-policy 侧: `inferDocumentWidgetTaskKind` 返 `'create' | 'update' | 'remove' | 'inspect' | null`
- pipeline 侧: `classifyStructuredDocumentIntent` 只返 `'document_read_then_widget_create' | null`

两份"种类"定义各自活着, 互不对齐. 这是典型的**类型单轴化没做到位** —— 应该有一个 `DocumentWidgetOperation` enum 贯穿整个链路.

### 4.5 `DocumentWidgetDraft.targetWidgetTitle` 是幽灵字段

全仓库 `targetWidgetTitle` 只出现在:

- `document-task-pipeline.ts:68` 声明
- `direct-chat.ts:1872` 解析
- `docs/superpowers/specs/2026-04-16-document-read-then-widget-pipeline-design.md:512` 设计

一次都**没有**被下游读取. 这是规范写到 80% 但实现止步于 30% 的典型痕迹.

## 5. 最小修复方案 (不改架构)

以下 3 步改完就能让 "已有信息卡修改" 闭环, 且不触碰 direct-chat 缩壳这个大重构.

### Step 1 — 扩展 classifier

`src/main/modules/agent-control/document-task-types.ts`:

```typescript
export type StructuredDocumentIntent =
  | 'document_read_then_widget_create'
  | 'document_locate_then_widget_update'
  | 'document_locate_then_widget_remove'
  | 'document_list_widgets'
  | null
```

把 `EXISTING_WIDGET_UPDATE_PATTERNS` 拆成三组 (update / remove / list), 分别返回对应 intent, 不再统一 null.

### Step 2 — Pipeline 增加定位 + 更新阶段

`src/main/modules/agent-control/document-task-pipeline.ts`:

新增 phase:

```typescript
| 'locating_target_widget'
| 'updating_widget'
| 'removing_widget'
```

`DocumentTaskPipeline.run` 分流:

- `intent === 'document_locate_then_widget_update'`:
  1. `locating_target_widget`: 调 `document.listWidgets` → 根据 `targetWidgetTitle` (或 occurrence / section 位置) 选中目标
  2. `building_insight` (可选, 若用户只改样式可跳过)
  3. `generating_widget_spec`: 生成新 spec
  4. `updating_widget`: 调 `document.updateWidget`
  5. `saving_document`

### Step 3 — Consumer 分流

`src/main/modules/claude-bridge/direct-chat.ts:1366`:

```typescript
upsertWidget: async ({ draft, signal }) => {
  void signal
  if (draft.insertionMode === 'update_existing') {
    const payload = await params.requestModuleToolAction!('document.updateWidget', {
      target: draft.targetWidgetTitle,
      widgetCode: draft.widgetCode,
      componentSpec: draft.componentSpec,
      title: draft.title,  // 重命名用
    })
    return typeof payload.summary === 'string' ? payload.summary : '已更新信息卡'
  }
  const payload = await params.requestModuleToolAction!('document.insertWidget', {
    title: draft.title,
    componentSpec: draft.componentSpec,
    widgetCode: draft.widgetCode,
    position: draft.insertionMode === 'after_section' ? 'after_section' : 'append_end',
    sectionTitle: draft.targetSectionTitle,
  })
  return typeof payload.summary === 'string' ? payload.summary : '已写入信息卡'
},
removeWidget: async ({ draft }) => {
  const payload = await params.requestModuleToolAction!('document.removeWidget', {
    target: draft.targetWidgetTitle,
  })
  return typeof payload.summary === 'string' ? payload.summary : '已删除信息卡'
},
```

## 6. 验收用例

改完后应通过以下 3 个手工回归:

1. 文档里先生成一张信息卡 ("根据这份文档生成一张信息卡") → 等成功.
2. 再发 "把这张信息卡的配色改成极简黑白" → 观察**同一张卡**原地换色, 不是文末多一张.
3. 再发 "删掉刚才那张信息卡" → 卡片被移除.
4. 发 "当前文档里有几张信息卡?" → 回复含具体数量和标题列表.

目前 (2026-04-17) 用例 2 / 3 / 4 都会失败.

## 7. 中期建议 (和主审核文档 §5 合流)

这三步只是闭合. 真正要消除"类型声明却无下游"的结构性重复, 建议**和主审核 §3.1 document pipeline 搬迁一并做**:

- 把 `classifyStructuredDocumentIntent / StructuredDocumentIntent / DocumentReadPlan / DocumentWidgetDraft / DocumentTaskPipeline / DocumentInsight` 全搬到 `DocumentTaskPipelineOrchestrator` 一个文件, 把 `insertWidget / updateWidget / removeWidget / listWidgets` 四个 consumer 也收敛成 `DocumentWidgetOpsGateway`.
- 让 `DocumentDomainAdapter.dispatch` 直接基于 `intent` 调编排器, 不再有 `maybeRunDocumentTaskPlanShortcut / maybeRunDocumentWidgetPipelineShortcut` 这对 shortcut.
- 类型单轴化: 全链路只认 `DocumentWidgetOperation = 'create' | 'update' | 'remove' | 'inspect'`, 淘汰 `documentWidgetTaskKind / documentWidgetReferenceIntent / structuredDocumentIntent / insertionMode` 之间的重复命名.
