# 阶段一 Checkpoint & Handoff（13/13 完成）

> 分支：`agent-evolution/phase1`（base：`codex/electron42-html-canvas`）
> 日期：2026-06-11
> 合同：`docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md`（approved v2.2, enforce）
> 状态：**全部 13 单完成**。剩余 4 单（I3-1 → T4-2 → I3-2 → G1）已于同日完成并提交；回归入口 `npm run verify:evolution-p1`；状态回填见 `08-缺陷解决映射与验收追踪.md` §3.5。本文档其余部分保留为 9/13 时点的 checkpoint 记录。

---

## 1. 已完成工单汇总

| 工单 | 主要新增/改动文件 | 焦点验证命令 | 结果 |
|------|------|------|------|
| X4 注入账单 | `agent-control/context-bill.ts`(新) · `prompt-assembly.ts`(接线) | `tsx --test src/__tests__/context-bill.test.ts` | 5 pass |
| X1a 任务索引 | `agent-control/session/daily-task-index-builder.ts`(新) · `prompt-assembly.ts`(loadL1) · `runtime-core/runtime.ts`(dep) | `tsx --test src/__tests__/daily-task-index.test.ts` | 7 pass |
| X3 资产 loader | `agent-control/prompt-assets/loader.ts`+`roots.ts`(新) · `assets/prompts/**` · `electron-builder.yml` | `tsx --test src/__tests__/prompt-asset-loader.test.ts` | 9 pass |
| T4-1 信封映射 | `tools/tool-result-envelope.ts`(新，纯映射未接线) | `tsx --test src/__tests__/tool-envelope-mapping.test.ts` | 5 pass |
| K1 信念卡存储 | `agent-control/knowledge/belief-card-store.ts`(新) · `tools/memory-tools.ts`+`schemas/memory-schemas.ts`(工具) · `runtime.ts`(accessor) · golden snapshot 放宽 | `tsx --test src/__tests__/belief-card-store.test.ts src/__tests__/memory-card-tools.test.ts src/__tests__/memory-zod-golden-snapshot.test.ts` | 25 pass |
| T5 ready-debug | `.claude/skills/ready-debug/SKILL.md`+`README.md`(纯文档) | 人工演练 + `npm run native:check` (ABI 146) | OK |
| K2 DB 镜像 | `migrations.ts`(052) · `knowledge/belief-card-mirror.ts`(新) · `belief-card-store.ts`(listAllCardFiles) | `tsx --test src/__tests__/migration-belief-columns.test.ts src/__tests__/belief-card-db-sync.test.ts` + `verify:native` | 4 pass(+1 ABI-skip) |
| B2a fragment 内联（合同修正） | `domain-adapters/domain-adapter.ts`(ref.text) · `prompt-assembly.ts`(resolveFragmentRefBody) | `tsx --test src/__tests__/fragment-inline-asset-ref.test.ts` | 4 pass |
| B2 浏览器纪律 | `domain-adapters/browser-discipline-asset.ts`(新) · `browser-domain-adapter.ts`(fragment) · `assets/prompts/browser/discipline.md` · `direct-chat.ts` | `tsx --test src/__tests__/browser-discipline-injection.test.ts` | 4 pass |
| B3 站点知识卡 | `knowledge/site-card-reader.ts`+`domain-adapters/site-card-fragments.ts`(新) · `browser-domain-adapter.ts`(fragment) · `assets/site-cards/**` · `direct-chat.ts` · `electron-builder.yml` | `tsx --test src/__tests__/site-card-alignment.test.ts` | 5 pass |

提交：`641533e0`(X4) `ae784d1e`(X1a) `dc243e9c`(T4-1) `06d01891`(X3) `57e1a490`(K1) `ea0bb745`(T5) `5680745c`(K2) `de08b741`(B2a/B2) `bebb0181`(B3)，前置 `93de9c1e`(设计+合同)。

## 2. 工作区洁净度确认

