---
title: Ready Agent 信息卡修改链路 · 架构缺口审计
date: 2026-04-18
status: audit-only（本轮不修改代码，后续制定修复计划）
scope: 文档 Agent · Widget/信息卡编辑 pipeline · 分类器 · 缓存 · projectionPatch · 渲染器动作层
trigger: 实测"让 agent 修改信息卡"失败，控制台返回"卡片草稿阶段失败"
---

## 0. 本轮目的与边界

- 本轮只做审计；**不动代码**。
- 目标：把"让 agent 修改当前文档里的信息卡"这一路径上所有缺口、错位、死字段、单点依赖、未接入的分支一次性盘出来，并给出可引用的文件:行号 + 日志证据。
- 后续将基于这份文档独立制定修复计划（排序、分阶段、引入测试契约）。

相关前序审计：
- `docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-info-card-gap-trace.md`
- `docs/superpowers/plans/2026-04-18-ready-agent-runtime-realignment-second-round-audit.md`
本轮在这两份基础上继续深挖，重点聚焦 **widget 草稿阶段 + update 语义 + 辅助分支**。

## 1. 复现与直接失败信号

### 1.1 用户请求形态
- 用户语义：要求 agent 基于当前文档修改/重做已有信息卡（形如"把这张信息卡改成…"/"优化一下现有 widget"）。
- 分类器命中：`EXISTING_WIDGET_UPDATE_PATTERNS` → 产生 `structuredDocumentIntent = 'document_read_then_widget_update'`（`src/main/modules/agent-control/document-task-types.ts:27-30, 54-56`）。

### 1.2 直接错误
来自 `/var/folders/wd/…/T/ready-directchat.log`：

```
[2026-04-18T12:33:51.321Z] document pipeline phase=building_insight status=running budgetMs=60000
[2026-04-18T12:34:00.891Z] document pipeline phase=building_insight status=completed durationMs=9567
[2026-04-18T12:34:00.895Z] document pipeline phase=generating_widget_spec status=running budgetMs=60000
[2026-04-18T12:34:06.636Z] document pipeline phase=generating_widget_spec status=failed
  error=Widget componentSpec 非法：info_card.body: Invalid input: expected string, received undefined
[2026-04-18T12:34:06.641Z] document pipeline phase=failed status=failed
  error=Widget componentSpec 非法：info_card.body: Invalid input: expected string, received undefined
```

抛出点：`src/main/modules/agent-control/document-task-pipeline.ts:281-284`

```ts
const validation = validateDocumentWidgetComponentSpec(normalized.componentSpec)
if (!validation.ok) {
  throw new Error(`Widget componentSpec 非法：${validation.errors.join('；')}`)
}
```

后续被 `DocumentTaskPipeline.run` 捕获，组装 `卡片草稿阶段失败` 的 finalText（`document-task-pipeline.ts:294-316`）。

### 1.3 Schema 约束
`src/shared/document-widget-openui.ts:96-102`

```ts
info_card: z.object({
  ...commonTextProps,
  body: z.string().min(1),
  tone: calloutToneSchema.optional(),
  points: z.array(z.string()).optional(),
}),
```

`body` 强制必填 string，但 LLM 返回的 componentSpec 缺失该字段，因此校验失败。**这是直接导火索，但背后是架构层面的多重设计缺口叠加导致的**，下文 2. 逐条拆解。

## 2. 缺口清单（15 项）

每项结构：**现象 → 定位(文件:行) → 证据 → 影响 → 为什么前一次修复没覆盖**。

---

### Gap A · Widget 草稿 prompt 固定 5 组件，且从不给出 props schema
**现象**：LLM 被告知 `componentSpec.component 只能是 info_card, stats_card, comparison_grid, callout_block, data_table`，但**系统 prompt 中不包含任何字段约束**（例如 info_card 需要 `body`）。模型只能凭记忆/名称推测字段，极易遗漏 `body`/`heading`/`metrics` 等必填项，于是 Zod 直接抛错。

