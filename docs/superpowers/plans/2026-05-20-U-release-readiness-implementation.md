---
name: U-release-readiness-implementation
stage: U
date: 2026-05-20
revision: v7
status: pending-review
enforce: true
prereq_audits:
  - docs/superpowers/audits/2026-05-20-ready-deep-review-and-refactor-plan.md
  - docs/superpowers/audits/2026-05-20-ready-module-runtime-map.md
codex_review:
  v1: 2026-05-20 — 7 阻断 + 12 重要修改全部纳入 v2
  v2: 2026-05-20 — 4 新阻断（N-1~N-5）+ 10 CI 不变量缺失（C-1~C-10）+ 多 D 未到位 → v3 处理
  v3: 2026-05-20 — 3 阻断（N-2/N-3/N-5 正文未与摘要同步）+ 7 重要（V3-4~V3-9, C-8, D3-5）→ v4 处理
  v4: 2026-05-20 — 4 阻断（X-1~X-4 数字一致性）+ 2 重要（X-5/X-6）+ 1 残（R-2）→ v5 处理
  v5: 2026-05-20 — 2 新发现（N-1 Phase 7 验收 10 vs 11；N-2 五处 v3 标签未升）→ v6 处理
  v6: 2026-05-20 — 4 处残留版本号（§0.3 / §13 / §14 / §15 仍标 v5/v3）→ v7 全局扫除
---

# Stage U — Release Readiness 实施计划 v7

> v6 → v7 修订摘要（codex 六审：4 处版本号残留）：
> - §0.3 时序图标题 (v5) → (v7)
> - §13 总时间预估 (v5) → (v7)
> - §14 调用 agent teams 的执行规则 (v5 批次) → (v7 批次)
> - §15 后续中 "本计划 v3 经 codex 三次审核通过后开始派发" → "本计划 v7 经 codex 七次审核通过后开始派发"

> v4 → v5 修订摘要（处理 codex 四审 4 阻断 + 2 重要 + 1 残）：
> - **X-1**：§0.3 时序图同步 Phase 4=9 / Phase 5=12 / Phase 7=11 / Phase 8=11 PR
> - **X-2**：Phase 7 标题改"11 PR"；§13 时间预估同步；§14 批次同步
> - **X-3**：Phase 8 标题改"11 PR"；删除"物理 PR 10"的矛盾说明；验收列表同步
> - **X-4**：批次 1 加入 U8.6.1（消除对 U8.7 的悬空依赖）
> - **X-5**：新增 U8.8（30 天后删除 settings legacy key feature flag），进入 Phase 8 PR 数与批次
> - **X-6**：U5.8 标题改"全 46 个"（与枚举一致）
> - **R-2**：Phase 5 标题改"12 PR"（与正文 U5.1a/b/c + U5.2-U5.10 一致）
> - **全局**：所有 PR 数三处自洽（标题 / 时序图 / 验收 / 批次）
>
> 实际 PR 总数：**61**（Phase 0:4 + P1:5 + P2:4 + P3:3 + P4:9 + P5:12 + P6:2 + P7:11 + P8:11）

> v2 → v3 修订摘要：
> - **N-1**: phase smoke gate 从 U7.7 拆出，在 Phase 0 即建立 runner（新 U0.4），消除时序矛盾
> - **N-2**: U4.1a 的 wire-contract-isolation gate 不立即启用，改 U4.1d 完成后启用
> - **N-3**: `check-move-only-pr.cjs` 删除 `non-move-only-justification` 后门；不允许 justification 放行
> - **N-4**: U5.6a "暂仍闭包捕获" 改为一次性完整 deps 注入；不拆 a/b
> - **N-5**: U5.7/5.8/5.9 全部展开为独立 a/b 小节，每个 PR 列具体 channel 清单
> - **N-6**: U5.10 加双向 contract 检查（main handler ↔ shared contract）
> - **N-7**: §0.3 时序图修正 — Phase 8 内 U8.5 依赖 U5.1
> - **N-8**: U8.3 加迁移退场 gate `check-settings-no-legacy-key-read.cjs`
> - **N-9**: U8.6 Windows CI matrix 扩到 verify:native + build
> - **D1-1/D1-3 残余**: U4.3 拆为 a/b、U7.1/U7.5/U7.6 拆为 a/b、U8.5 拆为 U8.5a/b
> - **D1-4 残余**: 全部 U7.x 补 Blocks 字段
> - **D2-1 残余**: move-only/smoke gate 升级 merge gate；e2e fixture index 接 verify:cloud
> - **D2-2 残余**: ipcMain.emit gate 加 "helper 包装后消费返回值" 检测
> - **D2-4 残余**: turn-engine gate 加 enum 检查
> - **D3-5 残余**: 全部 U7.x 列 fixture/golden/失败定位字段
> - **D4-4 残余**: 新增 `check-verify-native-trigger.cjs` 机器分类
> - **D4-5 残余**: 通过 N-1 解决
> - **D4-6 残余**: §0.7 列每个 grep gate 配套行为测试
> - **C-1**: 新 gate `check-ipc-handler-has-contract.cjs`（反向检查）
> - **C-3**: 新 gate `check-no-skill-executions-resurrection.cjs`
> - **C-5**: 新 gate `check-browserview-overlay-order.cjs`（renderer 模式：调用 showOverlay 前必须 hideAll）
> - **C-6**: 新 gate `check-scope-key-three-dim.cjs`（scope 构造必须含三维）
> - **C-7**: 新 gate `check-tool-log-not-in-transcript.cjs`
> - **C-8**: 新 gate `check-verify-native-trigger.cjs`（PR diff 涉及指定路径必须跑 verify:native）
> - **C-9**: U8.6 Windows CI matrix 涵盖 verify:native + build（已含于 N-9）
> - **C-10**: 新 gate `check-e2e-artifact-retention.cjs`（每 e2e 必须保留 artifact + screenshot）
> - 总 PR 数 v2 50 → v3 ~58；总日历时间 4-7 周

## 0. 计划目标与范围

把 codex 两份审查文档 Phase 0-7 + audit 漏包分解到**可独立合并的 PR 粒度**，完成后应用接近发行状态：

1. 没有正在欺骗用户的活 bug。
2. 当前正在漂移的合同全部上 CI 且接入 merge gate。
3. 输入边界、跨边界状态一致性、关键工作流 e2e 全部进入验收。
4. agent-control 目录、巨型文件、verify chain 第一波瘦身。
5. Windows / native ABI / BrowserView / widget target 等历史经验坑进入验收门。

**不在本计划范围**：UI 视觉重设计、新功能、模型/provider 新增。

**v2 新增范围（codex D6 反馈）**：
- Search worker fallback 可观测性（§9 U8.1）
- RSS 平台 adapter 化（§9 U8.2）
- Settings legacy Tavily/Jina key 收口（§9 U8.3）
- Embedded skills 三目录 manifest/asset/eval/sandbox parity（§9 U8.4）
- `skill-child-runner.ts` / `document-widget-openui.ts` 二次拆分（§9 U8.5）
- Windows release-readiness（§9 U8.6）
- LESSONS_LEARNED ABI / BrowserView / widget target 三类回归（§9 U8.7）

**计划本身的约束**：
- 每个 PR ≤ 500 LOC 净变更（**真正强制**，move-only PR 必须由 §0.5 的 `check-move-only-pr.cjs` 机器验证）。
- 每个 PR 至少一个行为测试或新 CI gate。
- 每个 phase 至少有一个新 CI gate 锁住本阶段不变量（Phase 5/7 现已补齐，见 §9）。
- 合同改动 PR 与文件搬迁 PR 不允许合并。
- 不允许 `--no-verify`，不允许 skip 当通过。
- 每个 PR 描述里必须写明：失败时哪个 gate / 测试会红；回滚命令；**受影响消费方清单**；**是否需要 `verify:native`**。

## 0.1 PR 编号与命名约定

- 编号：`U<phase>.<seq>[<sub>]`，例如 `U0.1`、`U4.1a`、`U5.6b`。
- branch：`u<phase>-<seq>-<slug>`。
- commit 第一行：`feat|fix|refactor|test|chore(<scope>): <U<phase>.<seq>> <动词> <对象>`。
- PR 描述模板见 §11（v2 已强化）。

## 0.2 角色与 agent 团队分配

| 角色代号 | agent 类型 | 适用场景 |
|---|---|---|
| **R-Implement** | `general-purpose` (sonnet) | 单 PR ≤ 300 LOC 实现 + 测试 |
| **R-Heavy** | `general-purpose` (sonnet), `isolation: worktree` | move-file、跨多文件重命名 |
| **R-Plan** | `Plan` | PR > 300 LOC 或涉及合同改动 |
| **R-Explore** | `Explore` | 验证断言、找调用方、定位入口 |
| **R-Codex** | `codex:rescue` | 卡住、合同歧义、二次诊断 |

## 0.3 总体时序与依赖图（v7）

```
Phase 0 (4 PR) ──┐  [U0.4 phase smoke runner 建立后，所有后续 PR merge 前都跑]
                 ├── Phase 1 (5 PR) ────┐
                 │                      ├── Phase 4 (9 PR) ──┐
                 │                      │                    ├── Phase 5 (12 PR) ──┐
                 ├── Phase 2 (4 PR) ────┤                    │                     │
                 │                      │                    │                     │
                 ├── Phase 3 (3 PR) ────┘                    │                     │
                 │                                           │                     ├── Phase 6 (2 PR)
                 └── Phase 8 启动子集 (U8.0/1/2/3/4/6/6.1/7) ── 与 Phase 1-3 并行  │
                                                              │                     │
                            U8.5a/U8.5b ── 必须等 Phase 5 完成（N-7）──────────────┤
                                                              │                     │
                            U8.8 ── 必须等 U8.3 land 后 30 天（X-5）───────────────┤
                                                              │                     │
                                              Phase 7 (11 PR) 与 Phase 5 后段并行 ──┘
```

实际 PR 总数：**61**
- Phase 0：4（U0.1/2/3/4）
- Phase 1：5（U1.1/2/3/4/5）
- Phase 2：4（U2.1/2/3/4）
- Phase 3：3（U3.1/2/3）
- Phase 4：9（U4.1a-e + U4.2a/b + U4.3a/b）
- Phase 5：12（U5.1a/b/c + U5.2/3/4/5/6/7/8/9/10）
- Phase 6：2（U6.1/2）
- Phase 7：11（U7.1a/b + U7.2/3/4 + U7.5a/b + U7.6a/b + U7.7/8）
- Phase 8：11（U8.0/1/2/3/4 + U8.5a/b + U8.6/6.1/7/8）

关键变化（v3）：
- **Phase 0 新增 U0.4** — phase smoke gate runner 建立（解决 N-1）
- **Phase 8 内 U8.5 单独依赖 Phase 5**（N-7）
- 其它依赖关系参见各 PR 表 `Blocked by`/`Blocks` 字段

## 0.4 关键合同条款（v6 全部硬规则）

下列条款是所有 PR 必须遵守的"硬规则"，全部对应 §9 中的 CI gate：

