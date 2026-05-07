---
stage: P (Stage 10)
date: 2026-05-07
enforce: true
status: approved (v8 — Codex round 8 returned READY-TO-IMPLEMENT 2026-05-07)
predecessor: 2026-05-07-O-ui-projection-consolidation-implementation.md
revision_history:
  - v1 (2026-05-07): initial draft
  - v2 (2026-05-07): incorporated Codex review round 1 — 11 findings addressed
  - v3 (2026-05-07): incorporated Codex review round 2 — 2 BLOCKERs (registry caller surface + §3.2/§3.5 contradiction) + 4 secondary findings addressed
  - v4 (2026-05-07): incorporated Codex review round 3 — 2 FAILs (full gateway caller table + execution-tool-config gate scope) + 4 PARTIALs (rearm-order gate precision, unfiltered naming, regex precision, stale R5/test refs)
  - v5 (2026-05-07): incorporated Codex review round 4 — HIGH (test migration scope beyond `not_set`) + MEDIUM (gateway public methods 9 row 增补) + LOW (frontmatter / commit table 命名一致性) + 提交策略重排
  - v6 (2026-05-07): incorporated Codex review round 5 — 3 HIGH (9 missed test callers + private helper test-access guidance + resolvePrimitiveSkillId test path) + 2 MEDIUM (executeToolCall ToolContext callers + prepareInitialRun authorization required) + 1 LOW (§3.9 stale Unfiltered naming)
  - v7 (2026-05-07): incorporated Codex review round 6 — 1 HIGH (legacy-chain-dependent tests at `skill-inspect-run-state-vea-contract.test.ts` / `skill-primitive-continuity.test.ts` will fail after Step C) + 1 HIGH (rule 11 misclassification: executeToolCall sites are model paths, not child-internal) + 1 MEDIUM (rule 4 false-positive prescriptions for tests asserting positive skill visibility)
  - v8 (2026-05-07): incorporated Codex review round 7 — 4 narrow corrections: (a) HIGH 增 `skill-tool-gating-by-session.test.ts:192-198`；(b) HIGH 修正 `tool-policy-authorization.test.ts` 行号映射（real getPolicy legacy at 358-365, prepareInitialRun baseline at 426-440）；(c) MEDIUM `skill-execution-tools-removed.test.ts` 强制 selected auth；(d) MEDIUM `skill-internal-action-runtime.test.ts:151` allowedTypedActions 用 `skill_video_expert_ai_analyze`
---

# Stage 10 (P 阶段) — 删过渡桥，做最终清场

## 0. 背景

Stage 4 W3a/W3b 引入了 `SkillToolAuthorization` 三层分离时，留了一个显式的退场条件：当所有 caller 都迁移到通过 `buildAuthorizationFromIdentity` 计算 authorization 之后，`'not_set'` 兼容短路（`SKILL_TOOL_AUTHORIZATION_NOT_SET` 常量 + reason union 中的 `'not_set'` 字面量）必须被删除。Stage M 同样为 `skill_read_artifact` 退役了 `resolveActiveSkillContext` fallback，但并未一次性清完相邻的过渡注释与 cascade 死代码。

Stage 10 兑现这些退场条件。

## 1. 已确认的现实

- `turn-engine.ts:1790`（识别后 rearm）与 `:2460`（W3b.2 refresh）已在生产路径上用 `buildAuthorizationFromIdentity` 写入真实 authorization。
- `turn-engine.ts:1217` 的 `__authorization = SKILL_TOOL_AUTHORIZATION_NOT_SET` 注释已写明：闭包 `buildHostToolContext` 仅在 rearm 之后被调用。Codex round 1 [1] 验证：`buildHostToolContext` 的三个调用点（line 2184 / 2643 / 3210）全部位于 line 1790 rearm 之后。**生产路径上没有任何 caller 实际观察到 `'not_set'`**。
- `?? SKILL_TOOL_AUTHORIZATION_NOT_SET` 共 **6 个表达式分布在 5 个文件**（v1 误报 5 个；Codex round 1 [11] 修正）：
  - `tool-runtime-context-builder.ts:110, 141`（2 处）
  - `tool-runtime.ts:566`（1 处）
  - `tool-executor.ts:187, 311`（2 处）
  - `skills-tools.ts:435`（1 处）
- `?? undefined` 桥接点共 **2 处**（v1 漏报；Codex round 1 [2] 找出）：
  - `tool-registry.ts:840`（model-visible definitions resolver）
  - `tool-registry.ts:908`（model-visible schemas resolver）
- 非 model 内部 metadata 调用站 **1 处**：`tool-registry.ts:956-958`（`enrichToolDefinitions` 内调用 `getToolSchemasResolutionForGroup` 仅传 3 参数，省略 authorization → 默认 undefined → 走 `filterToolsByAuthorization` 的 undefined passthrough）
- `resolvePrimitiveSkillId` (`skills-tools.ts:418-450`) 的 line 439-449 是 W3a 时为非迁移 caller 留的 legacy 链；删 `'not_set'` 之后 cascade 不可达。
- `execution-tool-skill-filters.ts:39-45` 的 `isSkillNameAuthorizedInAuthorization` mode:'none' 分支特判 `'not_set'` 为 true（保留）、其他为 false（拒绝）。删 `'not_set'` 后该分支恒返 false。
- 当前 `verify` / `verify:cloud` 起步链都在 `verify:o`，本 stage = `verify:p`。
- `doneEventType` (§6.13) 已 100% 删除完毕，**无残留**，本 stage 不涉及。
- `forceLoopGuard` / `shouldParentForceLongSkillTool` / `isParentForceForbiddenByManifest` / **`DEFAULT_RESUME_ACTION_BY_SKILL_ID`**（Codex round 1 [4] 强调）等是 Stage N 的当前架构（§6.21），**不是**过渡桥；Stage M/N 的 gate 与 invariant **不在本 stage 触动范围**。
- `<outputDir>/.ready/child-runs/` legacy resume sidecar 是 §6.20 显式的"升级前暂停 run 可续跑"语义，**不删**。
- `READY_OUTPUT_DIR_LEGACY_GRACE_DAYS` 等数据保留参数同上不删。

## 2. 合同（CI 必须强制的不可逆命题）

| 编号 | 合同 | 强制方式 |
|---|---|---|
| C1 | `SkillToolAuthorization['reason']` union 不包含字面量 `'not_set'` | typecheck + 新 gate `check-no-not-set-authorization.cjs` |
| C2 | `src/main/modules/` 下不存在 `SKILL_TOOL_AUTHORIZATION_NOT_SET` 标识符 | 新 gate |
| C3 | `src/main/modules/` 下不存在字面量 `'not_set'`（含注释，因为合同要求注释也不引用，符合 Codex round 1 [8] "不开 whitelist"建议） | 新 gate |
| C4 | `skill-tool-authorization.ts` 不存在 `=== 'not_set'` / `!== 'not_set'` 形态短路 | 新 gate (regex on reason==='not_set') |
| C5 | `resolvePrimitiveSkillId` 函数体不调用 `resolveActiveSkillContext` / `getLastReferenceSkill` / `getLatestActiveSkillTaskRun` / `choosePrimitiveSkillId`（含注释；Codex round 1 [8] 建议契约表述明确） | 新 gate `check-resolve-primitive-skill-id-shape.cjs` |
| C6 | `filterToolsByAuthorization` 的 authorization 参数不再接受 `undefined`（类型层强制） | typecheck（删除 `| undefined`）+ 新 gate 扫 `?? undefined` 不出现在 authorization 上下文 |
| C7 | `npm run typecheck` 无错 | 现有链 |
| C8 | `verify:p` 全绿 = `verify:o` + 上述新 gate + 新 `test:p:focus` 行为测试 | package.json |
| C9 | 顶层 `verify` 与 `verify:cloud` 起步链切到 `verify:p` | package.json |