**定位**：`src/main/modules/agent-control/document-task-pipeline-executor.ts:614-655`

```ts
const systemPrompt = [
  '你是 Ready 的 widget 草稿阶段。',
  '…',
  'componentSpec.component 只能是 info_card、stats_card、comparison_grid、callout_block、data_table。',
  '优先选择简单稳定的组件，不要发明 catalog 外的新组件。',
].join('\n')
```

注意该 prompt **只传了 insight JSON** 和组件枚举，没有传：
1. 每个组件允许的 props 及必填项；
2. 现有 widget 的结构（见 Gap B）。

**影响**：Widget 草稿阶段的失败率被写进了架构里——只要模型没恰好猜对字段名就会失败，且失败会污染缓存（见 Gap M）。

**为什么前一次修复没覆盖**：2026-04-17 审计重点在"分类器把 update 流路由进 pipeline"，并未检查 pipeline 内部 prompt 语义完整度；2026-04-18 的第二轮审计集中在 projectionPatch/渲染链路，没有回溯到 prompt 内容。

---

### Gap B · Update 模式下 LLM 看不到「现有 widget 内容与组件类型」
**现象**：`buildDocumentPipelineWidgetDraft` 无论 create/update，都只把 `insight` 作为输入。**LLM 根本不知道当前文档里已有哪个 widget、标题是什么、使用哪种组件、当前 props 是什么**。于是：
1. 即使是"微调"需求，模型也只能整张重写；
2. 模型倾向于固定产出 `info_card`，与现有 widget 类型不符（例如现有是 `week_schedule_card`）；
3. 没有 targetWidgetTitle 的稳定来源，定位阶段后续只能靠字符串包含匹配。

**定位**：`src/main/modules/agent-control/document-task-pipeline-executor.ts:634-642` —— userPrompt 仅传 `insight JSON`，不含 existing widget。

**影响**：
- `update` 语义实质上退化为 "生成一个全新 info_card → 用字符串包含匹配去覆盖"，不是真正的 update。
- 类型不匹配时，模型会把 week_schedule_card 替换成 info_card，用户原有视觉丢失。
- 无法对现有 widget 做增量 patch（例如只改某一个 metric.value）。

**为什么前一次修复没覆盖**：此前专注于"分类与路由"与"projectionPatch 写回"，未审 update pipeline 的输入语义。

---

### Gap C · 单次生成失败即终止，没有 reprompt 循环
**现象**：`normalizePipelineWidgetDraft` 解析失败或 schema 校验失败时立刻抛异常 → `DocumentTaskPipeline.run` catch → 整条 pipeline 失败。没有**将校验错误重新喂回 LLM 让其自修正**的循环。

**定位**：
- 抛错处：`document-task-pipeline.ts:281-284`
- 抛错被 catch：`document-task-pipeline.ts:664-688`
- 上一层也不重试：`document-task-pipeline-executor.ts:643-655`（一次性调用 `requestDocumentPipelineSimpleText`）

**影响**：Widget 草稿是一个"结构化 JSON + schema 校验"典型场景，本应有 1~2 次带错误回灌的 retry。当前设计下一次生成偏离就直接失败。

**为什么前一次修复没覆盖**：此前未把"widget 生成属于高结构化 JSON 场景"当作独立可靠性问题看待。

---

### Gap D · Update 分支强制走 info-card 家族，无视现有 widget 组件
**现象**：即使用户当前 widget 是 `week_schedule_card` / `habit_tracker` 等非摘要型组件，pipeline 依然把"推荐组件"限制在 5 种 info-card 家族内。

**定位**：
- `document-task-pipeline-executor.ts:551-557`（insight 阶段）：`recommendedWidget 只能是 info_card、stats_card、comparison_grid、callout_block、data_table 之一。`
- `document-task-pipeline-executor.ts:631`（widget 阶段）同样枚举。
- `document-task-pipeline.ts:45-62` `DocumentInsight.recommendedWidget` 类型字段本身只列这 5 种。