1. 不允许 `ipcMain.emit(...)` 作为返回值来源（**含 helper 包装后消费返回值**，D2-2 强化）→ `check-no-ipcmain-emit-truthy.cjs`（TS AST，含 taint tracking）
2. 不允许在 `turn-engine.ts` 出现产品分支（**字面量 / 常量 / enum / adapter id 比较 / startsWith**） → `check-turn-engine-no-domain-branch.cjs`（TS AST）
3. 不允许新增 silent catch → `check-silent-catch.cjs`（Phase 3 接入 merge gate）
4. 不允许跨边界 fire-and-forget（**5 种语法形态**）→ `check-no-fire-and-forget.cjs` + allowlist
5. 不允许在 `src/preload/index.ts` 新增 IPC 暴露而 `src/shared/ipc-contracts/` 没有对应 schema → `check-preload-uses-shared-contract.cjs`（Phase 4 后启用，全 channel）
6. 不允许直接 import `agent-control/run-contracts-internal.ts` 到 renderer / preload → `check-wire-contract-isolation.cjs`
7. 不允许重新引入 legacy `agent:orchestrate|getStatus|getAll|getDiagnostics|tool_execute` channel → `check-no-legacy-agent-ipc.cjs`
8. **不允许**在 move-only PR 中出现任何非路径/import 改动（**不接受 justification 后门**，N-3）→ `check-move-only-pr.cjs`
9. **不允许**任何 `ipcMain.handle('<channel>', ...)` 没有对应的 `src/shared/ipc-contracts/` schema（C-1 反向）→ `check-ipc-handler-has-contract.cjs`
10. **不允许**复活 `skill_executions` 表 / 状态机 / IPC channel（C-3）→ `check-no-skill-executions-resurrection.cjs`
11. **不允许**在 renderer 显示 DOM overlay 前未调用 `browser.hideAll()`（C-5）→ `check-browserview-overlay-order.cjs`（TS AST）
12. **不允许**构造 scope key 时遗漏"来源频道 + 线程/conversation + agent"三维之一（C-6）→ `check-scope-key-three-dim.cjs`
13. **不允许**工具日志（tool trace、tool result）写入 transcript / 正文消息持久化（C-7）→ `check-tool-log-not-in-transcript.cjs`
14. **不允许**改动 SQLite / settings / repositories / migration 路径而 PR 描述未声明跑过 `verify:native`（C-8）→ `check-verify-native-trigger.cjs`（CI 端 PR diff 自动判定）
15. **不允许**新增 e2e 测试不保留 artifact / screenshot（C-10）→ `check-e2e-artifact-retention.cjs`
16. **不允许**在 settings 迁移完成后继续读 legacy Tavily/Jina key（N-8）→ `check-settings-no-legacy-key-read.cjs`（U8.3 land 后启用）

## 0.5 Gate 接入策略（D2-1 回应）

每个 gate 必须明确接入点：

| 接入级别 | 含义 | 触发时机 |
|---|---|---|
| **pre-commit** | hook 阶段拒绝提交 | 开发者本地 |
| **PR check** | GitHub Actions 必跑 | PR 打开 |
| **verify chain** | 加入 `verify:<阶段>` 串 | `npm run verify` |
| **verify:cloud** | 阻塞 release build | release 流程 |
| **merge gate** | 不通过不能 merge | GitHub 设置 |

v2 PR 表中每个新 gate 都标注 `gate-tier`。默认要求所有 P0/P1 gate 必须达到 **PR check + verify chain + merge gate** 三档。

## 0.6 PR 验收命令最小集合（D4-4 回应）

每个 PR 验收必须包含（除非 PR 自己声明不涉及）：

```bash
npm run typecheck
npm run lint:check
node scripts/check-eslint-baseline.cjs
node scripts/check-no-fire-and-forget.cjs       # Phase 2 后
node scripts/check-silent-catch.cjs              # Phase 3 后
node scripts/check-wire-contract-isolation.cjs   # Phase 4 后
npm run verify:native                            # 凡涉及 SQLite/settings/local persistence
```

外加 PR 特定的 focused test 与 gate（见各 PR 表）。

## 0.7 源码 grep 测试 / 行为测试配对（v6 完整表，D4-6 回应）

本计划中 source-grep 测试只能作为 **结构 gate**，**必须**配真实入口行为测试。完整对照：

| Gate（结构） | 配套行为测试（真实入口） |
|---|---|
| `check-no-ipcmain-emit-truthy.cjs` | `src/__tests__/legacy-tool-execute-bridge-removed.test.ts` |
| `check-tool-error-shape.cjs` | `src/__tests__/tool-error-shape-*.test.ts`（4 个）+ `renderer-soft-failure-capsule-tool-not-registered.test.tsx` |
| `check-no-legacy-agent-ipc.cjs` | `src/__tests__/legacy-agent-ipc-removed.test.ts` |
| `check-turn-engine-no-domain-branch.cjs` | `pet-sticky-note-reminder.test.ts` + `browser-task-correction-reminder.test.ts` + `turn-engine-reminder-delegation.test.ts` |
| `check-read-skill-visibility-single-source.cjs` | `read-skill-visibility-helper.test.ts` |
| `check-no-fire-and-forget.cjs` | `runtime-projection-sync-failure-observable.test.ts` + `detached-tracker-cleanup-failure-marked.test.ts` + `hook-registry-timeout-abort.test.ts` |
| `check-silent-catch.cjs` | `file-tree-drop-failure-shows-toast.test.tsx` + `local-html-open-failure-userMessage.test.ts` + `url-utils-failure-userMessage.test.ts` + `web-clip-url-failure-reported.test.ts` |
| `check-input-boundary-coverage.cjs` | 同上 silent catch 行为测试 |
| `check-wire-contract-isolation.cjs` | `preload-wrapper-agent-contract.test.ts`（U4.2a）+ `preload-wrapper-all-channels-contract.test.ts`（U4.2b） |
| `check-preload-uses-shared-contract.cjs` | 同上 |
| `check-ipc-handler-has-contract.cjs` | `all-ipc-channels-registered.test.ts`（U5.10） |
| `check-move-only-pr.cjs` | 不需要行为测试（PR diff 解析） |
| `check-no-skill-executions-resurrection.cjs` | 不需要（DDL/path 级断言） |
| `check-browserview-overlay-order.cjs` | `browserview-overlay-hideAll-before-showOverlay.e2e.ts`（U7.6） |
| `check-scope-key-three-dim.cjs` | `scope-isolation-three-dim.test.ts`（U7.3） |
| `check-tool-log-not-in-transcript.cjs` | `tool-log-stays-in-runtime-not-transcript.test.ts`（U7.3） |
| `check-verify-native-trigger.cjs` | CI 自验证（PR 评论附 verify:native 运行证据） |
| `check-settings-no-legacy-key-read.cjs` | `settings-legacy-key-migration.test.ts`（U8.3） |
| `check-e2e-artifact-retention.cjs` | 不需要（meta 检查） |
| `check-rss-platform-rule-single-source.cjs` | `rss-platform-detection-acquisition-consistency.test.ts`（U8.2） |
| `check-embedded-skill-manifest-asset-parity.cjs` | 3 skill 各 1 个 fixture 测试（U8.4） |
| `check-windows-path-portability.cjs` | Windows CI matrix（U8.6） |
| `check-phase-smoke-gate.cjs` | `phase-smoke-runner.test.ts`（U0.4） |
| `check-e2e-fixture-index.cjs` | 不需要（path 级断言） |
| `check-gate-index-complete.cjs` | 不需要（meta 检查） |

---

## 1. Phase 0 — 停掉活 bug（V3-9 修正：4 PR，2-3 天）

### U0.1 — 删除 legacy tool_execute 桥与 calendar 假成功
- **依赖**：无
- **改动**：
  - `src/main/modules/claude-bridge/ipc-handler.ts:1772-1817`：删除 `agentManager.on('tool_execute', ...)`。
  - `src/main/modules/claude-bridge/agent-manager.ts`：删除 `feedToolResult` 若无内部调用方。
- **行为合同变化**：legacy `tool_execute` 工具桥停用。
- **受影响消费方**：renderer 无；main 内 `claude-bridge` 模块；test fixtures（grep `tool_execute` 找消费方）。
- **新 CI gate**：`scripts/check-no-ipcmain-emit-truthy.cjs`
  - **实现（v3 含 taint tracking，D2-2 残余）**：用 TypeScript Compiler API：
    1. 解析 `ipcMain.emit()` 调用的所有 enclosing 表达式（赋值、二元、三元、if 条件、return）不允许返回值被消费
    2. **Taint tracking**：若 `ipcMain.emit()` 结果赋给变量 `x`，禁止 `x` 在后续 5 行内被 `||`/`&&`/三元/if 条件消费（即使经过 helper 包装）
    3. **Helper 检测**：禁止 `function helper(...) { return ipcMain.emit(...) || ... }` 模式
  - **接入**：PR check + verify chain（`verify:a0`）+ merge gate
  - **gate-tier**：merge gate
- **测试**：
  - 结构：`scripts/__tests__/check-no-ipcmain-emit-truthy.test.cjs`（正反 fixture）
  - 行为：`src/__tests__/legacy-tool-execute-bridge-removed.test.ts`（断言 `agentManager` 不再监听）
- **验收命令**：见 §0.6 + 上面 2 个测试
- **回滚**：`git revert <sha>`
- **agent**：R-Implement
- **LOC**：≤ 150

### U0.2 — 4 项预算敏感 silent catch 改为 fail-fast
- **依赖**：无（与 U0.1 并行）
- **改动**：
  - `src/main/modules/skills-runtime/runtime-manager.ts:639/653`、`skill-configuration-store.ts:18`、`agent-control/video-expert-child-driver.ts:358`。
  - 新增 `SkillRuntimeConfigError` 类型，统一抛出。
- **行为合同变化**：sub-agent / VEA 在配置失败时直接 blocked + projection.failed，而不是带残缺配置启动。
- **受影响消费方**：
  - main: `skill-task-supervisor.ts`、`skill-task-tracker.ts`、`detached-skill-task-tracker.ts`、`runtime.ts`（接收 SkillRuntimeConfigError 并 mark projection failed）
  - renderer: task card 接收 `terminalReason: 'external_service_config_unavailable'` 时的展示文案（无 UI 改动，复用现有 failure UI）
- **新 metric**：`runtime.config.load_failed`（注册到 `agent-control/metrics.ts`）
- **测试**：
  - `src/__tests__/runtime-manager-config-fail-fast.test.ts`
  - `src/__tests__/video-expert-driver-config-preflight.test.ts`
  - `src/__tests__/skill-task-projection-failed-on-config-error.test.ts`（行为：projection 标 failed）
- **验收命令**：§0.6 + 3 个测试 + `node scripts/check-silent-catch.cjs`（少 4 项）
- **回滚**：`git revert`
- **agent**：R-Plan → R-Implement
- **LOC**：≤ 250

### U0.3 — secret-storage silent catch 注释化
- **依赖**：无
- **改动**：`src/main/modules/agent-control/secret-storage.ts:8` 加 `// silent-catch:` 注释。
- **行为合同变化**：无
- **受影响消费方**：无
- **测试**：`node scripts/check-silent-catch.cjs` 少 1 项
- **验收命令**：§0.6
- **回滚**：删注释
- **agent**：R-Implement
- **LOC**：1

### U0.4 — Phase smoke gate runner（N-1/D4-5 回应）
- **依赖**：无（与 U0.1/U0.2/U0.3 并行）
- **改动**：
  - 新建 `scripts/phase-smoke-runner.cjs`：可在任意 Phase 完成后调用，跑 3 类 smoke：
    1. **Browser smoke**：启动一个 BrowserView tab，导航到 `about:blank`，断言能 createTab / updateBounds / showActive 全跑通
    2. **Agent smoke**：本地 conversation 一次 send，断言收到 done event
    3. **Settings smoke**：保存一个 provider 配置 + 重启后读出
  - 新建 `scripts/check-phase-smoke-gate.cjs`：根据当前 PR 标签（`phase:0|1|2|3|4|5`）触发 smoke runner；不通过阻断 PR
  - 新建 `src/__tests__/phase-smoke-runner.test.ts`（meta 测试，断言 runner 能识别 phase 标签并跑对应 smoke）
- **行为合同变化**：所有 Phase 0 之后的 PR 必须通过 phase smoke gate 才能 merge
- **受影响消费方**：所有后续 PR 的 CI flow
- **新 CI gate**：
  - `check-phase-smoke-gate.cjs`
    - **接入**：PR check + merge gate；不在 verify chain（按 PR label 触发）
- **测试**：`src/__tests__/phase-smoke-runner.test.ts`
- **验收命令**：§0.6 + `node scripts/phase-smoke-runner.cjs --phase 0`（本地手测）
- **回滚**：删 gate + runner
- **agent**：R-Plan → R-Implement
- **LOC**：400

**Phase 0 验收**：silent catch 19 → 14；2 个新 gate 通过（含 smoke runner）；§0.6 全套绿。

---

## 2. Phase 1 — 合同唯一化（5 PR，5-7 天）

### U1.1 — 工具错误统一为顶级 errorKind: 'tool_not_registered'
- **依赖**：Phase 0
- **改动**：
  - `src/main/modules/tools/tool-executor.ts:141-150`
  - `src/main/modules/agent-control/tool-runtime.ts:482-490`
  - `src/main/modules/agent-control/agent-sdk-runtime.ts:1229-1263`
  - `src/main/modules/agent-control/error-kinds.ts`
