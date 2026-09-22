---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Ready Agent Round-3 审计：浏览器工具名单组装异常 + 意图错判 + 静默降级

> 产出时间：2026-04-19
> 测试基线：Ω0/Ω1/Ω2 超时修复已生效（见 Round-2 audit），**工具请求不再超时**；出现新错误 "浏览器工具名单组装异常，本轮已停止请求"，并伴随多轮意图理解丢失与需求错判。
> 作用：列出真实证据、锁定根因、给出分阶段修进计划骨架；**本阶段不改代码**。

## 0. 摘要 / TL;DR

本轮至少有三个独立缺陷叠加触发了最终的硬失败：

1. **P0 — 政策碰撞（G-Z3_1）**：`forceDocumentTool=true + documentWidgetTaskKind=update` 与 `browserDecisionMode=browser_workflow` 同时成立时，`getPolicyOpenAIToolBundle` 把 `allowedToolNames` 砍到 5 个 `document_*`，但政策里 `allowBrowserTools=true` 且 `visibleCapabilityGroupIds` 里有浏览器组，`buildToolResolutionDiagnostics` 检测到 `browser_tools_missing` 不变量违反，`turn-engine.ts:343` 抛 `浏览器工具名单组装异常，本轮已停止请求`。
2. **P0 — 错判上游（G-Z3_3）**：`detectLiveInfoIntent` 的 `SPORTS_PATTERNS = /(比分|赛程|战绩|排名|结果|战报|几比几|谁赢了|第几名)/i` 能在 widget 附件 `widgetCode` 里命中（lck_week_preview_9_16 里本来就是 "赛程"），使得一条纯排版调整 ("让下方的留白少一点") 被当成 live-info 浏览器任务，触发 `browser_workflow` 决策。
3. **P1 — 静默降级（G-Z3_4）**：`src/main/modules/agent-control/tool-registry.ts` 三处 `require('../tools/skills-tools')` 在 electron-vite 打包后的 `out/main/index.js` 里全部失败，每轮落入静态兜底；`skills` group 被标 `usedStaticFallback=true`、产出 `schemaError`；skill 工具在运行时没有完整 param schema，每轮都在 `ready-agent-metrics.log` 里留痕。

另有 R-Z3_5..R-Z3_9 次要缺口，详见 §3。

---

## 1. 证据：日志原文锚点

日志路径：`/var/folders/wd/bypcpnbx07n5_07dhp1m03xm0000gn/T/ready-directchat.log`、`ready-agent-metrics.log`、`ready-browser.log`。

### 1.1 直接报错（round 4 / 06:52）

```
136: [2026-04-19T06:52:20.642Z] [tool_resolution_error] {"stage":"host_effective",
     "invariantViolations":["browser_tools_missing,visibleGroups=browser_interaction|browser_content_tasks,allowBrowserTools=true"],
     "allowBrowserTools":true,
     "visibleCapabilityGroupIds":["browser_interaction","browser_content_tasks","document","skills","memory","session_recall"],
     "allowedToolNames":["document_open_tab","document_switch_tab","document_list_widgets","document_update_widget","document_save_tab"]}
137: [重复同一条]
138: [2026-04-19T06:52:20.642Z] Error: 浏览器工具名单组装异常，本轮已停止请求
139: [ipc] agent:sendScoped done ... success=false
```

重试一轮后同样报错（log 161-164），用户被卡死。

### 1.2 host_prepared vs host_effective 快照差异（核心）

| 字段 | host_prepared (06:52:20.620) | host_effective (06:52:20.641) |
|---|---|---|
| `browserDecisionMode` | `free_tool_loop` | **`browser_workflow`** |
| `allowBrowserTools` | `false` | **`true`** |
| `visibleCapabilityGroupIds` | `document,skills,memory,session_recall` | **加上 `browser_interaction,browser_content_tasks`** |
| `forceDocumentTool` | `true` | `true` |
| `documentWidgetTaskKind` | `update` | `update` |
| `allowedToolNames` | 5 个 document tools | **同样 5 个** |