**影响**：
- 用户案例 `lck_week_preview_9_16` 这种日程/周视图形态 widget 在 update 场景下会被 pipeline **整体替换为 info_card**，彻底偏离用户意图。
- 与 `src/shared/document-widget-openui.ts` 实际支持的 21 个组件脱节，形成 catalog 与 pipeline 两套可用组件集。

**为什么前一次修复没覆盖**：前序审计关注了"类型字段过窄"，但只登记未修；此处列为明确 Gap 并给出证据。

---

### Gap E · `DocumentInsight.recommendedWidget` 类型字段硬编码 5 种
**现象**：Gap D 的根源之一。`DocumentInsight` 作为跨阶段数据结构，其类型本身就限定了只能挑 5 种组件，导致下游 widget 草稿阶段无法据此选出 week_schedule_card / checklist 等组件。

**定位**：`document-task-pipeline.ts:45-62`

```ts
recommendedWidget:
  | 'info_card'
  | 'stats_card'
  | 'comparison_grid'
  | 'callout_block'
  | 'data_table'
```

**影响**：即使未来 widget 阶段 prompt 放开，`DocumentInsight` 这个"共识契约"依然把可能性砍掉了。

---

### Gap F · `document_list_widgets` / `document_remove_widget` 被分类但从未被 executor 路由
**现象**：`classifyStructuredDocumentIntent` 可以返回这两种意图，但 `DocumentTaskPipelineExecutor.tryExecute` 的路由 **只匹配 create/update**，另外两种意图会原样滑过 pipeline。

**定位**：`document-task-pipeline-executor.ts:174-201`

```ts
if (
  params.executionIntentContext.structuredDocumentIntent === 'document_read_then_widget_create'
  || params.executionIntentContext.structuredDocumentIntent === 'document_read_then_widget_update'
) {
  const pipelineResult = await this.runDocumentWidgetPipeline({ … })
  …
}
return { handled: false }
```

全文件搜索 `document_list_widgets` / `document_remove_widget` 在该 executor **零命中**（grep 已验证）。这两个意图目前只能通过 `DocumentTaskPlan` 路径（`planTaskType` 兜底）进入，而该路径依赖 plan 分解是否分发过 list/remove 子任务——并无保证。

**影响**：
- 用户说"列出当前文档的信息卡"/"删除第二张信息卡"时，即便分类器正确识别，也不会走到 `DocumentTaskPipeline` 中 `listing_widgets` / `removing_widget` 专用阶段。
- 实际行为退化为普通工具调用循环，没有结构化步骤回显、没有 phase 进度。

**为什么前一次修复没覆盖**：前序审计只提到"insertionMode 死字段"、"targetWidgetTitle 残留"，没有做意图枚举与 executor 分支的完整矩阵对照。

---

### Gap G · list_widgets 摘要只回传标题+模式，没有内容指纹
**现象**：`documentActions.ts` 的 list_widgets 返回形如 `1. lck_week_preview_9_16 [static-svg]`，不含 props、组件类型、正文片段。后续 update/remove 阶段的"定位"完全靠 LLM 自己从这串文本挑 target，然后用 **`summary.includes(target)`** 判断（`document-task-pipeline-executor.ts:658-665`）。

**定位**：
- 渲染器：`src/renderer/modules/agent/documentActions.ts:981-989`
- 定位校验：`document-task-pipeline-executor.ts:658-665`

**影响**：
- LLM 必须靠直觉猜测 target，一旦猜错，错误信息是"未找到 widget 标题"级别的低信息量反馈。
- 同名 widget（用户常复制模板）靠 `includes` + 首匹配，无法可靠选中第 N 个，`occurrence` 字段在 update pipeline 内部链路上也没有被稳定塞入（见 Gap I）。

---

### Gap H · 缺少"读取现有 widget"预阶段
**现象**：pipeline 的 phase 序列是 `loading_document → building_insight → generating_widget_spec → writing_widget → saving_document`。即使在 update 分支下，**没有单独阶段负责"读取并结构化待改的现有 widget"**。

