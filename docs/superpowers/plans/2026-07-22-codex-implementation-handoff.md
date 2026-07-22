---
title: Codex 实施启动 Handoff（L-1 在途清算 + L0 Browser 顺序收口）
date: 2026-07-22
kind: handoff
status: active
enforce: true
owner: 白
author: Claude
executor: Codex
authorities:
  - docs/superpowers/plans/2026-07-22-agent-long-task-remediation-roadmap.md（排序与范围唯一权威，approved）
  - docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md（L0 阶段权威，approved-for-implementation / enforce: true）
  - docs/superpowers/audits/2026-07-22-browser-agent-long-task-root-cause-and-evidence.md（证据真值，含 §6 独立复核与 §6.4 五日全景）
  - docs/architecture/current-runtime-contracts.md §5..§6
---

# Codex 实施启动 Handoff

## 0. 一句话任务

按 roadmap 已批准的顺序，先完成 L-1 在途清算，再实施 L0 Browser 顺序收口（S0 → S1 → S2 → S3-min → [S4 | R6 proof] → S5），出口是原始 18 组小红书任务在真实 Electron 连续 3 次通过（无干预 / 接管后恢复 / 重启后恢复），即收口计划验收矩阵 A1–A12。

阅读顺序（开工前必读）：roadmap 全文 → 审计 §2（根因）+ §6（复核与 R7–R10）→ 收口计划全文（以 2026-07-22 定稿版为准，含 §1.8 与 S3-min）→ contracts §5/§6。范围问题一律以 roadmap 裁决为准；两文档冲突时先定性"实现回归还是文档漂移"，不擅自改范围。

## 1. 当前状态快照（2026-07-22）

- 分支 `feature/skill-envelope-floors`，HEAD `3235cc6c7`；工作树 dirty：~117 文件、约 +3.9k 净增，另有 2 份未跟踪源码（`agent-sdk-provider-request-retry.ts`、`dynamic-delivery/grounded-delivery-repair.ts`）——全部属于 2026-07-18 grounded orchestration（`partially-implemented-known-failures`）的续作，尚未定性。
- 失败样本三 run（DB 只读可查）：`req-1784650529956-wpx7ap` / `req-1784651172715-lrh49u` / `req-1784651733758-9ugy5h`；DB=`~/Library/Application Support/Ready/ready.db`；日志在 `os.tmpdir()` 下 `ready-{directchat,tools,browser,agent-metrics}.log`。
- 五份文档已定稿待提交：审计（含 §6）、收口计划、架构计划、roadmap、本 handoff；`docs/README.md` 已更新索引。

## 2. 第一批动作（L-1，严格按序）

1. **docs-only 提交**（先于一切，避免被后续封存操作卷走）：
   ```bash
   git add docs/superpowers/audits/2026-07-22-browser-agent-long-task-root-cause-and-evidence.md \
     docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md \
     docs/superpowers/plans/2026-07-22-agent-plan-execute-policy-hooks-and-branching-runtime-design.md \
     docs/superpowers/plans/2026-07-22-agent-long-task-remediation-roadmap.md \
     docs/superpowers/plans/2026-07-22-codex-implementation-handoff.md \
     docs/README.md
   git commit -m "docs: land 2026-07-22 long-task audit, closure plans, roadmap and handoff"
   ```
2. **在途 gate 定性**（逐条执行、逐条记录退出码；禁止 `npm run X | tail` 之类管道掩蔽）：
   ```bash
   npm run typecheck > /tmp/l1-tc.log 2>&1; echo TC_EXIT=$?
   npm run verify:browser-orchestration > /tmp/l1-bo.log 2>&1; echo BO_EXIT=$?
   npm run verify:stability > /tmp/l1-st.log 2>&1; echo ST_EXIT=$?
   npm run verify:native > /tmp/l1-na.log 2>&1; echo NA_EXIT=$?
   ```
3. **二选一处置**（把 EXIT 码与结论写进 L-1 记录）：
   - 全绿 → 当前分支提交：`git add -A && git commit -m "feat(browser): land grounded orchestration partial implementation (2026-07-18 plan, partially-implemented-known-failures; sequencing: 2026-07-22 roadmap)"`。
   - 任一红或与 S1 改动面冲突过大 → 封存：`git switch -c wip/2026-07-18-grounded-orchestration-partial && git add -A && git commit -m "wip: shelve grounded orchestration partial implementation"`，再 `git switch feature/skill-envelope-floors`，以干净基线开工。
4. **探针归档**：`.ready-exact-prompt-live.mjs`、`.ready-exact-prompt-live-report.json`、`.ready-provider-probe.mjs` 移入 `outputs/agent-audit/2026-07-22/`（审计引用的 report 保留）。

### L-1 执行记录（2026-07-22）

