---
status: done 2026-07-07 — 五单全部收口（typed refs / floors 进裁决面 / controller parity / gate + 指引同步）；对抗性审查修复循环通过。本篇为 P1 执行书（P0 四单全部收口后才可开工）
revision_history:
  - v1 (2026-07-07): 初稿。母合同 §4 T1/T2/T3；把 P0 的临时 preserve/守卫收编成结构化地板。
owner: 白
author: Claude (Opus 4.8)
executor: 任意 coding agent——严格按工单执行
reviewer: 白 / Codex
enforce: false
note: >
  P1 交付"权限由代码承担"的机制版本：显式引用类型化进 envelope、地板在唯一裁决面计算、
  正则文本匹配降级为兜底并可观测。执行者铁律与 P0 执行书 §0 完全相同（锚点核验/手术式/
  禁改清单/EXIT=$? 纪律/红测先行/单单一 commit），此处不再重复但同样生效。
  行号会因 P0 落地而漂移——本篇一律用 grep 锚点，不给行号。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P1 执行书：类型化显式引用 + 能力地板进唯一裁决面

## 1. 工单 P1-1：envelope 增加 `skill_reference` 资源类型

### 锚点核验
```bash
grep -n "RequestEnvelopeResourceKind" src/main/modules/agent-control/contracts/request-envelope.ts | head -3
grep -n "export function buildRequestEnvelope" src/main/modules/agent-control/contracts/request-envelope.ts
grep -rn "buildRequestEnvelope(" src/main --include='*.ts' | grep -v "contracts/request-envelope" | head
```
第三条输出即调用方清单（预期 1~3 处），记下来——P1-1 只改 envelope 构造，不改调用方签名。

### 合同
- `RequestEnvelopeResourceKind` 联合新增 `'skill_reference'`；`source` 复用 `'explicit_reference'`。
- `buildRequestEnvelope` 在解析资源时：raw 用户文本里每个 `@[token]`，若**没有**被解析成任何既有资源
  （attachment/document/folder/widget/browser…），则产出一条
  `{ kind: 'skill_reference', source: 'explicit_reference', name: token, path: null, text: '', canRead: false, canWrite: false, ... }`。
  envelope **不做**技能存在性校验（envelope 保持哑数据；校验在授权层）。token 提取正则与
  `agent-sdk-utils.ts` 现有 mention 语法一致：`/@\[([^\]]+)\]/g`。
- 已有资源解析路径一行不改；新逻辑只允许在"其余 token 收尾"处追加。

### 红测
在 `src/__tests__/` 找 request-envelope 既有测试（`grep -rln "buildRequestEnvelope" src/__tests__`；若无则新建 `request-envelope-skill-reference.test.ts`）。用真实失败轮输入断言：
1. `@[ready-human-touch-ppt]` + `@[xx.md]`（xx.md 走附件路径）→ resources 恰好含一条 `kind==='skill_reference' && name==='ready-human-touch-ppt'`，且 .md 仍是原 kind。
2. 无 mention 文本 → 不产生 skill_reference。
3. `@[普通文件.md]` 已被解析为 attachment → 不重复产生 skill_reference。

### 验证与提交
焦点测试 + `npm run typecheck` 全 `EXIT=0`。
`git commit -m "feat(agent): carry explicit skill mentions as typed envelope resources"`

## 2. 工单 P1-2：授权优先消费 typed refs，正则降兜底

### 锚点核验
```bash
grep -n "resolveSkillAuthorizationForTurn" src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts | head -3
grep -n "skillAuthorizationTextCandidates" src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts
```

### 合同
在 `resolveSkillAuthorizationForTurn` 内，**先于**文本候选循环：
1. 从 `requestEnvelope` 读 `resources.filter(r => r.kind === 'skill_reference')`；对每个 name 调
   `this.skillContextOrchestrator.findExplicitlyRequestedSkills('@[' + name + ']')`（保持与现匹配语义同构）。
2. 命中 → 直接走现有 selected 构造路径（`buildPreferredSkillToolNames` + `allowedPrimitiveToolsForSdkSkillTurn` + `buildSelectedSkillToolAuthorization`），`reason` 前缀加 `typed_ref:`。
3. 未命中或 envelope 无该类资源 → 落入现有文本候选逻辑（一行不改），且在授权决策日志（若该函数已有 append 日志则追加字段，否则新增一行 `[skill_authorization] source=text_fallback`）标记兜底路径被使用。
4. **最小传话铁律不受影响**：typed ref 只用于授权判定，不改任何转发文本。

### 红测
扩展 `sdk-turnengine-capability-parity.test.ts`：
1. envelope 带 `skill_reference` 资源、rawUserText **不含** mention（模拟未来 renderer 只传结构化）→ `mode==='selected'`，`reason` 以 `typed_ref:` 开头。
2. envelope 无 skill_reference、rawUserText 含 mention（存量路径）→ 仍 `selected`（回归保护）。
3. skill_reference 指向不存在技能 → `mode==='none'`（不因 typed ref 放水）。

### 提交
`git commit -m "feat(agent): skill authorization consumes typed envelope refs before text heuristics"`

## 3. 工单 P1-3：地板模块 + 裁决面集成 + 不变量

### 锚点核验
```bash
ls src/main/modules/agent-control/domain-adapters/ | grep -E "run-capability-controller|execution-intent"
grep -n "LOCAL_DOCUMENT_FLOOR_TOOL_NAMES\|selectedSkillFloorToolNames" src/main/modules/agent-control/runtime-core/*.ts
```
第二条应显示 P0 落的临时地板（executor 的 preserve + orchestrator 的 skillFloor）——本单把它们收编。