**定位**：
- phase 枚举：`document-task-pipeline.ts:4-15`（没有 `reading_existing_widget`/`diffing_widget`）。
- 相应的 deps 接口也没有 `readExistingWidget`：`document-task-pipeline.ts` 的 `Deps`（未引用处，见该文件 deps 定义）。

**影响**：
- Gap B 的根因；
- 无法支持"对现有 widget 做字段级 patch"；
- 无法做"类型保持"策略（用户不想换组件家族时强制不变更 component）。

---

### Gap I · `targetWidgetTitle` 全靠 LLM 从原句自由文本中提取
**现象**：update pipeline 依赖 `targetWidgetTitle` 来定位，但该字段的来源只有两条：
1. LLM 在 widget 草稿 JSON 里自己写出；
2. fallback 把 LLM 产出的 `rawTargetWidgetTitle` 原样塞进草稿（`document-task-pipeline-executor.ts:464-472`）。

没有基于用户自然语言（"把叫 9·16 的那张卡片…"）做**确定性提取**，也没有从 `list_widgets` 结果做受控选择。

**定位**：`document-task-pipeline-executor.ts:464-513`

**影响**：同名/近名 widget 上会误定位，触发错误覆盖。

---

### Gap J · insight 构造使用"全文聚焦分块"，widget 专属场景浪费且分散
**现象**：`buildDocumentPipelineInsight` 对全文做 focused sectioning（`document-task-pipeline-executor.ts:543-549`），但在 update 场景下，用户 80% 的信息都围绕"那张 widget 周围的段落"。当前 pipeline 没有"围绕 target widget 抽取窗口"的能力，insight 容易被文档其它部分噪声污染。

**定位**：`document-task-pipeline-executor.ts:543-612`

**影响**：insight summary 与实际要改的 widget 关系稀薄，进一步放大 Gap B 造成的偏差。

---

### Gap K · `buildFallbackDocumentWidgetDraft` 只兜底 null，不兜底"解析成功但 schema 失败"
**现象**：fallback 只在 `raw` 为 null 时触发（即 JSON 解析都失败时）。如果 LLM 给出了能被 JSON.parse 的对象，但 schema 校验失败（当前案例），fallback 不会被启用，pipeline 直接抛异常。

**定位**：
- 入口：`document-task-pipeline-executor.ts:456-513`
- 抛错点：`document-task-pipeline.ts:281-284`

**影响**：本次失败完全可由 fallback 的摘要卡挽救，但 schema 异常让 fallback 逻辑被短路。

---

### Gap L · `pipelinePhaseOrder` 缺 `locating_target_widget` / `updating_widget` / `listing_widgets` / `removing_widget`
**现象**：UI 侧结构化步骤列表按固定 5 项 phase 展示，update/list/remove 专属 phase 在 `pipelinePhaseOrder` 中被遗漏。步骤图永远只显示 5 步，实际 pipeline 里跑的 `updating_widget` 等 phase 事件只会静默改变"某个未被列出的 phase"。

**定位**：`document-task-pipeline-executor.ts:1515-1521`

```ts
const pipelinePhaseOrder = [
  'loading_document',
  'building_insight',
  'generating_widget_spec',
  'writing_widget',
  'saving_document',
] // 缺 locating_target_widget / updating_widget / listing_widgets / removing_widget
```

**影响**：update 分支的 UI 进度条缺了最核心的两步；list/remove 根本不会出现在步骤列表中。与 CLAUDE.md §6.8 "未开始步骤显示 pending，失败步骤显示 blocked"的目标在这两条分支上落空。

---

### Gap M · Widget 草稿缓存未在失败时失效
**现象**：`documentWidgetDraftCache` / `sessionWidgetDraftCaches` 以 question + job + snapshot 组成 key 存储 draft；若此轮失败，**缓存键要么不被写入，要么被写入后下次同样语义命中仍可能返回旧坏草稿**（如果上一轮保存了坏 draft 后崩溃再复用）。

