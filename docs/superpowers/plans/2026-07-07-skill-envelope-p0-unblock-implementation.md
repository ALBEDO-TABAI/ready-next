---
status: approved — 白 2026-07-07 批准"全案 P0-P3 文档化施工"；本篇为 P0 执行书
revision_history:
  - v1 (2026-07-07): 初稿。母合同=2026-07-06-skill-envelope-floors-and-standard-adoption-implementation.md §4 T2/T3/T6、§5 P0。
owner: 白
author: Claude (Opus 4.8)
executor: 任意 coding agent（含弱模型）——严格按工单执行，禁止即兴发挥
reviewer: 白 / Codex
enforce: true
note: >
  目标：两个设计 skill（ready-human-touch-ppt/card）在真机端到端可用。
  四个工单顺序执行，每单独立 commit。所有行号以 2026-07-07 工作区为准，
  动手前必须跑"锚点核验"；核验不匹配 → 立即停下报告，禁止自行找相似代码替代。
---

# P0 执行书：解除 skill 工具封锁

## 0. 执行者铁律（每单适用）

1. **锚点核验先行**：每个工单开头的核验命令必须先跑；输出与文档预期不符 → 停止并报告差异，不得继续。
2. **手术式改动**：只改工单点名的文件与行；不重排 import、不改无关注释、不格式化、不重命名。
3. **禁改清单**：`Packer/`、`CHANGELOG.md`、`package.json`、`package-lock.json` 一律不碰、不提交（属发布线）。
4. **验证纪律**：所有验证命令用 `> /tmp/xx.log 2>&1; echo EXIT=$?` 形式；只有 `EXIT=0` 算过；禁止 `cmd | tail` 式管道（吞退出码）。
5. **红测先行**：先写测试、跑一次确认它红（或按工单说明确认基线），再实现，再确认绿。
6. 每单一个 commit，用工单给出的提交信息；commit 前 `git status` 比对"应提交文件清单"，出现清单外文件 → 停止报告。

## 1. 背景（只读，勿改）

失败轮日志（`$TMPDIR/ready-tools.log` 2026-07-06T15:15:37Z）：
`stage=sdk_runtime_final_tools toolCount=0 tools=none skillHintRelevant=true:explicit_skill`。
死因链：技能选中轮把工具面独占收窄成 4~6 个 `skill_*` 原语（`agent-sdk-tool-executor.ts` `filterSelectedSkillToolSurface` 调用点）→ 本地文档过滤器（`agent-sdk-turn-orchestrator.ts:890`，`@[….md]`+"生成"触发）再只留 `domain==='document'|'file'` → 交集空。且技能轮面上从来没有 `file_read_excerpt`，附件源文档不可读。

## 2. 工单 P0-1：提交工作区既有修复（两个 commit）

工作区已有一批**已验证**的未提交改动（上一轮会话产物，2026-07-07 实测 parity 14/14、fac 6/6、typecheck 绿）。

### 锚点核验
```bash
git status --porcelain | sort
```
预期恰好包含以下条目（`Packer/`、`CHANGELOG.md`、`package*.json` 也会出现——它们**不属于本单**）：
```
 M src/__tests__/embedded-skill-fac-three-skills.test.ts
 M src/__tests__/sdk-turnengine-capability-parity.test.ts
 M src/main/modules/agent-control/runtime-core/agent-sdk-utils.ts
 M src/main/modules/skills-runtime/manifest.ts
?? assets/embedded-skills/ready-human-touch-card/
?? assets/embedded-skills/ready-human-touch-ppt/
```
（另有 `docs/superpowers/plans/2026-07-0*.md` 计划文档，可与 commit A 一并提交。）

### 步骤
1. 验证基线：
```bash
npx tsx --test src/__tests__/sdk-turnengine-capability-parity.test.ts > /tmp/p01a.log 2>&1; echo EXIT=$?
npx tsx --test src/__tests__/embedded-skill-fac-three-skills.test.ts > /tmp/p01b.log 2>&1; echo EXIT=$?
npm run typecheck > /tmp/p01c.log 2>&1; echo EXIT=$?
```
三个都必须 `EXIT=0`。
2. **Commit A（技能注册）**：
```bash
git add assets/embedded-skills/ready-human-touch-ppt assets/embedded-skills/ready-human-touch-card \
  src/main/modules/skills-runtime/manifest.ts src/__tests__/embedded-skill-fac-three-skills.test.ts \
  docs/superpowers/plans/2026-07-06-skill-envelope-floors-and-standard-adoption-implementation.md \
  docs/superpowers/plans/2026-07-07-skill-envelope-p0-unblock-implementation.md \
  docs/superpowers/plans/2026-07-07-skill-envelope-p1-floors-implementation.md \
  docs/superpowers/plans/2026-07-07-skill-standard-p2-adoption-implementation.md \
  docs/superpowers/plans/2026-07-07-skill-ecosystem-p3-implementation.md
git commit -m "feat(skills): register ready-human-touch ppt/card embedded skills + skill-system plans"
```
3. **Commit B（D1 修复）**：
```bash
git add src/main/modules/agent-control/runtime-core/agent-sdk-utils.ts \
  src/__tests__/sdk-turnengine-capability-parity.test.ts
git commit -m "fix(agent): keep explicit skill mention through attachment context markers"
```