## 3. 实施步骤

### 3.1 Step A — 类型层硬化（C1, C4, C6）

| 文件 | 行号 | 改动 |
|---|---|---|
| `skill-tool-authorization.ts` | 42 | reason union: 删 `'not_set'`, 留 `'no_skill_signal' \| 'turn_not_skill_resume' \| 'config_repair_no_recoverable_task'` |
| 同上 | 59-62 | 删 `SKILL_TOOL_AUTHORIZATION_NOT_SET` 常量 |
| 同上 | 91-101 | `buildExplicitNoSkillAuthorization` 参数类型由 `Exclude<..., 'not_set'>` 简化为裸三元 union |
| 同上 | 132-145 | `buildAuthorizationFromIdentity` mode:'none' 分支：删"unknown reason fallback to leak `'not_set'`"注释（line 142），保留 `buildExplicitNoSkillAuthorization('no_skill_signal')` 默认 |
| 同上 | 18-29 | 文件顶部 docblock：删"Default value `{ mode: 'none', reason: 'not_set' }`"段（line 18-24）；保留三层分离 WHY |
| 同上 | 162-201 | **`filterToolsByAuthorization` 签名收紧（Codex round 1 [2]）**：从 `authorization: SkillToolAuthorization \| undefined` 改为 **必填** `authorization: SkillToolAuthorization`。删除 line 185 整段 `if (!authorization \|\| ...)` 短路。语义：mode:'selected' 走 allowedTypedActions ∪ allowedPrimitives；mode:'none' (任意 reason) 一律 strip skill_*。 |
| 同上 | 212-230 | `checkSkillToolAuthorization`：删 line 218 `'not_set'` 短路；mode:'none' 一律 deny，reason 直接用作 errorKind detail |
| 同上 | 162-179 | docblock：删"`'not_set'` default → no filter"段 (line 170)，删"any non-'not_set' reason"措辞 (line 172) |

### 3.2 Step B — 6 个填充位拆除（C2，5 文件 / 6 表达式）

| 文件 | 行号 | 改动 |
|---|---|---|
| `turn-engine.ts` | 1217 | `let __authorization: SkillToolAuthorization = SKILL_TOOL_AUTHORIZATION_NOT_SET` → `let __authorization: SkillToolAuthorization \| null = null`（**Codex round 1 [1]: option A**）；在 `buildHostToolContext` 闭包入口（line 1219）加 invariant: `if (!__authorization) throw new Error('Authorization read before identity rearm — Stage 10 invariant broken')` |
| `tool-runtime-context-builder.ts` | 78-86 | `authorization?: SkillToolAuthorization \| null` → 必填 `authorization: SkillToolAuthorization` |
| 同上 | 110 | `params.authorization ?? SKILL_TOOL_AUTHORIZATION_NOT_SET` → `params.authorization` |
| 同上 | 141 | `context.authorization ?? SKILL_TOOL_AUTHORIZATION_NOT_SET` → `context.authorization` |
| `tool-runtime.ts` | (`ToolRuntimeContext` 类型) | `authorization?: SkillToolAuthorization` → 必填 `authorization: SkillToolAuthorization` |
| 同上 | 566 | `context?.authorization ?? SKILL_TOOL_AUTHORIZATION_NOT_SET` → `context.authorization` |
| `tool-executor.ts` | (`ToolContext` 类型) | `authorization?: SkillToolAuthorization` → 必填 `authorization: SkillToolAuthorization` |
| 同上 | 187 | `context.authorization ?? SKILL_TOOL_AUTHORIZATION_NOT_SET` → `context.authorization` |
| 同上 | 311 | skill domain forwarding 同上 |
| `skills-tools.ts` | (`SkillToolRuntimeContext` 类型) | `authorization?: SkillToolAuthorization` → **必填**（**Codex round 1 [3]**）。`runtimeContext` 自身仍可选，但只要它存在，authorization 必须存在 |
| 同上 | 435 | `runtimeContext?.authorization ?? SKILL_TOOL_AUTHORIZATION_NOT_SET` → 双分支：`if (!runtimeContext?.authorization) return null; const authorization = runtimeContext.authorization` |

### 3.3 Step B' — `tool-registry.ts` + `tool-gateway.ts` 的 undefined passthrough 终结（Codex round 2 BLOCKER 1 修订）

#### 3.3.1 完整 caller 调用面表（实测于 2026-05-07）

`tool-registry.ts` 公共方法分为两类：**model-visible**（必须按 authorization 过滤）vs **execution-lookup / metadata**（必须看 ALL tools，不能过滤）。

| 方法 | 用途 | 是否需要 authorization |
|---|---|---|
| `getToolDefinition(toolName)` (line 772) | 通过名查找定义 | **execution-lookup → 不需要** |
| `getToolDefinitionForExecution(toolName)` (line 776) | 调度时按名查找 | **execution-lookup → 不需要** |
| `listToolDefinitions()` (line 918) | 全量列举（被 `getToolDefinition` / `defaultToolRegistry.listToolDefinitions().map(...)` 用于工具名集合） | **execution / metadata → 不需要** |
| `getToolDefinitionsResolutionForGroup(g, s, auth)` (line 784) | model-visible 列表 | **必须 + auth required** |
| `getToolSchemasResolutionForGroup(g, f, s, auth)` (line 846) | model-visible schemas | **必须 + auth required** |
| `getToolDefinitionsForGroup(g, s, auth)` (line 930) | thin wrap of `Resolution` | 必须 + auth required |
| `getToolSchemasForGroup(g, f, s, auth)` (line 938) | thin wrap of `Resolution` | 必须 + auth required |
| `enrichToolDefinitions(...)` 内部 line 957-958 | metadata 收集（非 model-visible） | **不需要** |

`tool-gateway.ts` 完整方法表（实测于 2026-05-07，覆盖 Codex round 3 BLOCKER Q1）：