- **行为合同变化**：模型看到的 errorKind shape 变化；renderer 软失败胶囊识别新 kind。
- **受影响消费方（D3-1 回应）**：
  - main: `tool-error-metrics.ts`、`tool-result-types.ts`、`agent-sdk-runtime.ts` child close mapping、`task-projection-reconciler.ts` 状态推断
  - preload: `electronAPI.agent.error` payload（不改 channel 名，改字段）
  - renderer: `src/renderer/modules/agent/task-status-vocabulary.ts`（kind → vocab 映射）、`SoftFailureCapsule.tsx`、`ChatMessages.tsx`（错误文案展示）、`useAgent.ts` error 分发
  - test: 全仓 grep `errorKind.*host_unavailable.*tool_not_registered` 全部改写（预估 14 个文件）
- **新 CI gate**：`scripts/check-tool-error-shape.cjs`
  - **实现**：TS AST，扫描 `errorKind: 'host_unavailable'` 表达式，禁止与 `reason: 'tool_not_registered'` 同对象出现
  - **接入**：PR check + verify:b + merge gate
- **测试**（4 类拒绝路径）：
  - `tool-error-shape-fabricated-skill.test.ts`
  - `tool-error-shape-fabricated-non-skill.test.ts`
  - `tool-error-shape-skill-unauthorized.test.ts`
  - `tool-error-shape-non-skill-restricted.test.ts`
  - **新增**：`renderer-soft-failure-capsule-tool-not-registered.test.tsx`（行为：renderer UI 正确识别新 kind）
- **验收命令**：§0.6 + `node scripts/check-tool-error-shape.cjs` + 5 个测试 + `npm run verify:c`
- **回滚**：拆为两步 revert（source 先于 test）
- **agent**：R-Plan → R-Implement
- **LOC**：450（接近上限，必要时拆 1.1a source / 1.1b consumers）

### U1.2 — 删除 legacy agent IPC + preload/types 清理
- **依赖**：U0.1
- **改动**：
  - `src/main/modules/claude-bridge/ipc-handler.ts:641-678`
  - `src/preload/index.ts:44-49`
  - `src/renderer/types/electron.d.ts`
  - `src/main/modules/claude-bridge/agent-manager.ts`（标 internal / 删）
- **行为合同变化**：renderer 无法再调 legacy agent API（已验证零调用方）
- **受影响消费方**：
  - main: 见上 4 文件
  - preload: 单文件改动
  - renderer types: 单文件改动
  - test: 无（已 grep 确认）
- **新 CI gate**：`scripts/check-no-legacy-agent-ipc.cjs`
  - **实现**：grep + AST 双层 — grep 字符串字面量；AST 检查 `ipcMain.handle` 第一参数
  - **接入**：PR check + verify:a0 + merge gate
- **测试**：
  - 结构：`scripts/__tests__/check-no-legacy-agent-ipc.test.cjs`
  - 行为：`src/__tests__/legacy-agent-ipc-removed.test.ts`（renderer 真实入口断言 `electronAPI.agent.orchestrate === undefined`）
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：≤ 200

### U1.3 — 删除 legacy event forward + DirectChatEngine 事件解绑
- **依赖**：U0.1 + U1.2
- **改动**：
  - `src/main/modules/claude-bridge/ipc-handler.ts:1751-1770`
  - `src/main/modules/agent-control/orchestrator.ts:60-69` + setter 转发段
  - 重命名 `domainAdapterEngine` → `domainAdapterProvider`
- **行为合同变化**：DirectChatEngine 不再 emit；继续作为 DomainAdapter / SkillContextOrchestrator 提供者
- **受影响消费方**：
  - main: `orchestrator.ts` setter 链路；所有调用 `setBrowserController/setSidecarManager/setRuntime/setRendererToolActionRequester/setCancelPendingToolActions` 的 callsite
  - renderer: 无
- **测试**：
  - `src/__tests__/orchestrator-no-direct-chat-engine-execution.test.ts`
  - **新增**：`src/__tests__/agent-event-single-source-runtime-only.test.ts`（行为：mock 一次 send，断言所有 `agent:stream/status/error` 事件都来自 SDK runtime）
- **验收命令**：§0.6 + 2 个测试 + `npm run verify:c`
- **回滚**：`git revert`
- **agent**：R-Plan → R-Implement
- **LOC**：250

### U1.4 — turn-engine 产品分支搬迁到 SystemReminderRegistry（D3-2 回应）
- **依赖**：无（与 U1.1/U1.2 并行）
- **改动**：
  - `src/main/modules/agent-control/turn-engine.ts:3804-3814` → 新建 `src/main/modules/agent-control/system-reminders/pet-stickynote-reminder.ts`，注册到 `SystemReminderRegistry`，**不放 pet-domain-adapter 内**（明确选择 SystemReminderRegistry 路径，因为这是 turn-level reminder 而非 domain-specific tool）。
  - `src/main/modules/agent-control/turn-engine.ts:3834-3841` → 新建 `src/main/modules/agent-control/system-reminders/browser-task-correction-reminder.ts`，同上路径。
  - 两个新 reminder 在 `SystemReminderRegistry.bootstrap()` 中注册。
- **行为合同变化**：reminder 触发条件、触发时机、文案完全等价；触发方从 turn-engine 内联改为 registry 派发。
- **受影响消费方**：
  - main: `turn-engine.ts`（删两段）、`SystemReminderRegistry.bootstrap`（加两条注册）、`system-reminder-assembly.ts`（无改动，registry 已支持）
  - test: 现有 turn-engine 测试若依赖内联 reminder 行为需更新
- **新 CI gate**：`scripts/check-turn-engine-no-domain-branch.cjs`
  - **实现（D2-4 v3 强化）**：TS AST 检查
    1. 字符串字面量包含产品中文名或工具前缀
    2. import / 引用 `*-domain-adapter` 文件
    3. 比较 `adapter.id === '...'`
    4. `toolName.startsWith('pet_'|'browser_'|...)` 调用
    5. **enum 引用**：禁止 `DomainAdapterId.Pet` / `DomainKind.Browser` 等 enum 成员直接比较（v3 新增）
    6. **常量引用**：禁止 import 任何只含产品域字符串的常量模块（v3 新增）
  - **接入**：PR check + verify:c + merge gate
- **测试**：
  - 结构：`scripts/__tests__/check-turn-engine-no-domain-branch.test.cjs`
  - 行为：`pet-sticky-note-reminder.test.ts`（registry 注册后触发等价）
  - 行为：`browser-task-correction-reminder.test.ts`
  - 行为：`turn-engine-reminder-delegation.test.ts`（mock registry，断言 turn-engine 调用 registry 而非内联）
- **验收命令**：§0.6 + 4 个测试
- **回滚**：`git revert`
- **agent**：R-Plan → R-Implement
- **LOC**：300

### U1.5 — read_skill visibility 归一 helper
- **依赖**：无
- **改动**：
  - 新建 `src/main/modules/skills-runtime/read-skill-visibility.ts`
  - `custom-skill-registry.ts:278`、`skill-compiler.ts:260` 改为调用 helper
- **行为合同变化**：等价
- **受影响消费方**：
  - main: 两个 callsite + 任何未来想自实现归一的新文件（被 gate 拒绝）
  - test: 现有 skill compiler / custom registry 测试不变
- **新 CI gate**：`scripts/check-read-skill-visibility-single-source.cjs`
  - **实现**：AST — 除 helper 文件外，任何文件不允许同时出现 `read_skill` 标识与 `visibility: 'internal'` 字面量
  - **接入**：PR check + verify:p（已有 stage P gate 链）
- **测试**：
  - 结构：scripts/__tests__/...
  - 行为：`src/__tests__/read-skill-visibility-helper.test.ts`（6 case：reference/advisory/runtime × 2 manifest visibility）
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：100

**Phase 1 验收**：4 个新 gate 通过；4 类 tool error 拒绝 + renderer UI 行为测试绿；legacy agent IPC/forward/tool_execute 三处零残留；turn-engine 无任何产品分支（字面量+常量+adapter id+startsWith）；read_skill 单 helper。

---

## 3. Phase 2 — 跨边界状态显式建模（4 PR，3-4 天）

### U2.1 — syncTaskProjection 失败上报
- **依赖**：Phase 0
- **改动**：
  - `src/main/modules/agent-control/runtime.ts:2452-2454`
  - `taskProjectionStore.markSyncFailed(scopeId, reason)`（新 method）
  - 新 IPC event `agent:projectionSyncFailed`
- **行为合同变化**：renderer 可看到 projection sync 失败计数
- **受影响消费方**：
  - main: runtime.ts、`task-projection-sync.ts`、`task-projection-reconciler.ts`
  - preload: 新增 `agent:projectionSyncFailed` 监听 wrapper
  - renderer: `useAgent.ts` 订阅 + 可选 diagnose UI（本 PR 不强制做 UI，只暴露 store 字段）
- **新 metric**：`projection.sync_failed`
- **测试**：
  - `src/__tests__/runtime-projection-sync-failure-observable.test.ts`
  - 行为：`src/__tests__/renderer-projection-sync-failure-visible.test.tsx`（mock IPC event，断言 store 字段更新）
- **验收命令**：§0.6 + `npm run verify:o`
- **回滚**：`git revert`
- **agent**：R-Plan → R-Implement
- **LOC**：200

### U2.2 — detached task cleanup metric/terminal
- **依赖**：无
- **改动**：`src/main/modules/agent-control/detached-skill-task-tracker.ts:226-229`
- **行为合同变化**：cleanup 失败 → terminal failed + metric
- **受影响消费方**：main `task-projection-reconciler`、renderer task card 看到 failed 状态
- **测试**：
  - `src/__tests__/detached-tracker-cleanup-failure-marked.test.ts`
  - 行为：`src/__tests__/renderer-task-card-detached-failure.test.tsx`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：100

### U2.3 — hook timeout AbortSignal
- **依赖**：无
- **改动**：`src/main/modules/agent-control/hook-registry.ts:113`
- **行为合同变化**：handler 可 opt-in AbortSignal
- **受影响消费方**：所有 hook handler 实现（无需改，向后兼容；不监听 signal 触发 `timeout_with_unknown_outcome`）
- **测试**：`src/__tests__/hook-registry-timeout-abort.test.ts`（监听 vs 忽略两个 case）
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：120

### U2.4 — fire-and-forget CI gate + allowlist（D2-3 回应：覆盖 5 种形态）
- **依赖**：U2.1/U2.2/U2.3
- **改动**：
  - 新建 `scripts/check-no-fire-and-forget.cjs`
  - 新建 `scripts/check-no-fire-and-forget.allowlist.json`
  - 整仓审计并加 `// fire-and-forget: <reason>` 注释
- **gate 形态覆盖**：
  1. `void <expr>.catch(() => undefined)`
  2. `<expr>.catch(noop)` / `.catch(_ => null)`
  3. `<expr>.catch(() => {})`
  4. `<expr>.finally(...).catch(...)`
  5. renderer `void window.electronAPI.<...>(...)` 后 < 5 行内继续使用同一返回 id（D4 原则 6）
- **实现**：TS AST，扫描 `CatchClause` 和 `ExpressionStatement(VoidExpression)` 节点
- **接入**：PR check + verify:l（与 ledger writer funnel 同档）+ merge gate
- **测试**：
  - 结构：5 种形态的正反 fixture
  - 行为：N/A（gate 本身是结构验证）
- **验收命令**：§0.6 + `node scripts/check-no-fire-and-forget.cjs`
- **回滚**：删除 gate
- **agent**：R-Explore（全仓审计）→ R-Implement
- **LOC**：gate 200 + 注释 ≤ 30 处

**Phase 2 验收**：3 处 fire-and-forget 显式 owner + 5 形态 gate 通过 + renderer 能看到 projection sync 失败。

---

## 4. Phase 3 — 输入边界统一合同（3 PR，4-5 天）

### U3.1 — 建立 InputBoundaryResult + renderer 入口改造
- **依赖**：Phase 0
- **改动**：
  - 新建 `src/shared/input-boundary.ts`
  - 改造 13 处 silent catch（已列）
- **行为合同变化**：失败 → 红字 toast + 可重试
- **受影响消费方**：
  - shared: 新 helper
  - renderer: 13 个文件 + toast 系统集成（用 `src/renderer/components/ui/Toast.tsx` 或同等）