- docs-only 提交：`6d6402853`。
- Gate 结果：`typecheck=0`（`/tmp/l1-tc.log`）、`verify:browser-orchestration=0`（`/tmp/l1-bo.log`）、`verify:stability=1`（`/tmp/l1-st.log`）、`verify:native=0`（`/tmp/l1-na.log`）。
- 失败定性：`verify:stability` 被 module-boundary gate 拒绝；`agent-sdk-turn-completion.ts` / `agent-sdk-turn-execution.ts` / `agent-sdk-turn-model-loop.ts` 超过 900 行，`agent-sdk-turn-orchestrator.ts` 达 1003 行并超过 1000 行硬上限。
- 处置：按“任一红则封存”分支执行，已将 07-18 在途实现封存到 `wip/2026-07-18-grounded-orchestration-partial`，提交 `79fbc376`；当前分支回到干净 `feature/skill-envelope-floors`。
- 探针归档：三份根目录探针已移入该 WIP 提交的 `outputs/agent-audit/2026-07-22/`，其中 live report 保留。
- 与计划偏差：为避免探针在切回基线后随分支消失，归档动作在 WIP 提交前完成；其余顺序、Gate 命令和处置标准零偏差。

## 3. L0 施工顺序与每阶段入口

全部细节以收口计划对应章节为准，此处只列入口与不可跳步：

| 阶段 | 权威章节 | 核心交付 | 不可跳步 |
| --- | --- | --- | --- |
| S0 | 计划 S0（含 2026-07-22 增补条目） | 失败测试先行：R1a/b/c、R2、R3、R6 proof、deadline 终态断言、指针/导航/关 tab 三信号、R8、R9、stale-projection 与 Main 守卫击杀路径；R7/R10 为调查项（结论追加进审计 §6.4） | 新测试必须在现状下稳定失败并留基线输出 |
| S1 | 计划 §1.1/§1.1.1/§1.4/§1.8 + S1 | `BrowserTargetClaim` 持久表替换 surface 租约；operation 先绑 child 再分类；§1.8 默认路由；dormant 全家删除或改写 | 不留 surface lock 双轨；claim 表是 L0 唯一新表 |
| S2 | 计划 §1.2/§1.2.1/§1.3 + S2 | target 级接管信号（含指针/chrome 导航/关 tab 补线）；监督 UI 真实"继续 Agent"；接管与页面挑战分离 | 跨进程五件套同步交付（IPC schema/Main/Preload/Renderer/行为测试） |
| S3-min | 计划 S3（2026-07-22 执行版） | 时钟显式状态机 + `user_input_resolved`；§1.6 终态映射接既有 suspension 机器；typed 续跑 + 多候选反问 | 不建 §1.5/§1.5.1 任何表；新增 `verify:agent-continuation-clock` |
| S4 | 计划 S4 | 类型/预算/终态投影统一 | 仅在 S0 的 R6 proof 达 100% 后开工，否则移出为独立待证计划 |
| S5 | 计划 S5 + §5 独立复审门 | `verify:browser-live-grounded` 全链真机验收 + A1–A12 报告 | 不接受预存报告；复审无输出不算通过 |

关键源码锚点（S1/S3-min 快速定位，行号为 2026-07-22 快照、以符号为准）：`browser-write-lease.ts`（surfaces/acquire/checkWrite/release）、`agent-browser-turn-lease.ts`（leaseIds/tabIds/ensureGateForSurface）、`browser-permission-policy.ts:102-107`（lease.tabId===target.tabId）、`ipc-handler.ts`（switchTab :2546 / requestAgentInterruption :1456 / attachUserViewLeaseTakeover :1415 / dormant ensureAgentTab :1328）、`user-view-takeover-bridge.ts`、`browser-tools.ts:284-336`（target 缺省=active tab，§1.8 改这里）、`browser-act-tools.ts:341/:884`（agent 自触发 switch 路径）、`delivery-deadline.ts:51-58`（1s 轮询）、`agent-sdk-browser-suspension.ts`（S3-min 复用的暂停机器）、`orchestrator.ts:390-397`（awaiting-input 豁免的参照语义）。

## 4. 红线（违反即回退，不讨论）

1. L-1 未完成不得开始 S1 编码；S 阶段 Gate 未全绿不得进下一阶段。
2. 不保留 surface lock 兼容分支；dormant 后台机器（ensureAgentTab/ScopedBrowserFacade/releaseForBackgroundHandoff/bounds-lock/'navigation' 未接线源）不得留未接线第三态。
3. L0 不建 §1.5/§1.5.1 的任何持久表（它们属架构计划 P3/P1）。
4. 不为通过特定站点加站点名、词表、固定 URL 或固定步骤分支。
5. 不开 Browser 执行型子代理、不并行多 tab 写入（L2 前置未满足）。
6. 所有验证命令逐条记录退出码；不得用管道尾接 echo 掩蔽失败。
7. 每阶段收尾按 CLAUDE.md §10：typecheck、对应专项 gate、涉 SQLite 跑 `verify:native`（ABI skip 只算未覆盖）、净增行数文件查 1000 行健康度并更新 `docs/code-health/large-file-health-log.md`。

## 5. 汇报与证据合同

- 每阶段完成：更新收口计划该阶段状态 + 附 gate 输出路径与 EXIT 码 + 简述与计划的偏差（零偏差也要写明）。
- 发现计划与代码事实冲突：停下，先在 roadmap 对应裁决条目下记录冲突与建议，等裁决后继续；不得现场自行改范围。
- S5 完成：产出 A12 要求的可重放验收报告，并启动 §5 独立复审门（具名 reviewer 反向审查，无输出不算通过）。
- 全部 A1–A12 通过后：同步 `docs/architecture/current-runtime-contracts.md` §5/§6 的对应合同条目，并把架构计划 frontmatter 翻为 `approved-for-implementation / enforce: true`（进入 L1 前仍需用户点头）。