| 行号 | 方法 | 当前签名 | 用途 | 处理 |
|---|---|---|---|---|
| 65-71 | `resolveGroupToolDefinitions(g, s, auth)` private | `auth?: ... \| null` | model-visible private wrap → `registry.getToolDefinitionsForGroup` | **auth required** |
| 73-92 | `resolveGroupToolSchemasDetailed(g, f, s, auth)` private | `auth?: ... \| null` | model-visible private wrap → `registry.getToolSchemasResolutionForGroup` | **auth required** |
| 108-114 | `resolveGroupToolSchemas(g, f, s, auth)` private | `auth?: ... \| null` | model-visible private wrap → `resolveGroupToolSchemasDetailed` | **auth required** |
| 117-123 | `resolveGroupToolNames(g, s, auth)` private | `auth?: ... \| null` | **混合用途**：被 line 132 `buildCapabilityGroupEntry` 与 line 178 `collectToolNamesForGroups` **不传 auth** 调用（capability metadata，非 model-visible）；当前接口让 caller 可以传 auth 但实际上没传——是 internal-lookup | **改为 unfiltered**：删 auth 参数，内部改调新 `resolveGroupToolDefinitionsForInternalLookup` |
| 125-135 | `buildCapabilityGroupEntry(groupId)` private | 无 auth | capability metadata 构建 | 行为不变（已 unfiltered） |
| 137-165 | `listResolvedToolDescriptors()` private | 无 auth | 工具描述符聚合（capability metadata） | 行为不变（已 unfiltered） |
| 167-169 | `listCapabilityGroups()` public | 无 auth | capability metadata public | 行为不变（已 unfiltered） |
| 171-173 | `getCapabilityGroup(id)` public | 无 auth | capability metadata public | 行为不变（已 unfiltered） |
| 175-183 | `collectToolNamesForGroups(groupIds)` public | 无 auth | 工具名集合 | 行为不变（已 unfiltered） |
| 185-192 | `getToolSchemasForGroup(g, f, s, auth)` public | `auth?: ... \| null` | model-visible schemas public | **auth required** |
| 194 | `getLastSchemaResolutionError(groupId, format)` public | 无 auth | resolution-error 元数据查询 | 行为不变（已 unfiltered） |
| 198-235 | `getToolSchemaResolutionForGroups(groupIds, f, s, auth)` public | `auth?: ... \| null` | model-visible bundle public | **auth required** |
| 232-237 | `getAnthropicToolsForGroups(groupIds, s, auth)` public | `auth?: ... \| null` | model-visible Anthropic tools | **auth required** |
| 240-245 | `getOpenAIToolsForGroups(groupIds, s, auth)` public | `auth?: ... \| null` | model-visible OpenAI tools | **auth required** |
| 247-249 | `getToolDefinition(id)` public | 无 auth | execution-lookup → `registry.getToolDefinition` | 行为不变（已 unfiltered） |
| 252-253 | `listToolDefinitions()` public | 无 auth | execution-lookup → `registry.listToolDefinitions()` | 行为不变（已 unfiltered） |
| 256-258 | `listTools()` public | 无 auth | descriptor 列表（capability metadata） | 行为不变（已 unfiltered） |
| 260-262 | `count()` public | 无 auth | descriptor 计数 | 行为不变（已 unfiltered） |
| 264-266 | `listToolGroups()` public | 无 auth | capability group id 列表 | 行为不变（已 unfiltered） |
| 268-270 | `getTool(id)` public | 无 auth | descriptor 查询 | 行为不变（已 unfiltered） |
| 272-274 | `hasTool(id)` public | 无 auth | descriptor 存在性 | 行为不变（已 unfiltered） |
| 276-278 | `listByModule(module)` public | 无 auth | descriptor 按 module 过滤 | 行为不变（已 unfiltered） |

外部 caller（model-visible）：

| 文件:行号 | 当前 | 处理 |
|---|---|---|
| `execution-tool-config.ts:243` | `defaultToolGateway.getAnthropicToolsForGroups(visibleGroupIds, policy?.sessionId, policy?.authorization ?? null)` | 删 `?? null`；当 `policy?.authorization` 为 undefined（policy 自身可能 undefined），caller 必须构造显式 `buildExplicitNoSkillAuthorization('no_skill_signal')` 默认。新增 helper `resolvePolicyAuthorization(policy?: ToolPolicy): SkillToolAuthorization` |
| `execution-tool-config.ts:261` | `_mergeForceDocumentAllowedNames(..., policy.authorization ?? null)` | 同上，用 `resolvePolicyAuthorization(policy)` |
| `execution-tool-config.ts:283` | `_filterPreferredSkillAnthropic(..., policy?.authorization ?? null)` | 同上 |
| `execution-tool-config.ts:298` | `defaultToolGateway.getToolSchemaResolutionForGroups(..., policy?.authorization ?? null)` | 同上 |
| `execution-tool-config.ts:318` | `_mergeForceDocumentAllowedNames(..., policy.authorization ?? null)` | 同上 |
| `execution-tool-config.ts:340` | `_filterPreferredSkillAnthropic(..., policy?.authorization ?? null)` | 同上 |
| `tools/index.ts:28, 33` `defaultToolGateway.getAnthropicToolsForGroups / getOpenAIToolsForGroups` 默认导出 | 默认导出函数自身签名也要收紧；caller 必须传 authorization |
| **新增 v6** `RunCapabilityBaseParams.authorization` / `prepareInitialRun(...)` 入参（Codex round 5 MEDIUM 2） | 当前 `authorization?: SkillToolAuthorization \| null` 可选 → **commit 3 收紧为必填** `authorization: SkillToolAuthorization`。生产侧仅 `turn-engine.ts` 一个 caller (`authorization: __authorization`)，已传，安全 |

#### 3.3.2 拆分实施

为实现 Codex round 2 §3 "B' 必须先调用面审计后再 type-tighten" 的要求，**Step B' 拆为两个 phase**：

**Phase B'-1 (兼容性 refactor，零行为变化；Codex round 3 Q5 强化命名)**：
- 新增私有 internal-lookup resolver 对（命名采用 Codex round 3 推荐的强表意形式）：
  - `getToolDefinitionsResolutionForGroupForInternalLookup(groupId, sessionId)` — 不调 `filterToolsByAuthorization`，docblock 明示"only for execution-lookup / metadata; never use for model-visible tool list"
  - `getToolSchemasResolutionForGroupForInternalMetadata(groupId, format, sessionId)` — 同上
- refactor `enrichToolDefinitions` (line 956-958) 改用 `getToolSchemasResolutionForGroupForInternalMetadata`
- refactor `listToolDefinitions` (line 921) 改用 `getToolDefinitionsResolutionForGroupForInternalLookup`
- refactor `tool-gateway.ts:117-123` `resolveGroupToolNames`：删 auth 参数，内部改调新增的 `resolveGroupToolDefinitionsForInternalLookup` private wrapper（其内部调 registry 的 `*ForInternalLookup`）
- 公共 model-visible 方法签名**不变**（仍接受 `authorization?: ... | null`），内部仍用 `?? undefined`
- 这一 phase **能独立编译通过**，不引入新 type 错误

**Phase B'-2 (与 Step A/B 同 commit，type tightening)**：
- 删 `filterToolsByAuthorization` 的 `| undefined`（Step A 已计划）
- 收紧 `tool-registry.ts` 公共 model-visible 方法 (`getToolDefinitionsResolutionForGroup` / `getToolSchemasResolutionForGroup` / `getToolDefinitionsForGroup` / `getToolSchemasForGroup`) 的 `authorization?: ... | null` → 必填 `authorization: SkillToolAuthorization`
- 收紧 `tool-gateway.ts` 公共 model-visible 方法 (`getToolSchemasForGroup` / `getToolSchemaResolutionForGroups` / `getAnthropicToolsForGroups` / `getOpenAIToolsForGroups`) 与 model-visible private wrap (`resolveGroupToolDefinitions` / `resolveGroupToolSchemasDetailed` / `resolveGroupToolSchemas`) 的 auth 参数为必填
- 删 `tool-registry.ts:840, 908` 的 `?? undefined`
- `execution-tool-config.ts` 引入 `resolvePolicyAuthorization(policy?: ToolPolicy): SkillToolAuthorization` helper（policy 缺失或 authorization 缺失时返 `buildExplicitNoSkillAuthorization('no_skill_signal')`）；4+ 处 `?? null` 都改用此 helper
- `tools/index.ts:28, 33` 默认导出函数签名同步收紧
- `listToolDefinitions()` 公共签名保持无 authorization（execution-lookup 路径，正确）
- 内部 `*ForInternalLookup` / `*ForInternalMetadata` resolver 签名亦无 authorization（unfiltered，正确）