- **新 CI gate**：`scripts/check-input-boundary-coverage.cjs`
  - **实现**：TS AST，对指定 renderer 路径下 try/catch，要求 catch body 出现 `asBoundary` 调用或 leading `// silent-catch:` comment
  - **接入**：PR check + verify:e + merge gate
- **测试**：
  - `src/__tests__/input-boundary-helper.test.ts`
  - 行为：`src/__tests__/file-tree-drop-failure-shows-toast.test.tsx`
  - 行为：`src/__tests__/local-html-open-failure-userMessage.test.ts`
  - 行为：`src/__tests__/url-utils-failure-userMessage.test.ts`
- **验收命令**：§0.6 + 4 个测试
- **回滚**：分步 revert
- **agent**：R-Plan → R-Implement
- **LOC**：500（接近上限）

### U3.2 — web-clip-url + 收尾 silent catch
- **依赖**：U3.1
- **改动**：`src/main/modules/tools/builtins/web-clip-url.ts:126`
- **行为合同变化**：返回结构化 reason
- **受影响消费方**：main web-clip 工具的 callsite（其它 builtin tool 测试）
- **测试**：`src/__tests__/web-clip-url-failure-reported.test.ts`
- **验收命令**：§0.6 + `node scripts/check-silent-catch.cjs`（0 失败）
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：80

### U3.3 — silent catch gate 接入 verify chain
- **依赖**：U3.1 + U3.2 + U0.2 + U0.3
- **改动**：
  - 把 `check-silent-catch.cjs` 加入 `verify:e`
  - `scripts/snapshots/silent-catch-baseline.json` 改为空集
- **gate-tier**：merge gate
- **验收命令**：§0.6 + `npm run verify:e`
- **agent**：R-Implement
- **LOC**：30

**Phase 3 验收**：silent catch 0 失败且 merge gate；input-boundary-coverage 通过；3 失败路径行为测试绿。

---

## 5. Phase 4 v2 — 收窄为 task-projection wire 推导（实操修正：6 PR，3-5 天）

> **Phase 4 v2 收窄说明**（2026-05-20 实操 + codex 二次审查共识）
>
> 原 plan §5 v1 设计为 9 PR、~3000 LOC 严格串行迁移（U4.1a-e 拆 run-contracts.ts + U4.2a/b preload 推导 + U4.3a/b renderer types）。
> 实操在 U4.1c 遇到 3 类无法绕过的类型耦合：
>
> 1. **TaskStep.status 双向不可赋值** — main 端 `ScopeRunTaskStep['status']` (5 member subset) 与 renderer 实际显示 superset (含 in_progress/failed/skipped/cancelled) 不兼容。强行 widen 引发 `skill-child-runner.ts:1769/2269-2271`、`task-step-runtime.ts:24/78/86`、`continuation-state.ts:578`、`task-projection-sync.ts:381` 等 8+ callsite 报错。
> 2. **ScopeRun* 跨 layer 引用** — TaskProjectionRecord 引用 ScopeRunWaitingFor / ScopeRunResumableAction / ScopeRunTaskContinuation / ScopeRunSkillProgress / ScopeRunEventPayload['artifactRefs'] 来自 main `types.ts`；wire 不能 `import from '../main/'`（layer rule）；用 `unknown` 占位则 `active-skill-context.ts:83/90/98/133/166/170/177` 等 10+ 深度 access 失败。
> 3. **实际 wire surface ≪ plan 预期** — grep 实测 src/preload/ + src/renderer/ 对 run-contracts **零 import**；真正跨进程的 wire 只有 2 个 (TaskProjectionChangeEvent + TaskProjectionRecord 顶层)；其余 63 internal types 物理 move 不增加 enforcement，只制造 import churn。
>
> **codex 二次审查结论**（共识）：
> - 方案 A（widespread cast）：50-80 callsite 改 + 6 PR 拆分，高风险低收益 → 拒绝
> - 方案 B（ScopeRun 整批前置迁移）：不是当前启动条件，作为后续专项 (U4.v2-6)
> - 方案 C（收窄为 renderer derive from wire）：**批准** — wire 是手段不是目的，让 renderer 类型不再手写副本才是 plan §5 真正想解决的漂移
>
> **Phase 4 v2 验收目标**（替代原 v1）：
> 1. `src/renderer/types/electron.d.ts` 中 `TaskProjectionRecordData` + `TaskProjectionChangeEventData` 不再手写完整结构，从 `src/shared/ipc-contracts/task-projection.ts` 推导
> 2. 漂移 gate (`check-task-projection-wire-canonical.cjs`) 拒绝 electron.d.ts 重新声明 wire-canonical 类型的完整结构
> 3. 三个 IPC channel (`listTaskProjections` / `getTaskProjection` / `onTaskProjectionsChanged`) 有边界合同测试
> 4. 其余 v1 工作（U4.1d 63 internal move / U4.1e 删 run-contracts.ts / U4.2 preload 全 channel 推导）**降级为后续架构债**，列入 plan 附录
>
> 已完成（v1 残留）：
> - **U4.1a** `ce2978d0` — skeleton + 65 export 分类表 + run-contracts.ts 顶部注释
> - **U4.1b** — TaskProjectionChangeEvent + Reason 迁到 wire；main re-export
> - **U4.1c-deferred** `1abb8bc` — wire 文件扩展 TaskProjectionRecord/UnifiedTaskState/TaskStep/TaskBudget/RecoveryRecord wire 版本 (permissive)；main 端保留 strict 不 re-export wire
>
> **Phase 4 v2 待做** (6 PR)：

> 9 PR：U4.1a / U4.1b / U4.1c / U4.1d / U4.1e / U4.2a / U4.2b / U4.3a / U4.3b
> §0.3 时序图与 §13 时间预估均同步。

> v2 回应 D1-1/D1-3：U4.1 拆为 5 步，每步可独立 land 与回滚。

### U4.1a — 准备：export 分类表 + wire-contract 目录骨架（V3-1/N-2 修正：本 PR 不启用 gate）
- **依赖**：Phase 1 完成
- **改动**：
  - 在 `run-contracts.ts` 顶部为每个 export 加注释 `// WIRE` / `// INTERNAL`
  - 新建 `src/shared/ipc-contracts/` 目录骨架（空 index.ts）
  - 新建 `src/main/modules/agent-control/run-contracts-internal.ts`（空）
  - 提交分类表 `docs/superpowers/plans/U4.1-run-contracts-export-classification.md`（每个 export → wire/internal + 目标新文件）
  - **不**启用任何 wire-contract gate（在 U4.1d 启用）
- **行为合同变化**：无
- **受影响消费方**：无（仅注释 + 空文件）
- **新 CI gate**：无（本 PR 不引入 gate；gate 在 U4.1d 启用）
- **测试**：typecheck
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Plan
- **LOC**：300（含分类文档）

### U4.1b — 迁移 wire contracts: task-projection + scope-run
- **依赖**：U4.1a
- **改动**：
  - 新建 `src/shared/ipc-contracts/task-projection.ts`
  - 新建 `src/shared/ipc-contracts/scope-run.ts`
  - 从 `run-contracts.ts` 删除对应 export
  - 更新所有 import callsite
- **行为合同变化**：无（纯 move + import 改写）
- **受影响消费方（D3-4 回应）**：
  - main: `runtime.ts`、`run-coordinator.ts`、`task-projection-*`（共 18 文件）
  - preload: `src/preload/index.ts` 类型签名
  - renderer: `useAgent.ts`、`task-status-vocabulary.ts`、`taskCardViewModel.ts`
- **测试**：typecheck 是主要验收 + `npm run verify:c`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy（worktree）
- **LOC**：400（含 import 改写）

### U4.1c — 迁移 wire contracts: agent-runtime-status + capability-snapshot + tool-error
- **依赖**：U4.1b
- **改动**：同样模式，迁 3 个 wire contract
- **行为合同变化**：无
- **受影响消费方**：`runtime.ts`、`provider-runtime-resolver.ts`、renderer settings 页
- **测试**：typecheck + `verify:c`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：400

### U4.1d — 迁移 internal contracts + 启用 wire-contract-isolation gate（V3-1/N-2 实施点）
- **依赖**：U4.1c
- **改动**：
  - 把剩余 internal-only export 搬到 `run-contracts-internal.ts`
  - 更新 main 内 import
  - **启用 gate** `scripts/check-wire-contract-isolation.cjs`：此时 wire / internal 文件齐备，可以真实约束
- **行为合同变化**：renderer/preload 自此不能 import internal contract
- **受影响消费方**：main 全模块 import 改写（约 50 文件）
- **新 CI gate**：`check-wire-contract-isolation.cjs`
  - **实现**：AST — `src/preload/` 只能 import `src/shared/ipc-contracts/`；`src/renderer/` 不允许 import `agent-control/run-contracts-internal`
  - **接入**：PR check + verify:b + verify:cloud + merge gate
- **测试**：typecheck + `verify:c` + gate 通过 + `scripts/__tests__/check-wire-contract-isolation.test.cjs`（正反 fixture）
- **验收命令**：§0.6
- **回滚**：`git revert`（同 PR 内 gate 一起回滚）
- **agent**：R-Heavy
- **LOC**：500

### U4.1e — 删除原 run-contracts.ts
- **依赖**：U4.1d
- **改动**：
  - 删除空文件
  - 删除残留 re-export
  - 加入 gate：`scripts/check-no-run-contracts-file.cjs`（禁止 path 出现）
- **行为合同变化**：无
- **受影响消费方**：无
- **测试**：typecheck
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：50

### U4.2a — preload wrapper agent/skill channel 从 contract 推导
- **依赖**：U4.1e
- **改动**：重写 `src/preload/index.ts` 中 agent / skill 段；每个 invoke 标注 contract type
- **行为合同变化**：preload 类型紧绷
- **受影响消费方**：renderer 凡用 `electronAPI.agent.*` / `electronAPI.skills.*`
- **测试**：typecheck + `src/__tests__/preload-wrapper-agent-contract.test.ts`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Plan → R-Heavy
- **LOC**：400

### U4.2b — preload wrapper 其余 channel（browser/document/rss/calendar/settings/pet/memory/file-tree/local-html）从 contract 推导（D2-5 回应）
- **依赖**：U4.2a
- **改动**：同上模式，覆盖所有剩余 channel
- **行为合同变化**：preload 类型紧绷
- **受影响消费方**：renderer 全模块
- **新 CI gate**：`scripts/check-preload-uses-shared-contract.cjs`
  - **实现**：AST 检查 preload 内每个 `ipcRenderer.invoke('<channel>', ...)` 调用必须有 contract type 标注（**覆盖所有 channel，不限 `agent:`**）
  - **接入**：PR check + verify:b + merge gate
- **测试**：`src/__tests__/preload-wrapper-all-channels-contract.test.ts`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：500

### U4.3a — renderer types 推导：agent/skill/memory 段
- **依赖**：U4.2b
- **改动**：`src/renderer/types/electron.d.ts` 中 agent/skill/memory 段改为 `typeof preloadAPI.agent` 推导，删除手写
- **行为合同变化**：renderer 类型完全跟随 preload
- **受影响消费方**：renderer 凡 import `Window['electronAPI']['agent'|'skills'|'memory']` 的模块
- **测试**：typecheck + `npm run verify:c`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：400（删多增少）

### U4.3b — renderer types 推导：browser/document/rss/calendar/pet/settings/file-tree/local-html 段
- **依赖**：U4.3a
- **改动**：剩余段改为推导
- **行为合同变化**：同上
- **受影响消费方**：renderer 凡 import 这些段
- **测试**：typecheck + `npm run verify:c`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：500

**Phase 4 验收**：3 个新 gate（含反向 `check-ipc-handler-has-contract.cjs`，见 §10）通过；run-contracts.ts 不存在；electron.d.ts ≤ 1500 行；IPC schema 改动只需改 contract + handler + preload。

---

## 6. Phase 5 — 大文件与目录结构拆分（R-2 修正：12 PR，2-3 周）

> v2 回应 D1-2/D3-3：所有 PR 展开为独立小节；move-only 与 deps injection 分开拆。