**定位**：
- 缓存定义：`document-task-pipeline-executor.ts:111-123`
- 构造 key：`document-task-pipeline-executor.ts:443-454`
- 清除入口仅在 `clearSessionCache`（整体清）：`document-task-pipeline-executor.ts:127-130`

**影响**：缺少"草稿生成失败时按 cacheKey 精准失效"路径，重试无法让缓存尽到"只缓存成功态"的语义。

---

### Gap N · `document.updateWidget` 渲染动作层只做整包覆盖
**现象**：渲染器 `update_widget` 直接把新的 widgetCode 整体写回，没有"保留旧属性/旧子元素/旧 style"的 merge 路径。

**定位**：`src/renderer/modules/agent/documentActions.ts:992-1007`

```ts
const resolvedWidget = await resolveWidgetCodeInput(widgetCode, action.componentSpec)
…
const updated = updateWidgetInDocument(tab.content, target, resolvedWidget.widgetCode, nextTitle, occurrence)
```

**影响**：即使将来 pipeline 能感知"只改一个字段"的需求，落到动作层也只能整块覆盖，增量语义彻底丢失。

---

### Gap O · Schema 校验错误信息未回喂 LLM
**现象**：`validateDocumentWidgetComponentSpec` 返回了结构化 errors（`info_card.body: Invalid input: expected string, received undefined`），但这些错误只被 log 和 finalText 使用，不会转成"你上次输出的 JSON 在 X 字段缺失了 Y"重新给 LLM。

**定位**：`document-task-pipeline.ts:281-284` 抛错后不 reprompt；`document-task-pipeline-executor.ts:643-655` 也没有重试入口。

**影响**：与 Gap C 同源，但独立列出强调"我们丢掉了现成高质量的错误反馈信号"这一信息损失。

---

## 3. 交叉依赖矩阵

| 用户观察到的问题 | 直接诱因 | 架构缺口（上面编号） |
|---|---|---|
| 控制台"卡片草稿阶段失败" | LLM 给出的 info_card 缺 body | A、B、C、K、O |
| update 后 widget 类型被换 | 推荐组件硬编码 5 种 | D、E、B |
| update 时 UI 进度条不显示"定位/更新"两步 | phaseOrder 缺项 | L |
| list / remove 请求没走进 pipeline | executor 路由缺分支 | F |
| "叫 9·16 那张" 这种定位误伤同名 widget | 定位靠字符串包含 | G、I |
| 同语义重试依然失败 | 单次生成、缓存不失效 | C、M、O |
| 小改动（换个 tone）被整块重写 | 无现有 widget 输入、无增量路径 | B、H、N |

## 4. 为什么以前几轮修复没能关闭这些缺口

- **2026-04-17 info-card-gap-trace** 聚焦"分类器把 update 流引入 pipeline"与"死字段清理"，但没审 pipeline 内 prompt 语义、没审阶段序列是否能覆盖 update 全流程。
- **2026-04-18 second-round-audit** 聚焦 projectionPatch 写回、渲染同步；它在"把结构化事件打通"的问题上做到位了，但这一次的失败不在传递链，而在**生成阶段语义设计**。
- `commit 4b5851a` 的 projectionPatch hint 确实覆盖了 widget 写入类工具，但它解决的是"事件能传出"，不是"事件语义能生成"。
- 测试层面：现有 `document-task-pipeline.test.ts` 主要覆盖 "正常生成 info_card" 的 happy path，未覆盖：schema 校验失败重试、update 输入存在现有 widget、非 info-card 家族组件推荐、list/remove executor 路由、phaseOrder 完备性。

## 5. 修复计划（草案占位，后续另起文档制定）

本轮不展开。预期后续修复文档按以下优先级组织：

- **P0（立即收敛失败面）**
  - 在 widget 草稿 prompt 中注入每个组件的 props 必填项（Gap A）
  - 为 update 模式读取现有 widget 并注入 prompt（Gap B + Gap H 简化版）
  - 校验失败时带错误信息 reprompt 一次（Gap C + Gap O）
  - Fallback 覆盖 "schema 失败" 而非仅 "null raw"（Gap K）