### 3.4 Step C — Cascade 死代码清理（C5）

| 文件 | 行号 | 改动 |
|---|---|---|
| `skills-tools.ts` | 418-450 | `resolvePrimitiveSkillId`：删 line 439-449 整个 legacy chain。函数主体压成：`if (!runtimeContext?.authorization) return null; const auth = runtimeContext.authorization; if (auth.mode === 'selected') return auth.skillId; return null` |
| 同上 | 419-434 | docblock 重写：删 W3a/W3b 历史叙事；只留"identity 决定本轮 skill 绑定；mode:'selected' 用 skillId，mode:'none' 返 null" |
| `execution-tool-skill-filters.ts` | 35-45 | `isSkillNameAuthorizedInAuthorization`：mode:'none' 分支由 `return authorization.reason === 'not_set'` 改为 `return false`；可进一步把整个 helper inline 简化为单层条件 |
| 同上 | 12-20 | docblock 删 'not_set' 行 (line 13-15) |

**关键验证**：grep `getLastReferenceSkill` / `getLatestActiveSkillTaskRun` / `choosePrimitiveSkillId` 全仓使用：
- 若 `resolvePrimitiveSkillId` 是它们最后的消费者 → 整体移除 helper
- 若仍有他处使用 → 仅删本处调用，helper 保留（**预期是这种**：`tool-registry.ts:342` 也调 `resolveActiveSkillContext` 用于 identity；`getLastReferenceSkill` 由 reference-hint 注册路径维护）

### 3.5 Step D — 测试迁移（v5 大扩 scope，Codex round 4 HIGH 要求）

测试迁移**不止** `not_set` grep。Codex round 4 指出：(a) `tsconfig.node.json` 不覆盖 `src/__tests__`，所以 typecheck 不会捕到测试编译失败；(b) v4 的 grep list 漏掉断言"no authorization back-compat"行为的多个测试块——这些会在 Phase B'-2 公共方法签名收紧后**编译失败**。

#### 3.5.1 三类 grep 扫描

```bash
# (1) 'not_set' 字面量
rg -n "SKILL_TOOL_AUTHORIZATION_NOT_SET|['\"]not_set['\"]" src/__tests__

# (2) 不传 authorization 的 gateway / registry 公共方法调用
rg -n "gateway\.(getOpenAIToolsForGroups|getAnthropicToolsForGroups|getToolSchemasForGroup|getToolSchemaResolutionForGroups)\([^)]*\)" src/__tests__
rg -n "registry\.(getToolDefinitionsForGroup|getToolSchemasForGroup|getToolDefinitionsResolutionForGroup|getToolSchemasResolutionForGroup)\([^)]*\)" src/__tests__

# (3) buildToolRuntimeContext 不传 authorization
rg -n "buildToolRuntimeContext\s*\(" src/__tests__
```

#### 3.5.2 处理规则

1. **删除"`'not_set'` 短路为 true"用例**（v4 已有）：
   - `skill-tool-authorization.test.ts:34-67`：`'SKILL_TOOL_AUTHORIZATION_NOT_SET has mode:none reason:not_set'` / `'is frozen'` / `'W3a back-compat short-circuit'` 三个 test block 整删
   - `tool-policy-authorization.test.ts:75` 默认 test、`540-559` back-compat 段、`649-664` `mergeForceDocumentAllowedNames: authorization=not_set` 测试块整删
   - `tool-executor-authorization.test.ts:88` 用法迁移到 `buildExplicitNoSkillAuthorization('no_skill_signal')`

2. **删除反向断言**（v4 已有）：
   - `tool-policy-authorization.test.ts:194, 218`：`assert.notEqual(auth.reason, 'not_set', ...)` 删除；保留正向 `assert.equal(auth.reason, 'no_skill_signal')` 类断言

3. **删除/迁移"no authorization back-compat"用例**（v5 启动，**v8 修正—Codex round 7 #2**：v5/v6/v7 行号映射错；以下是 v8 实测于 2026-05-07 的真实行号）：
   - `tool-policy-authorization.test.ts:344-356` `'ToolGateway chain: no authorization (back-compat) → both fixture skills retained'` 测试块——**整删**（断言被退役的 back-compat 行为）
   - `tool-policy-authorization.test.ts:358-365` `'getPolicyOpenAIToolBundle: no ToolPolicy.authorization (legacy callers) → behaves as before W3b.2'` 测试块——**整删**（**v8 行号修正**：v5-v7 误标为 426-440）
   - `tool-policy-authorization.test.ts:426-440` `'prepareInitialRun: skills group visible + no authorization → baseline contains skill_ask_user (sanity ...)'` 测试块——**整删**（**v8 行号修正**：v5-v7 误标为 488-497）。该 baseline 的"sanity for the next two tests"语义在退役 no-auth 之后失去意义；后续两个 prepareInitialRun 测试的 fixture 直接用显式 selected/none auth 即可保证非 vacuous
   - `tool-policy-authorization.test.ts:488-497` `'prepareInitialRun: no authorization passed → toolPolicy.authorization stays undefined (legacy back-compat)'` 测试块——**整删**