`git status` 干净（无未提交改动）。全分支 diff = +4637 / -18，**18 处删除全部为 in-scope 编辑**：
- `memory-zod-golden-snapshot.test.ts` (-12)：golden 锁改为"按名锁 legacy 4"（K1）。
- `domain-adapter.ts` (-1)：ref `path: string → string|null`（B2a）。
- `prompt-assembly.ts` (-3)：`readMemoryFile → resolveFragmentRefBody`、TriggerDefinition 类型、L1 section 顺序（X1a/B2a）。
- `browser-domain-adapter.ts` (-1) / `direct-chat.ts` (-1)：构造函数签名/调用行（B2/B3）。

**无任何无关模块改动**（无 UI、无随手重构、无越界文件）。

## 3. Checkpoint 验证结果（全绿）

- 焦点测试（12 文件）：`58 tests, 57 pass, 0 fail, 1 skipped`（skip = `migration-belief-columns` 的 `skipIfSqliteUnavailable` ABI 声明守卫，既有惯例，非失败）。
- `npm run typecheck`：CLEAN（node + web）。
- `npm run verify:native`：OK（rebuild + `[native:check] OK Electron 42.3.0 Node 24.15.0 ABI 146`）。
- `check-migration-numbering-sequential`：OK（52 migrations, 1–52）。
- `check-migration-fresh-upgrade-idempotent`：OK。

## 4. 剩余 4 单 Handoff

> 顺序固定：**I3-1 → T4-2 → I3-2 → G1**。I3 与 T4 共享 `tool-executor.ts`，全局串行。每单：先红测试 → 实现 → 焦点验证 → typecheck；**I3-2 额外必须跑 `verify:native`**（含迁移）。每单单独收口，G1 最后统一接 `verify:evolution-p1`、`verify:native`、`typecheck`、`test`。

### 已勘探的 HEAD 入口（直接可用）

- **工具分发闸门**：`src/main/modules/tools/tool-executor.ts` —— `executeToolUseAction`/dispatch 路径；authorization 检查后是闸门插入点。错误体系在 `tools/tool-errors.ts`（`ToolDomainError`/`errorKindFor`）。
- **工具结果结构**：`agent-control/tools-runtime/tool-result-types.ts` 的 `ToolExecutionOutput`（全域共用；T4-2 加可选 `envelope` 字段，旧 `text/data/errorKind` 零改）。信封映射已就绪：`tools/tool-result-envelope.ts`（T4-1，`mapErrorKindToEnvelopeKind`/`buildOkEnvelope`/`buildErrorEnvelope`）。
- **意图分类（已含 negations）**：`shared/agent-followup-intent.ts` 的 `classifyFollowupIntent`（S4-1 已合入，含"不要/别/先不/不用"否定）；`agent-sdk-runtime.ts` 已消费 `negations.includes('collection')`。
- **迁移模式**：`migrations.ts` 末尾追加（当前最后 = `052_belief_card_mirror_columns`，下一个 053）；幂等用 `PRAGMA table_info` + 条件 `ALTER`。迁移测试用 fake DB（host node 无法加载 electron-ABI sqlite），见 `migration-belief-columns.test.ts` 范式。
- **跨进程最小闭环**（I3-2 IPC）：CLAUDE.md §7 —— Main IPC handler + Preload API + Renderer 类型 + 组件 + 测试/gate + 文档。
- **确认卡复用**：`ask_user_questions`（CLAUDE.md §5：每 turn 最多一次、同 session 单 pending）。
- **gate 范式**：`scripts/check-run-finalize-funnel.cjs`（仿写 `check-checkin-funnel`/`check-ledger`）。

### EP1-I3-1 确认策略表与 dispatch 闸门
- **入口**：新增 `agent-control/safety/action-confirmation-policy.ts`（M1-M4 工具名+参数特征→模式映射，清单照 05 §3.1）；`tool-executor.ts` authorization 之后插闸门查表。
- **风险点**：闸门必须在 authorization **之后**（顺序断言）；M2/M3 全部走冻结流程（本单返回 `denied_pending_confirmation` 占位，I3-2 接实现）；禁止读 TurnFrame 意图做预批准。
- **红线**：阶段一 **M2/M3 每次都确认，不做预批准、不做确认缓存**；加"同对象同动作连续两次命中→两次都确认"防御测试。
- **测试**：`src/__tests__/action-confirmation-policy.test.ts`（M1-M4 矩阵 + 同工具不同参数落不同模式 + M3 与 M2 同走 + 禁缓存 + 闸门顺序）。

