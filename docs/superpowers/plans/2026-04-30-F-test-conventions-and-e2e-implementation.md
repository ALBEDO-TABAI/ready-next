---
name: F — 测试规约 + e2e 链路（根因 3 + O5 收口）
description: v3 路线 F 阶段实施计划。把根因 3（测试 helper 破坏生产 invariant 无机制告知 / 行为测试与结构测试无规约）与 O5（e2e 真子进程链路缺失）一次收口。建立 `__breaksInvariants` 显式标记、维护既有 `ready/no-source-grep-test` ESLint rule、补 `docs/superpowers/testing-conventions.md` 测试规约与首条 VEA opt-in e2e。
status: completed
enforce: true
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
---

# F — 测试规约 + e2e 链路（实施计划）

## W0 Reality Correction（2026-05-01）

W0 audit 已确认本计划原 §0.2 有两处事实过时，后续执行以本段覆盖旧文字：

- `ready/no-source-grep-test` 已存在并已在 `eslint.config.mjs` 中启用；F 不再新建同名 rule，只维护现有 rule 的 scope、豁免理由校验和 fixture 测试。
- source-grep 不是 8 个文件：原计划命令当前命中 9 个文件；现有 ESLint baseline 为 `142` 条 / `110` 个文件；现有 `eslint-disable-next-line ready/no-source-grep-test` 为 `46` 行 / `34` 个文件；`allow-source-grep` 当前为 0。
- F-Contract-6 改为 baseline 冻结 + 新测试零违例 + 1 条真实违例改写示例，不做全量三态清理。W0 初始 baseline 数记为 `N0=142`；W3 改写 1 条后，W5/W6 记录 `N_FINAL`。
- W3 文档必须 canonicalize 两种豁免形态：推荐 `// allow-source-grep: <product reason>`（W2 校验非空理由）；可接受 `// eslint-disable-next-line ready/no-source-grep-test -- <reason>`；禁止无理由豁免。E 阶段 `atomic-write.test.ts` 的 fsync 顺序源码检查保留不动。
- helper audit 真实命中 4 个生产 reset helper 与 3 个测试内 `setupRunner`；计划中提到的 `__resetSubAgentRegistryForTests` / `src/main/modules/agent-control/sub-agent-runner.ts` 在当前 worktree 不存在，不作为 W1 修改目标。
- D/E 已 land 且 `verify:e` 可用；F 固定链 `verify:e`。
- e2e 当前基建为 0；本机 `ffmpeg` / `ffprobe` / `yt-dlp` 可用。W4 e2e 验收是 child-run lifecycle 真链路深度，不是完整 VEA AI 分析。

## Final Record（2026-05-01）

- `HEAD`: `822ad056aeed357e802e22fd2b9de839a80bf484`
- Source-grep baseline: `N0=142 -> N_FINAL=142`（W3 改写了 `tool-loop-dedup.test.ts` 的历史 source-grep 示例，但该文件原本走 reviewed ESLint disable，不计入 baseline）。
- `npm run verify:f`: pass，退出码 0；末段 F gate 输出 `test:f:gates` 82 pass、`test:f:focus` 15 pass。
- `npm run verify:f:e2e`（无 `READY_E2E`）：pass，1 skipped。
- `READY_E2E=1 npm run verify:f:e2e`: pass，1 pass / 0 skipped / duration `4126.830542ms`；日志保存为 `docs/superpowers/plans/2026-04-30-F-vea-e2e.log`。
- W5 break gates: `f-phase-break-gates.test.mjs` 钉住删 `__breaksInvariants`、新增未标记 helper、新增 source-grep 测试、删除 `testing-conventions.md` 四类故意破坏。

> **范围**：把 `residual-debt` §1 根因 3 与 §3 O5 一次收口。这是 v3 §5.1 路线里"F — 测试规约 + e2e 链路"的全部内容。
>
> **F 完成 = 6 件事**：
> 1. **`__breaksInvariants` 标记**：测试 helper 破坏生产 invariant 时，必须显式 `export const __breaksInvariants: readonly string[]`；ESLint rule `ready/test-helper-must-declare-invariant-breach` 强制；缺标记的新 helper 进 PR 即被拒。
> 2. **`ready/no-source-grep-test` ESLint rule**：既有 rule 继续禁止 `__tests__/*.ts` 文件用 source-grep 伪装行为测试；F 维护 rule scope、豁免理由校验与 fixture 测试。既有 baseline 冻结，新增 0 条。
> 3. **测试规约文档化**：CLAUDE.md §6.17 新段落 + 独立 `docs/superpowers/testing-conventions.md`：行为测试模板 / 反模式清单 / e2e 适用边界 / helper invariant breach 规约。
> 4. **首条真子进程 e2e**：`src/__tests__/e2e/vea-happy-path.e2e.ts`，跑真 `SkillsRuntimeManager` + 真 VEA driver + 真 ffmpeg；yt-dlp 抓取用本地 mp4 fixture 替代；`READY_E2E=1` opt-in，默认 verify chain 不依赖。
> 5. **历史 helper 上 invariant 标记**：W0 audit 确认的 4 个生产 reset helper 与 3 个测试内 `setupRunner` 全部加显式 `__breaksInvariants` export，并把 Layer 1 加的 markdown banner 与之联动。
> 6. **历史 source-grep 冻结 + 示例改写**：冻结既有 `ready/no-source-grep-test` baseline；F 新写测试零 source-grep；从 baseline 里选 1 条非 `atomic-write.test.ts` 的简单违例改写为行为测试，作为 testing-conventions 文档例子。
>
> **不在 F 范围**：
> - O3 / O4 / O6 / O8 — E 已收口；
> - O7 child run UI 控制面 — 跟 UI 队走；
> - L2 history compaction 算法 — D 阶段 stub deferred；
> - `__breaksInvariants` 的 runtime metric 上报真实 telemetry 总线（CI fixture review）— F 仅做编译期/CI 可视化，不动 prod telemetry；
> - 全量 e2e 矩阵（多 driver / 多 OS / 多 ffmpeg 版本）— F 只立 1 条样板 e2e + harness，不展开矩阵。

---

## 0. Context

### 0.1 为什么现在做

