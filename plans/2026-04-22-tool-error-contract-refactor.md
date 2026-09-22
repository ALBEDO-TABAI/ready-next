---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../docs/architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../docs/documentation-inventory.md)。

# Tool Error Contract Refactor Plan

> Created: 2026-04-22
> Baseline commit: `13883b3` (branch `codex/document-widget-pipeline-cache`)
> Trigger: "Agent 错误: Execution not found" bug — a stale skill execution id crashed the whole turn instead of being handed back to the model as a recoverable tool result.
> Reference architecture: `/Users/user/Documents/实验田/CC-Source` (Claude Code source tree).

## 0. 目的

把我们 ready-cowork 主进程的"工具调用错误路径"从当前的**失败模式混杂（能分类 = 回灌给模型；不能分类 = 终结整轮）**迁移到 CC-Source 的**统一契约（所有工具错误都是 `tool_result {is_error: true}`，只有基础设施致命类才终结轮次）**。

这不是一次性重写。分四个阶段、可独立落地、可独立回滚；每阶段都有可验证的 exit criteria。

## 1. CC-Source 里值得拿来的核心模式

为避免贴原文，下表给出**模式 + 关键文件坐标 + 一句话释义**。读原文的路径就在 `CC-Source/src/`。

| 模式 | 关键文件 | 含义 |
|---|---|---|
| **统一 tool 错误出口** | `services/tools/toolExecution.ts:1206-1737` 的 `try { tool.call(...) } catch` | 所有 Error 都落到 `createUserMessage({ content: [{ type: 'tool_result', content, is_error: true, tool_use_id }] })`。只有 AbortError 走特殊分支（不 emit error 遥测，但依然返回 is_error tool_result）。**没有任何一条路径从 `.call()` rethrow 出这个函数**。 |
| **两阶段参数校验** | `toolExecution.ts:615`（Zod）+ `toolExecution.ts:683`（`tool.validateInput()`） | Zod `safeParse` 失败 → 直接生成 is_error tool_result 返回模型（`<tool_use_error>InputValidationError: ...</tool_use_error>`），不 dispatch；自定义 `validateInput` 失败 → 同样 is_error 返回。**校验失败从不抛异常**。 |
| **错误分类仅用于遥测** | `toolExecution.ts:150-171` `classifyToolError(error)` | 只负责提炼"telemetry-safe string"（errno、`error.name`），**不**参与"是否 rethrow"的决策。对照我们：`classifyExecutionError` 同时承担了路由决策 + 遥测描述，两个职责绑死在 regex 上。 |
| **稳定错误类层级** | `utils/errors.ts:1-121` `AbortError / ShellError / TelemetrySafeError / ConfigParseError` | 用 `error.name` 做稳定标识（minified 友好），用 `instanceof` 做运行时判别。调用侧在 `catch` 里可以区分"用户中断 vs 工具失败 vs 安全遥测错误"。 |
| **Tool 接口契约** | `Tool.ts:390-695` | 每个 tool 必须带 `inputSchema: z.ZodType`、可选 `validateInput`、`checkPermissions`、`call`、`mapToolResultToToolResultBlockParam`。`buildTool(def)` 注入默认值（`isEnabled: () => true` 等）。 |
| **Task ID 前缀 + 随机** | `Task.ts:79-106` `generateTaskId(type)` | 前缀（`a` / `r` / `w` / `t` / `b` / `m` / `d`）+ 8 位 base36。让模型即便猜 id 也会产生**类型一致**的 id；同时类型前缀让 log/调试一眼可辨。 |
| **Terminal 状态守卫** | `Task.ts:27-29` `isTerminalTaskStatus(status)` | 一个纯函数判"此 task 已终态，禁止注入消息/禁止重用"。任何会 mutate task 的代码都先过一道闸。 |
| **遥测事件结构** | `toolExecution.ts:635-663 / 1639-1690` `logEvent('tengu_tool_use_error', ...)` | 每个失败路径都带 `{ toolName, error(classified), errorCode, queryChainId, queryDepth, isMcp, mcpServerType, requestId }`。可以按 tool × depth × 失败原因聚合。 |

