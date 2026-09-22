---
stage: S (Stage 13)
date: 2026-05-09
enforce: true
status: approved v5 — Codex round 5 converged 2026-05-09 (5 rounds × 11 瑕疵 cleared)
predecessor: 2026-05-08-R-stage12-implementation.md
roadmap: archive/2026-05-08-deerflow-borrowing-roadmap.md
revision_history:
  - v1 (2026-05-09): initial implementation plan from roadmap v13; covers W0.2 / W3.0-W3.5 / W4.0-W4.5 / W5.2+W5.3 / W6.1-W6.3 / W8.1-W8.2 / W10.1-W10.3 / W11.1-W11.2 with 37 CI gates
  - v2 (2026-05-09): incorporated Codex round 1 — 7 瑕疵（3 Contract Gap + 3 Major + 1 Minor）：(#1) provider-parity gate `extra` 白名单加 `model-capability-resolver`（W4.5 新建文件）；(#2) vllm patch profile 不再"占位"——改为本 stage 实装最简 matchPredicate + stream_usage default patcher（避免 W3.1 4-profile coverage gate 红）；(#3) capabilityClass 字段名统一 `supportsVision / supportsThinking / supportsLongContext`（不是 `vision / thinking / longContext`）；(#4) thinking capability 不通过 `CapabilityModeMap.capabilityModes.thinking`（`CapabilityModeMap` keys 限定为 `CapabilityGroupId`，无 `thinking`）——改为通过 `AIModelConfig.thinkingMode?: AICapabilityMode` 独立字段或读 `AIModelDef.capabilityOverrides.supportsThinking` 直返；(#5) clarification 落点真实路径 `src/main/modules/tools/skill-primitives/ask-user.ts`（实测文件名，无 `-bridge` 后缀）；(#6) migration 034/035/036 SQL DDL 用 `IF NOT EXISTS`（与 `src/main/modules/migrations.ts` 现有约定一致）；(#7) gate 总数实测 38，不是 37（公式漏算 W3.0 parity gate）
---

> 2026-09-06 文档核对：本文保留当前仍使用的专项合同及原验收记录；后文的日期、阶段状态和现场缺口按原记录理解，不据此推导今天全部已验收或仍未实现。当前应用边界以 [运行时合同](../../architecture/current-runtime-contracts.md) 为准，近期状态见 [PROGRESS](../../../PROGRESS.md)。

# Stage S (Stage 13) — 完整功能 · 实施计划

## 0. 背景

Stage R（合同基础）已收敛于 `worktree-deerflow-stage-r-s-t/64a1147`。Stage S 把 Stage R 留下的"helper-only / stub" 部件接入主流程，并落地 provider 子模块化、capability 仲裁、observability 完整、SQLite 持久化、clarification 升级、LLM 弹性、skill 安全门。

**M1 里程碑**：Stage S 完成后，deep-research 真正可用——即 §6 列出的 W3.0+W3.1+W4.0+W4.1+W4.2+W4.3+W4.4+W5.2+W5.3+W8.2 全部 land。

## 1. 现实核实（基于 Stage R 收敛后 worktree）

### 1.1 关键路径

- `src/shared/ai-providers.ts:105-255` `AI_PROVIDERS[]` 7 个 inline provider（moonshot / anthropic / fox / openai / gemini / volcengine / openai-compatible）
- `src/shared/ai-providers.ts:441-455` `AIResolvedCapabilities`
- `src/shared/ai-providers.ts:471-528` `resolveAIConfigCapabilities` 函数
- `src/shared/ai-providers.ts:478-484` `inferredProtocol` IIFE
- `src/main/modules/claude-bridge/openai-execution-client.ts` 6 处 JSON.stringify 入口（line 121 / 151 / 203 / 230 / 605 / 651）
- `src/main/modules/claude-bridge/anthropic-execution-client.ts` ≥2 处 request 序列化
- `src/main/modules/agent-control/run-capability-controller.ts` `resolveRunCapabilities` 是策略仲裁单源
- `src/main/modules/skills-runtime/runtime-manager.ts` 是 skill 安装入口
- `src/main/modules/migrations.ts` 现有 33 个 migration（最末 033 由 Stage Q 引入）
- `src/shared/ai-capability-groups.ts:1-15` `CapabilityGroupId` 14 值（Stage R 加 'general_research'）
- Stage R 已落 `auto-title.ts` / `run-span-metadata.ts` / `message-correction-detector.ts` 三个 helper（未接入主流程）

### 1.2 Verify chain

主 `verify` 已切到 `verify:r`（Stage R PR-R8）。Stage S 完成后切 `verify:s`。

## 2. W0.2 — verify:s 定义

`package.json` 加：

```jsonc
"test:s:gates": "node --test eslint-rules/__tests__/*.test.mjs scripts/__tests__/*.test.cjs",
"test:s:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/provider-parity.test.ts src/__tests__/provider-patch-profiles.test.ts src/__tests__/provider-patcher-applied.test.ts src/__tests__/capability-class-resolution.test.ts src/__tests__/capability-gate-arbitration.test.ts src/__tests__/vision-tool-gating.test.ts src/__tests__/view-image-followup.test.ts src/__tests__/reasoning-effort-routing.test.ts src/__tests__/model-capability-overrides.test.ts src/__tests__/token-attribution-split.test.ts src/__tests__/clarification-five-types.test.ts src/__tests__/clarification-stable-id.test.ts src/__tests__/clarification-turn-gap.test.ts src/__tests__/layered-compactor-l2-stub.test.ts src/__tests__/llm-error-retry.test.ts src/__tests__/migration-034-run-meta.test.ts src/__tests__/migration-035-thread-meta.test.ts src/__tests__/migration-036-feedback.test.ts src/__tests__/skill-allowed-tools.test.ts src/__tests__/skill-installer-scanner.test.ts",
"verify:s": "npm run verify:r && npm run verify:native && node scripts/check-verify-s-defined.cjs && <S 段全 cjs gate> && npm run test:s:gates && npm run test:s:focus"
```

**verify:s 必须显式包含 `verify:native`**（W10.x 是 SQLite-backed）。

新建 `scripts/check-verify-s-defined.cjs`（最简骨架）+ `scripts/check-stage-s-verify-switch.cjs`（PR-S8 切换 gate）。

## 3. Theme 3 [RC-3] · Provider Compatibility

### 3.1 W3.0 / W3.0.5 / W3.0.6 — Provider parity gate + capabilityClass 字段扩

**新文件**：`scripts/check-provider-parity.cjs`：

```js
const fs = require('fs')
const path = require('path')
const PROVIDER_IDS = ['moonshot','anthropic','fox','openai','gemini','volcengine','openai-compatible']
const subDir = path.join(__dirname, '..', 'src/shared/ai-providers')
const filesPresent = fs.existsSync(subDir)
  ? fs.readdirSync(subDir).filter(f => f.endsWith('.ts') && !f.startsWith('patch-profiles')).map(f => f.replace(/\.ts$/, ''))
  : []
const missing = PROVIDER_IDS.filter(id => !filesPresent.includes(id))
const extra = filesPresent.filter(f => !PROVIDER_IDS.includes(f) && !['index','apply-provider-patch','resolve-provider-patch-profile','model-capability-resolver'].includes(f))
if (missing.length || extra.length) {
  console.error('[check-provider-parity] FAIL', { missing, extra })
  process.exit(1)
}
console.log('[check-provider-parity] OK')
```

**类型扩展**：

`src/shared/ai-providers.ts:37-52` `AIProviderDef` 加：
```ts
capabilityClass?: {
  supportsVision?: boolean
  supportsThinking?: boolean
  supportsLongContext?: boolean
}
```

`src/shared/ai-providers.ts:29-35` `AIModelDef` 加：
```ts
capabilityOverrides?: {
  supportsVision?: boolean
  supportsThinking?: boolean
  supportsLongContext?: boolean
}
```

`src/shared/ai-providers.ts:441-455` `AIResolvedCapabilities` 加：
```ts
supportsThinking: boolean
supportsLongContext: boolean
```

### 3.2 W3.1 — 7 provider 子模块化 + 4 patch profile

**新目录结构**：

```
src/shared/ai-providers/
├── index.ts                        # barrel + 类型 re-export
├── moonshot.ts                     # 含 def + capabilityClass + defaultRequestPatcher?
├── anthropic.ts
├── fox.ts
├── openai.ts
├── gemini.ts
├── volcengine.ts
├── openai-compatible.ts            # 含 stream_usage default patcher (W3.5)
├── apply-provider-patch.ts         # applyProviderRequestPatch / applyProviderResponsePatch
├── resolve-provider-patch-profile.ts
└── patch-profiles/
    ├── gemini-oai.ts               # W3.2
    ├── deepseek.ts                 # W3.3
    ├── minimax.ts                  # W3.4
    └── vllm.ts                     # 最简实装：matchPredicate baseUrl `/v1` + non-OpenAI/Anthropic + model 含 vllm/llm-/qwen-/baichuan- 等，requestPatcher 强制 stream_usage=true（与 openai-compatible default 重叠不冲突，按优先级 profile 覆盖）
```

每 provider 文件 export `{ def, capabilityClass, defaultRequestPatcher?, defaultResponsePatcher? }`。

`apply-provider-patch.ts` 优先级：
1. 用户显式 config（最高，不被任何 patcher 改）
2. provider defaultPatcher
3. profile patcher（最具体，但只能 add-or-overwrite profile-owned 字段）

原 `src/shared/ai-providers.ts:105-255` `AI_PROVIDERS[]` 改 import 7 子模块汇总。

### 3.3 W3.2-W3.5 — patch profile 实现

每 profile：matchPredicate (config, baseUrl, model) + requestPatcher? + responsePatcher?

- **gemini-oai**：matchPredicate baseUrl `generativelanguage.googleapis.com / vertex / aiplatform` 或 model `gemini-*`；preserve `thought_signature` 字段
- **deepseek**：matchPredicate baseUrl `*.deepseek.com / *.deepseek.ai` 或 model `deepseek-*`；保留 reasoning_content 多轮
- **minimax**：matchPredicate baseUrl `api.minimax.chat / *.minimaxi.com` 或 model `MiniMax-*`；映射 `extra_body.reasoning_split=true` 返回的 `reasoning_details` 到 `additional_kwargs.reasoning_content`
- **vllm**：matchPredicate `(config: AIProviderConfig | null, baseUrl: string | null, model: string) => { if (!baseUrl || !model) return false; if (config?.id === 'openai' || config?.id === 'anthropic' || config?.id === 'gemini') return false; return /\/v1\/?$/.test(baseUrl) && (model.startsWith('vllm/') || /llm-|qwen-|baichuan-|chatglm-|deepseek-r1/i.test(model)) }`；requestPatcher 强制 `stream_options: { include_usage: true }`（与 openai-compatible default 重叠时 profile 优先），保留 `stream_usage` 兼容字段

### 3.4 接入点

`src/main/modules/claude-bridge/openai-execution-client.ts` 6 处 request 序列化：
- 4 处 `JSON.stringify(reqBody)`（line 121 / 151 / 203 / 605）→ 前置 `applyProviderRequestPatch(reqBody, ctx)`
- 2 处 inline 对象（line 230 / 651）→ 实施期先提取为 `reqBody` 变量再调 patcher
- 6 处 response parse 后 → 调 `applyProviderResponsePatch(resp, ctx)`

`src/main/modules/claude-bridge/anthropic-execution-client.ts` 类似 ≥2 处。

**Streaming 边界**：helper 不接 chunk；SSE 在 stream end 后聚合再走 helper。

### 3.5 W3.x Gates（5 个）

1. `check-provider-parity.cjs`（W3.0）
2. `check-patch-profile-coverage.cjs`：4 profile 各有 fixture 命中（`src/__tests__/fixtures/patch-profiles.json`）
3. `check-provider-patcher-applied-at-execution-client.cjs`：AST 计 6/6 + ≥2/2 调用
4. `check-patch-priority-stream-usage-preserved.cjs`：fixture baseUrl=`api.deepseek.com` + provider=openai-compatible (默认 stream_usage=true) + DeepSeek profile → `body.stream_usage === true`
5. `check-ai-provider-submodule-shape.cjs`：每文件 export 检查

## 4. Theme 4 [RC-3] · Capability Gates & Vision

### 4.1 W4.0 — 7 内置 capabilityClass + resolveAIConfigCapabilities 三层 merge

每 provider 子模块的 `capabilityClass`（路线图 §3.4.1）：
- anthropic: `{ supportsVision: true, supportsThinking: true, supportsLongContext: true }`
- openai: `{ supportsVision: true, supportsThinking: false, supportsLongContext: true }`（gpt-4o；o3-mini 在 W4.5 model overrides）
- gemini: `{ supportsVision: true, supportsThinking: true, supportsLongContext: true }`
- moonshot: `{ supportsVision: false, supportsThinking: false, supportsLongContext: true }`
- fox / volcengine / openai-compatible: 全 false（保守，未填 = 拒绝原则）

`resolveAIConfigCapabilities` 函数体（`ai-providers.ts:471`）增 3 层 merge：

```ts
const providerCap = provider?.capabilityClass ?? {}
const modelDef = provider?.models.find(m => m.id === normalizedConfig.model)
const modelCap = modelDef?.capabilityOverrides ?? {}
const visionDefault = modelCap.supportsVision ?? providerCap.supportsVision ?? (agentProtocol === 'anthropic' || agentProtocol === 'openai')
const thinkingDefault = modelCap.supportsThinking ?? providerCap.supportsThinking ?? false
const longContextDefault = modelCap.supportsLongContext ?? providerCap.supportsLongContext ?? ((modelDef?.contextWindow ?? 0) >= 128000)
```

**Codex round 1 #4 修正**：`CapabilityModeMap` keys 限定为 `CapabilityGroupId`（实测 `src/shared/ai-capability-groups.ts:210`），无 `'thinking'` / `'longContext'` 值；不能用 `capabilityModes?.thinking` 形态。改为通过新增 `AIModelConfig.thinkingMode?: AICapabilityMode` + `longContextMode?: AICapabilityMode` 独立字段（与现有 `visionMode` 同款）：

```ts
// AIModelConfig 加：
thinkingMode?: AICapabilityMode       // 用户显式开关
longContextMode?: AICapabilityMode    // 用户显式开关（一般 'auto' 让推断走 contextWindow ≥ 128k）
```

返回值：

```ts
supportsVision: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.visionMode), visionDefault),
supportsThinking: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.thinkingMode), thinkingDefault),
supportsLongContext: applyCapabilityMode(normalizeCapabilityMode(normalizedConfig.longContextMode) || 'auto', longContextDefault),
```

### 4.2 W4.1-W4.4 — 仲裁与工具门

- **W4.1**: `run-capability-controller.ts` resolver 内 enforce capabilityClass —— vision tool 仅 capability=vision 暴露，thinking 模型走 reasoning_effort
- **W4.2**: `tool-gateway.ts` 装载期检查（实施期 grep）
- **W4.3**: 移植 deer-flow `view_image_middleware.py`；落 `turn-engine.ts` 工具批后处理：调用 view_image 后下轮注入图块到模型上下文
- **W4.4**: 各 provider 子模块 `requestPatcher` 内若 model thinking → 注入 `reasoning_effort` 字段

### 4.3 W4.5 — model-level capability + 删 o3-mini 特判

新建 `src/shared/ai-providers/model-capability-resolver.ts`：
```ts
export function resolveModelCapabilities(provider: AIProviderDef, model: string): {
  supportsVision: boolean
  supportsThinking: boolean
  supportsLongContext: boolean
}
```

`openai.ts` `o3-mini` 模型加 `capabilityOverrides: { supportsThinking: true, supportsVision: false }`（双覆盖）。

删除 `agent-context-source.ts:85-92` + `video-expert-child-driver.ts:118-125` 两处零散特判（grep 实测）。

### 4.4 W4.x Gates（11 个）

1. `check-builtin-provider-capability-fixture.cjs`：每 7 子模块 export capabilityClass
2. `check-resolveAIConfigCapabilities-consumes-capabilityClass.cjs`：AST 检查函数体引用 `provider?.capabilityClass` + `modelDef?.capabilityOverrides`
3. `check-w4-after-w3.cjs`：AST gate 检查字段定义 + 函数体三层 reference
4. `check-capability-gate-conservative-default.cjs`：未填 = 拒绝
5. `check-capability-gate-enforced-in-arbitration.cjs`：在 §6.10 真实 enforce
6. `check-vision-tool-capability-gated.cjs`
7. `check-view-image-followup-injection.cjs`
8. `check-reasoning-effort-routing.cjs`
9. `check-model-capability-resolver-merge-order.cjs`：model overrides 必须能覆盖 provider default
10. `check-text-only-models-resolve-text-only.cjs`：fixture o3-mini 返 thinking=true / vision=false
11. `check-no-o3-mini-special-cases.cjs`：断旧零散特判已删

## 5. Theme 5 — Token Attribution（W5.2 + W5.3）

### 5.1 W5.2 — token usage attribution split

新文件 `src/main/modules/agent-control/token-usage-middleware.ts`：

```ts
export const TOKEN_ATTRIBUTION_NAMESPACES = ['model_call', 'task_card_step'] as const
export type TokenAttributionNamespace = typeof TOKEN_ATTRIBUTION_NAMESPACES[number]

export interface TokenUsageRecord {
  namespace: TokenAttributionNamespace
  inputTokens: number
  outputTokens: number
  totalTokens: number
  // ...
}
```

接入位：`task-projection-*` taskCard projection（每 step 累计）。

### 5.2 W5.3 — 多维归因

新建 `src/main/modules/agent-control/token-attribution-dimensions.ts`：

```ts
export const TOKEN_ATTRIBUTION_DIMENSIONS = [
  'search', 'fetch', 'subagent', 'present', 'clarification', 'todo'
] as const
```

每维度独立计数，与 `TOOL_ERROR_METRICS` 分离。

### 5.3 W5 Gates（2 个）

- `check-token-attribution-namespaces-separate.cjs`：不与 TOOL_ERROR_METRICS 合并
- `check-token-attribution-dimensions-registered.cjs`

## 6. Theme 6 — Clarification（W6.1-W6.3）

### 6.1 W6.1 — 5-type + options

升级 `src/main/modules/tools/skill-primitives/ask-user.ts`（**Codex round 1 #5 修正**：实测路径无 `-bridge` 后缀；schema 在 `:31` 周围）：

```ts
type ClarificationType = 'missing_info' | 'ambiguous_requirement' | 'approach_choice' | 'risk_confirmation' | 'suggestion'

interface ClarificationRequest {
  type: ClarificationType
  question: string
  options?: string[] | null
  // ...
}
```

renderer 加 5 类不同 UI（自由文本 / 多选 / 风险确认 / 建议接受/拒绝）。

### 6.2 W6.2 — stable message ID

`f"clarification:${tool_call_id}"` 或 sha256 截 16；重试 replace 不 append。

### 6.3 W6.3 — turn-gap 触发（**非 middleware**）

`turn-engine.ts` 工具批后位插入 check；不吞 turn（拒绝 deer-flow `goto END`）。

### 6.4 Gates（3 个）

- `check-clarification-type-enum-frozen.cjs`
- `check-clarification-stable-id.cjs`
- `check-clarification-turn-gap-not-middleware.cjs`

## 7. Theme 8 — Compactor + Resilience（W8.1+W8.2）

### 7.1 W8.1 — L2 layered compactor stub + hook 接口

实测当前 `createLayeredCompactor()` 已存在（§6.15 Stage D）。本 stage 加 stub `_SkillBundle` 形态 + `BeforeSummarizationHook` interface（pure interface，不进 production）。

### 7.2 W8.2 — LLM error retry

新文件 `src/main/modules/claude-bridge/llm-resilience.ts`：

```ts
export const RETRY_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504]
export const RETRY_BUSY_PATTERNS = [/server.*busy/i, /try.*later/i]

export async function withRetryBackoff<T>(fn: () => Promise<T>, opts: { maxAttempts: number; baseDelayMs: number }): Promise<T>
```

接入：所有 provider 适配层（OpenAI / Anthropic / Gemini OAI / 自定义）共享。

### 7.3 Gates

- `check-l2-stub-not-in-production-path.cjs`
- `check-llm-retry-status-codes.cjs`：408/409/425/429/5xx + busy patterns

## 8. Theme 10 — Persistence（W10.1-W10.3）SQLite-backed

### 8.1 W10.1 — run_meta 表（migration 034）

`src/main/modules/migrations.ts` `migrations[]` append migration 034：

```sql
CREATE TABLE IF NOT EXISTS run_meta (
  run_id TEXT PRIMARY KEY,
  task_id TEXT,
  scope_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  first_message_text TEXT,
  last_message_text TEXT,
  follow_up_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_meta_task_id ON run_meta(task_id);
CREATE INDEX IF NOT EXISTS idx_run_meta_scope_id ON run_meta(scope_id);
```

新 repository `src/main/modules/agent-control/run-meta-repository.ts`。

### 8.2 W10.2 — thread_meta + owner filter (migration 035)

```sql
CREATE TABLE IF NOT EXISTS thread_meta (
  thread_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','agent','system')),
  owner_id TEXT NOT NULL,
  display_title TEXT,
  pinned INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

repository 内**强校验** mutate path（owner kind / id 不能在 update 时改）。

### 8.3 W10.3 — feedback upsert (migration 036)

```sql
CREATE TABLE IF NOT EXISTS run_feedback (
  feedback_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  signal TEXT,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES run_meta(run_id)
);
CREATE INDEX IF NOT EXISTS idx_run_feedback_run_id ON run_feedback(run_id);
```

upsert 形态：先 INSERT，冲突 UPDATE。

### 8.4 W10.x Gates（5 个）

- `verify:native` 真 sqlite 测试
- `check-migration-numbering-sequential.cjs`：034 / 035 / 036 顺序
- `check-migration-fresh-upgrade-idempotent.cjs`：fresh install / upgrade from 033 / re-run idempotent
- `check-thread-meta-strict-mutate.cjs`
- `check-feedback-upsert-shape.cjs`

## 9. Theme 11 — Skill System Hardening（W11.1+W11.2）

### 9.1 W11.1 — manifest allowed-tools 字段

`src/main/modules/skills-runtime/skill-compiler.ts` + tool-gateway 协同：
- skill ready-skill.json 加 `allowed_tools: string[]` 字段
- 编译期 validate 是 string array
- 运行期 tool-gateway 用 allowed_tools 与 §6.23 authorization 联合决定 visible

### 9.2 W11.2 — installer security_scanner

新文件 `src/main/modules/skills-runtime/skill-security-scanner.ts`：移植 deer-flow `skills/security_scanner.py` 模式 + Ready 沙箱风险词。

`src/main/modules/skills-runtime/runtime-manager.ts` 安装入口（实测在 `runtime-manager.ts` 内，**不存在** skill-installer.ts）加 hook：scanner 失败 → 保守阻断。

### 9.3 Gates

- `check-skill-allowed-tools-enforced.cjs`
- `check-skill-installer-scanner-blocks.cjs`：已知恶意 fixture 必须被拒

## 10. PR 拆分

| PR | 内容 | depends-on |
|---|---|---|
| **PR-S1** | W0.2 verify:s 骨架（含 verify:native）+ check-verify-s-defined.cjs | — |
| **PR-S2** | W3.0+W3.0.5+W3.0.6（capabilityClass / capabilityOverrides 字段扩 + AIResolvedCapabilities 字段扩）+ provider parity gate | PR-S1 |
| **PR-S3** | W3.1（7 provider 子模块化 + 4 patch profile + apply-provider-patch helper + index barrel） | PR-S2 |
| **PR-S4** | W3.2-W3.5 patch profile 实现（gemini OAI / deepseek / minimax / openai-compatible default stream_usage）+ execution-client 接入 | PR-S3 |
| **PR-S5** | W4.0 7 provider 默认 capabilityClass + resolveAIConfigCapabilities 三层 merge | PR-S3 |
| **PR-S6** | W4.1-W4.4 capability arbitration + vision tool gate + view_image followup + reasoning_effort routing | PR-S5 |
| **PR-S7** | W4.5 model-level capability resolver + 删 o3-mini 特判 | PR-S5 |
| **PR-S8** | W5.2+W5.3 token attribution split + dimensions | PR-S1 |
| **PR-S9** | W6.1-W6.3 clarification 5-type + stable ID + turn-gap | PR-S1 |
| **PR-S10** | W8.1 L2 stub + W8.2 LLM resilience | PR-S3 |
| **PR-S11** | W10.1+W10.2+W10.3 migration 034/035/036 + 3 repository | PR-S1 |
| **PR-S12** | W11.1+W11.2 skill allowed-tools + scanner | PR-S1 |
| **PR-S13** | Stage 切换：主 verify / verify:cloud / CLAUDE.md §6.26 | PR-S1..S12 |

## 11. 41 个 CI gate 完整列表（verify:s 内嵌 40 + PR-S13 switch gate 1）

W0.2: check-verify-s-defined.cjs + check-stage-s-verify-switch.cjs（switch 不进 verify:s 内嵌）
W3.0: check-provider-parity.cjs
W3.0.5/W3.0.6: check-ai-provider-def-capability-class.cjs + check-ai-model-def-capability-overrides.cjs + check-ai-resolved-capabilities-thinking-longcontext.cjs
W3.1: check-patch-profile-coverage.cjs + check-provider-patcher-applied-at-execution-client.cjs + check-patch-priority-stream-usage-preserved.cjs + check-ai-provider-submodule-shape.cjs
W3.2: check-gemini-thought-signature-preserved.cjs
W3.3: check-deepseek-reasoning-content-multi-turn.cjs
W3.4: check-minimax-reasoning-split-mapping.cjs
W3.5: check-openai-stream-usage-default.cjs
W4.0/W4.5: 11 gates（详 §4.4）
W5.2: check-token-attribution-namespaces-separate.cjs
W5.3: check-token-attribution-dimensions-registered.cjs
W6.1-W6.3: 3 gates（详 §6.4）
W8.1: check-l2-stub-not-in-production-path.cjs
W8.2: check-llm-retry-status-codes.cjs
W10.1: check-migration-numbering-sequential.cjs + check-migration-fresh-upgrade-idempotent.cjs（含 verify:native 内嵌）
W10.2: check-thread-meta-strict-mutate.cjs
W10.3: check-feedback-upsert-shape.cjs
W11.1: check-skill-allowed-tools-enforced.cjs
W11.2: check-skill-installer-scanner-blocks.cjs

**vllm 行为 gate** 新增（Codex round 3 修正）：`check-vllm-stream-options-include-usage.cjs`：fixture 跑 vllm patch profile，断 `body.stream_options.include_usage === true` 与 `body.stream_usage === true`。

**vllm 排除官方 provider gate** 新增（Codex round 4 修正）：`check-vllm-excludes-official-providers.cjs`：fixture 跑 `resolveProviderPatchProfile({ id: 'openai', ... })` / `'anthropic'` / `'gemini'` 配合任意 baseUrl + model 都不命中 vllm profile（matchPredicate 返 null）。

**LLM retry 接入 gate** 新增（Codex round 4 修正）：`check-llm-retry-applied-at-execution-clients.cjs`：grep `src/main/modules/claude-bridge/openai-execution-client.ts` 与 `anthropic-execution-client.ts` 都 import 并调用 `withRetryBackoff`（或同等 helper），覆盖率 ≥ 各 wire 的主要请求路径。

合计 41 个 unique gate（**Codex round 1+3+4 修正**：W0.2 含 2 个；W3 新增 vllm 行为 gate + vllm 官方 provider 排除 gate；W8 新增 LLM retry 接入 gate）。verify:s 内嵌 40（除 switch gate）。

## 12. CLAUDE.md §6.26 草稿

```md
### 6.26 deer-flow 借鉴 · 完整功能（S / Stage 13）

- Stage 13（S 阶段）落地 provider 子模块化 / capability 仲裁 / observability 完整 / SQLite 持久化 / clarification 升级 / LLM 弹性 / skill 安全门。
- **Provider 子模块**：`src/shared/ai-providers/` 7 个 provider（moonshot / anthropic / fox / openai / gemini / volcengine / openai-compatible）+ 4 patch profile（gemini-oai / deepseek / minimax / vllm）+ apply-provider-patch helper + resolve-provider-patch-profile。原 inline `AI_PROVIDERS[]` 改 import 子模块汇总。
- **Patch 优先级**：用户 config > provider default > profile patcher。
- **Capability merge 三层**：model overrides > provider class > inferred fallback。未填能力 = 保守拒绝。`o3-mini` 走 model overrides 双覆盖（thinking=true/vision=false），不再有零散特判。
- **Token attribution**：per model-call span + per-step taskCard 归因；多维 namespace（search/fetch/subagent/present/clarification/todo）独立计数，**不**进 TOOL_ERROR_METRICS。
- **Clarification**：5-type + options（missing_info/ambiguous_requirement/approach_choice/risk_confirmation/suggestion）；stable message ID `clarification:<tool_call_id>` 重试 replace 不 append；turn-gap 触发**非 middleware**形态，不吞 turn。
- **LLM resilience**：`llm-resilience.ts` 共享 helper，408/409/425/429/5xx + "server busy" 模式重试 + 退避，所有 provider 适配层接入。
- **SQLite 持久化**：migration 034 `run_meta` / 035 `thread_meta`（含 owner kind/id strict mutate） / 036 `run_feedback` (rating 1-5 + signal + upsert)。
- **Skill hardening**：manifest `allowed_tools` 字段编译期 + 运行期联合 §6.23 authorization；安装期 security_scanner 阻断恶意 fixture。
- **Verify chain**：`npm run verify:s` 必须内嵌 `verify:r` + `verify:native`，并覆盖 40 个内嵌 gate + `test:s:gates` + `test:s:focus`（外加 PR-S13 切换 gate `check-stage-s-verify-switch.cjs`，共 41 unique）。Stage S done 后主 `verify` / `verify:cloud` 起步链切到 `verify:s`。
```

## 13. 收敛条件

- [ ] §3-§9 所有 W 落点 land
- [ ] 41 unique cjs gate（verify:s 内嵌 40 + 切换 gate 1）+ 20 tsx test 全部绿
- [ ] `npm run verify:s` 在 worktree 内通过
- [ ] `npm run verify:native` 通过（migration 034/035/036 真测）
- [ ] CLAUDE.md §6.26 land
- [ ] 主 `verify` / `verify:cloud` 切换到 `verify:s`
- [ ] PR-S1..S13 全部 commit