A0 / A1 / B / C / D / E 把"agent 层结构 + 防爆"立完。剩下的两条债是**测试基建级**：

- **根因 3**：Layer 1 历史 A1 漏检的根源是测试 helper 破坏生产 invariant 但无机制告知；helper banner 是文档级修复，下个新写测试的人不读注释照样误用。
- **O5**：所有"看似 e2e"的测试都跑 fake driver / fake runtime / fake repository。任何 prod-only assumption（yt-dlp 真能找到 video / ffmpeg 输出 schema 真的对 / spawn 真的跨平台）破坏，单测全过、上线挂。

这两条在 A0/A1/B/C/D/E 完成后**不修就是给下一轮大改预埋陷阱**：下次 review 仍会被 source-grep 测试欺骗、下次大改仍会因为没有真 e2e 错过 prod-only 回归。

F 阶段还有一个隐含好处：A1 + B + E 的 `SkillChildSubAgent` / `ChildExecutionPermission` / `atomicWriteJson` 等抽象已就位，e2e harness 接进去成本极低（不必 mock 进程间通信细节，直接调框架即可）。

### 0.2 Reconnaissance Facts（已实地核查）

**根因 3.1（helper 破坏 invariant 无标记）**：

| Helper | 文件:行 | 破坏的 invariant | 当前标记 |
|---|---|---|---|
| `__resetSkillChildRunnerForTests` | `skill-child-runner.ts:1100` | 生产 singleton 永不 reset；测试 reset 会清 active/recentCloses cache | 仅 markdown banner（`skill-child-runner.test.ts:486-510` Layer 1 Team 4 加） |
| `setupRunner({ repo, maxActionsPerRun, ... })` | `skill-child-runner.test.ts:521`（约） | 调 `__resetSkillChildRunnerForTests` 同样清 singleton；mid-test 重置会掩盖 lifecycle 转换 bug | 同上 markdown banner |
| `__resetSubAgentRegistryForTests`（A1 阶段加） | `sub-agent-runner.ts` 类似位置 | SubAgent 注册表 singleton；生产从不重置 | 无标记 |
| 其他 `__reset*ForTests` | 待 W0 audit 全仓 grep | 同形态 | 无标记 |

**根因 3.2（source-grep 测试反模式）**：

```bash
$ grep -rln 'readFileSync.*\.ts\|readFileSync.*\.tsx' src/__tests__/
src/__tests__/skill-execution-tools-removed.test.ts
src/__tests__/before-quit-cleanup.test.ts
src/__tests__/database.test.ts
src/__tests__/tool-registry-skills-dynamic-resolution.test.ts
src/__tests__/tool-loop-dedup.test.ts
src/__tests__/chat-header-menu-style-contract.test.ts
src/__tests__/skill-python-runtime-contract.test.ts
src/__tests__/skill-session-cleanup-contract.test.ts
```

→ **8 个文件** 用 `readFileSync(*.ts)` + 后续断言。需要 W0 逐个分类：
- 可改写为行为测试（call 真 helper / mock 真依赖 → assert 真行为）：W0 给出迁移清单。
- 必须保留为结构断言（典型场景：验证某个 LLM-facing 工具确实从注册表里被删除、ESLint rule fixture 自身）：W0 给出豁免理由。

**注意**：`tool-internal-admission.test.ts` 在 `residual-debt §1 根因 3` 里被列为反模式样本，但实际现况已是真行为测试（grep `readFileSync\|assert.match` → 0 结果）。**F 不再 rewrite 该文件**；residual-debt 的描述对该文件已是历史。F 范围内只对仍在违规的 8 个文件做处理。

**O5 e2e 现状**：

```bash
$ ls src/__tests__/e2e/ 2>/dev/null
# (no such directory)

$ grep -rn "READY_E2E" src/ 2>/dev/null
# (no results)
```

→ **零 e2e 基建**。`skill-child-run-end-to-end.test.ts` 仅跑 contract 重建链路（`loadSkillRunContract`），不跑真子进程。

`SkillsRuntimeManager` / VEA driver / `skill_run_shell` 的真链路从未被任何测试覆盖。

**Verify chain 现状**（截至 2026-05-01 C 已 land）：

```
verify:a0  ←  a05  ←  a1  ←  b  ←  c
```

E 计划链 `verify:c`（D 已 land 时改链 `verify:d`）。F 链 `verify:e`。

**已有 ESLint factory pattern**（C 阶段建立）：

`eslint-rules/index.mjs:127` `createNoCoordinatorIdLeakRule()` 工厂；`eslint-rules/index.mjs:225` 注册。F 的两条新 rule 必须照同形态。

**已有 baseline 系统**：

`scripts/check-eslint-baseline.cjs` + `eslint-rules/baseline.json`。namespace key 已知格式：`<file>::<rule-id>`。F 引入两条新 rule 时把既有违例进 baseline。

### 0.3 与前序阶段的边界

| 阶段 | 是否阻塞 F | 备注 |
|---|---|---|
| A0 流程门 / 词汇 invariant | 必须 land | F 引用 baseline 系统 + plan-pairing hook |
| A1 SubAgent skeleton | 不直接依赖 | F 的 e2e 走 SubAgent 抽象作为入口，但若 e2e 取舍只覆盖旧 `SkillChildRunner` 入口也能成立 |
| B child runtime 迁移 | 推荐已 land | e2e 用 SubAgent 入口更干净；如未 land，F 用 `startSkillChildRun` 直接入口 |
| C Coordinator | 不直接依赖 | F 不动 Coordinator |
| D reminder/compaction/hooks | 不直接依赖 | F 不动 D 模块 |
| E 防爆减脆 | 不直接依赖 | e2e 顺带验证 E 的 lifecycle.json sidecar 写入；但 E 未 land 时 e2e 不断言 sidecar 存在 |

→ **F 完全可在 E 之后开工**，不需要 D/E 全部 land。最低门槛 = A0 + A1 + B + C land。

---

## 1. Hard Contracts（CI 必须可机器验证）

### F-Contract-1：每个破坏生产 invariant 的测试 helper 必须显式 `export const __breaksInvariants`

**形态**（helper 自身文件）：