4. **迁移 gateway / registry 测试调用**（v5 启动，v6 完整化—Codex round 5 HIGH 1+2 列出全 14 处）：

   `*ForInternalLookup` / `*ForInternalMetadata` 私有 resolver 仍**保持 private**——测试**不应**直接 access 它们（`(registry as any)._method` 是反模式）。测试要么用 **public unfiltered API** (`gateway.listToolDefinitions()` / `getToolDefinition(id)` / `collectToolNamesForGroups([...])`)，要么传**显式 authorization**。

   **逐个 caller 决策（Codex round 5 给出的具体推荐）**：

   | 文件:行号 | 当前调用 | v6 处理 |
   |---|---|---|
   | `tool-gateway-registry.test.ts:30` | `gateway.getOpenAIToolsForGroups(['skills'], sessionId)` | 显式 `buildSelectedSkillToolAuthorization({ skillId: 'video-expert-analyzer', allowedTypedActions: ['skill_video_expert_pipeline'], allowedPrimitives: [...all primitives...], source: 'explicit', reason: 'test_setup' })` |
   | `tool-gateway-registry.test.ts:33` | `gateway.getToolSchemasForGroup('system_host', 'openai')` | `buildExplicitNoSkillAuthorization('no_skill_signal')` |
   | `tool-gateway-registry.test.ts:104` | `gateway.getToolSchemasForGroup('system_host', 'openai')` | `buildExplicitNoSkillAuthorization('no_skill_signal')` |
   | `tool-gateway-registry.test.ts:114` | `gateway.getToolSchemasForGroup('browser_interaction', 'openai')` | `buildExplicitNoSkillAuthorization('no_skill_signal')` |
   | `tool-gateway-registry.test.ts:150` | `gateway.getToolSchemaResolutionForGroups(['skills'], 'openai')` | 显式 `buildSelectedSkillToolAuthorization({ skillId: '...', allowedTypedActions: ['skill_get_state'], ... })` |
   | `skill-execution-tools-removed.test.ts:73` | `gateway.getOpenAIToolsForGroups(['skills'])` | 测试 line 81-92 断言"public/model-facing skills list 包含现有 primitives"——**必须 selected auth** 允许相关 primitives（v7 曾允许 listToolDefinitions 选项，v8 修正：会弱化测试为 metadata coverage 而失语义）；**不能**用 no_skill_signal |
   | `skill-internal-action-runtime.test.ts:18` | helper `gateway.getOpenAIToolsForGroups(['skills'], sessionId)` | 该 helper 被多个测试调用，按 caller 测试意图分别处理：line 31-33 的 no-hint 断言 → caller 传 `buildExplicitNoSkillAuthorization('no_skill_signal')`；line 41-43 的 hinted-visible 断言 → caller 传 selected auth 允许 `skill_video_expert_pipeline` |
   | `tool-internal-admission.test.ts:193` | `gateway.getOpenAIToolsForGroups(['skills'], 'no-vea-hint')` | `buildExplicitNoSkillAuthorization('no_skill_signal')` (line 197 断言 `skill_video_expert_pipeline` 不存在) |
   | `tool-internal-admission.test.ts:198, 200` | `gateway.getToolDefinition(...)` / `gateway.listToolDefinitions()` | 已是 public unfiltered，**不需改** |
   | `tool-registry-skills-dynamic-resolution.test.ts:143` | `registry.getToolDefinitionsResolutionForGroup('skills')` | line 146 断言 `skill_static_fallback_read_skill` 在列——**必须 selected auth** 允许该工具，不能 no_skill_signal |
   | `tool-registry-skills-dynamic-resolution.test.ts:148` | `registry.getToolSchemasResolutionForGroup('skills', 'openai')` | line 150-152 断言同上——**必须 selected auth** |
   | `tool-registry-skills-dynamic-resolution.test.ts:269, 270` | `registry.getToolDefinitionsResolutionForGroup('skills')` / `registry.getToolSchemasResolutionForGroup('skills', 'openai')` | line 264-281 测 dynamic fallback——selected auth |
   | `tool-registry-skills-dynamic-resolution.test.ts:341, 343` | `registry.getToolDefinitionsResolutionForGroup('skills')` / `registry.getToolSchemasResolutionForGroup('skills', 'openai')` | 同上模式，selected auth |
   | **新增 v8** `skill-tool-gating-by-session.test.ts:192-198` | `new ToolRegistry().getToolDefinitionsForGroup('skills', 'session-with-vea-context')` | line 196-198 断言 `skill_run_shell` / `skill_patch_config` / `skill_video_expert_pipeline` 都在列——**必须 selected auth** 允许这 3 个工具名 |

5. **迁移 prepareInitialRun 类测试**（v5 启动，v6 修订—Codex round 5 HIGH 2 修正为 selected）：
   - `run-capability-controller.test.ts:151-188` 区域内 `prepareInitialRun(...)` 不传 authorization 的用例：补传 `authorization: buildSelectedSkillToolAuthorization({ skillId: '<the-skill-the-test-selects>', allowedTypedActions: ['skill_ask_user'], allowedPrimitives: [...], source: 'explicit', reason: 'test_setup' })` ——**不是** `no_skill_signal`，因为该测试的语义恰是"selected skill 时只暴露受 auth 的 skill_*"
   - 同文件其他 `prepareInitialRun` 调用站全 grep 列出，逐个按测试意图选 selected / no_skill_signal

6. **保留行为覆盖**：
   - `buildAuthorizationFromIdentity` 对 known reasons 透传、unknown reason 归一化为 `'no_skill_signal'` 的测试**保留**
   - `mergeForceDocumentAllowedNames` 在 mode:'none' / mode:'selected' 下的行为测试**保留**

7. **新增行为测试** Step C 简化语义（v6 修订—Codex round 5 HIGH 3：`resolvePrimitiveSkillId` 是 private function in `skills-tools.ts:418`，测试**不能直接 import**）：

   两条路径任选一（按 §0.5 P5 "CI 强制 > 文档约束"原则，倾向路径 A）：
   - **路径 A（推荐）**：通过 `executeSkillTool` 间接覆盖。新建 `src/__tests__/skill-primitive-skill-id-resolution.test.ts`：构造 `runtimeContext` 注入不同 authorization，调用 primitive 工具（如 `skill_read_artifact`），断言结果。语义覆盖：
     - mode:'selected' → primitive 调用走 `authorization.skillId` 上下文（artifact root 来自该 skill）
     - mode:'none' → primitive 调用返 `errorKind: 'primitive_no_skill_context'`
     - 无 runtimeContext → 同上
     - runtimeContext 但 authorization 缺失（`as any` 强转）→ 同上 (safe-null)
   - **路径 B**：仅当路径 A 不可行时考虑——`skills-tools.ts` 在 module 级加 `export const __testHooks = { resolvePrimitiveSkillId }`（标注 `@internal`，加 lint 禁止生产代码导入），测试通过 hook 直测。

   决策：v6 默认采用路径 A；执行期若证明路径 A 测试 setup 过重再切换 B。

8. **`buildHostToolContext` invariant：源码顺序 gate + 运行时 throw**（v3+v4 已有）：
   - 取消 unit test，改 `check-turn-engine-authorization-rearm-order.cjs` 静态 gate

9. **运行时 assert 测试**（v3 修订）：
   - `buildHostToolContext` 入口
   - `tool-executor.ts:executeToolCall` 在 model-issued skill_* 调用进入 admission 前

10. **`buildToolRuntimeContext` 测试 caller 迁移**（v3 已有 + v5 完整）：
   - `src/__tests__/skill-tools-frame-patch-delta.test.ts:423, 529` — 必须补传 authorization
   - 全仓 grep `buildToolRuntimeContext\s*\(` 列出，逐个评估

11. **`executeToolCall` `ToolContext` 测试 caller 迁移**（v6 启动，**v7 关键修正—Codex round 6 HIGH 2**）：

   **v6 误判**：将这 4 处归类为 child-internal 路径并推荐 `no_skill_signal`，但实测：
   - `turn-feature-flags.test.ts:37-41` 显式 `invoker: 'model'`
   - `skill-internal-action-runtime.test.ts:151-158, 168-175` 省略 `invoker` → tool-executor 默认 `'model'` (`tool-executor.ts:186`)
   - `tool-internal-admission.test.ts:182-185` 显式 `invoker: 'model'`

   **这些都是 model 路径**。若用 `buildExplicitNoSkillAuthorization('no_skill_signal')`，admission 会先返 `authorization_denied`，吞掉测试关心的 `AbortError` / `internal_tool_not_allowed` 后续断言。

   **v7 正确处理**：每处 ToolContext 字面量补 selected auth 允许测试调用的 skill：
   - `turn-feature-flags.test.ts:37` 测试 `skill_video_expert_pipeline` → `buildSelectedSkillToolAuthorization({ skillId: 'video-expert-analyzer', allowedTypedActions: ['skill_video_expert_pipeline'], allowedPrimitives: [...all primitives...], source: 'explicit', reason: 'test_setup' })`
   - **`skill-internal-action-runtime.test.ts:151`（v8 修正—Codex round 7 #4）**：测试 `skill_video_expert_ai_analyze`（非 `skill_video_expert_pipeline`）→ `allowedTypedActions: ['skill_video_expert_ai_analyze']`
   - `skill-internal-action-runtime.test.ts:168`：active frame 是 `lets-go-rss`，executor 在 authorization 之前已命中 internal admission 返 `internal_tool_not_allowed`——auth 不影响测试，但仍需补充 selected auth 以满足类型；可用任意有效 selected
   - `tool-internal-admission.test.ts:182` 同 site 1 selected auth；executor 顺序是 registration → internal-only admission → model authorization，本测试在 internal-only admission 阶段已返 `internal_tool_not_allowed`，auth 不影响断言