### U5.1a — agent-control 子目录化（move-only，V3-2/N-3/C-2 修正：无 justification 后门）
- **依赖**：Phase 4 完成
- **改动**：按 §0.4 结构搬 168 文件到子目录
- **新 CI gate**：`scripts/check-move-only-pr.cjs`
  - **实现**：解析 git diff（针对标 `move-only: true` 的 PR）；允许的改动仅限：
    1. 文件 rename / move（含路径）
    2. import / require 路径调整
    3. re-export 文件创建
    4. 注释行（含中文）改动
  - 任何其它非空白改动（赋值、表达式、新函数、类型变化）一律拒绝；**没有 justification 后门**
  - 若一个 PR 必须同时改 move + 行为，必须拆为两个 PR：move-only + behavior-change
  - **接入**：PR check + verify:cloud + merge gate（仅对标 `move-only: true` 的 PR 触发）
- **测试**：typecheck + `npm run verify:c` + `npm run test`（关键 suite）+ `scripts/__tests__/check-move-only-pr.test.cjs`
- **验收命令**：§0.6
- **回滚**：`git revert`（不允许 cherry-pick 部分子目录）
- **agent**：R-Plan → R-Heavy
- **LOC**：~3000 import 改动（move-only PR，必须 100% 由 gate 验证通过；不允许任何例外）

### U5.1b — agent-control 子目录的 index.ts re-export
- **依赖**：U5.1a
- **改动**：每个子目录加 `index.ts` re-export 关键 API
- **行为合同变化**：无
- **测试**：typecheck
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：300

### U5.1c — FEATURE_MODULE_MAP.md 更新反映新结构
- **依赖**：U5.1b
- **改动**：更新 `FEATURE_MODULE_MAP.md` + `PROJECT_STRUCTURE_SNAPSHOT.md`
- **agent**：R-Implement
- **LOC**：≤ 200（doc only）

### U5.2 — document-task-pipeline-executor 等 13 文件搬到 document-engine
- **依赖**：U5.1c
- **改动**：从 `agent-control/document-pipeline/`（U5.1 子目录化后位置）搬到 `src/main/modules/document-engine/pipeline/`；建立 cross-engine API
- **行为合同变化**：无（move-only + import 改写）
- **测试**：typecheck + `npx tsx --test src/__tests__/document-task-pipeline*.test.ts`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：500 import 改动

### U5.3 — ChatPanel: markdown renderer 抽出
- **依赖**：无（与 5.x 并行）
- **改动**：抽 `src/renderer/modules/agent/markdown/`（MarkdownNode、parser、renderer）
- **行为合同变化**：无
- **受影响消费方**：ChatPanel 内对 markdown 的引用
- **测试**：现有 ChatPanel snapshot + `src/__tests__/agent-markdown-renderer.test.tsx`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Plan → R-Implement
- **LOC**：450

### U5.4 — ChatPanel: scope run view-model 抽出
- **依赖**：U5.3
- **改动**：抽 `ChatScopeRun.tsx` 子组件 + 同名 view-model
- **行为合同变化**：无
- **测试**：现有测试 + `src/__tests__/chat-scope-run.test.tsx`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：450

### U5.5 — ChatPanel: session recall capsule + attachment grid 抽出
- **依赖**：U5.4
- **改动**：抽 hook / 子组件
- **行为合同变化**：无
- **测试**：现有测试 + 新增
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Implement
- **LOC**：450

### U5.6 — claude-bridge/ipc-handler 拆分 + 完整 deps 注入（V3-4 补兼容说明）
- **依赖**：U5.1c
- **改动**：
  - 把 `claude-bridge/ipc-handler.ts` 2042 行的每个 channel handler 提取为独立 export 函数 `handle<Channel>(deps: HandlerDeps, payload): IPCResponse<T>`
  - deps 通过参数传，**一次性完成**（不允许"暂仍闭包捕获"中间态）
  - 主文件 `ipc-handler.ts` 只做 wiring：调用各 export 函数注册到 ipcMain
- **DomainAdapter / SkillContextOrchestrator 兼容性（V3-4）**：
  - `HandlerDeps` 必须包含完整的 `domainAdapterProvider`（由 `orchestrator.getDomainAdapters()` 提供）和 `skillContextOrchestrator`（由 `orchestrator.getSkillContextOrchestrator()` 提供）
  - 注入点：在 `setupAgentIPC()` 入口创建一个 `HandlerDeps` 实例，把 `agentManager / orchestrator / runtime / browserController / mainWindow` 全部聚合进去
  - 不允许 handler 重新构造 DomainAdapter / SkillContextOrchestrator（否则会破坏 U1.3 后 DirectChatEngine 的单一拥有者契约）
  - 若 handler 需要 lazy access，通过 `HandlerDeps.lazy<T>(getter)` 包装
  - 兼容性测试：`src/__tests__/claude-bridge-handler-deps-domain-adapter-singleton.test.ts`（断言注入的 DomainAdapter / SkillContextOrchestrator 与 orchestrator 拥有的是同一引用）
- **行为合同变化**：handler 签名变化；行为不变（DomainAdapter 单例性保持）
- **受影响消费方**：`ipc-handler.ts` 内 wiring + `main/index.ts` 调用 `setupAgentIPC` 处
- **Channel 清单**（必须全覆盖；以 `grep -rhE "ipcMain.handle\(['\"]agent" src/main/modules/claude-bridge/ipc-handler.ts | grep -oE "['\"]agent[^'\"]+['\"]"` 为准）
- **新增测试**：
  - `src/__tests__/claude-bridge-ipc-handler-registration.test.ts`
  - `src/__tests__/claude-bridge-handler-deps-domain-adapter-singleton.test.ts`
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Plan → R-Heavy
- **LOC**：500（接近上限；若超必拆 5.6-1/2 按 channel 分组）

### U5.7 — rss-engine/ipc-handler 拆分 + deps 注入（V3-3/N-5 实际枚举）
- **依赖**：U5.1c
- **改动**：同 U5.6 模式
- **行为合同变化**：同 U5.6
- **受影响消费方**：仅 `rss-engine/ipc-handler.ts` 内 wiring + RSSHub manager 注入点
- **Channel 清单**（v4 从 `src/main/modules/rss-engine/ipc-handler.ts` 实际 grep，**全 23 个**，无 grep 占位）：
  1. `rss:addSource`
  2. `rss:benchmarkSources`
  3. `rss:clearDraftStore`
  4. `rss:deleteAnalysisJob`
  5. `rss:deleteItems`
  6. `rss:diagnostics`
  7. `rss:exportOpml`
  8. `rss:fetchAll`
  9. `rss:getDraftStoreSources`
  10. `rss:getItemAnalysisProgress`
  11. `rss:getItems`
  12. `rss:getSources`
  13. `rss:listItemAnalysisJobs`
  14. `rss:markRead`
  15. `rss:markReadBatch`
  16. `rss:pauseAnalysisJob`
  17. `rss:refreshSource`
  18. `rss:removeSource`
  19. `rss:repairRuntime`
  20. `rss:resumeAnalysisJob`
  21. `rss:stats`
  22. `rss:status`
  23. `rss:toggleStarred`
- **新增测试**：`src/__tests__/rss-ipc-handler-registration.test.ts`（断言 23 channel 全注册 + 配套 contract 存在）
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：500（若超过则按 channel 数 12+11 拆为 5.7a/b）

### U5.8 — browser-engine/ipc-handler 拆分 + deps 注入（V3-3/N-5 实际枚举）
- **依赖**：U5.1c
- **改动**：同模式
- **Channel 清单**（v4 从 `src/main/modules/browser-engine/ipc-*.ts` 实际 grep，**全 46 个**，X-6 修正：）：
  1. `browser:addBookmark`
  2. `browser:captureViewportSnapshot`
  3. `browser:captureWindowSnapshot`
  4. `browser:clearDownloads`
  5. `browser:clearHistory`
  6. `browser:clipCurrentTab`
  7. `browser:clipDraggedTab`
  8. `browser:closeTab`
  9. `browser:contentStudyDraggedTab`
  10. `browser:createTab`
  11. `browser:downloadUrlToDirectory`
  12. `browser:exportBookmarks`
  13. `browser:fitActiveTabToBounds`
  14. `browser:getAdblockState`
  15. `browser:getBookmarks`
  16. `browser:getDiagnostics`
  17. `browser:getDownloads`
  18. `browser:getHistory`
  19. `browser:getTabContext`
  20. `browser:getTabs`
  21. `browser:goBack`
  22. `browser:goForward`
  23. `browser:hideActiveHost`
  24. `browser:hideAll`
  25. `browser:importBookmarks`
  26. `browser:isBookmarked`
  27. `browser:navigate`
  28. `browser:openForCaptureTarget`
  29. `browser:previewClose`
  30. `browser:previewGetState`
  31. `browser:previewGoBack`
  32. `browser:previewGoForward`
  33. `browser:previewNavigate`
  34. `browser:previewOpen`
  35. `browser:previewReload`
  36. `browser:print`
  37. `browser:reload`
  38. `browser:removeBookmark`
  39. `browser:reorderTabs`
  40. `browser:searchHistory`
  41. `browser:setAdblockEnabled`
  42. `browser:showActive`
  43. `browser:showUtilityMenu`
  44. `browser:switchTab`
  45. `browser:toggleAdblockDomain`
  46. `browser:updateBounds`
- **新增测试**：`src/__tests__/browser-ipc-handler-registration.test.ts`（断言 46 channel 全注册）
- **特殊**：browser-engine 现已分 ipc-data/ipc-shell/ipc-clip/ipc-clip-dragged-tab/ipc-content-study-dragged-tab 等子文件；本 PR **不重新合并**，只在每个子文件内做 deps 注入改造
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：500（必要时按子文件拆 5.8a/b/c）

### U5.9 — document-engine/ipc-handler 拆分 + deps 注入（V3-3/N-5 实际枚举）
- **依赖**：U5.1c
- **改动**：同模式
- **Channel 清单**（v4 从 `src/main/modules/document-engine/ipc-handler.ts` 实际 grep，**全 25 个**）：
  1. `document:copy`
  2. `document:createFile`
  3. `document:createMark`
  4. `document:delete`
  5. `document:deleteMark`
  6. `document:exportWorkspace`
  7. `document:getHome`
  8. `document:importEbookAsMarkdown`
  9. `document:importWorkspace`
  10. `document:list`
  11. `document:listMarks`
  12. `document:mkdir`
  13. `document:move`
  14. `document:openFolder`
  15. `document:openPath`
  16. `document:parseDocx`
  17. `document:parseXlsx`
  18. `document:read`
  19. `document:rename`
  20. `document:saveAs`
  21. `document:showInFolder`
  22. `document:stat`
  23. `document:updateMark`
  24. `document:watchDirectories`
  25. `document:write`
- **新增测试**：`src/__tests__/document-ipc-handler-registration.test.ts`（断言 25 channel 全注册）
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Heavy
- **LOC**：450

### U5.10 — Phase 5 收口：channel 双向注册完整性（N-6 回应）
- **依赖**：U5.6/U5.7/U5.8/U5.9 全部完成
- **改动**：
  - 新建 `src/__tests__/all-ipc-channels-registered.test.ts`：
    1. **正向**：遍历 `src/shared/ipc-contracts/` 所有 channel，断言每个 channel 有 main handler + preload wrapper
    2. **反向（v3 新增）**：遍历 `src/main/**/ipc-handler*.ts` 的所有 `ipcMain.handle('<channel>', ...)`，断言每个 channel 在 `src/shared/ipc-contracts/` 有对应 schema
  - 启用 gate `scripts/check-ipc-handler-has-contract.cjs`（C-1，反向 gate）
- **新 CI gate**：`scripts/check-ipc-handler-has-contract.cjs`
  - **实现**：AST 扫描所有 `ipcMain.handle('<channel>', ...)`；查 `src/shared/ipc-contracts/**` 内是否有对应 schema export
  - **接入**：PR check + verify:b + merge gate
- **行为合同变化**：无
- **测试**：本测试 + typecheck
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Plan → R-Implement
- **LOC**：300

**Phase 5 验收**：每个目标文件 ≤ 800 行；channel 注册完整性测试通过；FEATURE_MODULE_MAP 反映新结构；现有 test suite 全绿。

---

## 7. Phase 6 — verify chain 自身瘦身（2 PR，3-5 天，**必须等 Phase 5 完成**）