```ts
export const __breaksInvariants: readonly string[] = [
  'singleton.skill-child-runner.never-reset-mid-session',
] as const

export function __resetSkillChildRunnerForTests(): void { ... }
```

**ESLint rule `ready/test-helper-must-declare-invariant-breach`**：

- 触发：函数名匹配 `/^__(reset|seed|stub|forceFlush|breakOpen)\w*ForTests?$/` 的 export。
- 同模块必须 export 一个 `__breaksInvariants` 常量，类型为 `readonly string[]` / `string[]`。
- 同模块若同时 `export const __noProductionInvariantBreach = true` 视为显式声明"无破坏"，豁免规则。
- 规则错误 messageId：`testHelperMustDeclareInvariantBreach`。

**CI 验证**：`eslint-rules/__tests__/test-helper-must-declare-invariant-breach.test.mjs`：

- it('flags __resetForTests export without __breaksInvariants in same module')
- it('passes when __breaksInvariants array is exported')
- it('passes when __noProductionInvariantBreach=true is exported')
- it('does not flag normal helpers (no __ prefix)')

### F-Contract-2：维护既有 source-grep 禁止规则

**ESLint rule `ready/no-source-grep-test`** 已存在并启用为 error。F 只维护它，不新建同名 rule：

- scope 必须覆盖 `src/__tests__/**/*.{ts,tsx}`。
- 触发模式继续覆盖同一文件内出现：
  - `readFileSync(<expr>)` 或 `fs.readFileSync(<expr>)`，且 expr 经常量传播后是 `*.ts` / `*.tsx` / `*.cjs` / `*.mjs` / `*.js` 路径。
  - **且**该模块在同一作用域内调用 `assert.match` / `RegExp.prototype.test` / `String.prototype.includes` 对 read 出来的内容做断言。
- 推荐豁免：`// allow-source-grep: <product reason>`，理由必填，空理由报 `allowSourceGrepMissingReason`。
- 可接受豁免：`// eslint-disable-next-line ready/no-source-grep-test -- <reason>`，保留 ESLint 标准形态；W2 不强制拒绝现有 disable 注释。
- baseline 冻结：W0 记录 `N0=142`，W5 用虚拟 area `no-source-grep-test` 锁最终 `N_FINAL`，新增 0 条。

**CI 验证**：`eslint-rules/__tests__/no-source-grep-test.test.mjs`：

- it('flags readFileSync of src/.ts + assert.match in same test file')
- it('passes when readFileSync is for fixture .json/.txt')
- it('respects allow-source-grep comment with reason')
- it('flags allow-source-grep without reason as allowSourceGrepMissingReason')
- it('does not break existing eslint-disable-next-line ready/no-source-grep-test form')

### F-Contract-3：测试规约成文 + CLAUDE.md 引用

新建 `docs/superpowers/testing-conventions.md`：至少包含 5 段：

1. **行为测试 vs 结构测试**：定义 / 何时各自正当 / 反模式清单。
2. **`__breaksInvariants` 协议**：助手要不要标记的判定流程图（破坏 singleton / mutation 全局 state / 绕过 admission ⇒ 必须标记）。
3. **e2e 测试边界**：什么是 e2e（真子进程 / 真依赖）、什么不是（contract 重建 / 多模块协作但仍走 fake）；e2e 何时必要、何时杀鸡用牛刀。
4. **fixture 提交规约**：mp4 / 大 JSON 等二进制 fixture 体积上限（< 2MB）、必须有 README 说明产生方式。
5. **测试运行模式表**：`npm test` / `npm run test:a0:focus` / `READY_E2E=1` / 各 `verify:*` 的覆盖范围与互斥。

CLAUDE.md 新增 §6.17 "测试规约"段落（5-8 行精简摘要 + 指针到 `docs/superpowers/testing-conventions.md`）。AGENTS.md 同步。

**CI 验证**：`scripts/check-testing-conventions-doc.cjs`（F 新建，简单存在性 + 关键 anchor 校验）：

- 文件存在
- 至少包含 anchor `## 行为测试 vs 结构测试` / `## __breaksInvariants 协议` / `## e2e 测试边界` / `## fixture 提交规约` / `## 测试运行模式表`
- CLAUDE.md 含 `### 6.17` 且包含 `testing-conventions.md` 字符串

### F-Contract-4：至少 1 条 opt-in 真子进程 e2e 跑通

新建 `src/__tests__/e2e/vea-happy-path.e2e.ts`：

- 调真 `SkillsRuntimeManager`（不 stub `runSkill`）。
- 调真 VEA driver（`video-expert-child-driver.ts` 真生成 plans）。
- 调真 `ffmpeg` / scenedetect 阶段，验证 fixture 输出物存在且 `size > 0`；如硬件不允许真 ffmpeg，e2e 测试 `skipIf(!hasFfmpeg)` 并打 `skipped` 标记。
- yt-dlp 不真跑：本地 fixture mp4 替代网络下载。
- 测试断言全部满足才算 pass：`startSkillChildRun` 返回 `status='running'`；`runtime.calls.length >= 1`；真 ffmpeg/scenedetect 输出物存在且非空；close event 在 timeout 内 delivered；plan 序列至少推进到 ffmpeg/scenedetect 阶段。
- `close.status` 本身不是 pass/fail 判据；AI 分析阶段不在 F e2e 范围内，可通过 fixture/runtime 注入短路。
- 关键：测试 **不** mock `tool-executor` / `tool-gateway` / `runtime-manager` / `child-runner`；禁止在 driver 里加 `if (TEST)` 或 env-gated `skipAIAnalysis` 分支。

**运行模式**：

```bash
READY_E2E=1 npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/e2e/*.e2e.ts
```

无 `READY_E2E` 环境变量时，e2e 文件以 `node:test` 的 `test.skip` 标记自身跳过；默认 `npm test` / `npm run verify:c` / `verify:d` / `verify:e` 不跑 e2e。

`package.json` 加 `verify:f:e2e` script（仅跑 e2e；CI 单独 job）。

**CI 验证**：

- `verify:f:e2e` 在 dev 环境跑通（W4 owner 在 audit 完成时给出截图 / log）。
- 默认 `verify:f` **不**跑 e2e，避免本地开发慢。
- e2e fixture mp4 < 2MB 且 commit 进 repo（W4 owner 提供产生命令记录在 `src/__tests__/e2e/fixtures/README.md`）。