**关键失谐**：effective 阶段 `visibleGroupIds` 加了浏览器两组、`allowBrowserTools` 翻成 true，但 `allowedToolNames` 没跟上——仍然是 prepared 阶段 `forceDocumentTool` 过滤后的 5 个 document 工具。不变量检测认出这个失谐后直接抛错。

### 1.3 用户文本（round 4）

```
117: sendMessage called: content=## L1 会话上下文
118: ## 当前 Scope
119: - 标题: 现在好了很多，尝试让下方的留白少一点，你
```

裸文本 "现在好了很多，尝试让下方的留白少一点" 不含任何浏览器关键字；但 widget target attachment 的 `widgetCode`/`excerpt` 里自带 "赛程"。

### 1.4 `skills-tools` 模块运行时加载失败（所有轮次都在报）

```
ready-agent-metrics.log line 3-26（每轮 3-5 次）：
{"metric":"tool_group_blocked_rate","groupId":"skills","format":"openai",
 "reason":"Cannot find module '../tools/skills-tools'\nRequire stack:\n- /Users/user/Documents/实验田/ready-cowork/out/main/index.js"}

ready-directchat.log line 19/25/50/56/88/94/126/133/150/158：
[tool_group_resolution] {"groupId":"skills","toolCount":6,"schemaError":"Cannot find module '../tools/skills-tools'...","usedStaticFallback":true}
```

### 1.5 意图理解丢失（round 1 → round 3）

```
line 33: tool execute: document_insert_widget, result=widget 内容未变化，已跳过：新文档.md  (round 1 第一次 insert)
line 80: sendMessage content=...标题: 怎么回事？怎么把赛程信息都干没了，也没维  (round 3 用户抱怨内容丢失)
```

Round 1 用户要求 "用之前的赛程信息做成竖向 9:16"——首插返回 "widget 内容未变化，已跳过"，意味着 `inserted.content === tab.content`，新卡没实际落地；Round 2 随即按 "update" 改那张不存在/空的卡；Round 3 用户发现赛程没了。

---

## 2. 代码证据：根因链路

### 2.1 不变量抛错点

`src/main/modules/agent-control/turn-engine.ts:295-343`

```ts
function buildBrowserToolInvariantViolation(params) {
  const browserGroupsVisible = params.visibleCapabilityGroupIds.filter(...)
  if (!params.allowBrowserTools && browserGroupsVisible.length === 0) return null
  if (params.allowedToolNames.some((name) => name.startsWith('browser_'))) return null
  return ['browser_tools_missing', ...].join(',')
}

function assertNoToolResolutionViolation(params) {
  ...
  if (invariantViolations.size === 0) return
  ...
  throw new Error('浏览器工具名单组装异常，本轮已停止请求')
}
```

`assertNoToolResolutionViolation` 在两个位点调用（595、678），只要 `allowBrowserTools=true` **或** 浏览器组可见、同时 `allowedToolNames` 里没有 `browser_*`，就抛错。

### 2.2 不变量被触发的制造者

`src/main/modules/agent-control/execution-tool-config.ts:257-311` `getPolicyOpenAIToolBundle`

```ts
if (policy?.forceDocumentTool) {
  const allowedNames = policy.documentWidgetTaskKind === 'update'
      ? DOCUMENT_WIDGET_UPDATE_TOOL_NAMES  // ← 只有 5 个 document_ 工具
      : ...
  tools = filterOpenAIToolsByAllowedNames(tools, allowedNames)   // ← 把 browser_* 全干掉
}
...
if (policy?.allowBrowserTools === false) {
  tools = tools.filter(...)   // ← 只在 false 时才进一步过滤；true 时不再兜底
}
```

**forceDocumentTool 先行过滤把浏览器工具全删掉，但 `allowBrowserTools` 仍然保留 `true`**，而 `visibleCapabilityGroupIds` 保留 `browser_interaction|browser_content_tasks`——三者不自洽。

### 2.3 browser_workflow 模式错判上游

`src/main/modules/agent-control/browser-task-planner.ts:420-463` + `live-info-intent.ts:22`