- **P1（扩展意图与组件空间）**
  - `DocumentTaskPipelineExecutor.tryExecute` 补 list/remove 分支（Gap F）
  - `DocumentInsight.recommendedWidget` 与 widget 阶段 prompt 同步放开到 openui catalog 全集（Gap D + Gap E）
  - `pipelinePhaseOrder` 根据 taskType 动态组装（Gap L）
- **P2（定位与增量能力）**
  - list_widgets 输出结构化（组件类型、首行正文摘要）（Gap G）
  - targetWidgetTitle 走"受控选择"而非自由文本（Gap I）
  - insight 按 target widget 所在段落窗口化（Gap J）
  - 支持字段级 patch 的 update_widget 动作（Gap N）
- **P3（可靠性周边）**
  - 缓存写入与失效基于成功态（Gap M）
  - 新增契约测试：schema-fail → reprompt、update input 包含 existing widget、list/remove 路由、全 phaseOrder 完备性

### 2026-04-18 · P3 落地

- Gap M 修复：`buildDocumentPipelineWidgetDraft` 返回 `{ draft, cacheable }`；fallback 草稿标 `cacheable:false` 不入缓存；新增 `deleteCachedWidgetDraft` 支持按 cacheKey 精准失效（同时清 session 缓存与共享缓存）；`runDocumentTaskPlan` 的 `compose_widget` 段改为显式 try/catch，失败时先按 key 失效再重抛；日志新增 `document widget draft cache invalidated key=… reason=build-failed`。
- 新增 6 份契约测试（全部在 `npm run test` 通过）：
  - `src/__tests__/pipeline.widget-draft.reprompts-on-schema-error.test.ts`
  - `src/__tests__/pipeline.update.includes-existing-widget-in-prompt.test.ts`
  - `src/__tests__/executor.routes-list-and-remove-intents.test.ts`
  - `src/__tests__/pipeline.phase-order-matches-task-type.test.ts`
  - `src/__tests__/widget-catalog.recommended-widget-superset.test.ts`
  - `src/__tests__/pipeline.widget-draft.cache-invalidation-on-failure.test.ts`
- 既有 `document-task-pipeline-widget-reprompt.test.ts` 的两条正则同步跟随 `{ draft, cacheable }` 新签名更新。
- 未触碰 prompt 语义、意图路由、phase 枚举等 P0–P2 已锁定的生产面。全量 `npm run typecheck` / 文档相关测试（74 条）均通过；主干 15 条非文档链路失败均为 P3 之外的既存问题（UI/RSS/icon/tool-context），在本轮任务范围外。

## 6. 建议的契约测试（待修复阶段补充）

- `pipeline.widget-draft.reprompts-on-schema-error.test.ts`：第一次返回缺 body 的 info_card，断言收到第二次 prompt 且错误信息入 prompt。
- `pipeline.update.includes-existing-widget-in-prompt.test.ts`：断言 widget 草稿 userPrompt 至少包含 existing widget title 与组件类型。
- `executor.routes-list-and-remove-intents.test.ts`：断言两意图触发 `listing_widgets` / `removing_widget` phase。
- `pipeline.phase-order-matches-task-type.test.ts`：create / update / list / remove 四条路径 phaseOrder 全枚举。
- `widget-catalog.recommended-widget-superset.test.ts`：`DocumentInsight.recommendedWidget` 联合类型与 openui catalog 的交集 ≥ 阈值（或整体一致）。

---

附：
- 直接日志片段：`/var/folders/wd/.../T/ready-directchat.log` 2026-04-18T12:33:51Z ~ 12:34:06Z。
- 关键源文件：
  - `src/main/modules/agent-control/document-task-pipeline.ts`
  - `src/main/modules/agent-control/document-task-pipeline-executor.ts`
  - `src/main/modules/agent-control/document-task-types.ts`
  - `src/main/modules/agent-control/execution-intent-resolver.ts`
  - `src/renderer/modules/agent/documentActions.ts`
  - `src/shared/document-widget-openui.ts`