### F-Contract-5：历史 helper 全部上 `__breaksInvariants` 标记

至少以下 W0 确认的 helper 必须加：

- `__resetSkillChildRunnerForTests`（`skill-child-runner.ts`）
- `__resetSkillChildDriversForTests`
- `__resetSessionContinuityForTests`
- `__resetBrowserRegistryForTests`
- 3 个测试内 `setupRunner` helper（`skill-child-runner.test.ts` / `skill-child-runner-resume-lifecycle.test.ts` / `skill-child-run-end-to-end.test.ts`）—— **测试模块自身**也算，文件层 export 即可。

W0 audit 给出全仓全部 helper 的清单。

**CI 验证**：`eslint-rules/__tests__/test-helper-must-declare-invariant-breach.test.mjs`（同 F-Contract-1）针对真实 helper 跑一次。

### F-Contract-6：source-grep baseline 冻结 + 1 条示例改写

F 不做全量历史债清理。W0 给出 `N0=142` 后，只做三件事：

- **Baseline 冻结**：`scripts/check-eslint-baseline.cjs --area no-source-grep-test --max <N_FINAL>`，新增即报错。
- **F 新测试零违例**：W3 / W4 / W5 新增测试不得 source-grep，不进 baseline，不打豁免注释。
- **示例改写**：W3 从 baseline 中选 1 条非 `atomic-write.test.ts` 的简单违例改写为行为测试，优先 `tool-loop-dedup.test.ts` 这类单点 source-grep。目的只是给 `testing-conventions.md` 提供"反模式 -> 行为测试"例子。

**CI 验证**：`scripts/check-eslint-baseline.cjs --area no-source-grep-test --max <N_FINAL>`。`N_FINAL = N0 - 示例改写实际移除条数`。

### F-Contract-7：A0/A1/B/C/D/E 不退化 + verify:f 绿灯

`verify:f` 内嵌 `verify:e`（如已 land）→ `verify:d` → `verify:c` → `verify:b`（含 a0/a05/a1）。任一退化则 F fail。

`verify:f` 跑两条新 ESLint rule 单元测试 + `check-testing-conventions-doc.cjs` + `check-eslint-baseline.cjs --area no-source-grep-test --max <N>` + 焦点测试。

**`verify:f` 不含 e2e**；`verify:f:e2e` 单独由 CI job 触发。

---

## 2. 架构决定（Architecture Decisions）

### D1. `__breaksInvariants` 是模块级 export，不是函数级 metadata

```ts
// src/main/modules/agent-control/skill-child-runner.ts
export const __breaksInvariants: readonly string[] = [
  'singleton.skill-child-runner.never-reset-mid-session',
] as const

export function __resetSkillChildRunnerForTests(): void { ... }
```

**理由**：

- 模块级 export 可被 ESLint 静态扫描 + TS 类型系统检查（`as const` 锁住）。
- 函数级 metadata（如 `Reflect.metadata`）需要装饰器，运行时反射，CI 验证成本高。
- 下游消费者：CI fixture review checkpoint **直接读模块**，不必 import + 调函数。
- `__breaksInvariants` 字符串本身**不规约语法**，但建议形如 `<scope>.<noun>.<rule>`（例：`singleton.skill-child-runner.never-reset-mid-session`），方便未来全仓 grep。

### D2. ESLint rule 走 C 已建立的 factory pattern

新增两条 rule：`ready/test-helper-must-declare-invariant-breach` 与 `ready/no-source-grep-test`，**严格照** `eslint-rules/index.mjs:127` 的 `createNoCoordinatorIdLeakRule()` 形态：

```ts
function createTestHelperMustDeclareInvariantBreachRule() { return { meta: ..., create(context) { ... } } }
function createNoSourceGrepTestRule() { return { ... } }

// rules object（line 225 区域）：
rules: {
  ...,
  'no-coordinator-id-leak': createNoCoordinatorIdLeakRule(),
  'test-helper-must-declare-invariant-breach': createTestHelperMustDeclareInvariantBreachRule(),
  'no-source-grep-test': createNoSourceGrepTestRule(),
}
```

`eslint.config.mjs` 追加两条 rule 配置，level 为 `'error'`。

### D3. e2e 测试 = opt-in，自旁路跳过

`src/__tests__/e2e/vea-happy-path.e2e.ts` 顶部：

```ts
import test from 'node:test'

const E2E_ENABLED = process.env.READY_E2E === '1'
if (!E2E_ENABLED) {
  test('e2e suite — vea happy path', { skip: 'set READY_E2E=1 to enable' }, () => {})
}
```

E2E 真测试内容用 `test('...', { skip: !E2E_ENABLED }, ...)` 包裹，或顶层 `if (E2E_ENABLED) { test(...) }`。

**理由**：

- 默认 verify chain 不跑 e2e，避免本地开发循环慢（VEA 跑完 30s+，CI 可接受，本地不可接受）。
- e2e 自旁路跳过比"在 CI YAML 里加 if"更稳：本地 `READY_E2E=1 npm test` 也能跑，不需要专门入口。

### D4. e2e fixture 体积与产生方式可追溯

`src/__tests__/e2e/fixtures/sample-video.mp4`（< 2MB，30s）+ `src/__tests__/e2e/fixtures/README.md`：

```
# E2E Fixtures

## sample-video.mp4
- 30s 黑屏视频，640x360，30fps，h264
- 产生命令：
  ffmpeg -f lavfi -i color=black:s=640x360:d=30 -c:v libx264 -pix_fmt yuv420p sample-video.mp4
- 用途：e2e VEA happy-path 替代 yt-dlp 下载
```

**理由**：

- README 让任何人能重新生成 fixture，避免"祖传 fixture 没人知道怎么来"。
- 体积 < 2MB 让 git clone 不痛。
- ffmpeg `-f lavfi` 合成纯黑视频不需任何素材授权。

### D5. 历史 source-grep 测试用 `// allow-source-grep` 注释豁免，不是 ESLint disable

```ts
// allow-source-grep: 验证 skill_executions 工具已从 LLM-facing 注册表全量删除（B Phase 4 退役合同）
const ipcHandler = readFileSync(...)
```