12. **新增 v7：legacy-chain-dependent 测试迁移**（Codex round 6 HIGH 1）：

   下列测试**直接依赖** Stage 10 Step C 要删的 `resolvePrimitiveSkillId` legacy chain（`skills-tools.ts:441-449`），删 cascade 之后**编译能过但运行时会失败**：

   | 文件:行号 | 当前行为 | v7 处理 |
   |---|---|---|
   | `skill-inspect-run-state-vea-contract.test.ts:393-400` | `executeSkillTool('skill_inspect_run_state', ..., undefined, ..., { frameSkillId: 'video-expert-analyzer' })` 依赖 `frameSkillId` 走 legacy chain | runtimeContext 补 `authorization: buildSelectedSkillToolAuthorization({ skillId: 'video-expert-analyzer', allowedTypedActions: [], allowedPrimitives: ['skill_inspect_run_state', ...], source: 'explicit', reason: 'test_setup' })` |
   | `skill-inspect-run-state-vea-contract.test.ts:422-429` | 同上 shape | 同上 |
   | `skill-primitive-continuity.test.ts:88-97` | 整个测试题为"primitive dispatch accepts active blocked skill task context **without a reference hint**"——**这就是被退役的 legacy 行为本身** | **整删该测试**。它断言的就是 Stage 10 要消除的 fallback 路径；同时新增一个等价语义的正向测试，caller 必须显式传 authorization |

### 3.6 Step E — 注释正文化

删过渡注释中"`'not_set'`/until W3b/back-compat/transitional"措辞，保留架构 WHY：

| 文件 | 段落 | 处理 |
|---|---|---|
| `tool-executor.ts:170-185` | "The `'not_set'` default (W3a) short-circuits..." | 整段删 |
| `tool-runtime.ts` | 接口 docblock 中 `'not_set'` 出现处 | 删 |
| `tool-runtime-context-builder.ts:79-85` | "Stage 4 W3 ... `SKILL_TOOL_AUTHORIZATION_NOT_SET` ... back-compat short-circuit" | 删，留下"per-turn skill tool authorization" 一句话即可 |
| `skills-tools.ts:94, 419-435` | resolvePrimitiveSkillId docblock 中 W3a/W3b 三种情况列举 | 重写为现状（只两种） |
| `execution-tool-skill-filters.ts:13-15` | docblock "not_set" 段 | 删 |
| `skill-tool-authorization.ts` | 整文件 docblock 中所有 `'not_set'` | 删 |
| `tool-registry.ts:832-835, 901-903` | "Stage 4 W3b.2 — apply authorization filter..." | 保留架构 WHY，但删任何指向"`'not_set'` short-circuit"的描述（若有） |
| `skills-tools.ts:1393-1396, 1731-1743` | Stage M "active-context fallback retired" 注释 | **保留**（架构 WHY，§0.5 P1） |
| `skill-primitives/read-artifact.ts:37-39` | "legacy resolveActiveSkillContext fallback was retired" | **保留** |

### 3.7 Step F — 旧 force path 审计（Codex round 1 [4] 修订）

**仅做审计、不改动**。`DEFAULT_RESUME_ACTION_BY_SKILL_ID` 是 Stage N 当前架构（§6.21 + `check-no-parent-force-for-child-loop.cjs:70-76`），保持空 dict 是 N 的 invariant，**不在 P 范围**。

确认：
- `forceLoopGuard` / `shouldParentForceLongSkillTool` / `isParentForceForbiddenByManifest` 是 N 当前架构，保留
- `DEFAULT_RESUME_ACTION_BY_SKILL_ID` 保持空 dict + N gate 保留
- N 的 force-tool 注释保留（与 v1 §3.5 注释正文化范围严格分开）

### 3.8 Step G — Stage 10 CI Gate（verify:p）

#### 3.8.1 `scripts/check-no-not-set-authorization.cjs`

扫 `src/main/modules/`：
- 禁止字符串字面量 `'not_set'` / `"not_set"`（含注释——Codex round 1 [8]: 不开 whitelist）
- 禁止 `SKILL_TOOL_AUTHORIZATION_NOT_SET` 标识符
- 扫 `skill-tool-authorization.ts`：
  - reason union AST/regex 检查不含 `'not_set'`
  - 不含 `=== 'not_set'` / `!== 'not_set'`
- 行为：违反 → exit 1 with 文件:行号
- 配套自检 `scripts/__tests__/check-no-not-set-authorization.test.cjs`

#### 3.8.2 `scripts/check-resolve-primitive-skill-id-shape.cjs`

扫 `src/main/modules/tools/skills-tools.ts` 中 `resolvePrimitiveSkillId` 函数体（从 `function resolvePrimitiveSkillId(` 到下一个 `function ` / `^export ` 边界）。

**契约表述明确（Codex round 1 [8]）**：禁止下列符号 **以任何形式**（含注释、字符串字面量）出现在该函数体内：
- `resolveActiveSkillContext`
- `getLastReferenceSkill`
- `getLatestActiveSkillTaskRun`
- `choosePrimitiveSkillId`

理由：函数体是契约级"该路径不再有 legacy 回落"，注释提及亦视为契约模糊化。

配套自检 `scripts/__tests__/check-resolve-primitive-skill-id-shape.test.cjs`。

#### 3.8.3 `scripts/check-authorization-undefined-passthrough.cjs`（Codex round 1 [2] / round 2 §2 #4 / round 3 Q4 扩 scope）

扫描范围扩大到 4 个文件（覆盖 model-visible 调用的所有源头）：
- `src/main/modules/agent-control/tool-registry.ts`
- `src/main/modules/agent-control/tool-gateway.ts`
- `src/main/modules/agent-control/execution-tool-config.ts`
- `src/main/modules/tools/index.ts`

禁止模式（regex-lite，按 `check-frame-write-single-source.cjs:7-11` precedent，先 strip 注释 + 字符串字面量）：
- `authorization\s*\?\?\s*(undefined|null)`
- `authorization\s*\|\|\s*(undefined|null)`
- `authorization\s*as\s*any`
- `\.authorization\s*\?\?\s*(undefined|null)` / `\|\|\s*(undefined|null)` （e.g. `policy?.authorization ?? null`）
- `filterToolsByAuthorization\(` 调用的第二参数为 `undefined` / `null` / `??` / `||` / `as any` 形态（regex-lite parse 该函数调用第 2 实参的字面文本，剥空白）

允许（防误报）：
- 本 gate 自身（`scripts/check-authorization-undefined-passthrough.cjs`）的 forbidden pattern 字符串字面量

配套自检 `scripts/__tests__/check-authorization-undefined-passthrough.test.cjs`，包含正反样例。

#### 3.8.4 `scripts/check-turn-engine-authorization-rearm-order.cjs`（Codex round 2 §2 #3 / round 3 Q3 修订）

扫 `src/main/modules/agent-control/turn-engine.ts`，先 strip 行级注释（`//.*`）与块注释 + 字符串字面量，再做下列三个检查：

**Check 1**：必须存在初始化语句：
```regex
let\s+__authorization\s*:\s*SkillToolAuthorization\s*\|\s*null\s*=\s*null
```
（regex `\s+` 容忍格式化变化，与 `check-frame-write-single-source.cjs` 风格一致）