### 关键观察：CC-Source 对"错误严重度"的处理方式与我们不同

CC-Source **不在 IPC 层区分** recoverable vs terminal。它的整条回路是：
```
tool throws → catch → is_error tool_result → next API round-trip → 模型读到 is_error 并自主决定重试/换路/认输
```

这意味着：CC-Source 把"要不要放弃此 turn"这个决策**完全交给模型**。基础设施（API rate limit、上下文溢出）才是另一条路径 —— 但那条路径不在 toolExecution 里，而在更外层的 `query.ts` 循环。

我们现在的问题是：**我们把"基础设施致命 vs 领域可恢复"错误都走同一个 `classifyExecutionError` 里，并且默认行为（`unknown`）倾向于终结**。反了。

## 2. ready-cowork 当前现状（对照标注）

### 2.1 Tool 错误出口
- `src/main/modules/agent-control/tool-runtime.ts:290` —— 当 `classified.kind === 'unknown'` 时直接 `throw error`（:316），冒泡到 orchestrator `error` 事件 → `agent:error` IPC（`claude-bridge/ipc-handler.ts:1115`）→ 渲染端 "Agent 错误: ..." 系统消息（`runtimeDriver.ts:350`）。
- 命中的受害域：`browser-tools.ts:215`（`throw new Error('无法在目录中写入文件')`）、`browser-tools.ts:230`（AbortError）、skill_* 所有 coordinator throw（已部分修复）、以及任何未来抛 Error 的 handler。
- **差异本质**：我们的默认值是"未知 = 致命"，CC-Source 是"未知 = 可恢复（让模型决定）"。

### 2.2 参数校验
- `src/main/modules/agent-control/tool-registry.ts:190`：`input_schema` 存在但只在**导出给 LLM 的 prompt** 时被使用（告诉模型"工具长这样"）。
- `src/main/modules/tools/tool-executor.ts:41-122`：dispatch 时直接传原始 `args: Record<string, unknown>`，handler 各自 `asString / asRecord` 软转。
- `skills-tools.ts:335-346`：`asString(args.executionId)` 空串会直通，最后到 DB 才爆。
- **差异本质**：schema 是单向契约（我们告诉模型），不是双向的（我们也相信模型按它发）。CC-Source 是双向的，`safeParse` 失败即挡。

### 2.3 分类器承担了太多职责
- `src/main/modules/claude-bridge/error-classifier.ts:29-114`：9 种 kind，都是纯字符串 regex。
- **单一失败点**：regex 未命中 → `kind='unknown'` → tool-runtime rethrow → 终结轮次。
- 没有错误类层级，所有 handler throw 都是 `new Error(string)`。

### 2.4 IPC 错误通路保真度
- `src/main/modules/claude-bridge/ipc-handler.ts:1113-1131` 的 `orchestrator.on('error', ...)` 向渲染端 emit `agent:error` payload 只有 `{ error, sessionId, agent, runId }`；errorKind、severity、recoverable 一路丢失。
- `src/renderer/modules/agent/runtimeDriver.ts:340-398` 的 `onError` 把所有 payload 拼成同一段 `"Agent 错误: ${data.error}"` system message，并把 `phase: 'error'` 写进 scopeRunState。
- **差异本质**：CC-Source 不需要区分，因为所有"可恢复"错误根本不会上浮到这一层；我们的架构把它们上浮了，但没带足够结构。

### 2.5 Skill 执行生命周期
- `src/main/modules/skills-runtime/execution-state-store.ts` 持久化到 SQLite `skill_executions` 表。
- 行**永不删除**（只在 `resetFromStep` 删子步骤 artifacts）。
- `executionId` 是 `randomUUID()`（无类型前缀），session 侧只记 summary（`session-continuity.ts:406-433`），模型要靠上轮 projection 里的 `taskContinuation.executionId` 来推断。