```ts
const SPORTS_PATTERNS = /(比分|赛程|战绩|排名|结果|战报|几比几|谁赢了|第几名)/i
...
const liveInfoIntent = detectLiveInfoIntent(text)
...
const effectiveBrowserIntent = ... || liveInfoIntent.needsLiveInfo
if (!effectiveBrowserIntent) return { mode: 'free_tool_loop', ... }
...
return { mode: 'browser_workflow', reason: 'live_information_lookup', ... }
```

当 `text` 参数包含 widget attachment 的 `excerpt`（`widgetCode` 切片）时，`赛程` 字面出现在里面，`SPORTS_PATTERNS` 命中 → `needsLiveInfo=true` → `browser_workflow`。后续 `reconcileAfterBrowserDecision`（run-capability-controller.ts:181）重算 visibility 把 browser 组加回来，但 `forceDocumentTool` 相关的 policy flags（由 `buildExecutionToolState` 基于 documentWidgetTaskKind 计算）仍然保留，产生失谐。

### 2.4 `skills-tools` 运行时加载失败

`src/main/modules/agent-control/tool-registry.ts:201-215, 397-431`

```ts
function resolveStaticSkillToolNames() {
  try {
    const { STATIC_SKILL_TOOL_NAMES } = require('../tools/skills-tools') as ...
    return Array.from(new Set(STATIC_SKILL_TOOL_NAMES))
  } catch {
    return [ 'skill_get_state', ..., 'skill_cancel_execution' ]
  }
}

function resolveSkillToolSchemas(format) {
  ...
  try {
    const skillToolsModule = require('../tools/skills-tools') as ...
    return { tools: ... skillToolsModule.getSkillOpenAITools() }
  } catch (error) {
    return { tools: staticTools, error: getErrorMessage(error), usedStaticFallback: true }
  }
}
```

这三处 `require()` 在 electron-vite 打包后指向 `out/main/index.js` 的相对路径解析不到模块。而 `src/main/modules/claude-bridge/direct-chat.ts:103`、`src/main/modules/tools/tool-executor.ts:21`、`src/main/modules/tools/index.ts:15` 的静态 `import` 在打包期会被 Vite 内联/bundling，所以工具执行路径（真正调 skill）没问题，**只有 tool-registry 的 schema 解析走的是 catch 分支**——skill 组每轮 schemaError、使用静态兜底 name 列表但无完整参数 schema。

### 2.5 insert 首次回 "内容未变化" 的疑点

`src/renderer/modules/agent/documentActions.ts:988-1010`

```ts
if (type === 'insert_widget') {
  ...
  const inserted = insertWidgetIntoDocument(tab.content, title, resolvedWidget.widgetCode, position, sectionTitle, resolvedWidget.componentSpec)
  if (!inserted.inserted) return inserted.error || 'widget 插入失败'
  if (inserted.content === tab.content) return `widget 内容未变化，已跳过：${tab.title}`  // ← round 1 命中这里
```

一张全新的 9:16 卡被判断 `content === tab.content`，只有两种可能：

- `insertWidgetIntoDocument` 在 `!inserted.inserted` 外又在插入后得到空 diff（插入失败但 `inserted.inserted=true`）；
- 或 pipeline 生成的 `widgetCode` 就是空字符串 / 与已有 widget 完全相同（比如命中 widget draft 缓存返回上轮的 placeholder）。

没有更细的 metric 记录 `insertWidgetIntoDocument` 的分支原因，**观测盲区**。

---

## 3. 缺口清单 G-Z3_1 .. G-Z3_9

### G-Z3_1 · P0：forceDocumentTool × browser_workflow 政策碰撞导致硬失败
- **文件**：`src/main/modules/agent-control/execution-tool-config.ts:261-291`；`src/main/modules/agent-control/turn-engine.ts:295-343`
- **现象**：effective 阶段策略内三个维度（`allowBrowserTools / visibleCapabilityGroupIds / allowedToolNames`）失谐，不变量直接抛错杀掉整轮
- **为何是设计问题**：`forceDocumentTool` 是 policy 里更强的开关（用户正在改 widget），`browser_workflow` 只来自 decision mode。碰撞时没有裁决路径，默认把兼容性责任甩给不变量并让它直接 throw
- **验证路径**：在 round 4 复现——用任何含 "赛程/比分/排名" 字样的 widget 做 update，随后发 "让留白少一点"，100% 复现
- **严重度**：P0，用户对话直接终止，无降级