**Check 2**：必须存在 invariant assert（在 `buildHostToolContext` 闭包 body 内）：
```regex
if\s*\(\s*!__authorization\s*\)\s*[{(]?\s*throw\s+new\s+Error
```
gate 验证该 pattern 至少出现 1 次。

**Check 3** (Codex round 3 Q3 关键)：rearm 优先级。按以下规则：
- 找到所有 **call 表达式** `buildHostToolContext\(` 的行号集合（**排除注释与字符串字面量内的出现**——已在 strip 步骤排除——以及 `buildHostToolContext` 闭包**自身的定义行**，即首个匹配 `buildHostToolContext\s*=\s*\(` 的所在行也要从 call 集合中剔除）
- 找到所有 `__authorization\s*=\s*buildAuthorizationFromIdentity\(` 的行号集合
- 必须满足：rearm 集合的最小行号 < call 集合的最小行号
- **失败条件**：(a) call 集合为空（说明 closure 已无消费者，gate 配置过期，必须重写）；(b) rearm 集合为空；(c) 任一 rearm 行号 ≥ 任一 call 行号（即 rearm 落在最早 call 之后）

未来 inlining `buildHostToolContext` 的可接受性：若该 closure 整体被 inline 删除，gate Check 1+2 会失败，PR 作者必须**重写 gate** 来反映新拓扑——这是有意为之的强约束（避免 gate 过期失效）。

配套自检 `scripts/__tests__/check-turn-engine-authorization-rearm-order.test.cjs`，包含：
- 正样例（v4 后真实形态）通过
- rearm 在 call 之后的反样例失败
- closure 被全部 inline（call 集合为空）的反样例失败

#### 3.8.5 `package.json` 脚本

```jsonc
"test:p:gates": "node --test scripts/__tests__/check-no-not-set-authorization.test.cjs scripts/__tests__/check-resolve-primitive-skill-id-shape.test.cjs scripts/__tests__/check-authorization-undefined-passthrough.test.cjs scripts/__tests__/check-turn-engine-authorization-rearm-order.test.cjs",
"test:p:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/skill-tool-authorization.test.ts src/__tests__/tool-policy-authorization.test.ts src/__tests__/tool-executor-authorization.test.ts src/__tests__/skill-primitive-skill-id-resolution.test.ts",
"verify:p": "npm run verify:o && node scripts/check-no-not-set-authorization.cjs && node scripts/check-resolve-primitive-skill-id-shape.cjs && node scripts/check-authorization-undefined-passthrough.cjs && node scripts/check-turn-engine-authorization-rearm-order.cjs && npm run test:p:gates && npm run test:p:focus",
"verify": "npm run verify:native && npm run verify:p && npm run test",
"verify:cloud": "npm run rebuild:native && npm run verify:p && npm run test"
```

注：`turn-engine-authorization-invariant.test.ts` 已撤（参见 §3.5 #5 修订）。invariant 由 `check-turn-engine-authorization-rearm-order.cjs` 静态强制 + 运行时 throw 兜底。

#### 3.8.6 `scripts/test-coverage-exemptions.json`

确认新测试文件被 verify chain 覆盖（`check-test-coverage-by-verify.cjs` C1 是硬门）；新增 `skill-primitive-skill-id-resolution.test.ts` 已通过 `test:p:focus` 覆盖。`turn-engine-authorization-invariant.test.ts` 不存在（已撤）。

### 3.9 Step H — 文档同步（Codex round 2 §4 LOW 扩 scope）

文档清理范围**不止** §3.5 测试 grep。需先做完整 sweep：

```bash
rg -n "not_set|SKILL_TOOL_AUTHORIZATION_NOT_SET" CLAUDE.md AGENTS.md LESSONS_LEARNED.md PROGRESS.md CHANGELOG.md docs/
```

逐个处理：

- `CLAUDE.md` §6.7：
  - 删 "Stage 4 W3 起 ... 'not_set' 短路 ... 都视同没填 authorization" 整段
  - 新增 §6.23（或合并入 §6.7）："Stage 10 已退役 'not_set' 兼容短路；identity mode:'none' 直接走 mode:'none' authorization (3 个 reason)；模型可见 tool list 不再有 back-compat short-circuit；`filterToolsByAuthorization` / `tool-registry.ts` / `tool-gateway.ts` model-visible 入口的 authorization 参数为必填；非 model 内部 metadata / execution-lookup 路径走 `getToolDefinitionsResolutionForGroupForInternalLookup` / `getToolSchemasResolutionForGroupForInternalMetadata` 私有 resolver（仅 registry 内部使用），或公共 unfiltered API（`gateway.listToolDefinitions / getToolDefinition / collectToolNamesForGroups`）。"
- `CLAUDE.md` §6.11：调整 `tool_not_registered` vs `authorization_denied` 互斥语义段，删 "和 not_set" 措辞（如有）
- `AGENTS.md`：同步 §6.7 / §6.11 / §6.23（§12 要求）
- `LESSONS_LEARNED.md`：新增"Stage 10 = 兑现 W3b 退场条件 + cascade 清理 + undefined-passthrough 终结"经验；删任何指向 `'not_set'` 短路的旧条目
- `CHANGELOG.md`：本次 commit 条目
- `PROGRESS.md`：若引用 `'not_set'` 字面量，修订
- `docs/superpowers/plans/2026-05-07-O-*` 与更早 plan：仅 frontmatter 标注 `enforce: false`（如未标），正文不动（plan 是历史记录）

### 3.10 Step I — Codex 审查（在 Step A 前）

1. v1 已审完一轮（11 finding，全数采纳）
2. v2 写完后再发 Codex round 2
3. round N 通过后开始 Step A

### 3.11 Step J — Codex 终审（Step A–H 全绿后）

1. 把全部 diff（`git diff main...HEAD`）发给 Codex 终审
2. 修复每个问题
3. 循环到 Codex 跳不出问题为止

## 4. 决策点已收敛（v5）

| 编号 | 决策 | 依据 |
|---|---|---|
| R1 | 选 A：`SkillToolAuthorization \| null = null` + invariant assert + 静态 gate (no unit test) | Codex round 1 [1] / round 2 §2 #3 / round 3 Q3 |
| R2 | 选 B：删 `\| undefined`，全路径强制 `SkillToolAuthorization`；非 model 路径用 `*ForInternalLookup` / `*ForInternalMetadata` 私有 helper | Codex round 1 [2] / round 3 Q5 |
| R3 | `SkillToolRuntimeContext.authorization` 当 `runtimeContext` 存在时必填；`runtimeContext` 自身仍可选；`as any` 绕过 typecheck 的 caller 走 safe-null（return null）兜底，**不抛 invariant** | Codex round 1 [3] / round 3 Q1 |
| R4 | 不删 `DEFAULT_RESUME_ACTION_BY_SKILL_ID`，保留 N gate | Codex round 1 [4] |
| R5 | 在 **2 处**加运行时 assert（v3 修订，v4 再确认）：`buildHostToolContext` 入口 / `executeToolCall` model-issued skill_* admission。**不在** `resolvePrimitiveSkillId` 加第三个 assert（与 §3.4 safe-null 行为冲突；v3 已撤） | Codex round 1 [5] / round 2 §2 #5 / round 3 Q7 |
| R6 | 删 `assert.notEqual(..., 'not_set')` 反向断言；保留正向 `=== 'no_skill_signal'` | Codex round 1 [6] |