### 2.6 观测性
- `logAgentMetric` 基础设施在 `src/main/modules/agent-control/metrics.ts`，写 `ready-agent-metrics.log`。
- 已有打点：`tool_group_blocked_rate`、`policy_conflict_resolved`、`task_title_correction_rate`、`tool_resolution_violation_post_arbitration` 等。
- **缺失**：本次 `skill_execution_missing` 修复没接入；tool-runtime 的 rethrow 路径没接入；IPC error emission 没接入。

## 3. 目标终态（承认我们是 Electron + IPC + SQLite，不照搬）

### 3.1 核心不变式
1. **Tool handler 可以 throw，但 dispatch 层必须把所有 throw 吃成 `ToolExecutionOutput`**（带 `errorKind + recoverable` 字段）。除非错误 `instanceof` 某个"终结类基础设施错误"（AuthError / ContextOverflowError / HostUnavailableError / AbortError），否则不得冒泡出 `executeToolCall`。
2. **参数校验在 dispatch 入口**：有 Zod schema 的工具走 `safeParse`，失败直接返回 `errorKind='input_validation'` 的 is_error 结果，不进 handler。
3. **错误分类器只管遥测**：不再做路由决策。路由决策由"错误类 instanceof 判断 + whitelist"完成。
4. **IPC 错误事件带结构**：`agent:error` payload 必须携带 `{ errorKind, recoverable, toolName? }`，renderer 可以据此区分胶囊层提示（recoverable）vs system 消息（terminal）。
5. **SQL 有保留窗口**：`skill_executions` 终态行 7 天清理，活跃行永不清理。
6. **每个错误落盘必打 metric**：`tool_error_surfaced` / `tool_error_terminal` / `tool_recovery_returned` 三种事件。

### 3.2 ready-cowork 特定的适配（不照搬 CC-Source）
- 我们继续用 `ToolExecutionOutput`（文本 + data + projectionPatch + interactionHint），不切到 Anthropic 原生 `tool_result` 块 —— provider 兼容层在上层处理。
- 我们保留 Electron 多进程 IPC：错误事件从 main 发到 renderer，payload 加 kind 字段即可。
- 我们保留 `classifyExecutionError`，但把它**拆成两个**：`classifyForTelemetry`（只产出 safe string）和 `isTerminalInfrastructureError`（只回答"要不要冒泡"）。
- 我们引入错误类层级（见 5.1 Phase 1），但仅作为**dispatch 层识别 hint**，handler 继续允许抛裸 Error。

## 4. 路径总览

```
Phase 1 —— Dispatch 层吃掉所有 throw            高杠杆，独立可落
   ↓
Phase 2 —— Zod schema 双向契约                   解决参数问题的根
   ↓
Phase 3 —— IPC 错误结构化 + UI 区分              用户侧收益
   ↓
Phase 4 —— 生命周期 + 观测性收口                  健康度 & 可持续
```

每阶段有三段落地建议："最小改动集 / 验证手段 / 回退策略"。

---

## 5. Phase 1 —— 把 tool dispatch 做成"不会 rethrow"的闸

### 5.1 最小改动集

#### (a) 新增错误类层级：`src/main/modules/tools/tool-errors.ts`

```ts
export class ToolDomainError extends Error {
  constructor(public readonly errorKind: string, message: string, public readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'ToolDomainError'
  }
}

export class ToolAbortError extends Error {
  constructor(message = 'Operation aborted') { super(message); this.name = 'AbortError' }
}

export class ToolHostUnavailableError extends Error {
  constructor(public readonly toolName: string, message: string) { super(message); this.name = 'ToolHostUnavailableError' }
}

// 枚举式终结类白名单（全部以 instanceof 判定）
export function isTerminalInfrastructureError(error: unknown): boolean {
  if (error instanceof ToolHostUnavailableError) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  // auth / context_overflow 走上层 model_request 链路，不经由 tool 执行
  return false
}
```