### U6.1 — provider/research 检查族合并
- **依赖**：Phase 5 完成（D5-3 回应）
- **改动**：合并 6 个 research check + AI capability check 族
- **行为合同变化**：单 gate 失败提供更多上下文；总 gate 数 ↓ 8
- **测试**：`scripts/__tests__/check-research-routing.test.cjs` 等
- **验收命令**：§0.6 + `npm run verify`（仍通过）
- **回滚**：`git revert`
- **agent**：R-Plan → R-Implement
- **LOC**：400

### U6.2 — gate 索引建立 + 强制更新规则
- **依赖**：U6.1
- **改动**：`scripts/__gate-index__.md` + `check-gate-index-complete.cjs`
- **新 CI gate**：`check-gate-index-complete.cjs`
  - **接入**：PR check + verify:a0 + merge gate
- **验收命令**：§0.6
- **agent**：R-Implement
- **LOC**：300 + 索引

**Phase 6 验收**：`npm run verify` 总耗时 ↓ ≥ 20%；新加 gate 必须更新索引（机器强制）。

---

## 8. Phase 7 — 真实工作流 e2e 补齐（X-2 修正：11 PR，并行 1-2 周）

> v2 回应 D1-4/D3-5：每 PR 加 Blocked-by + Blocks；明确 fixture/artifact/失败定位字段。

> v3：每个 U7.x 都补 **Blocked by / Blocks / Fixture / Golden artifact / 失败定位字段 / artifact 保留规则**（D1-4 + D3-5 残余）

### U7.1a — Browser Agent V7 e2e: 附件挂载 + prompt 提交链路
- **Blocked by**：Phase 1 完成 + Phase 2 完成
- **Blocks**：U7.1b, U7.7
- **覆盖**：附件挂载 → prompt 自动进入正确输入区 → 提交后运行态证据可见
- **Fixture**：`src/__tests__/e2e/fixtures/browser-agent-v7/`（HTML 页面 + 预录 LLM response）
- **Golden artifact**：`tests/golden/browser-agent-v7-attach-submit.json`
- **失败定位字段**：每 step `{ step, status, evidence, artifactPath, screenshotPath, ts }`
- **Artifact 保留**：`test-results/u7.1a/<runId>/`，保留 ≥ 7 天
- **agent**：R-Plan → R-Implement
- **LOC**：400

### U7.1b — Browser Agent V7 e2e: 产物可重新打开
- **Blocked by**：U7.1a
- **Blocks**：U7.7
- **覆盖**：U7.1a 结束后 reload renderer → 产物可重新打开 → 状态正确恢复
- **Fixture**：复用 U7.1a
- **Golden artifact**：`tests/golden/browser-agent-v7-reopen.json`
- **失败定位字段**：同上
- **Artifact 保留**：同上
- **agent**：R-Implement
- **LOC**：300

### U7.2 — Document/Widget e2e
- **Blocked by**：Phase 1 + Phase 3 + U5.2（document-pipeline 已搬迁）
- **Blocks**：U7.7, U7.8
- **覆盖**：多资源输入 → widget 更新上下文不被 live-info 污染 → H1/H2 降级
- **Fixture**：`src/__tests__/e2e/fixtures/document-widget/`（markdown sample + 多附件）
- **Golden artifact**：`tests/golden/document-widget-multi-source.json`
- **失败定位字段**：`{ step, widgetId, skeletonChoice, sourceRoles, evidence, artifactPath }`
- **Artifact 保留**：`test-results/u7.2/<runId>/`
- **agent**：R-Implement
- **LOC**：500

### U7.3 — Remote attachment + Scope isolation e2e（D4-3 / C-6 / C-7 配套）
- **Blocked by**：Phase 1 完成
- **Blocks**：U7.7
- **覆盖**：
  - 远程图片下发只入资源层；不自动触发 agent
  - 跨频道/线程 scope 隔离（飞书线程 A 附件不进本地 conversation B）
  - 工具日志只出现在前台运行态/胶囊层，不进 transcript
- **Fixture**：`src/__tests__/e2e/fixtures/remote-attachment/`（mock 飞书 channel + 本地 conv）
- **Golden artifact**：`tests/golden/remote-attachment-scope-isolation.json`
- **失败定位字段**：`{ step, sourceChannel, threadKey, conversationId, agent, attachmentIds, transcriptKeys }`
- **Artifact 保留**：`test-results/u7.3/<runId>/`
- **行为测试**（配 gate C-6/C-7）：
  - `src/__tests__/scope-isolation-three-dim.test.ts`
  - `src/__tests__/tool-log-stays-in-runtime-not-transcript.test.ts`
- **agent**：R-Plan → R-Implement
- **LOC**：500

### U7.4 — `/skill` `/doc` parity
- **Blocked by**：Phase 1（authorization）+ U1.5
- **Blocks**：U7.7
- **覆盖**：两命令的 visibility / authorization / projection 等价
- **Fixture**：`src/__tests__/e2e/fixtures/command-parity/`
- **Golden artifact**：`tests/golden/skill-doc-command-parity.json`
- **失败定位字段**：`{ step, command, visibleTools, authorization, projectionSnapshot }`
- **Artifact 保留**：`test-results/u7.4/<runId>/`
- **agent**：R-Implement
- **LOC**：500

### U7.5a — Live provider smoke runner + 配置基础设施（D5-4 / D3-5 v4 补字段）
- **Blocked by**：Phase 6 完成
- **Blocks**：U7.5b
- **改动**：
  - 新建 `verify:release-smoke` chain（独立，**不阻塞主 verify / verify:cloud**）
  - 新建 `src/__tests__/e2e/live-provider-smoke-runner.ts` + 配置加载
  - 缺 `READY_LIVE_PROVIDER_KEYS` 时整套 skip 并打印 message
  - Quota 限制（默认 ≤ 3 call / provider）+ retry ≤ 2 + 超时 30s
- **Fixture**：`src/__tests__/e2e/fixtures/live-provider-smoke-runner/`（mock keys 用于 dry-run；真实 key 由环境变量提供）
- **Golden artifact**：`tests/golden/live-provider-smoke-runner-skip-output.json`（缺 key 时 runner 输出格式）
- **失败定位字段**：`{ phase, provider, quotaUsed, retryCount, timedOut, skipReason }`
- **Artifact 保留**：`test-results/u7.5a/<runId>/`，保留 14 天
- **新 CI gate**：`scripts/check-e2e-fixture-index.cjs`
  - **实现**：扫描 `src/__tests__/e2e/`，要求每个 e2e 在 `tests/e2e-fixture-index.json` 注册（含 fixture 路径 / golden 路径 / artifact 保留期）
  - **接入**：PR check + verify:cloud
- **agent**：R-Plan → R-Implement
- **LOC**：400

### U7.5b — Live provider smoke: OpenAI-compatible / Moonshot / Volcengine / Gemini
- **Blocked by**：U7.5a
- **Blocks**：无
- **覆盖**：4 channel × (vision + tools) smoke
- **Fixture**：`src/__tests__/e2e/fixtures/live-provider-smoke/`（最小 prompt + tool schema）
- **Golden artifact**：每 provider 一份 `tests/golden/live-provider-<name>-smoke.json`
- **失败定位字段**：`{ provider, channel, capability, request, response, capabilityDriftDetected }`
- **Artifact 保留**：14 天（live 数据更需长期回溯）
- **供应商能力漂移检测**：若 `supportsNativeToolCalls` 或 vision 与本地配置不符则 fail，提示更新 `ai-providers.ts`
- **agent**：R-Implement
- **LOC**：400

### U7.6a — BrowserView native surface 回归 e2e: hideAll/showActive/bounds 顺序
- **Blocked by**：Phase 0 完成
- **Blocks**：U7.6b, U7.7
- **覆盖**：
  - 显示 DOM overlay 前必须 `browser.hideAll()`
  - 恢复时 `showActive()` 后同步 bounds
  - 4 模式切换冻结帧（捕获 viewport snapshot）
- **配套 gate C-5**：`scripts/check-browserview-overlay-order.cjs`
  - **实现**：TS AST 检查 renderer 内任何 `showOverlay/showPanel/showModal` 调用，必须在 5 行内有 `browser.hideAll()` 前置
- **Fixture**：`src/__tests__/e2e/fixtures/browser-overlay/`
- **Golden artifact**：`tests/golden/browser-overlay-order.json`
- **失败定位字段**：`{ step, overlayKind, hideAllCalled, bounds, screenshotPath }`
- **Artifact 保留**：`test-results/u7.6a/<runId>/`，保留 7 天
- **agent**：R-Plan → R-Implement
- **LOC**：350

### U7.6b — BrowserView native surface 回归 e2e: DOM 抽屉 + 下载 + 拖拽 + popup
- **Blocked by**：U7.6a
- **Blocks**：U7.7
- **覆盖**：剩余 native surface 交互
- **Fixture**：复用 U7.6a + 加 download/drag fixture
- **Golden artifact**：`tests/golden/browser-drawer-download-drag-popup.json`
- **失败定位字段**：同 U7.6a + `{ interactionKind }`
- **Artifact 保留**：同上
- **agent**：R-Implement
- **LOC**：350

### U7.7 — Browser/Agent/Settings 基础回归套件
- **Blocked by**：U7.1a, U7.1b, U7.2, U7.3, U7.4, U7.6a, U7.6b
- **Blocks**：U7.8
- **覆盖**：U0.4 已建立的 phase smoke runner 补全为完整套件（Browser tab 切换、Agent send/done、Settings 保存重启读出）
- **改动**：把 U0.4 的最小 smoke 扩展为生产级回归，每条 smoke 配独立测试
- **Fixture**：`src/__tests__/e2e/fixtures/key-page-regression/`
- **Golden artifact**：`tests/golden/key-page-regression-smoke.json`
- **失败定位字段**：`{ pageKind, action, expectedState, actualState, screenshotPath }`
- **Artifact 保留**：`test-results/u7.7/<runId>/`
- **agent**：R-Plan → R-Implement
- **LOC**：500

### U7.8 — LESSONS_LEARNED 三类坑回归（D6-7 回应）
- **Blocked by**：U7.6b + U7.7
- **Blocks**：无
- **覆盖**：
  - ABI 坑：`verify:native` 在 Electron rebuild 后立即检测到 ABI mismatch（行为测试 + 提示文案）
  - BrowserView 层级：从 panel 打开下拉菜单，菜单不被 BrowserView 遮挡
  - Widget target 污染：上轮 widget 编辑后下一句普通问答 target 不带入
- **Fixture**：`src/__tests__/e2e/fixtures/lessons-learned-regression/`
- **Golden artifact**：3 个 golden 各对应一类
- **失败定位字段**：`{ lessonKind, repro步骤, expectedRegressionGuarded, actualBehavior }`
- **Artifact 保留**：`test-results/u7.8/<runId>/`，保留 ≥ 30 天（lesson 类长期回溯）
- **配套 gate**：本 PR 同时启用 `check-e2e-artifact-retention.cjs`（C-10）
- **agent**：R-Plan → R-Implement
- **LOC**：500

**Phase 7 验收（N-1 修正）**：**11 个 e2e PR** 全绿（U7.1a/b + U7.2/3/4 + U7.5a/b + U7.6a/b + U7.7/8）；e2e fixture index gate 通过；phase smoke gate 启用并扩为生产级套件；artifact retention gate 通过。

---

## 9. Phase 8 — audit 漏包（X-3 修正：11 PR，与 Phase 1-3 并行，1-2 周）

> 11 PR（物理 PR 数）：U8.0 / U8.1 / U8.2 / U8.3 / U8.4 / U8.5a / U8.5b / U8.6 / U8.6.1 / U8.7 / U8.8

> v2 新增（D6 回应）；v3 新增 U8.0（C-3 skill_executions 复活防护）

### U8.0 — 禁止 skill_executions 复活（C-3 回应）
- **依赖**：无（与 U0.x 并行）
- **改动**：
  - 新建 `scripts/check-no-skill-executions-resurrection.cjs`
  - 直接 grep 整仓（含 migrations、repositories、IPC、tools）禁止以下符号重新出现：
    - `skill_executions` 表名（DDL / SQL string）
    - `SkillExecutionState` / `SkillExecutionWorkflow` 类
    - `skill:execution:*` IPC channel
    - `workflow-coordinator` 路径
  - 加入 verify chain
- **行为合同变化**：无（结构性 gate）
- **受影响消费方**：无
- **新 CI gate**：`check-no-skill-executions-resurrection.cjs`
  - **接入**：PR check + verify:a0 + verify:cloud + merge gate