### G-Z3_2 · P0：不变量响应策略应 reconcile 而非 throw
- **文件**：`turn-engine.ts:336-343`；`execution-tool-config.ts:359-395`
- **现象**：不变量正确识别失谐，但响应过激——直接 throw，整轮失败、IPC 返回 error、用户看到红字
- **应有行为**：检测到 `forceDocumentTool + browser_workflow` 时，策略收敛者应选一方：要么降 `allowBrowserTools=false` 并从 visibleGroupIds 剔除浏览器组，要么退出 `forceDocumentTool` 模式；不变量只作最后一道红线，不应在可调解情况下 throw
- **严重度**：P0，错误处理路径自己变成了故障源

### G-Z3_3 · P0：widget attachment 污染 live-info 检测，诱发错判
- **文件**：`src/main/modules/agent-control/live-info-intent.ts:22`；`browser-task-planner.ts:420-463`
- **现象**：`detectLiveInfoIntent` 直接用 `pureUserInput` 文本做正则，而 widget 附件（`widget-target-attachment.ts`）会把 widgetCode/excerpt 拼进去，体育词汇从卡片内容溢出到 "用户意图" 判断层
- **应有行为**：live-info 判定应只跑"纯用户指令"（与 widget 题面、附件 excerpt 分离），或对 widget-update 场景短路跳过 browser 分类
- **严重度**：P0，产生 G-Z3_1 的直接上游（不排斥还会引发其他跨域错判）

### G-Z3_4 · P1：`require('../tools/skills-tools')` 在打包产物里找不到模块
- **文件**：`src/main/modules/agent-control/tool-registry.ts:203, 401, 419`
- **现象**：electron-vite 把 main 打包成单个 `out/main/index.js`，运行时 CJS `require` 的相对路径 `'../tools/skills-tools'` 解析失败，每次都走 catch 分支，skill schema 以 6 个静态名称兜底
- **副作用**：
  - model 看到的 skill 工具没有完整 param schema（只有 name）
  - 日志每轮刷 `tool_group_blocked_rate` 和 `schemaError`
  - `resolveSkillToolDefinitions` 也降级，`buildToolDefinitions` 拿不到真实 param 结构，skill 资源类型/访问模式判定可能不准
- **修复方向**：把这 3 处 `require` 换成 ESM 静态 `import`（已在 `tool-executor.ts` 和 `direct-chat.ts` 验证可行），或接入同模块的预取缓存
- **严重度**：P1，功能未明显崩塌但持续静默降级

### G-Z3_5 · P1：`reconcileAfterBrowserDecision` 缺少策略冲突裁决
- **文件**：`src/main/modules/agent-control/run-capability-controller.ts:181-189`
- **现象**：`reconcileAfterBrowserDecision` 只把 `browserDecisionMode` 塞回去重算策略，没有任何 "两个强开关同时 true 时选谁" 的逻辑
- **期望**：reconcile 步骤必须产出自洽策略，否则传到不变量层只剩抛错一条路
- **严重度**：P1，G-Z3_1 的结构性成因

### G-Z3_6 · P1：insert_widget "内容未变化" 缺可观测性
- **文件**：`src/renderer/modules/agent/documentActions.ts:988-1010`；`src/shared/document-widget-parse.ts`（`insertWidgetIntoDocument`）
- **现象**：round 1 全新 widget 插入后 `inserted.content === tab.content`，但 metric/log 层面没有信息告诉我们：是 insert 定位失败退化成原文？是 widget code 为空？是 componentSpec 编译产物与已存在完全相同？
- **下游影响**：用户感知 "赛程内容丢失"（其实是新卡没落地），于是 round 2 基于 "空卡" 做 update，进一步恶化（log line 73 updating_widget 仅用 54ms，疑似没真正更新）
- **严重度**：P1，意图理解丢失的底座是 data 丢失的错觉