**不动** `error-classifier.ts`（下一阶段再改），避免和 tool-runtime 耦合。

#### (b) `src/main/modules/tools/tool-executor.ts` 变成"吃异常 + 返回结构化"

在 `executeToolCall` 外层加 try/catch，catch 分两支：

```ts
try {
  const rawResult = await (async () => { /* switch */ })()
  return toStructuredToolResult(toolName, rawResult)
} catch (error) {
  if (isTerminalInfrastructureError(error)) throw error  // 保留现有 AbortError/HostUnavailable 语义
  
  const errorKind = error instanceof ToolDomainError ? error.errorKind : 'tool_handler_failure'
  logAgentMetric('tool_error_surfaced', { toolName, errorKind, message: errorMessage(error).slice(0, 200) })
  return createToolExecutionOutput(
    `工具 ${toolName} 失败: ${errorMessage(error)}`,
    {
      shape: 'json',
      data: {
        errorKind,
        toolName,
        message: errorMessage(error),
        detail: error instanceof ToolDomainError ? error.detail ?? null : null,
      },
    },
  )
}
```

#### (c) 翻转 `tool-runtime.ts:290` 的默认

```ts
// 之前：if (classified.kind !== 'unknown') { 回灌 } else { throw }
// 之后：dispatch 层已经吃了 throw。到这里的 rethrow 只剩 terminal infrastructure。
// 因此这段 `catch (error)` 基本变成"只记录 + 重抛"的薄层
} catch (error) {
  // terminal 错误才会到这里（AbortError / HostUnavailable / 未分类模型请求错）
  logAgentMetric('tool_error_terminal', { toolName: toolCall.name, errorName: error instanceof Error ? error.name : 'Unknown' })
  throw error
}
```

同时保留现有 `timeout_tool` 的重试机制 —— 这个机制作用于**模型请求**侧，不是 tool handler 侧，保留无冲突。

#### (d) `skills-tools.ts` 清理（可选）

本次修复的 `runSkillCoordinator` 可以简化 —— dispatch 层已吃异常后，这个 wrapper 不再是"唯一的 catch"，但保留它的好处是能给出**领域定制的 hint**（"请改用 active executionId"）。建议保留，但把 `throw error` 路径删掉（dispatch 会兜底）。

### 5.2 验证

- **单测**：在 `src/__tests__/tool-executor-contract.test.ts` 增加三类：抛裸 Error、抛 ToolDomainError、抛 AbortError。前两类返回 ToolExecutionOutput，第三类 rethrow。
- **集成验证**：用现有的 `tool-executor-guard.test.ts` 做回归。
- **手动**：触发原 bug（让模型发一个假 executionId 到 `skill_submit_input`），观察：① UI 不出现 "Agent 错误" system 消息；② tool 返回进入模型上下文；③ `ready-agent-metrics.log` 里看到 `tool_error_surfaced` 记录。

### 5.3 回退

Phase 1 的改动都在 tool 执行链路，不触及 IPC 和存储。回退只需 revert 三个文件：`tool-errors.ts`（删除）、`tool-executor.ts`（恢复原 switch）、`tool-runtime.ts:290` 分支（恢复）。单 PR 内可完整回滚。

### 5.4 Exit Criteria

- [ ] `grep -rn "throw new Error" src/main/modules/tools/ | wc -l` 不增加（存量不要求清零，dispatch 兜底）
- [ ] 新增三条测试全绿
- [ ] 原 bug 手动复现时 UI 不再出现 system 消息
- [ ] `ready-agent-metrics.log` 出现 `tool_error_surfaced`

---

## 6. Phase 2 —— Zod schema 落到 dispatch 入口

### 6.1 最小改动集

#### (a) 给每个工具域生成 Zod schema