## 3. 工单 P0-2：修 D2 — 文档过滤器保地板 + 空面守卫

### 锚点核验
```bash
grep -n "toolDefinitions = toolDefinitions.filter(isLocalDocumentToolDefinition)" src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts
grep -n "export function filterSelectedSkillToolSurface" src/main/modules/agent-control/runtime-core/agent-sdk-utils.ts
grep -n "export function authorizedPrimitiveToolNames" src/main/modules/agent-control/runtime-core/agent-sdk-utils.ts
```
预期：第一条命中 1 处（约 :891）；后两条各命中 1 处（说明 `SkillToolAuthorization` 类型在 utils 已可用）。

### 红测（先写，先红）
新建 `src/__tests__/skill-doc-toolset-floor.test.ts`：
```ts
/**
 * P0-2 — 本地文档过滤器必须保留技能地板；收窄管线末端不得为空。
 * 母合同：2026-07-06 skill-envelope §4 T2/T3。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectedSkillFloorToolNames,
  recoverEmptyToolSurface,
  isLocalDocumentToolDefinition,
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

const def = (name: string, domain: string) => ({ name, domain }) as never

test('selectedSkillFloorToolNames returns primitives+typed actions for selected, empty for none', () => {
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_write_artifact', 'skill_export_artifact', 'skill_run_shell'],
    source: 'explicit',
    reason: 'test',
  })
  const floor = selectedSkillFloorToolNames(selected)
  assert.ok(floor.has('skill_read_artifact') && floor.has('skill_run_shell'))
  assert.equal(selectedSkillFloorToolNames({ mode: 'none', reason: 'no_skill_signal' }).size, 0)
})

test('local-document narrowing keeps skill floor members (D2 regression)', () => {
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_write_artifact'],
    source: 'explicit',
    reason: 'test',
  })
  const floor = selectedSkillFloorToolNames(selected)
  const surface = [def('skill_read_artifact', 'skill'), def('skill_write_artifact', 'skill'), def('browser_navigate', 'browser')]
  const narrowed = surface.filter(
    (d: { name: string }) => isLocalDocumentToolDefinition(d as never) || floor.has(d.name),
  )
  assert.deepEqual(narrowed.map((d: { name: string }) => d.name), ['skill_read_artifact', 'skill_write_artifact'])
})

test('recoverEmptyToolSurface restores pre-narrowing surface only when narrowed is empty', () => {
  const pre = [def('file_read_excerpt', 'file')]
  assert.deepEqual(recoverEmptyToolSurface([], pre), { definitions: pre, recovered: true })
  const kept = [def('skill_read_artifact', 'skill')]
  assert.deepEqual(recoverEmptyToolSurface(kept, pre), { definitions: kept, recovered: false })
  assert.deepEqual(recoverEmptyToolSurface([], []), { definitions: [], recovered: false })
})
```
先跑：`npx tsx --test src/__tests__/skill-doc-toolset-floor.test.ts > /tmp/p02red.log 2>&1; echo EXIT=$?` —— 预期非 0（函数还不存在）。
注：若 `buildSelectedSkillToolAuthorization` 的参数形状与上面不符（核验：`grep -n -A10 "export function buildSelectedSkillToolAuthorization" src/main/modules/agent-control/skills/skill-tool-authorization.ts`），按真实签名调整测试构造，断言不变。