**理由**：

- `// eslint-disable-next-line ready/no-source-grep-test` 是技术豁免，没强制理由。
- `// allow-source-grep: <reason>` 是产品豁免，理由进代码、可被 review。
- 规则同时校验"豁免必须带非空理由"——空理由触发独立 messageId `allowSourceGrepMissingReason`。

### D6. helper banner 与 `__breaksInvariants` 联动

Layer 1 Team 4 在 `skill-child-runner.test.ts` 顶部加的 markdown banner（`line ~486-510`）保留，但**段尾必须** 补一段机器可读引用：

```
 * MACHINE-READABLE: see __breaksInvariants exported from
 * src/main/modules/agent-control/skill-child-runner.ts for the canonical list.
```

Banner 不再是"靠人读注释"——人读注释 + CI 强制双轨。

### D7. e2e 不进默认 verify chain；CI job 单独跑

`package.json`：

```json
{
  "scripts": {
    "verify:f": "...（不含 e2e）",
    "verify:f:e2e": "READY_E2E=1 npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/e2e/*.e2e.ts"
  }
}
```

CI 配置（GitHub Actions / 类似）单独 job：

```yaml
- name: e2e
  if: ${{ github.event.label.name == 'run-e2e' || github.ref == 'refs/heads/main' }}
  run: npm run verify:f:e2e
```

**理由**：

- 默认 PR CI 跑 `verify:f`（快、确定性高）。
- e2e job 仅在 main 推送或显式 label 触发；e2e flake 不阻塞日常 PR。
- 这是 trade-off：PR 上 e2e 不强制 = e2e 回归延后到 main。F 接受这个 trade-off；后续如发现 main 经常红，再讨论 PR-time e2e。

---

## 3. Worker 划分（7 队）

### W0 — Pre-flight Audit

**Owner**：general-purpose 1 人 / 0.5 天

**输出**：`docs/superpowers/plans/2026-04-30-F-pre-flight-audit-report.md`

**任务**：

1. **Helper 全仓清单**：
   - `grep -rn "^export function __\w\+ForTests\?\\b" src/main/` → 完整列表，每个 helper 给出"破坏哪些 invariant"判定（基于代码注释 / 函数名推断 + 同 PR 历史决策注释）。
   - 同时审 `src/__tests__/` 目录里的局部 helper（`setupRunner` / `makeFakeRuntime` / 类似），判定它们是否"破坏 production singleton" 或仅是"测试 fixture 工厂"。
   - 输出表：`helper file:line | 类型（reset/seed/stub/factory）| 是否破坏 invariant | 应加 __breaksInvariants 还是 __noProductionInvariantBreach`。

2. **Source-grep 8 个文件分类**：每个文件给出：
   - 它在断言什么？（"x 已被删除"、"y 调用 z"、"代码不含 RegExp Z"...）
   - 能否改写为行为测试？（要 stub 什么、要 import 什么）
   - 不能改写时的产品理由（必须留结构断言）
   - 输出表：`file | 当前断言性质 | 改写方案 | 推荐处置（rewrite / allow-source-grep / baseline）`。

3. **e2e 链路可行性勘探**：
   - `which ffmpeg && ffmpeg -version`（dev 环境）→ 列版本与是否可在 CI 装。
   - VEA driver 当前的 plan 序列里，第一个 stage（download）能否被 fixture mp4 替代？查 `video-expert-child-driver.ts` 的 plan 生成逻辑。
   - SkillsRuntimeManager 启动需要哪些 prerequisite（数据库 / runtime root 创建 / venv）？给出 e2e 启动序列伪代码。
   - 输出：`e2e harness 设计草案 + ffmpeg/yt-dlp/runtime 依赖清单`。

4. **D/E land 状态确认**：D 与 E 已 land 时 `verify:f` 链 `verify:e`，否则链 `verify:c` 或 `verify:d`。

5. **既有 Layer 1 banner 内容核对**：确保 W6 改造时不破坏原 banner 语义。

**完成判据**：报告 push，每节有可机器执行的下游产物（helper 表 / source-grep 处置表 / e2e 启动序列）。

**依赖**：无。

### W1 — F-Contract-1 + F-Contract-5：`__breaksInvariants` 标记 + ESLint rule

**Owner**：general-purpose 1 人 / 1 天

**目标文件**（修改）：

- `eslint-rules/index.mjs`：加 `createTestHelperMustDeclareInvariantBreachRule()` 工厂 + 注册（line 225 区域）。
- `eslint.config.mjs`：把新 rule 配置为 `'error'`，scope 限定为 `src/main/**/*.ts` + `src/__tests__/**/*.ts`。
- W0 audit 给出的全部 helper 文件加 `export const __breaksInvariants: readonly string[] = [...]`：至少
  - `src/main/modules/agent-control/skill-child-runner.ts`
  - `src/main/modules/agent-control/sub-agent-runner.ts`（如 A1 已 land）
  - `src/__tests__/skill-child-runner.test.ts`（局部 setupRunner，文件层 export 即可）
  - W0 列出的其它 helper 文件
- `src/__tests__/skill-child-runner.test.ts:486-510` 既有 banner 末尾追加 D6 的 MACHINE-READABLE 引用。

**目标文件**（新建）：

- `eslint-rules/__tests__/test-helper-must-declare-invariant-breach.test.mjs`：4 测试，按 F-Contract-1 §CI 验证。

**完成判据**：

- ESLint rule 测试 4 条全过。
- `npm run lint:check` 在所有已迁 helper 文件上 0 报错。
- 故意删除 `__breaksInvariants` export → lint 报错。

**依赖**：W0。

### W2 — F-Contract-2 + F-Contract-6：维护 `no-source-grep-test` rule + baseline 冻结

**Owner**：general-purpose 1 人 / 1.5 天

**目标文件**（修改）：