### G-Z3_7 · P2：`[tool_resolution_error]` 每次抛错前会写两条相同日志
- **文件**：`turn-engine.ts:280-291, 336-343`
- **现象**：`appendLoggedToolResolution` + `assertNoToolResolutionViolation` 都 emit 同一份 payload；round 4 + retry 各 4 行 = 8 条重复
- **严重度**：P2，日志噪音 / 调试时误判冗余

### G-Z3_8 · P2：skill-tools 模块加载失败的 metric 打在 `tool_group_blocked_rate`，名字误导
- **文件**：`ready-agent-metrics.log`；metric 名 `tool_group_blocked_rate`
- **现象**：skill 组实际上**没有**被 block（运行时调 skill 走的是另一条静态 import 路径），但每轮 3-5 条 `tool_group_blocked_rate` 看着像 skill 工具全被禁了
- **严重度**：P2，诊断时容易误把 skill 组当成运行不可用；metric 语义需要区分 "schema 降级" vs "工具不可用"

### G-Z3_9 · P2：round 2 documentWidgetTaskKind=update 可能写空 widgetCode
- **文件**：`src/renderer/modules/agent/documentActions.ts:1033-1089`；`document-task-pipeline.ts` 的 update 分支
- **现象**：log line 72-73 `updating_widget status=completed durationMs=54` 极短；round 3 立即爆出 "赛程信息都干没了"；没有前后 diff 比对
- **严重度**：P2，需配合 G-Z3_6 的观测加强一并定位

---

## 4. 症状→根因→缺口 映射表

| 用户感知 | 直接日志线索 | 原因链路 | 归因缺口 |
|---|---|---|---|
| 突然报红 "浏览器工具名单组装异常" | `turn-engine.ts:343` throw + tool_resolution_error | 政策三维失谐 → 不变量抛错 | G-Z3_1 / G-Z3_2 / G-Z3_5 |
| 重试同一条还是报错 | req-1776581551179 再次 host_effective 失谐 | browserDecisionMode 仍由同样 widget attachment 文本推出 browser_workflow | G-Z3_3 |
| 前几轮改卡时 "用户意图丢失、需求错判" | round 1 "内容未变化" + round 3 "怎么把赛程干没了" | 首插未落地 + 后续基于空卡 update | G-Z3_6 / G-Z3_9 |
| 后台日志很多 `Cannot find module '../tools/skills-tools'` | ready-agent-metrics.log 每轮 3-5 条 | 打包后 CJS `require` 相对路径失效 | G-Z3_4 / G-Z3_8 |

---

## 5. 修进骨架（不在此阶段实施）

### Φ0：阻断硬失败（P0，即时止血）

1. **Φ0.1 裁决者**：在 `reconcileAfterBrowserDecision` 后增加 `resolveToolPolicyConflicts(prepared, reconciled)`：
   - `forceDocumentTool=true && browserDecisionMode ∈ {browser_workflow, browser_upload_workflow}` → 把 `allowBrowserTools` 压到 false，从 `visibleCapabilityGroupIds` 剔除浏览器两组，并在 log 里记 `policy_conflict_resolved=force_document_wins`
   - 反向情况（明确 browser task 且没有 widget target）保持 browser_workflow，但撤销 `forceDocumentTool`
2. **Φ0.2 不变量降级**：`assertNoToolResolutionViolation` 在 `resolveToolPolicyConflicts` 后仍失败时，记录 telemetry 但不要 throw；而是在 `buildHostToolContext` 里默认把 `allowBrowserTools` 复位为 false、清空浏览器组；只有真正不可恢复（比如没有任何 allowed tool）时才中断请求

### Φ1：修上游意图分类（P0）

1. **Φ1.1 分离 text 层**：`detectLiveInfoIntent` 只吃 `pureUserInstruction`（不含 widget excerpt / attachment content），在 `browser-task-planner.decideTask` 里显式传递
2. **Φ1.2 Widget-update 短路**：当 `executionIntentContext.hasWidgetTargetContext === true` 且 `documentWidgetTaskKind ∈ {update, inspect, remove}` 时，`browser-domain-orchestrator.prepareBrowserExecution` 直接返回 `{mode: 'free_tool_loop', reason: 'widget_target_active'}`，跳过 live-info 分类