- **测试**：`scripts/__tests__/check-no-skill-executions-resurrection.test.cjs`（正反 fixture）
- **验收命令**：§0.6
- **回滚**：删 gate
- **agent**：R-Implement
- **LOC**：100

### U8.1 — Search worker fallback 可观测性
- **依赖**：无
- **改动**：`src/main/modules/search-engine/` worker fallback 路径增加 metric `search.worker_fallback` + reason 字段 + 连续失败 N 次时主动 diagnose 提示
- **测试**：`src/__tests__/search-worker-fallback-observability.test.ts`
- **agent**：R-Implement
- **LOC**：200

### U8.2 — RSS 平台 adapter 化（D6-2 回应）
- **依赖**：无
- **改动**：
  - 新建 `src/main/modules/rss-engine/platform-adapters/` 目录
  - 每个平台（小红书、公众号、B 站、知乎、普通 RSS）一个 `<platform>-adapter.ts`，导出 `detect / validate / extract / normalize`
  - `scrapers/index.ts` 与 `browser-acquisition.ts` 改为通过 adapter 协调
- **新 CI gate**：`scripts/check-rss-platform-rule-single-source.cjs`
  - 拒绝 `detectPlatform` / 平台正则在 adapter 文件之外定义
- **测试**：每个 adapter 单测 + `src/__tests__/rss-platform-detection-acquisition-consistency.test.ts`
- **agent**：R-Plan → R-Implement
- **LOC**：500

### U8.3 — Settings legacy Tavily/Jina key 一次性切断 + 退场 gate（V3-7 修正：无保留窗口）
- **依赖**：无
- **改动（V3-7 修正）**：
  - `src/main/modules/settings-engine/external-service-store.ts`：**同 PR 内直接切断旧 key 读取路径**
  - 一次性迁移：本 PR 提供一个 `migrateLegacyKeysOnce()` 工具，仅在首次启动时把旧 key 读出并写到新 store；migrate 完成后立即删除旧 key
  - **无"保留一个 release 窗口"**：旧路径在同 PR 内物理消失
  - **紧急回滚机制**：用 feature flag `READY_SETTINGS_RESTORE_LEGACY_KEYS=1` 提供 24h 紧急回退窗口，flag 不可写入产品默认配置；超过 30 天后由 U8.3 跟进 PR 删除该 flag
  - 一次性迁移日志 `settings.legacy_key_migration_completed`（含 migrated count）
- **新 CI gate**：`scripts/check-settings-no-legacy-key-read.cjs`
  - **实现**：扫描 `settings-engine/` 与 repositories；拒绝任何 `legacyTavilyKey` / `legacyJinaKey` 读取代码存在（除 `migrateLegacyKeysOnce()` 函数本身）
  - **接入**：PR check + verify:b + verify:cloud + merge gate（**本 PR land 后立即 hard fail 全仓违规**）
- **测试**：
  - `src/__tests__/settings-legacy-key-one-shot-migration.test.ts`（迁移一次后旧 key 被清空）
  - `src/__tests__/settings-no-legacy-key-read-after-migration.test.ts`（迁移后再读应失败）
  - `src/__tests__/settings-emergency-feature-flag-restore.test.ts`（feature flag 紧急回退路径）
- **agent**：R-Plan → R-Implement
- **LOC**：350

### U8.4 — Embedded skills 三目录 manifest/asset/eval/sandbox parity
- **依赖**：无
- **改动**：
  - 把 `assets/embedded-skills/fastnote/`、`image-analysis-router/`、`study-notes/` 三目录加入 git tracking
  - 每个 skill 跑 checklist（见 audit §2.6）：SKILL.md frontmatter / manifest / fixture / sandbox host requirements / primitive allowlist
- **新 CI gate**：`scripts/check-embedded-skill-manifest-asset-parity.cjs`（已存在 `check-embedded-skill-manifest-vs-asset-parity.cjs`，确认覆盖三新 skill）
- **测试**：3 skill 各一个 manifest/schema/eval 测试
- **agent**：R-Plan → R-Implement
- **LOC**：500（含 fixture）

### U8.5a — skill-child-runner.ts 拆分（D1-1 残余 / D6-5）
- **依赖**：U5.1 完成
- **Blocks**：U8.5b（无强阻塞，纯组织）
- **改动**：`skill-child-runner.ts` 3217 行 → 拆为 4 模块：
  - `skill-child-lifecycle.ts`（启停 / 状态转移）
  - `skill-child-spawn.ts`（进程创建 / 环境）
  - `skill-child-ipc-bridge.ts`（与父进程 IPC）
  - `skill-child-state-machine.ts`（状态机已存在，吸收剩余 state 逻辑）
- **行为合同变化**：无（move + 必要接口提取）
- **测试**：现有 `src/__tests__/skill-child-*.test.ts` 全绿 + 4 模块单测
- **验收命令**：§0.6 + `npm run test:serial-skill-child`
- **回滚**：`git revert`
- **agent**：R-Plan → R-Heavy
- **LOC**：500（接近上限）

### U8.5b — document-widget-openui.ts 拆分
- **依赖**：U5.1 完成
- **改动**：`document-widget-openui.ts` 1561 行 → 拆为 4 模块：
  - `document-widget-openui-parse.ts`
  - `document-widget-openui-validate.ts`
  - `document-widget-openui-render.ts`
  - `document-widget-openui-patch.ts`
- **行为合同变化**：无
- **测试**：现有 widget openui 测试 + 4 模块单测
- **验收命令**：§0.6
- **回滚**：`git revert`
- **agent**：R-Plan → R-Heavy
- **LOC**：500（接近上限）

### U8.6 — Windows release-readiness（D6-6 / N-9 / C-9 强化）
- **依赖**：Phase 0
- **改动**：
  - 在 Windows 环境跑 `npm run verify:native`、`npm run build`、`npm run typecheck`、`npm run verify:a0`、`npm run verify:c`
  - 修补 Windows path / line ending / case-sensitive 问题
  - 文档：`docs/release/windows-release-checklist.md`（dev / build / sign / distribute 步骤）
  - **新增 CI matrix（N-9 强化）**：Windows runner 跑
    1. `npm run typecheck`
    2. `npm run verify:a0`
    3. `npm run verify:native`（含 `electron-rebuild` + 真实 SQLite 加载）
    4. `npm run build`（产出 NSIS installer）
    5. `npm run verify:c`（核心 agent runtime gate）
- **新 CI gate**：
  - `scripts/check-windows-path-portability.cjs`
    - 扫描 source `path.join` / `path.resolve` 调用，禁止硬编码 `/` 或 `\\`；要求用 `path.sep` 或 `path.posix` / `path.win32`
    - **接入**：PR check + verify:b + merge gate
- **测试**：CI matrix（必须；不允许只在本地手测）
- **agent**：R-Plan → R-Implement（必要时 R-Codex 协助 Windows-specific 问题）
- **LOC**：600（含 fix + 文档 + CI config）

### U8.6.1 — verify:native-trigger gate（C-8 独立 PR，V3 C-8 / D4-4 落实）
- **依赖**：U8.6（Windows CI matrix 已建立）
- **改动**：
  - 新建 `scripts/check-verify-native-trigger.cjs`
  - **触发路径定义**（PR diff 内含任一即必须跑 `npm run verify:native`）：
    - `src/main/modules/database.ts`
    - `src/main/modules/database/**`
    - `src/main/modules/repositories/**`
    - `src/main/modules/migrations.ts`
    - `src/main/modules/settings-engine/**`
    - `package.json` 内 `better-sqlite3` 版本
    - `electron` / `electron-builder` 主版本
  - PR CI 自动判断：若 diff 命中触发路径，PR 必须有 `verify:native` 运行 artifact（GitHub Actions log 或 PR comment 附 token）
- **行为合同变化**：所有触发路径的 PR 必须显式跑 verify:native
- **新 CI gate**：`check-verify-native-trigger.cjs`
  - **接入**：PR check + merge gate
- **测试**：`scripts/__tests__/check-verify-native-trigger.test.cjs`（正反 diff fixture）
- **验收命令**：§0.6
- **回滚**：删 gate
- **agent**：R-Plan → R-Implement
- **LOC**：250

### U8.7 — LESSONS_LEARNED 验收清单建档
- **依赖**：U8.6 + U8.6.1
- **改动**：
  - 整理 `LESSONS_LEARNED.md` 中所有「固化规则」段落，提取为可验证清单
  - 每条要么对应一个 CI gate / 行为测试，要么明确标 "manual verification at Stage U release"
  - 输出 `docs/release/u-stage-lessons-learned-checklist.md`
- **agent**：R-Plan → R-Implement
- **LOC**：≤ 300 doc only

### U8.8 — 删除 settings legacy key emergency feature flag（X-5 编号 + 排期）
- **依赖**：U8.3 land 满 30 天
- **Blocks**：无
- **改动**：
  - 删除 U8.3 引入的 `READY_SETTINGS_RESTORE_LEGACY_KEYS` feature flag 全部分支
  - 删除 `migrateLegacyKeysOnce()` 函数（迁移已完成，无需再保留）
  - 检查 30 天内 metric `settings.legacy_key_migration_completed`：若有用户最近 30 天才完成迁移，延后本 PR 30 天
- **行为合同变化**：紧急回退路径彻底消失（架构红线 3 收口）
- **受影响消费方**：仅 `settings-engine/`
- **新 CI gate**：升级 `check-settings-no-legacy-key-read.cjs`：本 PR 后禁止 `migrateLegacyKeysOnce` / `READY_SETTINGS_RESTORE_LEGACY_KEYS` 任一字面量出现
- **测试**：`src/__tests__/settings-legacy-key-emergency-flag-removed.test.ts`
- **验收命令**：§0.6
- **回滚**：`git revert`（仅适用 24h 内回退；超过 24h 必须前向修复）
- **agent**：R-Implement
- **LOC**：100

**Phase 8 验收（X-3 修正）**：**11 个 PR**（U8.0/U8.1/U8.2/U8.3/U8.4/U8.5a/U8.5b/U8.6/U8.6.1/U8.7/U8.8）全 merge；audit §2 全部覆盖；Windows 与本地 macOS 行为等价；settings legacy key 路径完全消失。

---

## 10. CI gate 总览（v6）

> v3 强化（保留至 v6）：所有 P0/P1 gate **merge gate + verify chain + PR check** 三档；新增 C-1/C-3/C-5/C-6/C-7/C-8/C-10 gate；smoke + e2e fixture 接入 verify:cloud。