- `eslint-rules/index.mjs` / `eslint-rules/a0-rule-utils.mjs`：维护既有 `ready/no-source-grep-test`，补 `allow-source-grep` 非空理由校验；不要新建同名 rule。
- `eslint.config.mjs`：确认 rule 保持 `'error'`，scope 仍覆盖 `src/__tests__/**/*.{ts,tsx}`。
- `scripts/check-eslint-baseline.cjs`：新增虚拟 area `no-source-grep-test`，按 rule id 统计 `ready/no-source-grep-test` 当前 findings，不要求改写现有 `ui-history` area。
- `package.json` 的 `verify:f` 后续由 W5 加 `node scripts/check-eslint-baseline.cjs --area no-source-grep-test --max <N_FINAL>`。

**目标文件**（新建）：

- `eslint-rules/__tests__/no-source-grep-test.test.mjs` 或补现有 rule fixture：valid / invalid / `allow-source-grep` 有理由 / `allow-source-grep` 空理由 / 既有 ESLint disable 形态不破坏。

**完成判据**：

- ESLint rule fixture 全过。
- `node scripts/check-eslint-baseline.cjs --area no-source-grep-test --max 142` 通过。
- 新增一个 source-grep 测试文件会让 checker 或 lint 报错。

**依赖**：W0 audit 出处置表。可与 W1 / W3 并行。

### W3 — F-Contract-3：测试规约文档

**Owner**：general-purpose 1 人 / 0.5-1 天

**目标文件**（新建）：

- `docs/superpowers/testing-conventions.md`：5 段，按 F-Contract-3。
  - 行为测试 vs 结构测试（含**反模式**清单：source-grep / 仅类型断言 / mock 太多导致测了 mock 而非真函数）
  - `__breaksInvariants` 协议（含**判定流程图**：是否 reset 全局 state？是否绕过 admission？是否 mutate static singleton？任一是 → 必须标记）
  - e2e 测试边界（含**何时不要 e2e**：单元逻辑可证、契约可证、行为可 stub）
  - fixture 提交规约（< 2MB / 必须 README / 不准提交真用户数据）
  - 测试运行模式表（`npm test` / `test:a0:focus` / `verify:*` / `READY_E2E=1`）
- `scripts/check-testing-conventions-doc.cjs`：F-Contract-3 §CI 验证脚本。
- `scripts/__tests__/check-testing-conventions-doc.test.cjs`：脚本自身 3-4 测试。

**目标文件**（修改）：

- `CLAUDE.md`：新增 §6.17 测试规约（5-8 行精简摘要 + 指针）。
- `AGENTS.md`：同步 §6.17。

**完成判据**：

- `check-testing-conventions-doc.cjs` 通过。
- `CLAUDE.md` / `AGENTS.md` 同步完成。
- 文档至少有一个具体的"反模式 → 行为测试模板"对照例（建议用 W2 改写的某个真实文件作为示例）。

**依赖**：W0 audit。可与 W1 / W2 / W4 并行（不动代码）。

### W4 — F-Contract-4：真子进程 e2e harness + 首条 e2e

**Owner**：general-purpose 1 人 / 1.5-2 天

**目标文件**（新建）：

- `src/__tests__/e2e/vea-happy-path.e2e.ts`：按 D3 形态 opt-in 跳过 + 真链路调用。至少 1 个 it：
  - it('VEA e2e: startSkillChildRun penetrates real ffmpeg before AI mock short-circuit')
- `src/__tests__/e2e/fixtures/sample-video.mp4`：< 2MB，30s 黑屏视频。
- `src/__tests__/e2e/fixtures/README.md`：D4 形态。
- `src/__tests__/e2e/harness.ts`（如需要）：e2e 启动 SkillsRuntimeManager 的样板代码（`runtimeRoot` 走 `mkdtemp` 临时目录，跑完清理）。

**目标文件**（修改）：

- `package.json`：加 `verify:f:e2e` script。
- W0 audit 已确认不允许 driver `if (TEST)` 或 env-gated skip seam；W4 只能通过 fixture/runtime 注入把 AI stage 短路到测试边界之外。

**完成判据**：

- `READY_E2E=1 npm run verify:f:e2e` 在 W4 owner 的 dev 环境跑通（提供 log）。
- e2e 满足 5 条断言：launch running、`runtime.calls.length >= 1`、ffmpeg/scenedetect 输出非空、close delivered、plan 到达 ffmpeg/scenedetect。
- 不带 `READY_E2E` 时 `npm test` / `npm run verify:f` 不跑 e2e（自动跳过）。
- e2e fixture mp4 < 2MB（`du -h` 验证）。

**依赖**：W0 audit。可与 W1 / W2 / W3 并行（不冲突文件）。

### W5 — verify:f gate

**Owner**：general-purpose 1 人 / 0.5 天

**目标文件**（修改）：

- `package.json`：加 `verify:f` script + `test:f:gates` + `test:f:focus` 拆分。

**verify:f 内容**：

```
"verify:f": "npm run verify:e && node scripts/check-eslint-baseline.cjs --area no-source-grep-test --max 142 && node scripts/check-testing-conventions-doc.cjs && npm run test:f:gates && npm run test:f:focus",
"test:f:gates": "node --test eslint-rules/__tests__/*.test.mjs scripts/__tests__/*.test.cjs",
"test:f:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/tool-loop-dedup.test.ts",
"verify:f:e2e": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/e2e/*.e2e.ts"
```

如 D 未 land 改链 `verify:c`；如 E 未 land 改链 `verify:d`。

**完成判据**：

- `npm run verify:f` 主分支跑成功。
- 故意 break：删 `__breaksInvariants` / 加新 source-grep 文件 / 加新未标记 helper / 删 `testing-conventions.md` → CI 各报错。

**依赖**：W1-W4 全部 land。

### W6 — 路线图状态 + 文档收尾

**Owner**：general-purpose 0.5 人 / 0.5 天

**改动清单**：

1. 路线图 §5.1 把 F 行从工作量描述改为 `[x] completed YYYY-MM-DD`。
2. §5.1 加 G 准入 note：G 阶段开工要求 F 的 7 条 hard contract 全绿。
3. CLAUDE.md / AGENTS.md 已在 W3 完成 §6.17 加入；W6 仅校验 §0.5 战略原则段落是否需要追加（**不**修改原则本身，仅检查表述是否清晰）。
4. `docs/superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md` §1 根因 3 与 §3 O5 末尾追加状态段：`> **F 阶段已收口（YYYY-MM-DD）**：参 `2026-04-30-F-test-conventions-and-e2e-implementation.md`。`