### EP1-T4-2 信封并存 + browser/skills 试点
- **入口**：`ToolExecutionOutput` 加可选 `envelope`（additive）；`tool-executor.ts` dispatch 出口统一组装；skills 子进程结果 stdout 单 JSON 信封纪律。
- **风险点**：全域共用结构 → 全域改动须**全域证明**：browser+skill 试点正向 + 一个非 browser/skill 工具旧字段快照不变。
- **红线**：旧 `text/data/errorKind` **零改动零删除**；envelope 仅新消费方读取。
- **测试**：`src/__tests__/tool-envelope-pilot.test.ts`。

### EP1-I3-2 冻结放行与确认卡（最大单，~300 行）
- **入口**：迁移 053 `pending_confirmations` 表（`id/run_id/task_id/scope_id/tool_name/params_json/created_at/expires_at/status/released_at`）；新增 `agent-control/safety/frozen-call-store.ts`；`tool-executor.ts` M2/M3 拦截→冻结入库+发确认卡；专用 `release(id, token)` 入口；IPC 最小闭环（confirm/deny）；新增 `check-checkin-funnel`-style 不需要，但 release 路径要测。
- **执行模型（合同已定）**：**原 run 内同步等待**——拦截发生在工具执行上下文内（abortSignal/browserController/allowedToolNames/scope/runId 都活着），确认期间挂起原 run，确认后在**同一上下文**放行。**不做**"后续 run 恢复执行"（需序列化重建 ToolRuntimeContext）。
- **红线（务必逐条守）**：
  1. 冻结的是**原始 tool_use 参数**，确认后**不能让模型重新生成参数**（重生成=漂移=确认失效）；放行参数与冻结时**逐字节一致**。
  2. `release` token **只跳过"再次确认"**，注册/authorization/工具策略**照常执行**（确认≠提权）——必测"确认后恰好失去授权 → 被 authorization 拦下而非靠 token 提权"。
  3. 超时（默认 10 分钟）/run 被抢占/取消 → frozen call 置 expired，工具返回结构化"确认超时已取消"，**绝不在上下文失效后补执行**。
  4. 同 session 单 pending：已有 pending 时第二个 M2 直接 `denied_pending_confirmation` 让模型改道。
  5. 执行在原 run 内同步完成，结果直接作为该 tool_use 返回回灌——**不引入 TaskEventBridge 跨 run 回灌**。
- **测试**：`src/__tests__/frozen-call-release.test.ts`（逐字节放行 + release 仍跑 authorization + 二次放行拒绝 + 过期作废+不补执行 + 拒绝回灌 + 单 pending）。
- **额外**：本单**必须 `npm run verify:native`**（含迁移 053）。

### EP1-G1 verify 链与文档同步（收口）
- **入口**：`package.json` 新增 `verify:evolution-p1`（本计划全部焦点测试，内部串 `verify:native` 或完成定义单列）；`CLAUDE.md`+`AGENTS.md` §8 索引追加本合同（§12 同步）；硬约束（确认闸门、staged 注入禁令）按 §10 进根目录指引 §2；`docs/agent-evolution/08-缺陷解决映射与验收追踪.md` 回填本阶段行。
- **验证**：`npm run verify:evolution-p1 && npm run verify:native && npm run typecheck && npm run test`。

## 5. 阶段一已建立、后续可复用的基建

- 信念卡：`BeliefCardStore`（两 glob 白名单/五态/原子写/读默认排除 staged）+ DB 镜像（`syncBeliefCards`，未接启动，留 K6）。
- 资产化：`PromptAssetLoader`（版本化、缺文件回退）+ `assets/prompts/**`、`assets/site-cards/**`（已打包）。
- fragment 内联：ref `text`（仅宿主代码、内容来自 X3、不接用户输入）→ B2/B3 已用，I3 若需注入提示词同理。
- 工具信封：`tool-result-envelope.ts`（kind 映射就绪，T4-2 接线）。
- 观测：`context-bill.ts`（每轮注入账单）。
- 站点风险权威：`isHighControlPlatformText`（代码 store 权威，卡片只读镜像）。