### 合同
1. 新文件 `src/main/modules/agent-control/domain-adapters/capability-floors.ts`：
```ts
export interface CapabilityFloors {
  readonly toolNames: ReadonlySet<string>
  readonly reasons: ReadonlyArray<string>   // 如 'skill_selected:ready-human-touch-ppt' / 'local_document_resource'
}
export function computeCapabilityFloors(params: {
  authorization: SkillToolAuthorization
  hasLocalDocumentResource: boolean
  hasCurrentDocumentContext: boolean
}): CapabilityFloors
```
   语义：selected 授权 → 并入 typed actions ∪ primitives（即 P0 的 `selectedSkillFloorToolNames`）；
   `hasLocalDocumentResource` → 并入 `['file_locate','file_read_excerpt']`；
   `hasCurrentDocumentContext` → 再并入 `'document_read_section'`。纯函数、零 IO、全量单测。
2. `listDefaultToolDefinitionsForTurn`（agent-sdk-tool-executor.ts）：
   - 开头计算一次 `floors`；
   - **硬地板**：函数 return 前，若 floors 中某工具名不在 definitions 里但存在于全量注册表
     （`defaultToolRegistry` 已在该文件使用，用它按名取定义；取不到则跳过并记 reason），把它补回；
   - P0-3 的 `preserveLocalDocumentFloor` 临时组合谓词改为 `floors.toolNames.has(name)`（行为超集，测试不许回退）。
3. orchestrator 末端（P0-2 守卫处）升级为**不变量断言**：
   - `surface ⊇ floors`（缺失 → `appendToolCapabilityLog('[tool_capability] stage=tool_surface_floor_violation missing=...')` 并把缺失定义补回）；
   - 空面守卫保留；
   - `sdk_runtime_final_tools` 日志行追加 `floors=<逗号分隔>|none` 字段。
4. **循环依赖警戒**：capability-floors.ts 只 import 类型（SkillToolAuthorization）；不得 import runtime-manager/tool-registry。若 executor→domain-adapters 方向 import 报环，把纯函数移至 `agent-control/contracts/capability-floors.ts`（同名导出），并在本单报告里注明。

### 红测
1. `capability-floors.test.ts`：三输入正交矩阵（selected×doc×docContext = 8 case）断言并集正确、none 轮无 skill 项。
2. parity 测试加硬地板 case：构造 document 组被 intent 压制的输入 + selected skill + 本地文档资源 → 结果含 `file_read_excerpt`（P0 的 preserve-if-present 做不到这条，本单必须做到）。
3. floor-violation 日志路径：人为传入会掏空地板的过滤序列（单测直接调 orchestrator 用的导出助手），断言补回+日志。

### 提交
`git commit -m "feat(agent): capability floors computed at arbitration surface with invariant enforcement"`

## 4. 工单 P1-4：resolveRunCapabilities 侧 parity

### 锚点核验
```bash
grep -n "resolveRunCapabilities\|resolveActiveSkillAllowedTools" src/main/modules/agent-control/domain-adapters/run-capability-controller.ts | head
grep -rn "P6e" src/__tests__/sdk-turnengine-capability-parity.test.ts | head -3
```

### 合同
`resolveRunCapabilities` 产出的 `toolPolicy` 增加 `capabilityFloors`（复用 computeCapabilityFloors），
`getPolicyOpenAIToolBundle`/`getPolicyAnthropicTools` 的 `filterToolsByAllowedTools` 应用处保证地板不被滤除。
按 P6e 惯例在 parity 测试中锁两条路径同构（同输入 → 同 floors）。CLAUDE.md §4 "resolveRunCapabilities 是唯一裁决点"的表述保持为真——floors 的**权威计算点**在此，SDK 路径消费同一函数。

### 提交
`git commit -m "feat(agent): run-capability-controller applies the same capability floors (parity)"`

## 5. 工单 P1-5：gate 扩展 + 指引同步

1. 读 `scripts/check-capability-gate-enforced-in-arbitration.cjs` 现有断言风格，追加一条存在性断言：
   `run-capability-controller.ts` 与 `agent-sdk-tool-executor.ts` 都必须出现 `computeCapabilityFloors(` 调用；缺失即 gate 红。跑 `node scripts/check-capability-gate-enforced-in-arbitration.cjs > /tmp/p15.log 2>&1; echo EXIT=$?`。
2. `CLAUDE.md` §2 追加硬约束条目（`AGENTS.md` 同次同文）：
   > 工具信封地板：显式技能引用/本地文档资源产生代码级能力地板（`capability-floors.ts`），一切收窄过滤只做减法且不得移除地板项；管线末端强制 `surface ⊇ floors ∧ surface ≠ ∅`，违反必须落 `tool_surface_floor_violation`/`empty_surface_recovered` 可观测日志。权限判定禁止依赖对用户原文的正则猜测，typed envelope refs 为第一信源。
3. 本篇与母合同 status 更新（P1 段标记 done + 日期）。

### 提交
`git commit -m "chore(agent): floors arbitration gate + guideline sync"`

## 6. 完成定义
- 五单全部 commit；`npx tsx --test` 焦点集（parity + capability-floors + skill-doc-toolset-floor + run-capability-controller*.test.ts + capability-gate-arbitration.test.ts）与 `npm run typecheck` 全 `EXIT=0`；
- 三个 capability gate 脚本（arbitration / conservative-default / ask-user-not-in-skill-authorization）全 `EXIT=0`；
- 真机复跑 P0-4 场景：`sdk_runtime_final_tools` 行出现 `floors=` 字段且无 violation/recovered 日志。