### 实现
1. `agent-sdk-utils.ts` — 在 `authorizedPrimitiveToolNames` 函数定义的**紧后面**新增两个导出（不要动其他代码）：
```ts
/** P0-2 — 技能选中轮的地板工具名（typed actions ∪ primitives）；none 轮为空集。 */
export function selectedSkillFloorToolNames(authorization: SkillToolAuthorization): ReadonlySet<string> {
  if (authorization.mode !== 'selected') return new Set()
  return new Set([...authorization.allowedTypedActions, ...authorization.allowedPrimitives])
}

/** P0-2 — 收窄管线末端防空：窄化后为空且窄化前非空 → 回退窄化前全量面。 */
export function recoverEmptyToolSurface<T>(
  narrowed: readonly T[],
  preNarrowing: readonly T[],
): { definitions: readonly T[]; recovered: boolean } {
  if (narrowed.length === 0 && preNarrowing.length > 0) {
    return { definitions: preNarrowing, recovered: true }
  }
  return { definitions: narrowed, recovered: false }
}
```
2. `agent-sdk-turn-orchestrator.ts` 三处：
   a. import 区把 `selectedSkillFloorToolNames, recoverEmptyToolSurface` 加进已有的 agent-sdk-utils import 列表（按字母序插入）。
   b. 在 `let toolDefinitions = this.host.listToolDefinitionsForTurn({...})` 语句**结束后的下一行**（即 `if (shouldUseLocalDocumentToolSet(...)` 之前）插入：
```ts
      const preNarrowingToolDefinitions = toolDefinitions
```
   c. 把原两行过滤：
```ts
      if (shouldUseLocalDocumentToolSet(content as RunMessage, effectiveExecutionOptions?.requestEnvelope)) {
        toolDefinitions = toolDefinitions.filter(isLocalDocumentToolDefinition)
      }
```
   替换为：
```ts
      if (shouldUseLocalDocumentToolSet(content as RunMessage, effectiveExecutionOptions?.requestEnvelope)) {
        // P0-2(D2)：本地文档收窄不得吞掉技能选中轮的地板工具（否则 skill+doc 轮交集为空）。
        const skillFloor = selectedSkillFloorToolNames(authorization)
        toolDefinitions = toolDefinitions.filter((definition) =>
          isLocalDocumentToolDefinition(definition) || skillFloor.has(definition.name))
      }
```
   d. 在 `restoredToolSurface.missingToolNames.length > 0` 的 early-return 块（`return finalizeEarlyReturn({... 'blocked_tool_error' ...})`）**结束后的下一行**、`const hasVeaPipelineTool = ...` 之前插入：
```ts
      // P0-2(T2)：工具面非空不变量——多层收窄串联出空集时响亮回退，禁止零工具开跑。
      const surfaceRecovery = recoverEmptyToolSurface(toolDefinitions, preNarrowingToolDefinitions)
      if (surfaceRecovery.recovered) {
        appendToolCapabilityLog([
          '[tool_capability]',
          'stage=sdk_runtime_empty_surface_recovered',
          `restoredCount=${surfaceRecovery.definitions.length}`,
        ].join(' '))
        toolDefinitions = [...surfaceRecovery.definitions]
      }
```

### 验证
```bash
npx tsx --test src/__tests__/skill-doc-toolset-floor.test.ts > /tmp/p02a.log 2>&1; echo EXIT=$?
npx tsx --test src/__tests__/sdk-turnengine-capability-parity.test.ts > /tmp/p02b.log 2>&1; echo EXIT=$?
npm run typecheck > /tmp/p02c.log 2>&1; echo EXIT=$?
```
全部 `EXIT=0`。应提交文件清单：`agent-sdk-utils.ts`、`agent-sdk-turn-orchestrator.ts`、`skill-doc-toolset-floor.test.ts`。
```bash
git commit -m "fix(agent): local-document narrowing keeps skill floor and empty tool surface recovers"
```

## 4. 工单 P0-3：修 D3 — 技能轮保留文档读取地板

### 锚点核验
```bash
grep -n "function hasLocalDocumentResource" src/main/modules/agent-control/runtime-core/agent-sdk-utils.ts
grep -n "preserveToolName: preserveVisibleBrowserTool" src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts
```
预期：第一条命中 1 处（约 :1550，**无 export**）；第二条命中 1 处（约 :357）。

### 红测（先写，先红）
在 `src/__tests__/sdk-turnengine-capability-parity.test.ts` 中：找到名为
`SDK authorization keeps raw skill mention when attachment context strips ready-human-touch token`
的测试（约 :679 起），**完整复制**该测试块并粘贴其后，做三处修改：
1. 测试名改为 `explicit skill turn with local document attachment keeps document-read floor tools`。
2. 保持输入 fixture 不变（该 fixture 即真实失败轮：`@[*.md]` 附件块 + `@[ready-human-touch-ppt]`）。
3. 断言部分**追加**（保留原断言）：对 `listDefaultToolDefinitionsForTurn` 的结果工具名集合：
```ts
    const names = new Set(definitions.map((d) => d.name))
    assert.ok(names.has('file_read_excerpt'), 'doc-read floor: file_read_excerpt must survive skill narrowing')
    assert.ok(names.has('file_locate'), 'doc-read floor: file_locate must survive skill narrowing')
    assert.ok(names.has('skill_read_artifact') && names.has('skill_run_shell'), 'skill tools must stay')
```
（复制块内如果结果变量不叫 `definitions`，沿用该块原变量名。）
先跑确认新测试红：`npx tsx --test src/__tests__/sdk-turnengine-capability-parity.test.ts > /tmp/p03red.log 2>&1; echo EXIT=$?` 非 0，且失败点是新测试的 `file_read_excerpt` 断言。