### Φ2：去掉静默降级（P1）

1. **Φ2.1 static import**：把 `tool-registry.ts` 的 3 处 `require('../tools/skills-tools')` 换成 `import { ... } from '../tools/skills-tools'`（顶层或 lazy getter）
2. **Φ2.2 metric 语义分层**：`tool_group_blocked_rate` 拆成 `tool_group_schema_fallback_rate`（降级但可执行）和 `tool_group_blocked_rate`（真正不可用）

### Φ3：可观测性补齐（P1）

1. **Φ3.1 widget 插入/更新 diff metric**：在 `insertWidgetIntoDocument` / `updateWidgetInDocument` 返回体加 `reason: 'inserted'|'updated'|'no_diff'|'spec_collision'|'code_empty'`，渲染端把它写入 `ready-tools.log`
2. **Φ3.2 政策裁决 metric**：Φ0.1 的裁决结果作为 metric 落 `ready-agent-metrics.log`，便于复现判断

### Φ4：日志去重（P2）

1. **Φ4.1**：`appendLoggedToolResolution` 和 `assertNoToolResolutionViolation` 共用一次 emit；只在 violations 真正产生时写一次

---

## 6. 复现实验清单

| 实验 | 前置 | 步骤 | 期望观测 |
|---|---|---|---|
| R-Z3_1 | 打开任意含 "赛程" 字样 widget 的文档 | 指定该 widget 为 target，发 "让留白少一点" | host_effective 失谐 → 抛 "浏览器工具名单组装异常" |
| R-Z3_2 | R-Z3_1 同场景 | 换成含 "比分/排名/战绩" 任一字样的 widget | 同样触发 |
| R-Z3_3 | 任意 widget，文本不含上述关键字 | 发 "留白少一点" | 不触发（证伪：不是 widget attachment 注入，而是 live-info 正则所致） |
| R-Z3_4 | 干净启动 | 走任何一轮 agent 对话 | `ready-agent-metrics.log` 必然出现 `tool_group_blocked_rate/groupId=skills/reason=Cannot find module` |
| R-Z3_5 | 全新文档 | 让 agent 生成新 widget | 查看是否出现 "widget 内容未变化，已跳过" |

---

## 7. 与 Round-2 audit 的关系

- Round-2 的 G-Z1..G-Z12 聚焦**工具超时链路**（send 抢占、abort 丢失、cache key、附件粘性等）
- Round-3 聚焦**工具组装一致性 + 意图分类 + 静默降级**
- 共同的架构隐患：**多个独立策略模块（capability resolver / intent classifier / tool bundle / invariant check）没有统一的裁决层**。Round-2 是 "跨轮次抢占不 sync"，Round-3 是 "跨阶段重算不协调"——都属于 orchestration coherence 缺失

建议 Φ0.1 的裁决者与 Round-2 的 Ω0+ per-scope 队列、Ω1+ cache key 一并纳入 `run-orchestrator.ts`（新模块）统一托管，避免继续在各旧模块里打补丁。

---

## 8. 决策复盘 checklist

- [ ] 是否允许不变量在可裁决情况下 throw？（建议：不允许）
- [ ] forceDocumentTool 和 browser_workflow 冲突时谁优先？（建议：widget-target-active 时 forceDocumentTool 优先）
- [ ] `detectLiveInfoIntent` 是否应该消费 attachment 内容？（建议：否，只用裸指令）
- [ ] `skills-tools` 走 ESM 静态 import 可不可接受其 side-effect 打包体？（需测打包体积变化）

---

## 9. 文档联动

- 与 `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-19-ready-agent-continuous-widget-modification-timeout-audit.md`（Round-1）和
  `2026-04-19-ready-agent-continuous-widget-modification-timeout-round2-audit.md`（Round-2）并列
- 本文件不修改 CLAUDE.md / AGENTS.md；若 Φ0/Φ1 实施后引入新统一编排层，需同步更新协作文档 §6（稳定性约定）