**完成判据**：

- 路线图 / 残债文档同步完成。
- W5 已 land。

**依赖**：W5。

---

## 4. 团队依赖与执行顺序

```
W0 audit ─┬─→ W1 (helper invariant marker + ESLint rule 1)
          ├─→ W2 (no-source-grep ESLint rule + 8 文件整改)
          ├─→ W3 (testing-conventions.md + CLAUDE.md §6.17)
          └─→ W4 (e2e harness + vea-happy-path)
                                                      │
                                          W1 ∧ W2 ∧ W3 ∧ W4 ─→ W5 (verify:f gate) ─→ W6 (docs)
```

**串行段**：W0 → 任一 W1/W2/W3/W4；W5 等 W1-W4 全 land；W6 等 W5。
**并行段**：W1 / W2 / W3 / W4 全程并行（不冲突文件）。

---

## 5. 端到端验证

```bash
# 1. 类型 + lint baseline
npm run typecheck
npm run lint:check
node scripts/check-eslint-baseline.cjs

# 2. F 自有 lint + 文档校验 + 焦点测试
node scripts/check-eslint-baseline.cjs --area no-source-grep-test --max 142
node scripts/check-testing-conventions-doc.cjs
node --test eslint-rules/__tests__/test-helper-must-declare-invariant-breach.test.mjs
node --test eslint-rules/__tests__/a0-rules.test.mjs
node --test eslint-rules/__tests__/f-phase-break-gates.test.mjs

# 3. 不退化 gate
npm run verify:e   # 含 verify:d / verify:c / verify:b / verify:a*

# 4. 故意 break 检查（CI 应该挡住）
# - 在 src/main/modules/agent-control/skill-child-runner.ts 删 __breaksInvariants → ESLint 报
# - 加新 src/__tests__/foo.test.ts 内含 readFileSync('src/main/x.ts', 'utf8') + assert.match → ESLint 报
# - 加新 helper __resetXForTests 不带 __breaksInvariants → ESLint 报
# - 把 testing-conventions.md 删除 → check-testing-conventions-doc.cjs 报

# 5. 单独 e2e job（默认 PR 不跑）
READY_E2E=1 npm run verify:f:e2e

# 6. 手动 dev 烟测
# - npm test 不跑 e2e（grep "skip.*set READY_E2E" 在输出里找到跳过标记）
# - 把 e2e fixture mp4 删了 → e2e job 失败但其他 verify 不受影响
```

---

## 6. 关键文件路径速查

修改：

- `eslint-rules/index.mjs`（W1 + W2：两条新 rule 工厂 + 注册）
- `eslint.config.mjs`（W1 + W2：两条 rule 配置为 `'error'`）
- `eslint-rules/baseline.json`（W2：新增 `no-source-grep-test` namespace）
- `src/main/modules/agent-control/skill-child-runner.ts`（W1：加 `__breaksInvariants` export）
- `src/main/modules/agent-control/sub-agent-runner.ts`（W1：加 `__breaksInvariants` export）
- `src/__tests__/skill-child-runner.test.ts`（W1：banner 段尾追加 MACHINE-READABLE 引用 + 局部 helper marker）
- 8 个 source-grep 测试文件（W2：rewrite / 加豁免注释 / 进 baseline）
- W0 audit 给出的其它 helper 文件（W1）
- `package.json`（W2：`verify:f` 含 baseline area；W4：`verify:f:e2e`；W5：`test:f:gates` / `test:f:focus`）
- `CLAUDE.md`（W3：§6.17）
- `AGENTS.md`（W3：§6.17）
- `docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` 路线图（W6）
- `docs/superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md`（W6：根因 3 / O5 末尾追加完成 note）

新建：

- `docs/superpowers/testing-conventions.md`（W3）
- `docs/superpowers/plans/2026-04-30-F-pre-flight-audit-report.md`（W0）
- `eslint-rules/__tests__/test-helper-must-declare-invariant-breach.test.mjs`（W1）
- `eslint-rules/__tests__/no-source-grep-test.test.mjs`（W2）
- `scripts/check-testing-conventions-doc.cjs`（W3）
- `scripts/__tests__/check-testing-conventions-doc.test.cjs`（W3）
- `src/__tests__/e2e/vea-happy-path.e2e.ts`（W4）
- `src/__tests__/e2e/fixtures/sample-video.mp4`（W4，< 2MB）
- `src/__tests__/e2e/fixtures/README.md`（W4）
- `src/__tests__/e2e/harness.ts`（W4，如需）

---

## 7. 显式 out-of-scope

不在 F 范围，留给 G / 后续 follow-up：

- **e2e 矩阵展开**：多 driver / 多 OS / 多 ffmpeg 版本 / 多 Node 版本 — F 只立 1 条样板。
- **真 yt-dlp 网络拉取**：F 用 fixture mp4 替代；真 yt-dlp 测试需要稳定外部 video 源，不可控，留给独立运维测试。
- **e2e PR-time 强制**：F 把 e2e 放 main / label 触发；PR-time 强制 e2e 是后续讨论。
- **`__breaksInvariants` 的真 telemetry 总线上报**：F 仅做编译期 / CI 静态校验；运行期收集 helper 调用 metric 留给 G。
- **Layer 1 N1-N4 残余测试空白**（如 N4 flag 中途切换的测试空白）— F 不收，归入 G 提质。
- **测试数据隐私 / 用户数据剥离规约**：fixture 规约只规定体积与可重现性，不涉及 PII / 数据合规；如需，独立 PR。
- **CI 时长优化**：W4 e2e 跑 30s+，未来 e2e 矩阵展开时需考虑并行 / 缓存；F 不做。

---

## 8. 风险与缓解

### 8.1 ESLint rule 误判已有 helper

**风险**：W1 的 `test-helper-must-declare-invariant-breach` 规则匹配模式 `^__\w+ForTests?$` 太宽，可能把不破坏 invariant 的 utility helper 也判定为 "需要标记"。

**缓解**：

- 提供 `__noProductionInvariantBreach = true` 显式逃生口（D1 已规约）。
- W0 audit 阶段先全量 grep + 人工分类，确保规则 land 后只有"应该标"的 helper 触发。
- ESLint rule 的 messageId 在错误信息里包含 doc link 到 `testing-conventions.md` §`__breaksInvariants 协议`，让首次踩坑的开发者立即看到判定流程图。