### 实现
1. `agent-sdk-utils.ts`：
   a. 给 `hasLocalDocumentResource` 加 `export`（只加关键字，函数体不动）。
   b. 在 `selectedSkillFloorToolNames` 定义前新增：
```ts
/** P0-3(D3) — 技能选中轮的文档读取地板：本轮携带本地文档资源时这些工具不得被技能收窄丢弃。 */
export const LOCAL_DOCUMENT_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'file_locate',
  'file_read_excerpt',
  'document_read_section',
]
```
2. `agent-sdk-tool-executor.ts`：`if (activeSkillAllowedTools) {` 块内，把
```ts
      definitions = filterSelectedSkillToolSurface(definitions, activeSkillAllowedTools, {
        preserveToolName: preserveVisibleBrowserTool,
      })
```
改为：
```ts
      // P0-3(D3)：skill+本地文档同轮时，文档读取工具是地板，不随技能收窄丢弃。
      const preserveLocalDocumentFloor = hasLocalDocumentResource(params.message, params.requestEnvelope)
      definitions = filterSelectedSkillToolSurface(definitions, activeSkillAllowedTools, {
        preserveToolName: (name) =>
          preserveVisibleBrowserTool(name)
          || (preserveLocalDocumentFloor && LOCAL_DOCUMENT_FLOOR_TOOL_NAMES.includes(name)),
      })
```
并把 `hasLocalDocumentResource, LOCAL_DOCUMENT_FLOOR_TOOL_NAMES` 加进该文件既有的 agent-sdk-utils import。
注意：`createVisibleBrowserToolPreserver` 返回 `(name: string) => boolean`，直接组合即可。

### 验证
```bash
npx tsx --test src/__tests__/sdk-turnengine-capability-parity.test.ts > /tmp/p03a.log 2>&1; echo EXIT=$?
npx tsx --test src/__tests__/skill-doc-toolset-floor.test.ts > /tmp/p03b.log 2>&1; echo EXIT=$?
npm run typecheck > /tmp/p03c.log 2>&1; echo EXIT=$?
npx tsx --test src/__tests__/skill-tool-gating-by-session.test.ts src/__tests__/tool-policy-authorization.test.ts > /tmp/p03d.log 2>&1; echo EXIT=$?
```
全部 `EXIT=0`。提交：
```bash
git commit -m "fix(agent): preserve document-read floor tools on explicit skill turns"
```
已知边界（写进 commit body 或留言，不要求修）：P0 的地板是 preserve-if-present——`document_read_section` 仅在 document 组本就可见时被保留；硬地板（组不可见也强制注入）属 P1 T2。

## 5. 工单 P0-4：真机 dogfood（验收面，不可跳过）

1. `npm run dev` 启动 Ready。
2. 在 agent 对话输入（附一个真实 .md 文件 + 技能引用）：
   `使用@[ready-human-touch-ppt]根据@[<任一 md 文档>]生成一个人文感风格的 ppt，输出到同一目录`
3. 运行结束后核日志（macOS）：
```bash
grep "sdk_runtime_final_tools" "$TMPDIR/ready-tools.log" | tail -3
```
验收标准（三条全部满足才算过）：
   - 最后一行 `toolCount` ≥ 7 且 `tools=` 同时含 `skill_read_artifact`、`skill_run_shell`、`file_read_excerpt`；
   - 不出现 `stage=sdk_runtime_empty_surface_recovered`（出现=还有别的收窄路径在打架，报告并贴日志）；
   - agent 实际产出 HTML 文件到目标目录（`ls` 确认），对话中无"工具未开放"类措辞。
4. 把三条证据（日志行、`ls` 输出、对话截图/摘录）写进 closeout 留档。若第 3 步 agent 行为仍不完整但工具面正常，属 SKILL.md 工作流问题，单独报告，不回改本单代码。

## 6. 完成定义
四单全部 commit + P0-4 三证据留档 + `npm run test:parallel > /tmp/p0full.log 2>&1; echo EXIT=$?` 为 0（若基线本就有既知失败，报告差集而不是硬判）。