## 5. 提交策略（v5 重排 — Codex round 4 Q4b 修订）

**Codex round 4 关键洞察**：`tsconfig.node.json` 不覆盖 `src/__tests__`，所以 Phase B'-2 的公共方法签名收紧只会通过 `npm run typecheck` 一项 gate，但**不会**捕获测试文件的编译失败。测试编译错误只在 `npm run test`（用 `tsx`）时才显形。因此必须把测试迁移放在 production type tightening **之前**，让中间提交保持可 bisect。

| Commit | 内容 | 验证 |
|---|---|---|
| 1 | **Step B'-1**（兼容性 refactor 单飞）：新增 `*ForInternalLookup` / `*ForInternalMetadata` 私有 resolver 对（`tool-registry.ts`）；refactor `enrichToolDefinitions` / `listToolDefinitions` 使用之；refactor `tool-gateway.ts:117-123 resolveGroupToolNames` 删 auth 参数 + 改调新 `resolveGroupToolDefinitionsForInternalLookup` private wrapper；公共方法签名**不变** | `npm run typecheck` 全过；`verify:o` 全绿（行为零变化） |
| 2 | **Step D**（测试迁移完整版）：所有 §3.5.2 1-10 规则一次性迁移：(a) 删 `'not_set'` 测试块；(b) 删反向断言；(c) 删 "no authorization back-compat" 三个测试块；(d) 迁移 5 处 gateway-registry no-auth 调用；(e) 迁移 prepareInitialRun no-auth 调用；(f) 补 `buildToolRuntimeContext` 测试 caller authorization 实参；(g) 新增 `skill-primitive-skill-id-resolution.test.ts`。**此 commit 后所有 `src/__tests__` 都用显式 `buildExplicitNoSkillAuthorization('no_skill_signal')` / `buildSelectedSkillToolAuthorization(...)`**——既兼容当前老签名（接受 SkillToolAuthorization），又为下个 commit 的签名收紧做准备 | `npm run test` 全过；`verify:o` 全绿（运行时行为零变化，仅显式化） |
| 3 | **Step A + B + B'-2 + C**（type tightening 总集）：(a) 删 `'not_set'` union member + 常量；(b) 删 6 个 `??` filler；(c) `tool-registry.ts` / `tool-gateway.ts` / `tools/index.ts` model-visible 公共方法签名收紧（auth required）；(d) `execution-tool-config.ts` 6 处 `?? null` 改用 `resolvePolicyAuthorization` helper；(e) `resolvePrimitiveSkillId` cascade 死代码删；(f) `__authorization` 改 nullable + invariant assert；(g) `executeToolCall` model-issued skill_* admission 入口加 invariant assert；(h) `RunCapabilityBaseParams.authorization` / `prepareInitialRun` 入参收紧为必填 | `npm run typecheck` 全过；`npm run test` 全过 |
| 4 | **Step E**（注释正文化）（Step F 仅审计，无改动） | typecheck |
| 5 | **Step G + H**（CI gate + 文档）：4 个新 gate + verify:p / test:p:gates / test:p:focus / verify / verify:cloud chain 切换 + CLAUDE.md / AGENTS.md / LESSONS / CHANGELOG / docs sweep | `npm run verify:p` 全绿 |

每个 commit 信息：`chore(agent): Stage P/10 — <step name>` 范式，Co-Authored-By: Claude Opus 4.7 (1M context)。

不引入 `__retired__not_set` 临时 sentinel（Codex round 1 [9] 推荐）。

## 6. 不在范围（重申）

- 旧 force path 中的 Stage N 当前架构（`forceLoopGuard` / `shouldParentForceLongSkillTool` / `DEFAULT_RESUME_ACTION_BY_SKILL_ID` / N gate）
- `<outputDir>/.ready/child-runs/` legacy resume sidecar
- `READY_OUTPUT_DIR_LEGACY_GRACE_DAYS` / `READY_CHILD_RUN_LOG_RETENTION_DAYS` 数据保留参数
- `doneEventType`（已 100% 退役）
- 任何架构 WHY 注释（"Stage M fallback retired" 这类历史决策记录保留）

## 7. 附录：`resolveActiveSkillContext` 调用站分类（v3 修订，Codex round 2 §4 MEDIUM）

实测于 2026-05-07 (`rg -n "resolveActiveSkillContext\(" src/main/modules`)。`turn-engine.ts:1593` v2 误报为 call site（实为 callback property 赋值 `resolveActiveSkillContextLive: resolveActiveSkillContext`，**不是**调用），已剔除。`active-skill-context.ts:482` v2 漏报，已补。

| 文件:行号 | 表达式 | 用途 | 在 P 范围 |
|---|---|---|---|
| `tool-registry.ts:342` | `const activeSkillContext = sessionId ? resolveActiveSkillContext({ sessionId }) : null` | static skill visibility / identity（动态 tool def 暴露） | ✗ |
| `turn-engine.ts:1515` | `const context = resolveActiveSkillContext({...})` | identity 解析（per-turn） | ✗ |
| `turn-engine.ts:1692` | `activeSkillContextForTurn = resolveActiveSkillContext({...})` | active context for turn / log | ✗ |
| `turn-engine.ts:2899` | `const observedActiveSkillContext = resolveActiveSkillContext({...})` | supervisor / continuity reconciliation | ✗ |
| `skills-tools.ts:324` | `const activeSkillContext = sessionId ? resolveActiveSkillContext({ sessionId }) : null` | `getSkillToolDefs` — model-visible 工具元数据 | ✗ |
| **`skills-tools.ts:441`** | `const activeContext = sessionId ? resolveActiveSkillContext({ sessionId }) : null` | **`resolvePrimitiveSkillId` legacy chain（W3a 兼容）** | **✓ 删除** |
| `skills-tools.ts:1462` | `const activeSkillId = resolveActiveSkillContext({ sessionId })?.skillId ?? null` | `skill_start_detached` admission | ✗ |
| `skills-tools.ts:1610` | `const activeSkillId = resolveActiveSkillContext({ sessionId })?.skillId ?? null` | shell allowlist 解析 | ✗ |
| `active-skill-context.ts:482` | `const context = resolveActiveSkillContext({ sessionId })` | `hasActiveSkillContext` utility（独立查询函数） | ✗ |
| `active-skill-context.ts:398` (declaration) | `export function resolveActiveSkillContext(...)` | 声明 | n/a |

参考引用（callback 注入，**非调用**）：

| 文件:行号 | 表达式 | 说明 |
|---|---|---|
| `turn-engine.ts:1593` | `resolveActiveSkillContextLive: resolveActiveSkillContext` | callback prop 赋值给一个对象字段 — 不是 call |

只有 `skills-tools.ts:441` 是 W3a 时为非迁移 caller 留的 legacy chain；其余 8 处真实 call 是 identity 解析、metadata 暴露、admission 等独立用途，与本 stage 退役的"`'not_set'` 兼容短路"无关。Stage M 已退役的"read-artifact active-context fallback"在 `skills-tools.ts` / `read-artifact.ts` 已物理删除，剩下的注释属于历史决策记录（保留）。

## 8. 执行就绪门

**只有当 Codex round 2 (或更后) 对本计划无 BLOCKER/CRITICAL/HIGH 反馈后，才进入 Step A**。这是 §0.5 P5（CI 强制 > 文档约束 > 人审）的具体兑现：Stage 10 不是"顺手清扫"，是兑现退场条件，必须先有合同。