| Gate | Phase | 实现 | gate-tier | verify chain | 配套行为测试 |
|---|---|---|---|---|---|
| `check-no-ipcmain-emit-truthy.cjs` | 0 | TS AST + taint | merge | verify:a0 + verify:cloud | legacy-tool-execute-bridge-removed.test.ts |
| `check-phase-smoke-gate.cjs` | 0 (U0.4) | meta | merge | per-phase label trigger | phase-smoke-runner.test.ts |
| `check-tool-error-shape.cjs` | 1 | TS AST | merge | verify:b + verify:cloud | tool-error-shape-*.test.ts (4) + renderer-soft-failure-capsule-tool-not-registered.test.tsx |
| `check-no-legacy-agent-ipc.cjs` | 1 | grep + AST | merge | verify:a0 + verify:cloud | legacy-agent-ipc-removed.test.ts |
| `check-turn-engine-no-domain-branch.cjs` | 1 | TS AST（含 enum + 常量）| merge | verify:c + verify:cloud | pet-sticky-note-reminder + browser-task-correction-reminder + turn-engine-reminder-delegation |
| `check-read-skill-visibility-single-source.cjs` | 1 | AST | merge | verify:p | read-skill-visibility-helper.test.ts |
| `check-no-fire-and-forget.cjs` | 2 | TS AST 5 形态 | merge | verify:l + verify:cloud | runtime-projection-sync-failure-observable + detached-tracker-cleanup-failure-marked + hook-registry-timeout-abort |
| `check-input-boundary-coverage.cjs` | 3 | TS AST | merge | verify:e + verify:cloud | file-tree-drop-failure-shows-toast + 3 others |
| `check-silent-catch.cjs` 升级 | 3 | grep | merge | verify:e + verify:cloud | 同 input-boundary 配套 |
| `check-wire-contract-isolation.cjs` | 4 | AST | merge | verify:b + verify:cloud | preload-wrapper-agent-contract + preload-wrapper-all-channels-contract |
| `check-preload-uses-shared-contract.cjs` | 4 | AST 全 channel | merge | verify:b + verify:cloud | 同上 |
| `check-no-run-contracts-file.cjs` | 4 | path | merge | verify:a0 | — |
| **`check-ipc-handler-has-contract.cjs`（C-1 新）** | 4 (U5.10) | AST 反向 | merge | verify:b + verify:cloud | all-ipc-channels-registered.test.ts |
| `check-move-only-pr.cjs` | 5 | git diff parser | merge | PR check + verify:cloud | — |
| `check-research-routing.cjs`（合并版）| 6 | TS AST | merge | verify:r | check-research-routing.test.cjs |
| `check-ai-capability-contract.cjs`（合并版）| 6 | TS AST | merge | verify:s | — |
| `check-gate-index-complete.cjs` | 6 | path + 索引 | merge | verify:a0 | — |
| `check-e2e-fixture-index.cjs` | 7 | path + 索引 | PR check | verify:f:e2e + verify:cloud | — |
| **`check-browserview-overlay-order.cjs`（C-5 新）** | 7 (U7.6a) | TS AST | merge | verify:b + verify:cloud | browserview-overlay-hideAll-before-showOverlay.e2e.ts |
| **`check-scope-key-three-dim.cjs`（C-6 新）** | 7 (U7.3) | TS AST | merge | verify:b + verify:cloud | scope-isolation-three-dim.test.ts |
| **`check-tool-log-not-in-transcript.cjs`（C-7 新）** | 7 (U7.3) | TS AST | merge | verify:b + verify:cloud | tool-log-stays-in-runtime-not-transcript.test.ts |
| **`check-e2e-artifact-retention.cjs`（C-10 新）** | 7 (U7.8) | meta | merge | verify:f:e2e | — |
| `check-rss-platform-rule-single-source.cjs` | 8 | AST | merge | verify:b + verify:cloud | rss-platform-detection-acquisition-consistency.test.ts |
| `check-embedded-skill-manifest-asset-parity.cjs` | 8 | 文件存在 | merge | verify:s | 3 skill fixture 测试 |
| `check-windows-path-portability.cjs` | 8 | TS AST | merge | verify:b + verify:cloud | Windows CI matrix |
| **`check-no-skill-executions-resurrection.cjs`（C-3 新）** | 8 (新单 PR U8.0) | grep + DDL scan | merge | verify:a0 + verify:cloud | — |
| **`check-verify-native-trigger.cjs`（C-8 新）** | 8 (U8.6 配套) | PR diff classifier | merge | PR check | — |
| **`check-settings-no-legacy-key-read.cjs`（N-8 新）** | 8 (U8.3) | AST + 版本判断 | merge | verify:b | settings-legacy-key-retired-version.test.ts |

## 11. PR 描述模板 v6

```markdown
## U<phase>.<seq> — <标题>

### 改动摘要
- <一句话>

### 行为合同变化
- [ ] 无（move-only）— 必须由 `check-move-only-pr.cjs` 验证
- [ ] 有：<列具体合同 + 受影响 channel/event/类型>

### 受影响消费方
- main: <文件列表>
- preload: <文件列表>
- renderer: <文件列表>
- test: <文件列表>
- 文档: <文件列表>

### 改动文件
- src/...:<line>

### 新增 CI gate（如有）
- scripts/check-<name>.cjs — <不变量>
- gate-tier: [merge | PR check | verify chain]
- 接入: verify:<阶段>

### 验收命令（必须包含 §0.6 最小集合）
```bash
npm run typecheck
npm run lint:check
node scripts/check-eslint-baseline.cjs
node scripts/check-no-fire-and-forget.cjs   # Phase 2 后
node scripts/check-silent-catch.cjs          # Phase 3 后
node scripts/check-wire-contract-isolation.cjs   # Phase 4 后
# 涉及 SQLite/settings/local persistence 时：
npm run verify:native
# PR 特定：
node scripts/check-<name>.cjs
npx tsx --test src/__tests__/<name>.test.ts
```

### 关键页面回归（D4-5）
- [ ] Browser tab 切换无视觉异常
- [ ] Agent 本地会话 send 收到 done
- [ ] Settings 保存后重启保留
- [ ] N/A（理由：<说明>）

### 回滚
```bash
git revert <sha>
```
分步 revert 顺序（若需）：1. <step> 2. <step>

### 依赖
- Blocked by: U<...>
- Blocks: U<...>

### 关联 audit / lesson
- docs/superpowers/audits/2026-05-20-ready-deep-review-and-refactor-plan.md §<n>
- LESSONS_LEARNED.md §<n>（如适用）
```

## 12. 风险与回滚总策略（v6）

| 风险 | 缓解 |
|---|---|
| Phase 1 tool error shape 改动破坏模型行为 | U1.1 拆 source + consumers（必要时再拆 1.1a/1.1b）；上线后 24h 监控 `tool.error.shape_mismatch` |
| Phase 2 fire-and-forget 改造引入 unhandledRejection | U2.4 gate 上线前 staging 跑 24h；保留 allowlist |
| Phase 4 run-contracts 拆分 | 拆为 U4.1a-e 5 步，每步可独立 land/回滚 |
| Phase 4 wire-contract-isolation gate 顺序风险（N-2）| **v3 修正**：gate 在 U4.1d 完成后启用，U4.1a 不立即开 |
| Phase 5 move-only PR 被 justification 绕过（N-3）| **v3 修正**：move-only gate 删除 justification 后门，非 move 必拆 PR |
| Phase 5 ipc-handler 拆分破坏 channel 注册 | U5.10 双向 contract gate 强制（C-1） |
| Phase 5 与其它 fix cherry-pick 冲突 | 每个 5.x PR 期间不允许 rebase 其它 branch；强制 fast-forward |
| Phase 6 与 Phase 5 verify chain 改写冲突 | Phase 6 必须等 Phase 5 完成 |
| Phase 7 live provider 不稳定 | U7.5a/b 改为 opt-in；缺 key 跳过；quota/retry/超时全部预设 |
| Phase 7 phase smoke gate 时序矛盾（N-1）| **v3 修正**：U0.4 在 Phase 0 即建立 runner；U7.7 仅扩展为生产级 |
| Windows native 风险 | U8.6 + Windows CI matrix（含 verify:native + build） |
| ABI mismatch 复发 | U7.8 单独 e2e + `verify:native` 进入 §0.6 默认验收 |
| skill_executions 复活（C-3）| **v3 新增**：U8.0 单 PR gate 守护 |
| Settings legacy key 漂移（N-8）| **v3 新增**：U8.3 退场 gate 在版本号到达后 hard fail |
| BrowserView overlay 顺序漂移（C-5）| **v3 新增**：U7.6a 配 `check-browserview-overlay-order.cjs` AST gate |
| Scope key 三维丢失（C-6）| **v3 新增**：U7.3 配 `check-scope-key-three-dim.cjs` |
| 工具日志混入 transcript（C-7）| **v3 新增**：U7.3 配 `check-tool-log-not-in-transcript.cjs` |
| verify:native 被遗漏（C-8）| **v3 新增**：`check-verify-native-trigger.cjs` PR diff 自动判定 |
| e2e artifact 不保留（C-10）| **v3 新增**：U7.8 启用 `check-e2e-artifact-retention.cjs` |

## 13. 总时间预估（v7）

- Phase 0：2-3 天（4 PR 并行，含 U0.4 smoke runner）
- Phase 1：5-7 天（5 PR，部分并行）
- Phase 2：3-4 天（4 PR）
- Phase 3：4-5 天（3 PR）
- Phase 4：8-12 天（9 PR：U4.1a-e 串行 + U4.2a/b + U4.3a/b）
- Phase 5：18-22 天（12 PR：U5.1a-c 串行；U5.3-5.5/U5.6/U5.7/U5.8/U5.9 部分并行；U5.10 收口）
- Phase 6：3-5 天（2 PR，必须等 Phase 5）
- Phase 7：12-16 天（11 PR，按 Blocked-by 链）
- Phase 8：8-12 天主体 + U8.8 等 30 天窗口（11 PR：U8.0-4/6/6.1/7 与 Phase 1-3 并行；U8.5a/b 等 Phase 5；U8.8 等 U8.3 land 30 天）

**总日历时间承诺**：**4-7 周** 完成主体（U8.8 单独排到 U8.3 land 后第 5-9 周）。

## 13.5 CI 时间预算（V3-8 回应）

为防止 verify chain 接入过多 gate 后 CI 耗时失控：

| chain | v4 目标时长 | 上限 | 触发条件 |
|---|---|---|---|
| `verify:a0` | ≤ 5 min | 7 min | 每 PR |
| `verify:c` | ≤ 10 min | 15 min | Phase 1+ PR |
| `verify:e` | ≤ 15 min | 20 min | Phase 3+ PR |
| `verify:p` | ≤ 20 min | 25 min | Phase 1.5+ PR |
| `verify:cloud` | ≤ 60 min | 90 min | release build / merge to main |
| `verify:release-smoke` | ≤ 20 min | 30 min | opt-in，缺 key skip |
| Windows CI matrix | ≤ 45 min | 60 min | merge to main / release tag |
| `verify:f:e2e` | ≤ 30 min | 45 min | PR 含 e2e 改动 |

并行策略：
- PR check 内 gate 按 chain 分层并行（同 chain 内串行）
- `verify:cloud` 拆为 4 个 shard 并行（gate / unit / integration / e2e）
- Windows CI matrix 与 macOS matrix 并行（不串行等待）

超时处理：
- 任何 chain 连续 3 次超过上限 → 触发 `ci-budget-violation` issue，要求 Phase 6 重新合并 gate
- 单 PR 超出 chain 上限 → CI 失败，开发者本地复跑前必须先用 `READY_CI_PROFILE=1` 跑一遍找慢点

## 14. 调用 agent teams 的执行规则（v7 批次）

完成本计划批准后，按 §0.3 时序图分批派发：

1. **批次 1（Phase 0 + Phase 8 启动子集）**：U0.1/U0.2/U0.3/U0.4 + U8.0/U8.1/U8.2/U8.3/U8.4/U8.6 + **U8.6.1**（X-4 修正）+ U8.7 并行（U8.5a/b 等 Phase 5；U8.8 等 U8.3 land 30 天）
2. **批次 2（Phase 1）**：5 PR；U1.2 → U1.3 串行；U1.1/U1.4/U1.5 与 U1.2 并行
3. **批次 3（Phase 2 + Phase 3）**：可与批次 2 后段并行（4 + 3 = 7 PR）
4. **批次 4（Phase 4）**：必须等 Phase 1；U4.1a → U4.1b → U4.1c → U4.1d → U4.1e 严格串行；之后 U4.2a → U4.2b → U4.3a → U4.3b
5. **批次 5（Phase 5）**：U5.1a → U5.1b → U5.1c → U5.2 串行；U5.3 → U5.4 → U5.5 串行；U5.6/U5.7/U5.8/U5.9 可并行；U5.10 收口；同期启动 U8.5a/U8.5b
6. **批次 6（Phase 6）**：等 Phase 5 完成；U6.1 → U6.2 串行
7. **批次 7（Phase 7）**：按各 PR Blocked-by 派发（U7.6a → U7.6b；U7.1a → U7.1b；U7.7 等 U7.1b/U7.2/U7.3/U7.4/U7.6b；U7.8 等 U7.6b/U7.7；U7.5a → U7.5b 等 Phase 6）
8. **批次 8（U8.8 收口）**：U8.3 land 满 30 天后启动；监控 metric `settings.legacy_key_migration_completed` 不再有最近 30 天新增完成事件后才 land

每批次完成后：
- 更新本文档对应 PR 状态（`pending` → `in-progress` → `merged`）
- 跑当前 phase 的 smoke gate（`node scripts/phase-smoke-runner.cjs --phase <n>`）
- 失败必须暂停后续 PR 派发，先查根因

## 15. 后续

- 本计划 v7 经 codex 七次审核通过后开始派发。
- Stage U 结束时写 `2026-05-20-U-release-readiness-pre-flight-audit-report.md`。
- 第三阶段：codex 审查实施结果 → 修问题 → 循环直至零问题。