当前 `tool-registry.ts` 里手写 JSONSchema 导出给 LLM。改成：Zod schema 作为 SSOT，自动派生 JSONSchema for LLM、派生 `safeParse` for runtime。

pilot 范围：**仅 skill_* 工具**（6 个），其他域保持现状，看效果。

创建 `src/main/modules/tools/schemas/skill-schemas.ts`：

```ts
import { z } from 'zod'

export const SkillExecutionIdSchema = z.string().uuid().or(z.string().startsWith('e-'))  // UUID 或未来的 prefix 形式

export const SkillSubmitInputArgs = z.object({
  executionId: SkillExecutionIdSchema,
  inputs: z.record(z.unknown()),
})
// ... 另外 5 个
```

#### (b) `tool-executor.ts` dispatch 前加 `safeParse`

```ts
const schema = getToolArgsSchema(toolName)  // 返回 Zod schema 或 null
if (schema) {
  const parsed = schema.safeParse(args)
  if (!parsed.success) {
    logAgentMetric('tool_input_validation_failed', { toolName, issues: parsed.error.issues.length })
    return createToolExecutionOutput(
      `工具 ${toolName} 参数校验失败: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { shape: 'json', data: { errorKind: 'input_validation', toolName, issues: parsed.error.issues } },
    )
  }
  args = parsed.data as Record<string, unknown>
}
```

#### (c) 自动派生 JSONSchema

用 `zod-to-json-schema` 或自己写一个浅层转换 —— 反正 `tool-registry.ts` 现状也是浅层手写。让 LLM 看到的 schema 与 runtime 校验的是同一来源。

### 6.2 验证

- **单测**：恶意模型输入 —— 空串 executionId、错类型的 inputs、多余 key。都返回 `errorKind: 'input_validation'`。
- **回归**：跑 `skills-tools` 既有测试，确认正常路径未被误拦。

### 6.3 回退

Schema 派生逻辑如果出问题，可以用 env flag `READY_SKIP_TOOL_INPUT_SCHEMA=1` 关掉 `safeParse` 环节。schema 文件本身保留（只是不生效）。

### 6.4 Exit Criteria

- [x] 6 个 skill 工具有 Zod schema（`src/main/modules/tools/schemas/skill-control-schemas.ts`）
- [x] 恶意输入测试全部返回 input_validation（`tool-input-validator.test.ts` + `skill-control-schemas.test.ts` 全绿）
- [x] LLM 看到的 JSONSchema 与 runtime 校验同源（golden snapshot 锁定 + `zodObjectToParamList` 派生 + `skill-zod-param-derivation.test.ts` 对 6 个 schema 做 deepEqual）
- [x] 没有正常调用被误拦（`npm test` 1101 pass / 36 fail，基线 +27 pass，零新回归）
- [x] Phase 2 落地于 2026-04-22；后续 Phase 2.5 按一个域一 PR 滚到 browser / document / feishu / memory / rss / calendar / file / system；dynamic skill-action 单独推进

### 6.5 Phase 2.5 滚动（详 `~/.claude/plans/generic-enchanting-gosling.md`）

按易到难 12 PR 链条：

- [x] PR 1 基础设施：`schemas/index.ts` 注册表 + `tool-executor.ts` 域无关 gate（2026-04-22）
- [x] PR 2 memory（4 工具；首次扩 `SkillParamDefinition.items` + `ZodArray` 带 items 派生）（2026-04-22）
- [x] PR 3 rss（5 工具）（2026-04-22）
- [x] PR 4 calendar（5 工具）（2026-04-22）
- [x] PR 5 session-recall（1 工具）（2026-04-22）
- [x] PR 6 file-management（7 工具 —— 原计划写 8，实际 7，并额外抽出纯模块 `file-management-tool-defs.ts` 以绕开测试环境 electron 链）（2026-04-22）
- [x] PR 7 document（实际 15 工具；`componentSpec` 用 `z.record` 派生到 `{type:'object'}` 不递归，与旧输出字节一致；顺带修 `document-widget-system.test.ts` 的 guidance 字符串契约读入路径）（2026-04-22）
- [x] PR 8 feishu（16 工具；5 个操作族共享 `ChannelId` 常量收 16 份 channel_id boilerplate）（2026-04-22）
- [x] PR 9 browser-interaction（实际 25 工具；刻意省 golden snapshot —— 25 工具 ~660 行 inline 噪声大于信号，靠派生 + 手动 diff + 下游回归兜住 byte drift）（2026-04-22）
- [x] PR 10 browser-content-tasks（13 工具；顺带扩 `zod-param-derivation` 支持 `.meta({additionalProperties:true})` opt-in，4 个工具用到；`z.record` 默认不 emit `additionalProperties` 以保持前几 PR 字节等价）（2026-04-22）
- [x] PR 11 system（2 工具；抽 `system-tool-defs.ts` 纯模块绕开 skills-runtime electron 链）（2026-04-22）
- [x] PR 12 skill-action 动态工具：`paramListToZodObject` 反函数 + signature-based cache（不订阅 runtime-manager 事件，签名变化自动重算）+ 合并顺序 dynamic→static 让控制工具 schema 胜出（2026-04-22）

### 6.6 Phase 2.5 收官

10 个工具域全部接入 dispatch 入口 Zod 校验（skill control 6 + memory 4 + rss 5 + calendar 5 + session 1 + file 7 + document 15 + feishu 16 + browser interaction 25 + browser content 13 + system 2 + dynamic skill-action 变长）。`npm test` 从 Phase 2 pilot 基线 1101/36 → 1295/36（净 +194 pass，0 新回归）；`npx tsc --noEmit` 对所有触动文件干净。下一步 Phase 3（IPC errorKind）/ Phase 4（TTL + 观测性收口）无 Phase 2.5 遗留 blocker。

---

## 7. Phase 3 —— IPC 错误结构化到 UI

### 7.1 最小改动集

#### (a) `agent:error` payload 增 kind/recoverable

`src/main/modules/claude-bridge/ipc-handler.ts:1113-1131`：

```ts
orchestrator.on('error', (data) => {
  if (!mainWindow.isDestroyed()) {
    const payload = {
      ...data,
      errorKind: data.errorKind || 'unknown',
      recoverable: Boolean(data.recoverable),  // orchestrator 需要往上传
    }
    mainWindow.webContents.send('agent:error', payload)
    // ... scopeRunEvent 同步带 kind
  }
})
```

orchestrator 侧需要在 emit 的地方带上 kind（从 tool-runtime 的 terminal 路径捕获）。Phase 1 引入的 `ToolHostUnavailableError` / `AbortError` 天然带类型，转成 kind 简单。

#### (b) Preload 类型 + Renderer 区分

`src/preload/index.ts` 的 `agent.onError` 类型扩展为 `(data: { agent, error, errorKind, recoverable, sessionId, runId }) => void`。

`src/renderer/modules/agent/runtimeDriver.ts:340`：

```ts
const cleanupError = window.electronAPI.agent.onError((data) => {
  // ...
  if (data.recoverable) {
    // 走胶囊层：updateScopeRunState({ blockedReason: data.error, phase: 'warning' })
    // 不写入 addMessage
  } else {
    // 原有行为：system 消息 "Agent 错误: ..."
    state.addMessage({ ... })
  }
})
```

#### (c) UI 胶囊层示意

Side panel / chat panel 里加一个"软失败胶囊"组件，接收 `recoverable: true` 的事件，显示短文本 + 可点 dismiss，**不阻塞对话流**。

### 7.2 验证

- **契约测试**：模拟一个 `ToolHostUnavailableError`（browser 不在线时），验证 renderer 收到 `recoverable: true` 且 system 消息**不**出现。
- **手动**：再跑一次原 bug，确认 recoverable 路径走胶囊；再跑一次 auth 失败，确认 terminal 路径仍走 system 消息。

### 7.3 回退

Phase 3 改动局部，renderer 的分支加一个 feature flag `READY_USE_RECOVERABLE_CAPSULE`，默认 false 时走原 system 消息路径即可。

### 7.4 Exit Criteria

- [x] `agent:error` payload 契约测试覆盖 kind/recoverable（`agent-error-ipc-contract.test.ts` 9 case + `agent-error-legacy-payload.test.ts` 4 case，2026-04-22）
- [x] Renderer 胶囊层存在且只在 recoverable=true 时渲染（`SoftFailureCapsule.tsx` + `ChatPanel.tsx:3148` 挂载；runtimeDriver.ts 严格 `recoverable === true` 分流，2026-04-22）
- [x] 原 bug 触发 → 胶囊；auth 失败 → system 消息（契约 map：`auth/context_overflow/host_unavailable/aborted/unknown → terminal`，其他 → recoverable；合约测试锁死分支）
- [x] Phase 3 落地于 2026-04-22；`error-contract.ts` 纯派生 + `emitRuntimeError` 签名加宽 + IPC payload 加字段 + runtimeDriver 三向分流 + softError 侧字段
- [x] `npm test` 1295/36 → 1323/36（+28 pass，0 回归）；`npx tsc --noEmit` 干净
- [x] 放弃 `READY_USE_RECOVERABLE_CAPSULE` feature flag（回滚面 = 单 runtimeDriver 分支，不值养 test matrix）

---

## 8. Phase 4 —— 生命周期 & 观测性收口

### 8.1 最小改动集

#### (a) `skill_executions` TTL

- 新 migration：加 `idx_skill_executions_status_finished_at`。
- `runtime-manager.ts` 启动时（或每 24h）跑 `DELETE FROM skill_executions WHERE status IN ('completed','failed','cancelled') AND finished_at < datetime('now','-7 days')`。
- 保留 `running` / `blocked`（永不删）。

#### (b) Task ID 前缀迁移（可选，推荐做）

`createExecution` 改为 `id = 'e-' + randomBytes(4).toString('hex')`（8 字符 hex + 前缀）。老 UUID 行可继续兼容（`getExecution` 不假设前缀）。前缀让日志/调试一眼可辨。

#### (c) 观测性收口

所有 Phase 1-3 的 metric 汇到一个枚举：

```ts
export const TOOL_ERROR_METRICS = {
  surfaced: 'tool_error_surfaced',       // dispatch 层吃掉 throw
  terminal: 'tool_error_terminal',        // 基础设施致命
  inputValidation: 'tool_input_validation_failed',
  recovery: 'skill_execution_missing_recovered',  // 现有修复
} as const
```

#### (d) 文档同步

- `DOCUMENTATION.md` 增一节"工具错误契约"
- `LESSONS_LEARNED.md` 收录本次重构背景（"stale executionId 引发架构翻新"）
- `CLAUDE.md` 6.x 新一节"6.11 工具错误契约"明确 dispatch 层不 rethrow 业务错误

### 8.2 Exit Criteria

- [x] `skill_executions` 表有 TTL cron（`SkillsRuntimeManager.startTtlSweep()` boot+30s 首跑、之后每小时；Migration 028 加 `(status, finished_at DESC)` 索引；2026-04-22）
- [x] 回归测试模拟时间推进验证清理（`execution-state-store-ttl.test.ts` 6 case，用 FakeDb 跑真实 `purgeExpiredExecutions` 逻辑 + cascade 顺序断言）
- [x] **关键发现**：DB 未开启 `PRAGMA foreign_keys = ON`，Migration 018 的 `ON DELETE CASCADE` 实际是 no-op；purge 方法里显式先删子表再删父表绕开此问题；全局 PRAGMA 开启列为后续待办（2026-04-22）
- [x] Metric 枚举 `TOOL_ERROR_METRICS` 存在（`src/main/modules/agent-control/tool-error-metrics.ts`，6 个 entry，2026-04-22）
- [x] 4 个既有 emit 点换引用；补 `skill_execution_missing` + `ttlSwept` 两个新 emit 点（2026-04-22）
- [x] 4 份协作文档已更新（`CLAUDE.md` §6.11 + `AGENTS.md` 镜像 + `DOCUMENTATION.md` 大节追加 + `LESSONS_LEARNED.md` 首部条目，2026-04-22）
- [x] Task ID 前缀迁移完成（`generateSkillExecutionId() → 'e-{8hex}'`；旧 UUID 行 coexist，format-agnostic 查询，2026-04-22）
- [x] `npm test` 1323/36 → 1344/36（+21 pass，0 回归）；`npx tsc --noEmit` 干净
- [x] Phase 4 落地于 2026-04-22；**整个 tool-error refactor 四阶段收官**

---

## 9. 不做的事

- **不**切换到 CC-Source 的 `Tool` 接口（`tool.call(input, context, canUseTool, assistantMessage, onProgress)` async generator）。我们的 `executeToolCall` 是纯 `Promise<ToolExecutionOutput>`，contract 简单，改动成本远大于收益。
- **不**引入 CC-Source 的 `ToolUseContext` 超级结构（50+ 字段）。我们的 `ToolContext` 刻意窄，够用。
- **不**实现 coordinator/worker agent 模式。ready-cowork 的 session-scope 模型与 CC-Source 的 subagent 模型不同，不强拧。
- **不**搬 OTel telemetry。`logAgentMetric` + 本地日志就够 stable，商业化考虑再上。
- **不**碰 MCP 工具的错误路径。现阶段 MCP 还未接入，留在接入 MCP 的 PR 里一起处理。

## 10. 推进顺序

1. **今天就可做 & 应做**：Phase 1（三个文件、一个测试）。独立 PR 1 天可出。
2. **下周做**：Phase 2 pilot（skill 工具 schema）。如果 pilot 稳定，后续一个 PR / 一个域地推 document / browser / feishu 等。
3. **Phase 2 pilot 稳定后做**：Phase 3。UI 侧的改动要和设计对齐胶囊层样式。
4. **月末做**：Phase 4。偏运维 / 观测，不紧急。

## 11. 开局：Phase 1 第一个 PR 的最小 checklist

- [ ] `src/main/modules/tools/tool-errors.ts` 新建，导出三个类 + `isTerminalInfrastructureError`
- [ ] `src/main/modules/tools/tool-executor.ts:41-122` 的 `executeToolCall` 外层包 try/catch，catch 分两支
- [ ] `src/main/modules/agent-control/tool-runtime.ts:289-316` 调整：unknown 路径不再 `throw error`（由 dispatch 兜底），仅 terminal 路径 rethrow
- [ ] `src/__tests__/tool-executor-contract.test.ts` 新建，三类测试
- [ ] `src/main/modules/tools/skills-tools.ts` 的 `runSkillCoordinator` 保留，`throw error` 那支删掉（dispatch 会兜）
- [ ] `PROGRESS.md` 追加一条，`CHANGELOG.md` 追加一条
- [ ] `npm run typecheck` 净化；`npx tsx --test src/__tests__/tool-*.test.ts` 全绿
- [ ] 手动跑一次 stale executionId 复现 —— UI 无 system 消息 + metrics log 出现 `tool_error_surfaced`

## 12. 协作注意

- CLAUDE.md / AGENTS.md 保持同步（12 节约定）。
- Phase 1 落地时一并加 `CLAUDE.md 6.11 工具错误契约`（Phase 4 做正式文档同步，Phase 1 先埋一句话占位）。
- 每个 Phase 的 PR 单独成文；不要把 Phase 1 + Phase 2 打包，回退成本会爆。