### 8.2 W2 rewrite 8 个文件引入回归

**风险**：把 source-grep 测试改为行为测试时，新版本因为 stub 不准 / 语义偏差导致原本能抓到的 bug 抓不到。

**缓解**：

- W0 audit 给每个文件明确"它在断言什么"。W2 rewrite 必须在新版本里**保留同一断言意图**，仅改实现手段。
- W2 owner 完成 rewrite 后跑全量 `npm test` 确认其它测试不受影响。
- 若某个文件 rewrite 后行为等价度存疑，W2 改用"加 `// allow-source-grep` 豁免"或进 baseline，**不**强行 rewrite。
- F-Contract-6 三态分类（rewrite / allow-source-grep / baseline）明确允许"先 baseline 后续再改"，避免 W2 owner 时间压力下做错决策。

### 8.3 e2e fixture 在 CI 装不上 ffmpeg

**风险**：CI 镜像不带 ffmpeg，W4 的 e2e 在 CI job 必然失败。

**缓解**：

- W0 audit 阶段先确认 dev 与 CI 镜像的 ffmpeg 可用性。
- 如 CI 无 ffmpeg，W4 owner 在 e2e 测试顶部加 `skipIf(!hasFfmpegInPath)` 保护；CI job 显示 skipped 但不红。
- 长期：CI 镜像加 `apt-get install ffmpeg` 步骤；F 不做这一步，留给运维。

### 8.4 e2e 跑得慢拖累 main 分支 CI

**风险**：每次 main push 跑 e2e（30s-60s+），并发多 PR 合 main 时 CI 队列拥堵。

**缓解**：

- W4 e2e 仅 1 条 happy-path（一次 `< 60s` 完成）。
- e2e job 只在 main push / `run-e2e` label 触发；普通 PR 不跑。
- 长期 e2e 矩阵展开时再讨论缓存 / 并行。

### 8.5 W3 文档与 CLAUDE.md 不同步

**风险**：W3 写了 `testing-conventions.md` 但忘了同步 CLAUDE.md / AGENTS.md。

**缓解**：

- `scripts/check-testing-conventions-doc.cjs` 同时校验 CLAUDE.md 含 §6.17 anchor + `testing-conventions.md` 字符串。
- W3 完成判据明确要求"CLAUDE.md / AGENTS.md 同步完成"，W6 收尾再 cross-check 一次。

### 8.6 helper 大量加 `__breaksInvariants` 引入误标

**风险**：W1 owner 为了让 lint 通过，把不破坏 invariant 的 helper 也标了。

**缓解**：

- W0 audit 给出"应该标 vs 不应该标"的明确清单，W1 owner 严格按表执行。
- `__breaksInvariants` 数组**禁止为空**（空数组语义未定义）；规则同时校验"如果声明了 `__breaksInvariants` 则数组长度 > 0；如要表达'无破坏'则用 `__noProductionInvariantBreach = true`"。
- W6 收尾 audit 一次：每个 `__breaksInvariants` 字符串能否回到代码里找到对应 invariant？找不到的 → ESCALATE，不是补充就是删除。

---

## 9. 与战略原则的对照

`CLAUDE.md §0.5` 5 条 + 升维 2 条原则在 F 的应用：

1. **先合同，后代码**：§1 给 7 条 hard contract，每条都有 CI 可机器验证手段（ESLint rule / cjs 脚本 / baseline）。
2. **修根因，不修症状**：F 不"再加一个 helper banner / 再 rewrite 一个测试" —— 而是建机器执行的标记机制 + lint rule，**让根因 3 不可能再以同形态复发**。
3. **拒绝 legacy 兼容分支**：F-Contract-6 的三态分类里"baseline" 是过渡，不是终态；baseline 不允许增加（hard rule），且 W6 在路线图末尾留 follow-up note 跟踪 baseline 减少。
4. **形态意识**：CC-Source 没有"测试规约"是因为**测试在私有 repo**，规约靠 code review；Ready 测试在公开 monorepo + 多 agent 协作，必须把规约变成 CI 强制。**这是根因 3 真正的形态差异点**。
5. **CI 强制 > 文档约束 > 人审**：F 全部 7 条都 CI 强制；`testing-conventions.md` 是辅助查阅，不是 enforcement。
6. **抽象的边界 = 形态的差异**：`__breaksInvariants` 边界 = "破坏生产 invariant 的 helper" / 普通 utility helper 的差异；`no-source-grep-test` 边界 = 行为测试 / 结构测试 的差异；e2e 边界 = 真子进程 / fake-driver 的差异。三个新抽象各有清晰的形态对照。
7. **重新做一遍优于继续打磨**：F **不**继续在 helper banner 上"再加一段说明"；改成 `__breaksInvariants` 显式 export + ESLint rule。Banner 保留作为人读补充，但 enforcement 路径换了。

---

## 10. 文档维护

- F 完成后更新路线图 §5.1（W6）。
- 如 W0 audit 发现 §0.2 表数字与现实不符（例如 source-grep 文件数 != 8、helper 数 != 3），**优先**修计划，不就地"算了"。
- W0 audit 报告产出后，如发现更多债（不在根因 3 / O5 范围），列入"F 后续 follow-up"段落，**不**塞进本计划。
- `testing-conventions.md` 是活文档：每次发现新反模式 / 新 helper 类别时追加一节；不修改既有判定流程图，避免下游测试规约判断漂移。

---

## 11. 与 G 阶段的衔接

G 阶段（v3 §5.1 末段）= 提质（剩余 N1-N4 + O7）。F 完成后 G 准入：

- F 7 条 hard contract 全绿（`verify:f` 通过）。
- `testing-conventions.md` 已 land + CLAUDE.md §6.17 同步。
- e2e harness 已建（即使 G 不直接用，也是 G 任何"用户控制面"测试的备选）。

G 范围内的 N4（flag 中途切换的测试空白）正是 F 建立的"行为测试 + 助手规约"的下游消费者：N4 修复时必须按 `testing-conventions.md` 行为测试模板写。
